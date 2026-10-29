import { DirectionalLight, PointLight, SpotLight, Vector3, type Light, type ShadowGenerator } from "@babylonjs/core";
import type { ShadowSettings } from "@haptic/core";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";
import {
  createPrivateShadowAtlas,
  placeInPrivateAtlas,
  SHADOW_ATLAS_BYTES_PER_TEXEL,
  type PrivateShadowAtlas,
} from "./shadow-atlas";
import type { ShadowMapContext } from "./shadow-map-factory";
import { createDetachedShadowGenerator, PREDICTION_MAP_SIZE } from "./shadow-prediction-maps";

/** The maps' tiles (a map's kind, format and filter shape its casters' depth variants, never its size). */
const TILE = PREDICTION_MAP_SIZE;
/** Their atlas: room for four cascades, a spot light's tile and a point light's six faces. */
const EDGE = 4 * TILE;

/**
 * Lighting plan: on the light block's path a light's first shadow map of a kind (the sun's cascades, a spot light's
 * tile, a point light's faces) draws its casters with that kind's depth variants, which would compile mid-game. Play
 * asks for them ahead, in its world presentation's loading frames, for the casters as its starting state poses them (a
 * variant reads the caster's scaling; `SceneShadowController.warmCasterVariants`): a map of each kind, built as an
 * admitted map is, on a stand-in light outside the Scene, with tiles in a private atlas of the atlas's format, asks
 * every caster for its depth variant, as the map's own readiness check would, whatever its light's reach, and again at
 * each of the controller's syncs until every caster holds them (a new map asks for nothing until Babylon has loaded its
 * shaders).
 * Never drawn, the maps keep those variants compiled while they live (the casters' draw wrappers for their passes hold
 * them), until new shadow settings build them again. A caster that arrives once they are held, with a variant no caster
 * had, compiles it at its first cast.
 */
export class ShadowCasterVariants {
  private readonly context: ShadowMapContext;
  private maps: ShadowGenerator[] = [];
  private lights: Light[] = [];
  private atlas: PrivateShadowAtlas | null = null;
  private lease: ManagedRenderLease | null = null;
  /** The settings the maps were built with, serialized; null without maps. */
  private built: string | null = null;
  /** Some caster does not hold its depth variants yet. */
  private pending = false;
  constructor(context: ShadowMapContext) {
    this.context = context;
  }
  /** Asks every caster for its depth variant of each kind of atlas map with `settings`, building the maps for them. */
  warm(settings: ShadowSettings): void {
    if (JSON.stringify(settings) !== this.built) this.build(settings);
    this.pending = this.built !== null;
    this.request();
  }
  /** A sync: builds the maps again for `settings` when they were built for others, or asks the casters still pending. */
  follow(settings: ShadowSettings): void {
    if (this.built === null) return;
    if (JSON.stringify(settings) !== this.built) this.warm(settings);
    else if (this.pending) this.request();
  }
  /** Disposes the maps, which release the variants only they held. */
  dispose(): void {
    for (const map of this.maps) map.dispose();
    for (const light of this.lights) light.dispose();
    this.atlas?.target.dispose();
    if (this.lease) void releaseManagedRenderLeaseAfterDisposal(this.context.scene.getEngine(), this.lease).catch(() => {});
    this.maps = [];
    this.lights = [];
    this.atlas = null;
    this.lease = null;
    this.built = null;
    this.pending = false;
  }
  private build(settings: ShadowSettings): void {
    this.dispose();
    const scene = this.context.scene;
    const bytes = EDGE ** 2 * SHADOW_ATLAS_BYTES_PER_TEXEL;
    const lease = beginManagedRenderAllocation(scene.getEngine(), bytes);
    if (!lease) return;
    this.lease = lease;
    const atlas = this.atlas = createPrivateShadowAtlas(scene, EDGE);
    lease.commit([{ handle: atlas.target, bytes, category: "shadow" }]);
    this.lights = [
      new DirectionalLight("hapticCasterVariants:directional", Vector3.Down(), scene, true),
      new SpotLight("hapticCasterVariants:spot", Vector3.Zero(), Vector3.Down(), Math.PI / 2, 2, scene, true),
      new PointLight("hapticCasterVariants:point", Vector3.Zero(), scene, true),
    ];
    for (const light of this.lights) {
      const map = placeInPrivateAtlas(atlas, () =>
        createDetachedShadowGenerator(this.context, light as DirectionalLight | SpotLight | PointLight, settings, TILE, EDGE));
      // It asks the casters itself (`request`), so its list holds none.
      map.getShadowMap()!.renderList = [];
      this.maps.push(map);
    }
    this.built = JSON.stringify(settings);
  }
  /**
   * Each caster's depth variants for each map, prepared in the map's first pass as its own readiness check does; still
   * pending while a drawn part of a caster (with a Material and vertices) holds none there.
   */
  private request(): void {
    const engine = this.context.scene.getEngine();
    const pass = engine.currentRenderPassId;
    let pending = false;
    try {
      for (const generator of this.maps) {
        const map = generator.getShadowMap()!;
        const id = map.renderPassId;
        engine.currentRenderPassId = id;
        for (const caster of this.context.casters) {
          // A variant reads the caster's world matrix (non-uniform scaling), which a frame computes before its maps draw.
          caster.computeWorldMatrix();
          map.customIsReadyFunction?.(caster, 0, true);
          pending ||= caster.subMeshes?.some((part) =>
            part.getMaterial() && part.verticesCount > 0 && !part._getDrawWrapper(id)?.effect) ?? false;
        }
      }
    } finally {
      engine.currentRenderPassId = pass;
    }
    this.pending = pending;
  }
}
