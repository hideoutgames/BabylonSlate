import {
  syncDirectionalLightPolicy,
  isDirectionalLightExcluded,
  isForwardLightExcluded,
} from "./light-policy";
import {
  CascadedShadowGenerator,
  DirectionalLight,
  PointLight,
  SpotLight,
  ShadowGenerator,
  Vector3,
  Frustum,
  Material,
  Plane,
  RenderTargetTexture,
  type AbstractMesh,
  type Light,
  type Scene,
  type Camera,
} from "@babylonjs/core";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { TimingTools } from "@babylonjs/core/Misc/timingTools";
import {
  effectiveShadowSettings,
  SHADOW_CAPACITY_PROFILES,
  type ShadowSettings,
} from "@babylonslate/core";
import { sceneRenderingSettings } from "./render-settings";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { ReusableShadowGenerator, type LocalShadowLight } from "./reusable-shadow-generator";
import {
  exchangeShadowReceivers,
  invalidateShadowReceiverHandoffs,
} from "./shadow-receiver-handoff";
import { hasClusteredLightPolicy } from "./clustered-light-policy";
import {
  authoredShadowParticipation,
  casterWithinShadowRange,
  hasDeformingShadowBounds,
  neverCastsShadows,
  participatesInShadows,
  type ShadowParticipation,
} from "./shadow-mesh-policy";
import { ShadowSpatialIndex } from "./shadow-spatial-index";
import "./shadow-shader";
import { partitionShadowGeometry } from "./shadow-geometry-partitions";
import {
  resolveDirectionalShadowBias,
  type DirectionalShadowBiasInput,
} from "./shadow-bias";
import { configureDirectionalShadowProjection, trackDirectionalShadowFit } from "./directional-shadow-projection";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";
import { readEngineDrawCalls } from "./draw-calls";
import { beginShadowAllocationValidation } from "./shadow-allocation-validation";
import { beginEngineAllocationCheckpoint } from "./allocation-checkpoint";
import { ShadowMapRefresh } from "./shadow-map-refresh";
import { remainingShadowSamplers } from "./light-sampler-budget";
import {
  ENGINE_SHADOW_BUDGET,
  otherShadowReservations,
  availableSceneShadowBytes,
  reserveSceneShadows,
  shadowBytesPerTexel,
  type ShadowCost,
} from "./shadow-admission";

type ShadowLight = DirectionalLight | PointLight | SpotLight;
export type EffectiveShadowBias = {
  layer: number;
  cameraId: string | null;
  renderId: number;
  depthBias: number;
  normalBias: number;
  worldTexelSize: number;
  depthScale: number;
  mode: "directional-auto" | "manual" | "local-authored";
};
export type ShadowLightStatus =
  | "active"
  | "disabled"
  | "not-requested"
  | "non-illuminating"
  | "shadows-disabled"
  | "outside-relevant-area"
  | "budget-limited"
  | "allocation-failed";
type Entry = {
  light: ShadowLight;
  requested: boolean;
  priority: number;
  generator: ShadowGenerator | null;
  key: AllocationKey | null;
  settings: ShadowSettings | null;
  mapSize: number;
  reason: string | null;
  failedKey: string;
  recovery: { requestKey: string; mapSize: number; error: string } | null;
  resetAllocation: boolean;
  status: ShadowLightStatus;
  /** Keeps a camera-rejected local map attached, neutral and unrendered for reuse. */
  standby: boolean;
  admittedAt: number;
  distanceSquared: number;
  effectiveBias: EffectiveShadowBias[];
};
/**
 * A view's own sun map (a Full Quality Render Target Capture's): the scene
 * map's kind, size, cascades and settings, keyed to the view's camera and
 * fitted to it as a scene view there would fit it. `mirrors` is the scene map
 * it was built from; a replaced scene map replaces it.
 */
type ViewMap = { generator: ShadowGenerator; mirrors: ShadowGenerator; lease: ManagedRenderLease };
type View = {
  camera: Camera;
  /** Live claims; the maps go with the last. */
  claims: number;
  maps: Map<Light, ViewMap>;
  /** Scene maps whose mirror the ledger refused at every size; retried when the scene map changes. */
  refused: Map<Light, ShadowGenerator>;
  /** Ledger releases of disposed maps, pending the WebGPU end-of-frame drain. */
  pending: Set<Promise<void>>;
};
/** A view's claim on its own sun maps. */
export type ViewShadows = {
  /** Disposes the view's maps; settles once their ledger charge is released. Idempotent. */
  release(): Promise<void>;
};
// Minimum residency bounds camera-driven map churn; priority/camera switches
// and loss of eligibility still take effect immediately.
const SHADOW_MIN_RESIDENCY_MS = 250;
// Every Babylon 9.29 shadow filter returns fully lit at darkness 1.
const NEUTRAL_DARKNESS = 1;
const controllers = new WeakMap<Scene, SceneShadowController>();

/** An admitted map's allocation shape; a change replaces the generator. */
type AllocationKey = {
  readonly mapSize: number;
  readonly cube: boolean;
  readonly cascades: number;
};

function allocationKey(
  mapSize: number,
  light: ShadowLight,
  cascades: number,
): AllocationKey {
  return {
    mapSize,
    cube: light.needCube(),
    cascades: light instanceof DirectionalLight ? cascades : 1,
  };
}

/** JSON equality of two numbers: every non-finite value serializes as null. */
function sameJsonNumber(a: number, b: number): boolean {
  return a === b || (!Number.isFinite(a) && !Number.isFinite(b));
}

/** Whether `key` equals the allocation shape of these inputs, without building one. */
function matchesAllocationKey(
  key: AllocationKey | null,
  mapSize: number,
  light: ShadowLight,
  cascades: number,
): boolean {
  return (
    key !== null &&
    sameJsonNumber(key.mapSize, mapSize) &&
    key.cube === light.needCube() &&
    sameJsonNumber(key.cascades, light instanceof DirectionalLight ? cascades : 1)
  );
}

/** Faces admission charges a light under the effective settings. */
function admissionPasses(light: ShadowLight, settings: ShadowSettings): number {
  return light instanceof DirectionalLight
    ? settings.cascades
    : light.needCube()
      ? 6
      : 1;
}

/** Material samplers admission charges a light under the effective settings. */
function admissionSamplers(light: ShadowLight, settings: ShadowSettings): number {
  return settings.filter === "pcss" && !light.needCube() ? 2 : 1;
}

/** Faces a live generator renders: its cascades, a cube's six, otherwise one. */
function generatorPasses(generator: ShadowGenerator): number {
  return generator instanceof CascadedShadowGenerator
    ? generator.numCascades
    : generator.getLight().needCube()
      ? 6
      : 1;
}

/** Illumination state and shadow allocation of one light; no entry is "unsupported". */
/**
 * A point/spot map's depth ends at the light's range, not the camera's far
 * plane: casters beyond it have no light to block, and the shorter range both
 * culls them per face and spends the depth precision where the light reaches.
 * A range at or beyond the camera's far plane uses the camera's values, written
 * explicitly: Babylon reads unset values from whichever camera renders, so a
 * second view (a Full Quality capture) would otherwise bind another depth range
 * than the one the map was drawn with. Only the scene view's camera fits.
 */
