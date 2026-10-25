import {
  CascadedShadowGenerator,
  DirectionalLight,
  type ShadowGenerator,
  type Light,
  type Scene,
  type Camera,
} from "@babylonjs/core";
import type { ShadowSettings } from "@haptic/core";
import type { ShadowSpatialIndex } from "./shadow-spatial-index";
import {
  beginManagedRenderAllocation,
  managedRenderReleaseIsDeferred,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";
import {
  availableSceneShadowBytes,
  pendingViewShadowDrains,
  shadowBytesPerTexel,
  trackViewShadowDrain,
} from "./shadow-admission";
import type { ShadowEntry as Entry } from "./shadow-entry";
import {
  applyShadowSettings,
  createShadowGenerator,
  shadowAllocationCheckpoint,
  type ShadowMapContext,
} from "./shadow-map-factory";

/**
 * A view's own sun map (a Full Quality Render Target Capture's): the scene
 * map's kind, size, cascades and settings, keyed to the view's camera and
 * fitted to it as a scene view there would fit it. `mirrors` is the scene map
 * it was built from; a replaced scene map replaces it.
 */
export type ViewMap = {
  generator: ShadowGenerator;
  mirrors: ShadowGenerator;
  lease: ManagedRenderLease;
  /** Ledger charge: a cascaded map's four-layer construction peak, as the scene map's reservation holds. */
  bytes: number;
  /** Final attachments and layers drawn, for metrics(). */
  attachmentBytes: number;
  passes: number;
};
type View = {
  camera: Camera;
  /** Live claims; the maps go with the last. */
  claims: number;
  maps: Map<Light, ViewMap>;
  /**
   * Scene maps whose mirror the ledger refused at every size (warned once per
   * scene map). Retried after `retryAt`, once the Engine's view drains settle,
   * after view maps yield, and whenever the scene map changes.
   */
  refused: Map<Light, { mirrors: ShadowGenerator; retryAt: number }>;
  /** After a failed construction, the next sync's size for a scene map's mirror. */
  recovery: Map<Light, { mirrors: ShadowGenerator; mapSize: number }>;
  /** Ledger releases of disposed maps, pending the WebGPU end-of-frame drain. */
  pending: Set<Promise<void>>;
};
/** How long a view waits before asking the ledger again for a mirror it refused. */
const VIEW_REFUSAL_RETRY_MS = 1_000;
/** A view's claim on its own sun maps. */
export type ViewShadows = {
  /** Disposes the view's maps; settles once their ledger charge is released. Idempotent. */
  release(): Promise<void>;
};
type CasterBounds = ReturnType<ShadowSpatialIndex["bounds"]>;

/**
 * The per-view sun maps of a scene's shadow controller (`attachView`): one set
 * per claimed camera, mirroring the scene view's admitted sun maps, each
 * reserved in the shared rendering ledger.
 */
export class ShadowViewMaps {
  /** Views with their own sun maps, by camera. */
  private readonly views = new Map<Camera, View>();
  /** Effective settings of the last sync, which views mirror. */
  private settings: ShadowSettings | null = null;
  private readonly entries: ReadonlyMap<Light, Entry>;
  private readonly maps: ShadowMapContext;
  private readonly scene: Scene;
  constructor(entries: ReadonlyMap<Light, Entry>, maps: ShadowMapContext) {
    this.entries = entries;
    this.maps = maps;
    this.scene = maps.scene;
  }
  /** Claims `camera`'s own sun maps, built at once for a new view. */
  attach(camera: Camera, casterBounds: () => CasterBounds | undefined): ViewShadows {
    let view = this.views.get(camera);
    if (view) view.claims++;
    else {
      view = { camera, claims: 1, maps: new Map(), refused: new Map(), recovery: new Map(), pending: new Set() };
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
  /** Mirrors the maps a sync admitted with `settings`, after their releases and replacements. */
  sync(settings: ShadowSettings, casterBounds: () => CasterBounds | undefined): void {
    this.settings = settings;
    for (const view of this.views.values()) this.syncView(view, casterBounds);
  }
  /** Every view's map, view by view. */
  forEachMap(action: (map: ViewMap) => void): void {
    for (const view of this.views.values()) for (const map of view.maps.values()) action(map);
  }
  /** Drops a disposed light's maps and history from every view. */
  forgetLight(light: Light): void {
    for (const view of this.views.values()) {
      this.dropViewMap(view, light);
      view.refused.delete(light);
      view.recovery.delete(light);
    }
  }
  /** Releases every view, whatever its claims. */
  releaseAll(): void {
    for (const view of [...this.views.values()]) void this.releaseView(view).catch(() => {});
  }
  /**
   * Mirrors every admitted sun map for `view` and drops mirrors of replaced or
   * released maps. Settings that keep the allocation apply in place, as they do
   * to the scene map. Point and spot maps stay shared.
   */
  private syncView(
    view: View,
    casterBounds: () => CasterBounds | undefined,
  ): void {
    const settings = this.settings;
    for (const [light, map] of view.maps) {
      const entry = this.entries.get(light);
      if (!settings || entry?.status !== "active" || entry.standby || entry.generator !== map.mirrors)
        this.dropViewMap(view, light);
    }
    for (const [light, { mirrors }] of view.refused)
      if (this.entries.get(light)?.generator !== mirrors) view.refused.delete(light);
    for (const [light, { mirrors }] of view.recovery)
      if (this.entries.get(light)?.generator !== mirrors) view.recovery.delete(light);
    if (!settings) return;
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
      this.createViewMap(view, entry, source, settings, casterBounds());
    }
  }
  /**
   * The scene map's allocation for the view's camera, reserved in the shared
   * rendering ledger first. A refused reservation halves the map like admission
   * does; refused at every size, the view's receivers sample the scene view's
   * map instead, and the view asks again later (VIEW_REFUSAL_RETRY_MS, or once
   * drains settle or view maps yield). A mirror that fit only at a smaller
   * size keeps it until the scene map changes or the view is re-created. A
   * failed construction retries at half size on a later sync, after its
   * release has drained. Nothing is allocated while any view map's release on
   * this Engine is still draining: its texture still holds the memory, and a
   * view allocated beside it would settle smaller for good.
   */
  private createViewMap(
    view: View,
    entry: Entry,
    source: ShadowGenerator,
    settings: ShadowSettings,
    casterBounds: CasterBounds | undefined,
  ): void {
    const scene = this.scene;
    const engine = scene.getEngine();
    // Released view maps (any Scene's on this Engine) still hold their memory
    // until WebGPU's end-of-frame drain: allocate once they have gone, on a later sync.
    if (pendingViewShadowDrains(engine)) return;
    const cascaded = source instanceof CascadedShadowGenerator;
    // Mirror the scene map's kind even if the settings moved on since it was built.
    if (cascaded !== settings.cascades > 1) return;
    const layers = cascaded ? source.numCascades : 1;
    const bytesPerTexel = shadowBytesPerTexel(engine);
    const recovery = view.recovery.get(entry.light);
    const first = recovery?.mirrors === source ? Math.min(entry.mapSize, recovery.mapSize) : entry.mapSize;
    for (let mapSize = first; mapSize >= 256; mapSize /= 2) {
      // CSM constructs four layers before applying the authored count, and
      // WebGPU destroys that texture only at the frame's end: charge the peak
      // for the map's lifetime, as the scene map's reservation does.
      const bytes = (cascaded ? 4 : layers) * mapSize ** 2 * bytesPerTexel;
      const lease = beginManagedRenderAllocation(engine, bytes);
      if (!lease) continue;
      const cleanup = shadowAllocationCheckpoint(scene);
      try {
        const generator = createShadowGenerator(this.maps, entry, mapSize, settings, view.camera, casterBounds);
        lease.commit([{ handle: generator.getShadowMap()!, bytes, category: "shadow" }]);
        view.maps.set(entry.light, {
          generator, mirrors: source, lease, bytes, attachmentBytes: layers * mapSize ** 2 * bytesPerTexel, passes: layers,
        });
        view.recovery.delete(entry.light);
        view.refused.delete(entry.light);
        return;
      } catch (error) {
        const failures: unknown[] = [error];
        try {
          cleanup(entry.light.getShadowGenerator(view.camera));
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        // Uncertain cleanup keeps the reservation.
        if (failures.length > 1)
          throw new AggregateError(failures, "View shadow allocation and resource cleanup failed", { cause: error });
        this.releaseViewLease(view, lease);
        // Its reservation drains first (WebGPU: at the frame's end); a later
        // sync retries at half size.
        view.recovery.set(entry.light, { mirrors: source, mapSize: mapSize / 2 });
        if (mapSize / 2 < 256) break;
        return;
      }
    }
    const previous = view.refused.get(entry.light);
    view.refused.set(entry.light, { mirrors: source, retryAt: performance.now() + VIEW_REFUSAL_RETRY_MS });
    if (previous?.mirrors !== source)
      console.warn(`[render] A Full Quality capture samples "${entry.light.name}" shadows from the main camera's map: its own map does not fit the shared rendering budget.`);
  }
  /** Committed bytes of every view's maps, which the scene view's admission leaves out. */
  bytes(): number {
    let bytes = 0;
    for (const view of this.views.values()) for (const map of view.maps.values()) bytes += map.bytes;
    return bytes;
  }
  /**
   * When the scene view's maps need ledger room the views' maps hold, view
   * maps give way, largest first, until the scene's fit. Each charge passes to
   * the scene at once, as a replaced scene map's does (both textures go in the
   * same end-of-frame drain); views allocate again only after that drain, from
   * what is left, and refused mirrors may ask again.
   */
  yieldTo(sceneBytes: number): void {
    if (sceneBytes <= availableSceneShadowBytes(this.scene)) return;
    const maps: Array<{ view: View; light: Light; bytes: number }> = [];
    for (const view of this.views.values())
      for (const [light, { bytes }] of view.maps) maps.push({ view, light, bytes });
    maps.sort((a, b) => b.bytes - a.bytes);
    for (const { view, light } of maps) {
      if (sceneBytes <= availableSceneShadowBytes(this.scene)) break;
      this.dropViewMap(view, light, true);
    }
    this.retryRefusedViewMaps();
  }
  /**
   * Disposes a view's map; its ledger charge goes after the WebGPU destruction
   * drain, or at once when it yields to the scene view's maps (its drain is
   * still awaited before any view allocates again).
   */
  private dropViewMap(view: View, light: Light, yieldToScene = false): void {
    const map = view.maps.get(light);
    if (!map) return;
    view.maps.delete(light);
    try {
      map.generator.dispose();
    } catch (error) {
      // Uncertain cleanup keeps the reservation.
      this.trackViewRelease(view, Promise.reject(error instanceof Error ? error : new Error(String(error))), false);
      return;
    }
    if (yieldToScene) map.lease.release();
    // Idempotent after the yield's release: then it only waits for the drain.
    this.releaseViewLease(view, map.lease);
  }
  /** Releases a disposed view map's charge after the destruction drain, which every view waits for. */
  private releaseViewLease(view: View, lease: ManagedRenderLease): void {
    const engine = this.scene.getEngine();
    const deferred = managedRenderReleaseIsDeferred(engine);
    this.trackViewRelease(view, releaseManagedRenderLeaseAfterDisposal(engine, lease), deferred);
  }
  private trackViewRelease(view: View, release: Promise<void>, deferred: boolean): void {
    view.pending.add(release);
    // A failed release stays pending, so the claim's release reports it.
    void release.then(() => view.pending.delete(release), () => {});
    // The Engine's drain count settles either way (a lost device or disposed Engine settles it too).
    const engine = this.scene.getEngine();
    if (deferred)
      void trackViewShadowDrain(engine, release).then(() => {
        if (!pendingViewShadowDrains(engine)) this.retryRefusedViewMaps();
      });
  }
  /**
   * Ledger room the views' missing sun mirrors will ask for once they may
   * allocate (a view that yielded or was re-created, waiting for a drain; a new
   * capture), at the size each would ask for first (cascaded: the four-layer
   * peak). Optional standby maps leave it free. A refused mirror counts only
   * when it is about to ask again, at the smallest size (it was refused at
   * every larger one), and only if that fits beside `admittedBytes`: otherwise
   * releasing standby maps for it would be futile, and repeat every retry.
   */
  missingMirrorBytes(settings: ShadowSettings, admittedBytes: number): number {
    if (!this.views.size) return 0;
    const bytesPerTexel = shadowBytesPerTexel(this.scene.getEngine());
    const layers = settings.cascades > 1 ? 4 : 1;
    const smallest = layers * 256 ** 2 * bytesPerTexel;
    const room = availableSceneShadowBytes(this.scene) - admittedBytes;
    const now = performance.now();
    let bytes = 0;
    for (const entry of this.entries.values()) {
      if (!(entry.light instanceof DirectionalLight) || entry.status !== "active") continue;
      for (const view of this.views.values()) {
        if (view.maps.has(entry.light)) continue;
        const refused = view.refused.get(entry.light);
        if (refused && refused.mirrors === entry.generator) {
          if (now >= refused.retryAt && smallest <= room) bytes += smallest;
          continue;
        }
        const recovery = view.recovery.get(entry.light);
        const mapSize = recovery && recovery.mirrors === entry.generator
          ? Math.min(entry.mapSize, recovery.mapSize)
          : entry.mapSize;
        bytes += layers * mapSize ** 2 * bytesPerTexel;
      }
    }
    return bytes;
  }
  /** Lets every refused mirror ask the ledger again on the next sync. */
  private retryRefusedViewMaps(): void {
    for (const view of this.views.values()) for (const refused of view.refused.values()) refused.retryAt = 0;
  }
  private releaseView(view: View): Promise<void> {
    if (this.views.get(view.camera) === view) this.views.delete(view.camera);
    for (const light of [...view.maps.keys()]) this.dropViewMap(view, light);
    view.refused.clear();
    view.recovery.clear();
    return Promise.all([...view.pending]).then(() => {});
  }
}
