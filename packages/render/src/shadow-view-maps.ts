import type { Camera } from "@babylonjs/core/Cameras/camera";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { Light } from "@babylonjs/core/Lights/light";
import type { Scene } from "@babylonjs/core/scene";
import type { ShadowSettings } from "@haptic/core";
import type { ShadowCasterList } from "./shadow-caster-list";
import { isReflectionCamera } from "./reflection-camera";
import { isAtlasShadow } from "./shadow-atlas";
import type { ShadowEntry as Entry } from "./shadow-entry";
import {
  applyShadowSettings,
  createShadowGenerator,
  neutralUntilRendered,
  shadowAllocationCheckpoint,
  type ShadowMapContext,
} from "./shadow-map-factory";

/**
 * A view's own sun map (a High or Full Quality Render Target Capture's, or a planar reflection's): the scene
 * map's size, cascades (at most the view's `cascades`) and settings, keyed to the view's camera and fitted to
 * it as a scene view there would fit it. `mirrors` is the scene map it was
 * built from; a replaced scene map replaces it. It is cascade tiles of the same
 * shadow atlas, which holds their memory, so it charges nothing.
 */
export type ViewMap = {
  generator: ShadowGenerator;
  mirrors: ShadowGenerator;
  /** Layers drawn, for metrics(). */
  passes: number;
};
type View = {
  camera: Camera;
  /** Live claims; the maps go with the last. */
  claims: number;
  /** The most cascades its sun maps take (`attach`): the scene map's count when that is fewer. */
  cascades: number;
  maps: Map<Light, ViewMap>;
  /**
   * Scene maps whose mirror found no room in the atlas at any size (warned once per scene map). Retried after
   * `retryAt` and whenever the scene map changes.
   */
  refused: Map<Light, { mirrors: ShadowGenerator; retryAt: number }>;
  /** Disposals that threw, which the view's release reports. */
  pending: Set<Promise<void>>;
};
/** Scene maps whose mirror the atlas refused a reflection (warned once each). */
const refusedReflections = new WeakSet<ShadowGenerator>();
/** How long a view waits before asking the atlas again for a mirror it refused. */
const VIEW_REFUSAL_RETRY_MS = 1_000;
/** A view's claim on its own sun maps. */
export type ViewShadows = {
  /** Disposes the view's maps; settles once they are disposed. Idempotent. */
  release(): Promise<void>;
};
type CasterBounds = ReturnType<ShadowCasterList["bounds"]>;

/**
 * The per-view sun maps of a scene's shadow controller (`attachView`): one set
 * per claimed camera, mirroring the scene view's admitted sun maps as tiles of
 * the shadow atlas.
 */