export function fitLocalShadowDepth(light: Light, camera: Camera | null): void {
  if (!(light instanceof PointLight || light instanceof SpotLight)) return;
  const far = camera?.maxZ || 10000;
  const ranged = Number.isFinite(light.range) && light.range > 0 && light.range < far;
  // Babylon 9.29's camera defaults, the same values the unset fields resolve to.
  const maxZ = ranged ? light.range : camera ? far : undefined;
  const minZ = camera ? camera.minZ || 0 : undefined;
  const depth = light as { shadowMinZ: number | undefined; shadowMaxZ: number | undefined };
  if (depth.shadowMaxZ !== maxZ) depth.shadowMaxZ = maxZ;
  if (depth.shadowMinZ !== minZ) depth.shadowMinZ = minZ;
}

function shadowLightRow(light: Light, entry?: Entry) {
  const generator = entry?.standby ? null : entry?.generator;
  return {
    name: light.name,
    illumination: isDirectionalLightExcluded(light)
      ? "directional-limit"
      : isForwardLightExcluded(light)
        ? "forward-limit"
      : !light.isEnabled() || light.intensity <= 0
        ? "disabled"
        : "active",
    status: entry?.status ?? "unsupported",
    reason: entry?.reason ?? null,
    allocationError: entry?.recovery?.error ?? null,
    refreshMode: generator
      ? generator.getShadowMap()?.refreshRate === RenderTargetTexture.REFRESHRATE_RENDER_ONCE
        ? "on-change"
        : "continuous"
      : null,
    effectiveFilter: !generator
      ? null
      : generator.usePoissonSampling
        ? "poisson"
        : generator.useContactHardeningShadow
          ? "pcss"
          : "pcf",
    passes: generator ? generatorPasses(generator) : 0,
    mapSize: generator?.getShadowMap()?.getSize().width ?? 0,
  };
}

/** Construction is synchronous: no other renderer can allocate between checkpoints. */
function shadowAllocationCheckpoint(
  scene: Scene,
): (generator: { dispose(): void } | null) => void {
  const rollback = beginEngineAllocationCheckpoint(scene);
  return (generator) => {
    const failures = rollback({
      before: (attempt) => {
        if (generator) attempt(() => generator.dispose());
      },
      // A throwing RTT constructor has already registered itself and its observers
      // on the Scene, but has not returned into ShadowGenerator._shadowMap yet.
      textureFilter: (texture) => texture instanceof RenderTargetTexture,
    });
    if (failures.length)
      throw new AggregateError(
        failures,
        "Could not release a failed shadow allocation",
      );
  };
}

