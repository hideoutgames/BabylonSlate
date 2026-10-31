import { DirectionalLight, InstancedMesh, Mesh, PointLight, SpotLight, Vector3, type AbstractMesh, type Light, type ShadowGenerator } from "@babylonjs/core";
import type { ShadowSettings } from "@haptic/core";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";
import {
  createPrivateShadowAtlas,
  placeInPrivateAtlas,
  prepareTileClear,
  SHADOW_ATLAS_BYTES_PER_TEXEL,
  type PrivateShadowAtlas,
} from "./shadow-atlas";
import { drawnMaterialVariants } from "./drawn-variants";
import { createDetachedShadowGenerator, type ShadowMapContext } from "./shadow-map-factory";

/** The maps' tiles (a map's kind, format and filter shape its casters' depth variants, never its size). */
const TILE = 64;
/** Their atlas: room for four cascades, a spot light's tile and a point light's six faces. */
const EDGE = 4 * TILE;

/**
 * The depth variants `generator` draws a regular-instance batch with, asked of the caster's own submeshes (an
 * instance's read its own scaling): an instance the instanced one, a source the ones it draws (`drawnMaterialVariants`). The map's own check asks for the variant
 * of the frame's visible instances, which outside a frame are none, so it would compile the plain one only.
 */
function batchVariantsReady(generator: ShadowGenerator, caster: InstancedMesh | Mesh): boolean {
  const source = caster instanceof InstancedMesh ? caster.sourceMesh : caster;
  const instancing = source.getEngine().getCaps().instancedArrays;
  const drawn = drawnMaterialVariants(source);
  const plain = !instancing || (caster === source && drawn.plain);
  const instanced = instancing && (caster !== source || drawn.instanced);
  let ready = true;
  // An instance's own submeshes, as the map draws it: its defines read the instance (its scaling), not the source.
  for (const subMesh of caster.subMeshes ?? []) {
    const material = subMesh.getMaterial();
    if (!material || subMesh.verticesCount === 0) continue;
    const transparent = material.needAlphaBlendingForMesh(source);
    if (plain) ready = generator.isReady(subMesh, false, transparent) && ready;
    if (instanced) ready = generator.isReady(subMesh, true, transparent) && ready;
  }
  return ready;
}

/**
 * Lighting plan: on the light block's path a light's first shadow map of a kind (the sun's cascades, a spot light's
 * tile, a point light's faces) draws its casters with that kind's depth variants, which would compile mid-game. Play
 * asks for them ahead, in its world presentation's loading frames, for the casters as its starting state poses them (a
 * variant reads the caster's scaling; `SceneShadowController.warmCasterVariants`): a map of each kind, built as an
 * admitted map is, on a stand-in light outside the Scene, with tiles in a private atlas of the atlas's format, asks
 * every caster for its depth variant, as the map's own readiness check would, whatever its light's reach. The
 * controller's syncs ask again only the casters that check found not ready (the map's shaders loading, an Effect
 * compiling, a depth wrapper's variant Material not yet ready, which its first ask compiles), so a caster that never
 * becomes ready costs one check per sync.
 * Never drawn, the maps keep those variants compiled while they live (the casters' draw wrappers for their passes, or
 * their Materials' depth wrappers, hold them), until new shadow settings build them again. A caster that arrives once
 * they are held, with a variant no caster had, compiles it at its first cast.
 */
export class ShadowCasterVariants {
  private readonly context: ShadowMapContext;
  private maps: ShadowGenerator[] = [];
  private lights: Light[] = [];
  private atlas: PrivateShadowAtlas | null = null;
  private lease: ManagedRenderLease | null = null;
  /** The settings the maps were built with, serialized; null without maps. */
  private built: string | null = null;
  /** The casters some map's readiness check found not ready when it last asked. */
  private waiting = new Set<AbstractMesh>();
  constructor(context: ShadowMapContext) {
    this.context = context;
  }
  /** Asks every caster for its depth variant of each kind of atlas map with `settings`, building the maps for them. */
  warm(settings: ShadowSettings): void {
    if (JSON.stringify(settings) !== this.built) this.build(settings);
    this.request(this.context.casters);
    // The atlas tiles' clear, whose WebGPU pipeline would otherwise be made at the first shadow start.
    if (this.atlas) prepareTileClear(this.atlas);
  }
  /** A sync: builds the maps again for `settings` when they were built for others, or asks the casters still waiting. */
  follow(settings: ShadowSettings): void {
    if (this.built === null) return;
    if (JSON.stringify(settings) !== this.built) this.warm(settings);
    else if (this.waiting.size) this.request([...this.waiting].filter((caster) => this.context.casters.has(caster)));
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
    this.waiting.clear();
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
  /** `casters`' depth variants for each map, prepared in the map's first pass by its own readiness check. */
  private request(casters: Iterable<AbstractMesh>): void {
    const engine = this.context.scene.getEngine();
    const pass = engine.currentRenderPassId;
    const waiting = new Set<AbstractMesh>();
    try {
      for (const generator of this.maps) {
        const map = generator.getShadowMap()!;
        engine.currentRenderPassId = map.renderPassId;
        for (const caster of casters) {
          // A variant reads the caster's world matrix (non-uniform scaling), which a frame computes before its maps draw.
          caster.computeWorldMatrix();
          const ready = caster instanceof InstancedMesh || (caster instanceof Mesh && caster.hasInstances)
            ? batchVariantsReady(generator, caster) : map.customIsReadyFunction!(caster, 0, true);
          if (!ready) waiting.add(caster);
        }
      }
    } finally {
      engine.currentRenderPassId = pass;
    }
    this.waiting = waiting;
  }
}