export class ShadowViewMaps {
  /** Views with their own sun maps, by camera. */
  private readonly views = new Map<Camera, View>();
  /** Effective settings of the last sync, which views mirror. */
  private settings: ShadowSettings | null = null;
  /** The last sync's atlas edge, which mirrors take tiles of. */
  private atlasEdge = 0;
  private readonly entries: ReadonlyMap<Light, Entry>;
  private readonly maps: ShadowMapContext;
  private readonly scene: Scene;
  constructor(entries: ReadonlyMap<Light, Entry>, maps: ShadowMapContext) {
    this.entries = entries;
    this.maps = maps;
    this.scene = maps.scene;
  }
  /**
   * Claims `camera`'s own sun maps, built at once for a new view, with at most `cascades` cascades each (a small
   * capture's image has no room for the detail the scene view's near cascades add). The first claim sets it.
   */
  attach(camera: Camera, casterBounds: () => CasterBounds | undefined, cascades = Infinity): ViewShadows {
    let view = this.views.get(camera);
    if (view) view.claims++;
    else {
      view = { camera, claims: 1, cascades: Math.max(1, cascades), maps: new Map(), refused: new Map(), pending: new Set() };
      this.views.set(camera, view);
      this.syncView(view, casterBounds);
    }
    const claimed = view;
    let released: Promise<void> | undefined;
    return {
      release: () => (released ??= --claimed.claims > 0
        ? Promise.resolve()
        : this.releaseView(claimed)),
    };
  }
  /** `camera`'s own map for `light`, if it holds one. */
  generator(light: Light, camera: Camera): ShadowGenerator | undefined {
    return this.views.get(camera)?.maps.get(light)?.generator;
  }
  /**
   * Mirrors the maps a sync admitted with `settings`, after their releases and replacements, as tiles of the
   * `atlasEdge`-texel atlas (`ShadowAdmissionPlan.atlasEdge`). Whether any view's map was built or dropped.
   */
  sync(settings: ShadowSettings, casterBounds: () => CasterBounds | undefined, atlasEdge: number): boolean {
    this.settings = settings;
    this.atlasEdge = atlasEdge;
    let changed = false;
    for (const view of this.views.values()) if (this.syncView(view, casterBounds)) changed = true;
    return changed;
  }
  /**
   * Drops every view's mirrors of scene maps released or replaced since, before their replacements are built: their
   * tiles go back with the scene map's, and the atlas with its last tile. Whether any was dropped.
   */
  prune(): boolean {
    let dropped = false;
    for (const view of this.views.values())
      for (const [light, map] of view.maps) if (this.stale(light, map.mirrors) && this.dropViewMap(view, light)) dropped = true;
    return dropped;
  }
  /** Every view's map, view by view. */
  forEachMap(action: (map: ViewMap) => void): void {
    for (const view of this.views.values()) for (const map of view.maps.values()) action(map);
  }
  /** `camera`'s own maps. */
  forEachMapOf(camera: Camera, action: (map: ViewMap) => void): void {
    const view = this.views.get(camera);
    if (view) for (const map of view.maps.values()) action(map);
  }
  /** Whether `camera` holds a map of its own. */
  holdsMaps(camera: Camera): boolean {
    return (this.views.get(camera)?.maps.size ?? 0) > 0;
  }
  /** Drops a disposed light's maps and history from every view. */
  forgetLight(light: Light): void {
    for (const view of this.views.values()) {
      this.dropViewMap(view, light);
      view.refused.delete(light);
    }
  }
  /** Releases every view, whatever its claims. */
  releaseAll(): void {
    for (const view of [...this.views.values()]) void this.releaseView(view).catch(() => {});
  }
  /**
   * Mirrors every admitted sun map for `view` and drops mirrors of replaced or
   * released maps. Settings that keep the allocation apply in place, as they do
   * to the scene map. Point and spot maps stay shared. Whether a map of the view was built or dropped.
   */
  private syncView(
    view: View,
    casterBounds: () => CasterBounds | undefined,
  ): boolean {
    const settings = this.settings;
    let changed = false;
    for (const [light, map] of view.maps) if (this.stale(light, map.mirrors) && this.dropViewMap(view, light)) changed = true;
    for (const [light, { mirrors }] of view.refused)
      if (this.entries.get(light)?.generator !== mirrors) view.refused.delete(light);
    if (!settings) return changed;
    const now = performance.now();
    for (const entry of this.entries.values()) {
      const source = entry.generator;
      if (!(entry.light instanceof DirectionalLight) || entry.status !== "active" || !source || entry.standby)
        continue;
      const existing = view.maps.get(entry.light);
      if (existing) {
        applyShadowSettings(existing.generator, settings);
        // Babylon checks the distance against the view's own clip range, as a camera there would.
        if (existing.generator instanceof CascadedShadowGenerator) existing.generator.shadowMaxZ = settings.distance;
        continue;
      }
      const refused = view.refused.get(entry.light);
      if (refused?.mirrors === source && now < refused.retryAt) continue;
      if (this.createViewMap(view, entry, source, settings, casterBounds())) changed = true;
    }
    return changed;
  }
  /** Whether a mirror of `light`'s map `mirrors` outlived it: the scene map was released or replaced since. */
  private stale(light: Light, mirrors: ShadowGenerator): boolean {
    const entry = this.entries.get(light);
    return !this.settings || entry?.status !== "active" || entry.standby || entry.generator !== mirrors;
  }
  /**
   * The scene map's cascade tiles for the view's camera, of the size the atlas has room for, halving at once, in the
   * room the scene view's admitted and standby maps leave; it samples neutrally until its first draw. Refused at every
   * size, the view's receivers sample the scene view's map instead, and the view asks again later
   * (`VIEW_REFUSAL_RETRY_MS`, or once the scene map changes). Whether it built the map.
   */
  private createViewMap(
    view: View,
    entry: Entry,
    source: ShadowGenerator,
    settings: ShadowSettings,
    casterBounds: CasterBounds | undefined,
  ): boolean {
    if (!isAtlasShadow(source)) return false;
    const cascades = Math.min(source instanceof CascadedShadowGenerator ? source.numCascades : 1, view.cascades);
    const layers = cascades;
    const viewSettings = cascades < settings.cascades ? { ...settings, cascades } : settings;
    for (let mapSize = entry.mapSize; mapSize >= 256; mapSize /= 2) {
      const cleanup = shadowAllocationCheckpoint(this.scene);
      try {
        const generator = createShadowGenerator(this.maps, entry, mapSize, viewSettings, view.camera, casterBounds, this.atlasEdge);
        // Its tiles hold what their last map drew until it draws.
        neutralUntilRendered(generator);
        view.maps.set(entry.light, { generator, mirrors: source, passes: layers });
        view.refused.delete(entry.light);
        return true;
      } catch (error) {
        const failures: unknown[] = [error];
        try {
          cleanup(entry.light.getShadowGenerator(view.camera));
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        if (failures.length > 1)
          throw new AggregateError(failures, "View shadow allocation and resource cleanup failed", { cause: error });
        // Its tiles are free again at once: the next size down.
      }
    }
    const previous = view.refused.get(entry.light);
    view.refused.set(entry.light, { mirrors: source, retryAt: performance.now() + VIEW_REFUSAL_RETRY_MS });
    if (!isReflectionCamera(view.camera)) {
      if (previous?.mirrors !== source)
        console.warn(`[render] A Render Target Capture samples "${entry.light.name}" shadows from the main camera's map: its own map does not fit the shadow atlas.`);
    } else if (!refusedReflections.has(source)) {
      // Once per scene map, for every reflection: they come and go with their surfaces' draws.
      refusedReflections.add(source);
      console.warn(`[render] Reflections draw "${entry.light.name}" unshadowed: their own sun maps do not fit the shadow atlas.`);
    }
    return false;
  }
  /**
   * When a scene view's map finds no room in the shadow atlas, the views' maps give way: it is built again with their
   * tiles free, and they take the room it leaves at the sync's end. Whether any gave way.
   */
  yieldAtlasTiles(): boolean {
    let yielded = false;
    for (const view of this.views.values())
      for (const light of [...view.maps.keys()]) {
        this.dropViewMap(view, light);
        yielded = true;
      }
    return yielded;
  }
  /** Disposes a view's map; its tiles go back to the atlas. Whether the view held one for `light`. */
  private dropViewMap(view: View, light: Light): boolean {
    const map = view.maps.get(light);
    if (!map) return false;
    view.maps.delete(light);
    try {
      map.generator.dispose();
    } catch (error) {
      // A failed disposal stays pending, so the claim's release reports it.
      const failed = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      view.pending.add(failed);
      failed.catch(() => {});
    }
    return true;
  }
  private releaseView(view: View): Promise<void> {
    if (this.views.get(view.camera) === view) this.views.delete(view.camera);
    for (const light of [...view.maps.keys()]) this.dropViewMap(view, light);
    view.refused.clear();
    return Promise.all([...view.pending]).then(() => {});
  }
}