/** One lifecycle owner for authored lights in every world host. */
export class SceneShadowController {
  private readonly entries = new Map<Light, Entry>();
  private readonly meshes = new Set<AbstractMesh>();
  private readonly pending = new Set<AbstractMesh>();
  /** Scene meshes already queued once; a removal forgets the mesh so a re-add is queued again. */
  private readonly known = new WeakSet<AbstractMesh>();
  /**
   * Meshes the Scene has announced as removed since they were last seen listed.
   * Removal notifies synchronously, so any other mesh we have heard of since
   * this controller began listening is still in scene.meshes without searching
   * that list.
   */
  private readonly departed = new WeakSet<AbstractMesh>();
  /**
   * Babylon queues each add notice on one ordered task queue, so the Scene can
   * still owe notices for meshes added before this controller listened, and one
   * that left the Scene in that time is not in `departed`. A marker queued at
   * construction runs after those notices and before any later one: from then
   * on a notice can only follow a removal this controller saw.
   */
  private earlierAddsNotified = false;
  /** scene.meshes.length at the last scan, and synchronous removals since. */
  private knownMeshCount = 0;
  private removedSinceScan = 0;
  private readonly spatial = new ShadowSpatialIndex();
  private selectionCamera: Camera | null = null;
  /** Per-map closures read their current owner; a local map can move between lights. */
  private readonly slots = new WeakMap<ShadowGenerator, { entry: Entry; guard: boolean; view: boolean }>();
  /** Views with their own sun maps, by camera. */
  private readonly views = new Map<Camera, View>();
  /** Effective settings of the last sync, which views mirror. */
  private viewSettings: ShadowSettings | null = null;
  private readonly refresh = new ShadowMapRefresh((mesh) =>
    this.spatial.invalidate(mesh),
  );
  /** A native camera pass began since the last before-render-targets notification. */
  private cameraPass = false;
  private drawCalls = 0;
  private triangles = 0;
  shadowDrawCalls(): number {
    return this.drawCalls;
  }
  shadowTriangles(): number {
    return this.triangles;
  }
  private readonly scene: Scene;
  constructor(scene: Scene) {
    this.scene = scene;
    const engine = scene.getEngine();
    const restored = engine.onContextRestoredObservable.add(() => {
      for (const entry of this.entries.values()) {
        entry.failedKey = "";
        entry.recovery = null;
        entry.resetAllocation = true;
      }
    });
    this.queueUnknownMeshes();
    TimingTools.SetImmediate(() => {
      this.earlierAddsNotified = true;
    });
    scene.onNewMeshAddedObservable.add((mesh) => {
      // Babylon defers this notification. RTT-only proxies can already have
      // left the Scene before it arrives; removal must win over a stale add.
      // sync() may already have queued the mesh through the count check.
      if (
        !mesh.isDisposed() &&
        !this.known.has(mesh) &&
        // Until the notices queued before construction have run, only the list
        // can tell a mesh that left before this controller listened.
        (this.earlierAddsNotified ? this.listed(mesh) : scene.meshes.includes(mesh))
      ) {
        this.departed.delete(mesh);
        this.known.add(mesh);
        this.pending.add(mesh);
      }
    });
    scene.onMeshRemovedObservable.add((mesh) => {
      this.removedSinceScan++;
      this.departed.add(mesh);
      this.known.delete(mesh);
      this.pending.delete(mesh);
      // Only casters own a spatial leaf or generator render-list membership.
      if (!this.meshes.delete(mesh)) return;
      this.spatial.remove(mesh);
      this.forEachGenerator((generator) => generator.removeShadowCaster(mesh, false));
    });
    scene.onBeforeRenderObservable.add(() => {
      this.drawCalls = 0;
      this.triangles = 0;
      // Admission only: a caster walk here would be redone before any map renders.
      this.cameraPass = false;
      this.sync("admission");
    });
    scene.onBeforeCameraRenderObservable.add(() => {
      this.cameraPass = true;
    });
    // Babylon's native path notifies this once per frame before any camera
    // renders, then again per camera after its active-mesh/world-matrix
    // evaluation and just before it gathers and renders the shadow maps. Only the
    // latter decides a map, so only it walks. A frame graph draws the maps from
    // ManagedShadowsTask, whose pass refreshes after Babylon's world-matrix
    // update, so it never walks here.
    scene.onBeforeRenderTargetsRenderObservable.add(() => {
      if (scene.frameGraph || !this.cameraPass) return;
      this.cameraPass = false;
      this.refreshShadowMaps();
    });
    scene.onDisposeObservable.addOnce(() => {
      engine.onContextRestoredObservable.remove(restored);
      // Their owners still await the ledger releases through their own claims.
      for (const view of [...this.views.values()]) void this.releaseView(view).catch(() => {});
      for (const entry of this.entries.values()) entry.generator?.dispose();
      this.entries.clear();
      this.meshes.clear();
      this.pending.clear();
      this.refresh.dispose();
      this.spatial.dispose();
      reserveSceneShadows(scene, { bytes: 0, passes: 0, samplers: 0 });
      controllers.delete(scene);
    });
  }
  register(light: Light, requested: boolean, priority = 0): void {
    if (!(
      light instanceof DirectionalLight ||
      light instanceof PointLight ||
      light instanceof SpotLight
    ))
      return;
    let entry = this.entries.get(light);
    if (!entry) {
      entry = {
        light,
        requested,
        priority,
        generator: null,
        key: null,
        settings: null,
        mapSize: 0,
        reason: null,
        failedKey: "",
        recovery: null,
        resetAllocation: false,
        status: "disabled",
        standby: false,
        admittedAt: -Infinity,
        distanceSquared: 0,
        effectiveBias: [],
      };
      this.entries.set(light, entry);
      light.onDisposeObservable.addOnce(() => {
        this.entries.get(light)?.generator?.dispose();
        this.entries.delete(light);
        for (const view of this.views.values()) {
          this.dropViewMap(view, light);
          view.refused.delete(light);
        }
        markSceneReadinessDirty(this.scene);
      });
    }
    entry.requested = requested;
    entry.priority = Number.isFinite(priority) ? priority : 0;
  }
  setParticipation(mesh: AbstractMesh, value: ShadowParticipation): void {
    const previous = mesh.metadata?.slateShadowParticipation as
      ShadowParticipation | undefined;
    if (
      previous?.castShadows === value.castShadows &&
      previous?.receiveShadows === value.receiveShadows
    )
      return;
    mesh.metadata = {
      ...mesh.metadata,
      slateShadowParticipation: {
        castShadows: value.castShadows,
        receiveShadows: value.receiveShadows,
      },
    };
    this.pending.add(mesh);
    for (const child of mesh.getChildMeshes()) this.pending.add(child);
  }
  /** The admitted map; standby maps are neither rendered nor admitted. */
  generator(light: Light): ShadowGenerator | null {
    const entry = this.entries.get(light);
    return entry?.standby ? null : (entry?.generator ?? null);
  }
  /** Admitted or standby map still attached to the light, which receivers bind. */
  boundGenerator(light: Light): ShadowGenerator | null {
    return this.entries.get(light)?.generator ?? null;
  }
  /**
   * Gives `camera` (a Full Quality capture's) its own sun maps: each admitted
   * sun map is mirrored with the same kind, size, cascades and settings, keyed
   * to the camera, so materials drawn for it bind a map fitted to it as a scene
   * view there would fit one. Point and spot maps do not depend on the view and
   * stay shared. The maps follow every sync until the claim is released; each
   * reserves in the shared rendering ledger and redraws in every pass the view draws.
   */
  attachView(camera: Camera): ViewShadows {
    if (this.scene.isDisposed) return { release: () => Promise.resolve() };
    let view = this.views.get(camera);
    if (view) view.claims++;
    else {
      view = { camera, claims: 1, maps: new Map(), refused: new Map(), pending: new Set() };
      this.views.set(camera, view);
      this.syncView(view, () => this.spatial.bounds());
    }
    const claimed = view;
    let released: Promise<void> | undefined;
    return {
      release: () => (released ??= --claimed.claims > 0
        ? Promise.resolve()
        : this.releaseView(claimed)),
    };
  }
  /**
   * The map a pass drawn for `camera` binds for `light`: the view's own sun
   * map (null when it has none), or the shared point or spot map.
   */
  viewBoundGenerator(light: Light, camera: Camera): ShadowGenerator | null {
    if (light instanceof DirectionalLight) return this.views.get(camera)?.maps.get(light)?.generator ?? null;
    return this.boundGenerator(light);
  }
  /** Last completed map pass, bounded to the admitted faces/cascades. */
  effectiveBias(light: Light): readonly EffectiveShadowBias[] {
    return this.entries.get(light)?.effectiveBias ?? [];
  }
  /**
   * Refreshes admitted maps after the owning renderer updates caster transforms.
   * This is the one caster walk of a rendered frame: it runs immediately before
   * Babylon's render-once gate consumes each map, so no later change is missed.
   */
  refreshShadowMaps(): void {
    if (!this.holdsGenerator()) return;
    this.refresh.syncCasters(this.scene, this.meshes);
    // A sync("admission") skips the walk, so frozen cascade caster bounds follow it here.
    let casterBounds: ReturnType<ShadowSpatialIndex["bounds"]>;
    for (const entry of this.entries.values())
      if (entry.generator && !entry.standby) {
        if (entry.generator instanceof CascadedShadowGenerator) {
          casterBounds ??= this.spatial.bounds();
          if (casterBounds)
            entry.generator.shadowCastersBoundingInfo.reConstruct(
              casterBounds.min,
              casterBounds.max,
            );
        }
        fitLocalShadowDepth(entry.generator.getLight(), this.scene.activeCamera);
        this.refresh.apply(entry.generator);
      }
    // A view's maps draw later in this frame, from its own pass; they redraw every time.
    for (const view of this.views.values())
      for (const { generator } of view.maps.values())
        if (generator instanceof CascadedShadowGenerator) {
          casterBounds ??= this.spatial.bounds();
          if (casterBounds)
            generator.shadowCastersBoundingInfo.reConstruct(casterBounds.min, casterBounds.max);
        }
  }
  status(light: Light): ShadowLightStatus | undefined {
    return this.entries.get(light)?.status;
  }
  /** Authored request, independent of admission, visibility and global shadow enablement. */
  requestsShadow(light: Light): boolean {
    return this.entries.get(light)?.requested ?? false;
  }
  limits(): string[] {
    const limits = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.reason) limits.add(entry.reason);
      if (!entry.standby && entry.generator?.usePoissonSampling)
        limits.add(
          entry.light.needCube()
            ? "point shadows: Poisson filter fallback"
            : "shadows: Poisson filter capability fallback",
        );
    }
    return [...limits];
  }
  metrics(): { passes: number; bytes: number } {
    let passes = 0;
    let bytes = 0;
    for (const { generator, standby } of this.entries.values()) {
      if (!generator) continue;
      const count = generatorPasses(generator);
      if (!standby) passes += count;
      bytes +=
        count *
        (generator.getShadowMap()?.getSize().width ?? 0) ** 2 *
        shadowBytesPerTexel(this.scene.getEngine());
    }
    return { passes, bytes };
  }
  /** Whether the Scene lists the mesh; only a mesh that has left needs the search. */
  private listed(mesh: AbstractMesh): boolean {
    return !this.departed.has(mesh) || this.scene.meshes.includes(mesh);
  }
  private queueUnknownMeshes(): void {
    for (const mesh of this.scene.meshes) {
      if (this.known.has(mesh)) continue;
      this.departed.delete(mesh);
      this.known.add(mesh);
      this.pending.add(mesh);
    }
    this.knownMeshCount = this.scene.meshes.length;
    this.removedSinceScan = 0;
  }
  diagnostics(lights: readonly Light[] = this.scene.lights) {
    return lights.map((light) => shadowLightRow(light, this.entries.get(light)));
  }
  /**
   * "full" also walks every caster and re-applies each map's refresh policy.
   * "admission" leaves both to refreshShadowMaps(), which runs before every map
   * render; it still walks when it must read caster state itself (a new map or
   * a changed directional distance).
   */
  sync(mode: "full" | "admission" = "full"): void {
    const scene = this.scene;
    if (scene.isDisposed) return;
    syncDirectionalLightPolicy(scene);
    // Babylon pushes a mesh synchronously but notifies it on a later task, and
    // a frame can render first. Removals notify synchronously, so a length
    // that is not the last scan minus those removals means an unnotified add.
    if (scene.meshes.length !== this.knownMeshCount - this.removedSinceScan)
      this.queueUnknownMeshes();
    const hadPending = this.pending.size > 0;
    for (const mesh of this.pending) {
      if (mesh.isDisposed() || !this.listed(mesh)) continue;
      // Shadow maps draw the selected level through its master caster, and a
      // level mirrors its master's receiveShadows.
      if (mesh.isBlocked) {
        if (this.meshes.delete(mesh)) {
          this.spatial.remove(mesh);
          this.forEachGenerator((generator) => generator.removeShadowCaster(mesh, false));
        }
        continue;
      }
      if (!participatesInShadows(mesh)) {
        mesh.receiveShadows = false;
        if (this.meshes.delete(mesh)) {
          this.spatial.remove(mesh);
          this.forEachGenerator((generator) => generator.removeShadowCaster(mesh, false));
        }
        continue;
      }
      const participation = authoredShadowParticipation(mesh);
      mesh.receiveShadows = participation.receiveShadows !== false;
      if (participation.castShadows === false || neverCastsShadows(mesh)) {
        if (this.meshes.delete(mesh)) {
          this.spatial.remove(mesh);
          this.forEachGenerator((generator) => generator.removeShadowCaster(mesh, false));
        }
        continue;
      }
      this.meshes.add(mesh);
      this.spatial.add(mesh);
      partitionShadowGeometry(mesh);
      this.forEachGenerator((generator) => generator.addShadowCaster(mesh, false));
    }
    this.pending.clear();
    // Caster participation and receiveShadows changed material defines or map
    // membership; cached strict readiness no longer applies.
    if (hadPending) markSceneReadinessDirty(scene);
    // Without a map nothing reads caster state, so the walk waits for the first
    // allocation; kept snapshots make the late walk report only real changes.
    const holding = this.holdsGenerator();
    let castersCurrent = holding && mode === "full";
    if (castersCurrent) this.refresh.syncCasters(scene, this.meshes);
    else if (!holding) this.refresh.dropRemovedCasters(this.meshes);
    let casterBounds = castersCurrent ? this.spatial.bounds() : undefined;
    const currentCasters = () => {
      if (castersCurrent) return;
      castersCurrent = true;
      this.refresh.syncCasters(scene, this.meshes);
      casterBounds = this.spatial.bounds();
    };
    const state = sceneRenderingSettings(scene);
    const requested = state.shadows;
    const engineSupportsCascades = scene.getEngine()._features.supportCSM;
    // Babylon 9.29's constructor also checks its static last-created-engine
    // capability. Match both gates before admission; a rejected CSM constructor
    // cannot be recovered by trying smaller cascaded maps.
    const constructorSupportsCascades = CascadedShadowGenerator.IsSupported;
    const cascadeFallback =
      requested.cascades <= 1
        ? null
        : !engineSupportsCascades
          ? "cascades: device capability; using single-map directional shadows"
          : !constructorSupportsCascades
            ? "cascades: Babylon constructor capability; using single-map directional shadows"
            : null;
    const { settings } = effectiveShadowSettings(
      requested,
      engineSupportsCascades && constructorSupportsCascades,
      state.mode,
    );
    const camera = scene.activeCamera;
    camera?.getViewMatrix();
    const cameraChanged = camera !== this.selectionCamera;
    this.selectionCamera = camera;
    const selectionTime = performance.now();
    const allocationRequestKey = (entry: Entry) =>
      JSON.stringify([
        entry.light instanceof DirectionalLight
          ? settings.mapSize
          : settings.localMapSize,
        entry.light.needCube(),
        entry.light instanceof DirectionalLight ? settings.cascades : 1,
        settings.profile,
      ]);
    const candidates = [...this.entries.values()].filter((entry) => {
      entry.status = "disabled";
      entry.reason = null;
      // Healthy entries build no request key.
      if (entry.recovery && entry.recovery.requestKey !== allocationRequestKey(entry))
        entry.recovery = null;
      if (isDirectionalLightExcluded(entry.light)) {
        entry.status = "non-illuminating";
        return false;
      }
      if (!entry.light.isEnabled() || entry.light.intensity <= 0) return false;
      if (!entry.requested) {
        entry.status = "not-requested";
        return false;
      }
      if (!settings.enabled) {
        entry.status = "shadows-disabled";
        return false;
      }
      if (entry.failedKey !== "" && entry.failedKey === allocationRequestKey(entry)) {
        entry.status = "allocation-failed";
        entry.reason =
          "shadow allocation failed at minimum size; awaiting settings change or context recovery";
        return false;
      }
      entry.distanceSquared = 0;
      if (camera && !(entry.light instanceof DirectionalLight)) {
        // Shadow-limited lights may never bind a material. Refresh their
        // parents explicitly rather than ranking a stale transformedPosition.
        entry.light.parent?.computeWorldMatrix(true);
        entry.light.computeTransformedInformation();
        entry.distanceSquared = Vector3.DistanceSquared(
          entry.light.parent ? entry.light.getAbsolutePosition() : entry.light.position,
          camera.globalPosition,
        );
      }
      if (camera && !(entry.light instanceof DirectionalLight) &&
        entry.distanceSquared > (settings.distance + entry.light.range) ** 2) {
        entry.status = "outside-relevant-area";
        return false;
      }
      entry.status = "budget-limited";
      return true;
    });
    // Nearest relevant lights win independently of brightness. A short minimum
    // residency and squared-distance bonus stabilize camera boundaries without
    // preventing an authored-priority change or a newly possessed camera.
    const incumbent = (entry: Entry) => Boolean(entry.generator && !entry.standby && !cameraChanged);
    const resident = (entry: Entry) => incumbent(entry) &&
      selectionTime - entry.admittedAt < SHADOW_MIN_RESIDENCY_MS;
    const distance = (entry: Entry) =>
      entry.distanceSquared / (incumbent(entry) ? 1.15 : 1);
    candidates.sort(
      (a, b) =>
        b.priority - a.priority ||
        Number(resident(b)) - Number(resident(a)) ||
        distance(a) - distance(b) ||
        a.light.uniqueId - b.light.uniqueId,
    );
    const caps = scene.getEngine().getCaps();
    const profile = SHADOW_CAPACITY_PROFILES[settings.profile];
    const other = otherShadowReservations(scene);
    const byteBudget = Math.max(
      0,
      Math.min(
        profile.byteBudget,
        ENGINE_SHADOW_BUDGET.bytes - other.bytes,
        availableSceneShadowBytes(scene),
      ),
    );
    const passBudget = Math.max(
      0,
      Math.min(profile.passes, ENGINE_SHADOW_BUDGET.passes - other.passes),
    );
    const samplerBudget = remainingShadowSamplers(scene);
    const bytesPerTexel = shadowBytesPerTexel(scene.getEngine());
    const admitted: ShadowCost = { bytes: 0, passes: 0, samplers: 0 };
    const reserveLocalMaps =
      settings.maxLocalLights > 0 &&
      candidates.some((entry) => !(entry.light instanceof DirectionalLight));
    // Reserve the single sun before local maps regardless of local priorities.
    candidates.sort(
      (a, b) =>
        Number(b.light instanceof DirectionalLight) -
        Number(a.light instanceof DirectionalLight),
    );
    let plannedLocal = 0;
    let plannedPasses = 0;
    let plannedSamplers = 0;
    let remainingLocalFaces = 0;
    const planned = candidates.filter((entry) => {
      const directional = entry.light instanceof DirectionalLight;
      const passes = admissionPasses(entry.light, settings);
      const samplers = admissionSamplers(entry.light, settings);
      entry.reason =
        !directional && plannedLocal >= settings.maxLocalLights
          ? "local light capacity"
          : plannedPasses + passes > passBudget
            ? "shadow face/pass budget"
            : plannedSamplers + samplers > samplerBudget
              ? "material sampler headroom"
              : null;
      if (entry.reason) return false;
      plannedPasses += passes;
      plannedSamplers += samplers;
      if (!directional) {
        plannedLocal += 1;
        remainingLocalFaces += passes;
      }
      return true;
    });
    // Admitted totals never exceed the planned ones, so every planned entry still
    // fits the local, pass and sampler budgets; only memory can reject it here.
    for (const entry of planned) {
      const directional = entry.light instanceof DirectionalLight;
      const passes = admissionPasses(entry.light, settings);
      const samplers = admissionSamplers(entry.light, settings);
      const requestedSize = directional
        ? settings.mapSize
        : settings.localMapSize;
      let mapSize = Math.min(requestedSize, caps.maxTextureSize);
      if (entry.light.needCube())
        mapSize = Math.min(mapSize, caps.maxCubemapTextureSize);
      if (entry.recovery) mapSize = Math.min(mapSize, entry.recovery.mapSize);
      if (
        entry.generator &&
        !entry.resetAllocation &&
        entry.settings?.profile === settings.profile &&
        (directional ? entry.settings.mapSize : entry.settings.localMapSize) ===
          requestedSize
      )
        mapSize = Math.min(
          mapSize,
          entry.generator.getShadowMap()?.getSize().width ?? mapSize,
        );
      mapSize = 2 ** Math.floor(Math.log2(mapSize));
      // CSM constructs four layers before applying an authored lower count.
      // Admit that temporary peak as well as the final attachments.
      const peakPasses = directional && settings.cascades > 1 ? 4 : passes;
      const availableBytes = Math.min(
        byteBudget - admitted.bytes,
        directional
          ? reserveLocalMaps
            ? byteBudget / 2
            : byteBudget
          : ((byteBudget - admitted.bytes) * passes) / remainingLocalFaces,
      );
      if (!directional) remainingLocalFaces -= passes;
      while (
        mapSize >= 256 &&
        peakPasses * mapSize ** 2 * bytesPerTexel > availableBytes
      )
        mapSize /= 2;
      if (mapSize < 256) {
        entry.reason = "shadow attachment memory budget";
        continue;
      }
      entry.mapSize = mapSize;
      entry.resetAllocation = false;
      entry.reason = entry.recovery
        ? "shadow map reduced after allocation failure"
        : mapSize < requestedSize
          ? "shadow map reduced by memory or texture capability"
          : null;
      entry.status = "active";
      admitted.bytes += peakPasses * mapSize ** 2 * bytesPerTexel;
      admitted.passes += passes;
      admitted.samplers += samplers;
    }
    // CSM freezes caster bounds; retained owners refresh them every sync.
    const maintainCascades = (entry: Entry) => {
      if (!(entry.generator instanceof CascadedShadowGenerator)) return;
      entry.generator.shadowMaxZ = settings.distance;
      if (casterBounds)
        entry.generator.shadowCastersBoundingInfo.reConstruct(
          casterBounds.min,
          casterBounds.max,
        );
    };
    const applyCascadeFallback = (entry: Entry) => {
      if (entry.light instanceof DirectionalLight && cascadeFallback)
        entry.reason = entry.reason
          ? `${cascadeFallback}; ${entry.reason}`
          : cascadeFallback;
    };
    // Only map moves and standby retention compare serialized settings.
    let serializedSettings: string | undefined;
    const settingsKey = () => (serializedSettings ??= JSON.stringify(settings));
    const release = (entry: Entry) => {
      if (entry.generator) {
        entry.generator.dispose();
        markSceneReadinessDirty(scene);
        invalidateShadowReceiverHandoffs(scene);
      }
      entry.generator = null;
      entry.standby = false;
      entry.effectiveBias.length = 0;
      entry.key = null;
    };
    // Release incompatible and retired maps before reserving/constructing their
    // replacements; old and new sets must never overlap outside this envelope.
    // A local map that only lost camera admission stays allocated for reuse.
    const donors: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "active" && entry.generator &&
        matchesAllocationKey(entry.key, entry.mapSize, entry.light, settings.cascades)) {
        if (entry.standby) {
          entry.standby = false;
          entry.admittedAt = selectionTime;
          this.neutralUntilRendered(entry.generator);
        }
        continue;
      }
      if (entry.status !== "active" && entry.generator instanceof ReusableShadowGenerator &&
        !entry.resetAllocation)
        donors.push(entry);
      else release(entry);
    }
    // Hand a retained map to a same-kind winner instead of constructing one.
    // Farther donors are least likely to return.
    donors.sort((a, b) => b.distanceSquared - a.distanceSquared);
    for (const entry of planned) {
      if (entry.status !== "active" || entry.generator || entry.light instanceof DirectionalLight)
        continue;
      const index = donors.findIndex((donor) =>
        matchesAllocationKey(donor.key, entry.mapSize, entry.light, settings.cascades) &&
        (donor.generator as ReusableShadowGenerator).canMoveTo(entry.light as LocalShadowLight));
      if (index < 0) continue;
      const [donor] = donors.splice(index, 1) as [Entry];
      const generator = donor.generator as ReusableShadowGenerator;
      generator.moveTo(entry.light as LocalShadowLight);
      // Same-kind lights exchange shader light indices, so receivers keep their
      // defines and effects. Otherwise dirty them as construction/disposal would.
      if (JSON.stringify(donor.settings) !== settingsKey() ||
        !exchangeShadowReceivers(scene, donor.light, entry.light, generator)) {
        invalidateShadowReceiverHandoffs(scene);
        donor.light._markMeshesAsLightDirty();
        entry.light._markMeshesAsLightDirty();
        markSceneReadinessDirty(scene);
      }
      entry.generator = generator;
      entry.key = donor.key;
      // The retained-owner path compares against the settings this map last applied.
      entry.settings = donor.settings;
      entry.standby = false;
      entry.failedKey = "";
      entry.admittedAt = selectionTime;
      entry.effectiveBias.length = 0;
      donor.generator = null;
      donor.standby = false;
      donor.key = null;
      donor.effectiveBias.length = 0;
      this.slots.get(generator)!.entry = entry;
      this.neutralUntilRendered(generator);
    }
    // Remaining donors keep their receiver defines on standby while the pool,
    // memory and sampler budgets allow; authored, eligibility and settings
    // changes still release immediately. Clustered Forward moves an unshadowed
    // light into the cluster instead.
    const clustered = hasClusteredLightPolicy(scene);
    let pooled = 0;
    for (const entry of this.entries.values())
      if (entry.status === "active" && !(entry.light instanceof DirectionalLight)) pooled++;
    const standby: ShadowCost = { bytes: 0, passes: 0, samplers: 0 };
    for (const entry of donors.reverse()) {
      const generator = entry.generator!;
      const bytes = generatorPasses(generator) * entry.mapSize ** 2 * bytesPerTexel;
      const samplers = admissionSamplers(entry.light, settings);
      if (
        clustered ||
        (entry.status !== "outside-relevant-area" && entry.status !== "budget-limited") ||
        JSON.stringify(entry.settings) !== settingsKey() ||
        pooled >= settings.maxLocalLights ||
        admitted.bytes + standby.bytes + bytes > byteBudget ||
        admitted.samplers + standby.samplers + samplers > samplerBudget
      ) {
        release(entry);
        continue;
      }
      pooled++;
      standby.bytes += bytes;
      standby.samplers += samplers;
      if (entry.standby) continue;
      entry.standby = true;
      entry.effectiveBias.length = 0;
      generator.setDarkness(NEUTRAL_DARKNESS);
      this.slots.get(generator)!.guard = false;
      // A continuous caster would otherwise keep redrawing the neutral map.
      const map = generator.getShadowMap();
      if (map && map.refreshRate !== RenderTargetTexture.REFRESHRATE_RENDER_ONCE)
        map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    }
    reserveSceneShadows(scene, {
      bytes: admitted.bytes + standby.bytes,
      passes: admitted.passes,
      samplers: admitted.samplers + standby.samplers,
    });
    // One scene-wide light invalidation covers every retained generator's defines.
    let materialsDirty = false;
    for (const entry of this.entries.values()) {
      if (entry.status !== "active") continue;
      const directionalLight = entry.light instanceof DirectionalLight;
      let mapSize = entry.mapSize;
      const previousSettings = entry.settings;
      entry.settings = settings;
      if (entry.generator) {
        this.applySettings(entry.generator, settings);
        // Only CSM emits the fade define; only the sun uses automatic bias.
        if (!materialsDirty && ((entry.generator instanceof CascadedShadowGenerator &&
            previousSettings?.fadeFraction !== settings.fadeFraction) ||
            (directionalLight && previousSettings?.autoBias !== settings.autoBias))) {
          materialsDirty = true;
          scene.markAllMaterialsAsDirty(Material.LightDirtyFlag);
          markSceneReadinessDirty(scene);
          invalidateShadowReceiverHandoffs(scene);
        }
        maintainCascades(entry);
        if (
          entry.light instanceof DirectionalLight &&
          !(entry.generator instanceof CascadedShadowGenerator)
        ) {
          if (previousSettings?.distance !== settings.distance) {
            currentCasters();
            configureDirectionalShadowProjection(
              entry.light,
              scene,
              settings.distance,
              mapSize,
              this.spatial,
            );
          }
          entry.light.forceProjectionMatrixCompute();
        }
        continue;
      }
      // The first map reads caster state, bounds and spatial queries from here on.
      currentCasters();
      // Halving is bounded by the normalized 4096 maximum and 256 floor. Failed
      // attempts are fully released before smaller maps reuse the reservation.
      while (mapSize >= 256) {
        const cleanup = shadowAllocationCheckpoint(scene);
        try {
          const generator = this.createGenerator(entry, mapSize, settings, null, casterBounds);
          entry.generator = generator;
          markSceneReadinessDirty(scene);
          invalidateShadowReceiverHandoffs(scene);
          entry.admittedAt = selectionTime;
          entry.mapSize = mapSize;
          entry.key = allocationKey(mapSize, entry.light, settings.cascades);
          entry.failedKey = "";
          if (entry.recovery)
            entry.reason = "shadow map reduced after allocation failure";
          break;
        } catch (error) {
          const requestKey = allocationRequestKey(entry);
          const reason = entry.reason;
          entry.failedKey = requestKey;
          entry.status = "allocation-failed";
          entry.reason =
            "shadow allocation failed at minimum size; awaiting settings change or context recovery";
          const failures: unknown[] = [error];
          try {
            cleanup(entry.light.getShadowGenerator());
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          if (failures.length > 1) {
            entry.reason = "shadow allocation cleanup failed";
            throw new AggregateError(
              failures,
              "Shadow allocation and resource cleanup failed",
              { cause: error },
            );
          }
          // Standby maps are optional reuse; free them before reducing an admitted map.
          let reclaimed = false;
          for (const other of this.entries.values()) {
            if (!other.standby) continue;
            release(other);
            reclaimed = true;
          }
          if (reclaimed) {
            entry.failedKey = "";
            entry.status = "active";
            entry.reason = reason;
            continue;
          }
          mapSize /= 2;
          entry.recovery = {
            requestKey,
            mapSize,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (entry.generator) entry.status = "active";
    }
    // Failed constructors own no allocation. Retain conservative CSM creation
    // headroom for live generators so another client cannot consume it mid-sync.
    const live: ShadowCost = { bytes: 0, passes: 0, samplers: 0 };
    for (const entry of this.entries.values()) {
      if (!entry.generator) continue;
      applyCascadeFallback(entry);
      const cascaded = entry.generator instanceof CascadedShadowGenerator;
      const passes = generatorPasses(entry.generator);
      live.bytes +=
        (cascaded ? 4 : passes) * entry.mapSize ** 2 * bytesPerTexel;
      if (!entry.standby) live.passes += passes;
    }
    reserveSceneShadows(scene, live);
    for (const entry of this.entries.values())
      if (entry.generator && !entry.standby) {
        fitLocalShadowDepth(entry.generator.getLight(), scene.activeCamera);
        // Without a walk this sync, apply() would compare stale caster state.
        if (castersCurrent) this.refresh.apply(entry.generator);
      }
    // Views mirror the maps admitted above, after their releases and replacements.
    this.viewSettings = settings;
    if (this.views.size) {
      const bounds = () => {
        currentCasters();
        return casterBounds;
      };
      for (const view of this.views.values()) this.syncView(view, bounds);
    }
  }
  /**
   * Constructs one admitted map with every hook the controller relies on:
   * receiver defines, automatic bias, culled caster lists and draw counters.
   * `view` keys a sun map to a view's camera (attachView); null is the scene
   * view's map, which receivers of every other camera bind.
   */
  private createGenerator(
    entry: Entry,
    mapSize: number,
    settings: ShadowSettings,
    view: Camera | null,
    casterBounds: ReturnType<ShadowSpatialIndex["bounds"]> | undefined,
  ): ShadowGenerator {
    const scene = this.scene;
    const directionalLight = entry.light instanceof DirectionalLight;
    const validateAllocation = beginShadowAllocationValidation(
      scene.getEngine(),
    );
    // A view's map is keyed to its camera; the scene view's to the null camera.
    const camera = view ?? undefined;
    const generator =
      directionalLight && settings.cascades > 1
        ? new CascadedShadowGenerator(
            mapSize,
            entry.light as DirectionalLight,
            undefined,
            camera,
          )
        : directionalLight
          ? new ShadowGenerator(mapSize, entry.light, undefined, camera)
          : new ReusableShadowGenerator(mapSize, entry.light as LocalShadowLight);
    const slot = { entry, guard: false, view: view !== null };
    this.slots.set(generator, slot);
    if (generator instanceof CascadedShadowGenerator) {
      generator.numCascades = settings.cascades;
      generator.stabilizeCascades = true;
      generator.lambda = 0.7;
      generator.shadowMaxZ = settings.distance;
      generator.cascadeBlendPercentage = 0.05;
      generator.autoCalcDepthBounds = false;
      generator.depthClamp = true;
      generator.freezeShadowCastersBoundingInfo = true;
      if (casterBounds)
        generator.shadowCastersBoundingInfo.reConstruct(
          casterBounds.min,
          casterBounds.max,
        );
    } else if (entry.light instanceof DirectionalLight) {
      // The light's one builder fits each of its generators to its own camera.
      if (!view)
        configureDirectionalShadowProjection(
          entry.light,
          scene,
          settings.distance,
          mapSize,
          this.spatial,
        );
      trackDirectionalShadowFit(generator);
    }
    this.applySettings(generator, settings);
    const prepare = generator.prepareDefines.bind(generator);
    generator.prepareDefines = (defines, lightIndex) => {
      prepare(defines, lightIndex);
      defines[`SLATE_SHADOW_AUTO${lightIndex}`] =
        directionalLight && slot.entry.settings!.autoBias && generator.usePercentageCloserFiltering;
      if (generator instanceof CascadedShadowGenerator)
        defines[`SLATE_SHADOW_FADE${lightIndex}`] = slot.entry.settings!.fadeFraction;
      defines.rebuild();
    };
    validateAllocation(generator);
    const map = generator.getShadowMap();
    // The new map's list is empty and the casters are unique, so skip
    // addShadowCaster's per-mesh indexOf scan. The constructor has already
    // light-dirtied every mesh that can bind this light's shadow defines.
    if (map) map.renderList = Array.from(this.meshes);
    let drawsBefore = 0;
    let indicesBefore = 0;
    map?.onBeforeBindObservable.add(() => {
      drawsBefore = readEngineDrawCalls(scene.getEngine());
      indicesBefore = scene.getActiveIndices();
    });
    map?.onAfterUnbindObservable.add(() => {
      this.drawCalls += Math.max(
        0,
        readEngineDrawCalls(scene.getEngine()) - drawsBefore,
      );
      this.triangles +=
        Math.max(0, scene.getActiveIndices() - indicesBefore) / 3;
    });
    if (generator instanceof CascadedShadowGenerator)
      map?.onBeforeBindObservable.add(
        () => generator.splitFrustum(),
        -1,
        true,
      );
    // Registered after Babylon 9.29's native observer: single-map view /
    // projection and the CSM layer are current, caster uniforms are not
    // bound yet. Never derive from the previous frame in applySettings.
    let preparedBias: EffectiveShadowBias | null = null;
    let clearedForDraw = false;
    // The resolver reads its input synchronously; each map reuses one.
    const biasInput: DirectionalShadowBiasInput = {
      width: 0, height: 0, depth: 0, mapWidth: 0, mapHeight: 0, filter: "none", filterQuality: "low",
      poissonRadiusTexels: 0, depthClamp: false, authoredDepthBias: 0, authoredNormalBias: 0,
    };
    map?.onBeforeRenderObservable.add((layer) => {
      clearedForDraw = false;
      const settings = slot.entry.settings!;
      const automatic = settings.autoBias && directionalLight;
      const projection = generator instanceof CascadedShadowGenerator
        ? generator.getCascadeProjectionMatrix(layer)
        : generator.projectionMatrix;
      const size = map.getSize();
      const matrix = projection?.m;
      biasInput.width = automatic && scene.activeCamera && matrix ? Math.abs(2 / matrix[0]) : 0;
      biasInput.height = automatic && scene.activeCamera && matrix ? Math.abs(2 / matrix[5]) : 0;
      biasInput.depth = matrix ? Math.abs((scene.getEngine().isNDCHalfZRange ? 1 : 2) / matrix[10]) : 0;
      biasInput.mapWidth = size.width;
      biasInput.mapHeight = size.height;
      biasInput.filter = generator.usePercentageCloserFiltering ? "pcf"
        : generator.useContactHardeningShadow ? "pcss"
          : generator.usePoissonSampling ? "poisson" : "none";
      biasInput.filterQuality = generator.filteringQuality === ShadowGenerator.QUALITY_HIGH ? "high"
        : generator.filteringQuality === ShadowGenerator.QUALITY_MEDIUM ? "medium" : "low";
      biasInput.poissonRadiusTexels = generator.blurScale;
      biasInput.depthClamp = generator instanceof CascadedShadowGenerator && generator.depthClamp;
      biasInput.authoredDepthBias = settings.depthBias;
      biasInput.authoredNormalBias = settings.normalBias;
      const effective = resolveDirectionalShadowBias(biasInput);
      generator.bias = effective.bias;
      generator.normalBias = effective.normalBias;
      const record = preparedBias ??= {
        layer, cameraId: null, renderId: -1, depthBias: 0, normalBias: 0, worldTexelSize: 0, depthScale: 0,
        mode: "manual",
      };
      record.layer = layer;
      record.depthBias = effective.bias;
      record.cameraId = (generator.camera ?? scene.activeCamera)?.id ?? null;
      record.renderId = scene.getRenderId();
      record.normalBias = effective.normalBias;
      record.worldTexelSize = effective.worldTexelSize;
      record.depthScale = effective.depthScale;
      record.mode = !settings.autoBias ? "manual" : automatic ? "directional-auto" : "local-authored";
    });
    // Native readiness probes emit before/after-render without drawing.
    // Only actual RTT passes (including empty maps and snapshot rendering)
    // emit clear before their successful after-render notification. Keep
    // prepared values private until that pass has finished, so evidence
    // cannot relabel a cached map after another camera's readiness probe.
    map?.onClearObservable.add(() => { clearedForDraw = true; });
    map?.onAfterRenderObservable.add((face) => {
      if (!clearedForDraw) return;
      clearedForDraw = false;
      // A moved or resumed map samples neutrally until its last face is redrawn.
      if (slot.guard && face === (map.isCube ? 5 : 0)) {
        slot.guard = false;
        if (!slot.entry.standby) generator.setDarkness(0);
      }
      // Effective bias reports the scene view's maps.
      if (!preparedBias || slot.view) return;
      const record = slot.entry.effectiveBias[preparedBias.layer] ??= { ...preparedBias };
      Object.assign(record, preparedBias);
      record.depthBias = generator.bias;
      record.normalBias = generator.normalBias;
    });
    let activePlanes: Plane[] | null = null;
    // Babylon consumes each custom list synchronously, so every map reuses
    // its planes and caster list; upstream views the same side/far planes.
    const planes = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
    const upstream = planes.slice(1);
    const casters: AbstractMesh[] = [];
    if (map)
      map.getCustomRenderList = (layer) => {
        const transform =
          generator instanceof CascadedShadowGenerator
            ? generator.getCascadeTransformMatrix(layer)
            : generator.getTransformMatrix();
        if (!transform) return null;
        Frustum.GetPlanesToRef(transform, planes);
        activePlanes =
          directionalLight && slot.entry.settings!.filter === "pcf"
            ? upstream
            : planes;
        this.spatial.queryPlanes(activePlanes, casters);
        // The index never plane-culls deforming casters. A local map ends
        // at its light's range, so anything that cannot reach it draws nothing.
        const light = generator.getLight();
        if (!directionalLight && "range" in light && Number.isFinite(light.range)) {
          const position = (light as LocalShadowLight).getAbsolutePosition();
          let kept = 0;
          for (const mesh of casters)
            if (casterWithinShadowRange(mesh, position, light.range)) casters[kept++] = mesh;
          casters.length = kept;
        }
        return casters;
      };
    generator.customAllowRendering = (part) => {
      if (hasDeformingShadowBounds(part.getMesh())) return true;
      if (!activePlanes || part.getMesh().subMeshes.length < 2)
        return true;
      const box = part.getBoundingInfo()?.boundingBox;
      if (!box) return true;
      for (const plane of activePlanes) {
        const n = plane.normal;
        if (
          n.x * (n.x >= 0 ? box.maximumWorld.x : box.minimumWorld.x) +
            n.y * (n.y >= 0 ? box.maximumWorld.y : box.minimumWorld.y) +
            n.z * (n.z >= 0 ? box.maximumWorld.z : box.minimumWorld.z) +
            plane.d <
          0
        )
          return false;
      }
      return true;
    };
    return generator;
  }
  /** Every allocated map: the scene view's (admitted or standby) and every view's own. */
  private forEachGenerator(action: (generator: ShadowGenerator) => void): void {
    for (const entry of this.entries.values()) if (entry.generator) action(entry.generator);
    for (const view of this.views.values()) for (const map of view.maps.values()) action(map.generator);
  }
  /**
   * Mirrors every admitted sun map for `view` and drops mirrors of replaced or
   * released maps. Settings that keep the allocation apply in place, as they do
   * to the scene map. Point and spot maps stay shared.
   */
  private syncView(
    view: View,
    casterBounds: () => ReturnType<ShadowSpatialIndex["bounds"]> | undefined,
  ): void {
    const settings = this.viewSettings;
    for (const [light, map] of view.maps) {
      const entry = this.entries.get(light);
      if (!settings || entry?.status !== "active" || entry.standby || entry.generator !== map.mirrors)
        this.dropViewMap(view, light);
    }
    for (const [light, refused] of view.refused)
      if (this.entries.get(light)?.generator !== refused) view.refused.delete(light);
    if (!settings) return;
    for (const entry of this.entries.values()) {
      const source = entry.generator;
      if (!(entry.light instanceof DirectionalLight) || entry.status !== "active" || !source || entry.standby)
        continue;
      const existing = view.maps.get(entry.light);
      if (existing) {
        this.applySettings(existing.generator, settings);
        // Babylon checks the distance against the view's own clip range, as a camera there would.
        if (existing.generator instanceof CascadedShadowGenerator) existing.generator.shadowMaxZ = settings.distance;
        continue;
      }
      if (view.refused.get(entry.light) !== source) this.createViewMap(view, entry, source, settings, casterBounds());
    }
  }
  /**
   * The scene map's allocation for the view's camera, reserved in the shared
   * rendering ledger first. A refused reservation halves the map like admission
   * does; refused at every size, the view draws its sun unshadowed and retries
   * once the scene map changes.
   */
  private createViewMap(
    view: View,
    entry: Entry,
    source: ShadowGenerator,
    settings: ShadowSettings,
    casterBounds: ReturnType<ShadowSpatialIndex["bounds"]> | undefined,
  ): void {
    const scene = this.scene;
    const engine = scene.getEngine();
    const cascaded = source instanceof CascadedShadowGenerator;
    // Mirror the scene map's kind even if the settings moved on since it was built.
    if (cascaded !== settings.cascades > 1) return;
    const layers = cascaded ? source.numCascades : 1;
    const bytesPerTexel = shadowBytesPerTexel(engine);
    for (let mapSize = entry.mapSize; mapSize >= 256; mapSize /= 2) {
      // CSM constructs four layers before applying the authored count.
      const lease = beginManagedRenderAllocation(engine, (cascaded ? 4 : layers) * mapSize ** 2 * bytesPerTexel);
      if (!lease) continue;
      const cleanup = shadowAllocationCheckpoint(scene);
      try {
        const generator = this.createGenerator(entry, mapSize, settings, view.camera, casterBounds);
        lease.commit([{ handle: generator.getShadowMap()!, bytes: layers * mapSize ** 2 * bytesPerTexel, category: "shadow" }]);
        view.maps.set(entry.light, { generator, mirrors: source, lease });
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
        this.trackViewRelease(view, releaseManagedRenderLeaseAfterDisposal(engine, lease));
      }
    }
    view.refused.set(entry.light, source);
    console.warn(`[render] A Full Quality capture draws "${entry.light.name}" without shadows: its own shadow map does not fit the shared rendering budget.`);
  }
  /** Disposes a view's map; its ledger charge goes after the WebGPU destruction drain. */
  private dropViewMap(view: View, light: Light): void {
    const map = view.maps.get(light);
    if (!map) return;
    view.maps.delete(light);
    try {
      map.generator.dispose();
    } catch (error) {
      // Uncertain cleanup keeps the reservation.
      this.trackViewRelease(view, Promise.reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    this.trackViewRelease(view, releaseManagedRenderLeaseAfterDisposal(this.scene.getEngine(), map.lease));
  }
  private trackViewRelease(view: View, release: Promise<void>): void {
    view.pending.add(release);
    // A failed release stays pending, so the claim's release reports it.
    void release.then(() => view.pending.delete(release), () => {});
  }
  private releaseView(view: View): Promise<void> {
    if (this.views.get(view.camera) === view) this.views.delete(view.camera);
    for (const light of [...view.maps.keys()]) this.dropViewMap(view, light);
    view.refused.clear();
    return Promise.all([...view.pending]).then(() => {});
  }
  /** Caster state only drives allocated maps (admitted or standby) and their spatial queries. */
  private holdsGenerator(): boolean {
    for (const entry of this.entries.values()) if (entry.generator) return true;
    return false;
  }
  /** Keep a moved or resumed map from sampling stale depth before it redraws. */
  private neutralUntilRendered(generator: ShadowGenerator): void {
    generator.setDarkness(NEUTRAL_DARKNESS);
    this.slots.get(generator)!.guard = true;
    generator.getShadowMap()?.resetRefreshCounter();
  }
  private applySettings(
    generator: ShadowGenerator,
    settings: ShadowSettings,
  ): void {
    generator.filter =
      settings.filter === "pcss"
        ? ShadowGenerator.FILTER_PCSS
        : ShadowGenerator.FILTER_PCF;
    generator.contactHardeningLightSizeUVRatio = settings.softness;
    generator.filteringQuality =
      settings.filterQuality === "high"
        ? ShadowGenerator.QUALITY_HIGH
        : settings.filterQuality === "medium"
          ? ShadowGenerator.QUALITY_MEDIUM
          : ShadowGenerator.QUALITY_LOW;
    generator.bias = settings.depthBias;
    generator.normalBias = settings.normalBias;
    generator.frustumEdgeFalloff = 0;
  }
}

/** Internal renderer lookup; observing a scene never installs a second owner. */
export function findSceneShadowController(scene: Scene): SceneShadowController | undefined {
  return controllers.get(scene);
}

/** Per-light rows for a read path; a Scene without an owner lists every light unsupported. */
export function shadowLightDiagnostics(
  scene: Scene,
  controller?: SceneShadowController,
) {
  return controller?.diagnostics() ?? scene.lights.map((light) => shadowLightRow(light));
}

export function sceneShadowController(scene: Scene): SceneShadowController {
  let controller = controllers.get(scene);
  if (!controller) {
    controller = new SceneShadowController(scene);
    controllers.set(scene, controller);
  }
  return controller;
}
