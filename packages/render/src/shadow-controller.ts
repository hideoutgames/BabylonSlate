import {
  syncDirectionalLightPolicy,
  isDirectionalLightExcluded,
  isForwardLightExcluded,
  lightsInCreationOrder,
} from "./light-policy";
import {
  CascadedShadowGenerator,
  DirectionalLight,
  PointLight,
  SpotLight,
  Material,
  RenderTargetTexture,
  type ShadowGenerator,
  type AbstractMesh,
  type Light,
  type Scene,
  type Camera,
} from "@babylonjs/core";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { TimingTools } from "@babylonjs/core/Misc/timingTools";
import {
  effectiveShadowSettings,
  type ShadowSettings,
} from "@haptic/core";
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
  neverCastsShadows,
  participatesInShadows,
  type ShadowParticipation,
} from "./shadow-mesh-policy";
import { ShadowSpatialIndex } from "./shadow-spatial-index";
import "./shadow-shader";
import { partitionShadowGeometry } from "./shadow-geometry-partitions";
import { configureDirectionalShadowProjection } from "./directional-shadow-projection";
import { ShadowMapRefresh } from "./shadow-map-refresh";
import { awaitsFirstDraw, setAwaitingFirstDraw } from "./shadow-first-draw";
import { onMeshRevealed } from "./reveal-pending";
import { forgetCasterRequests, setShadowCasterReach } from "./shadow-caster-warm";
import {
  availableSceneShadowBytes,
  reserveSceneShadows,
  shadowBytesPerTexel,
  type ShadowCost,
} from "./shadow-admission";
import {
  admissionSamplers,
  allocationKey,
  allocationRequestKey,
  generatorPasses,
  matchesAllocationKey,
  type EffectiveShadowBias,
  type ShadowEntry as Entry,
  type ShadowLightStatus,
} from "./shadow-entry";
import {
  applyShadowAdmission,
  cameraDistanceSquared,
  planShadowAdmission,
  predictShadowStarts,
  readShadowAdmissionBudget,
  type ShadowAdmissionSnapshot,
  type ShadowStartPrediction,
} from "./shadow-admission-plan";
import {
  NEUTRAL_DARKNESS,
  applyShadowSettings,
  createShadowGenerator,
  fitLocalShadowDepth,
  neutralUntilRendered,
  shadowAllocationCheckpoint,
  type ShadowDrawCounters,
  type ShadowMapContext,
  type ShadowMapSlot,
} from "./shadow-map-factory";
import { ShadowViewMaps, type ViewShadows } from "./shadow-view-maps";
import { ShadowPredictionMaps } from "./shadow-prediction-maps";

export type { EffectiveShadowBias, ShadowLightStatus } from "./shadow-entry";
export type { ShadowAdmissionSnapshot, ShadowStartPrediction } from "./shadow-admission-plan";
export type { ViewShadows } from "./shadow-view-maps";
export { PREDICTION_MAP_SIZE } from "./shadow-prediction-maps";

const controllers = new WeakMap<Scene, SceneShadowController>();

/** Illumination state and shadow allocation of one light; no entry is "unsupported". */
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
  /** History the sync `restoreAdmission` runs ranks by, instead of its own. */
  private restoring: ShadowAdmissionSnapshot | null = null;
  /** The effective settings the last sync admitted by. */
  private planSettings: ShadowSettings | null = null;
  /** Per-map closures read their current owner; a local map can move between lights. */
  private readonly slots = new WeakMap<ShadowGenerator, ShadowMapSlot>();
  private readonly refresh = new ShadowMapRefresh((mesh) =>
    this.spatial.invalidate(mesh),
  );
  /** A native camera pass began since the last before-render-targets notification. */
  private cameraPass = false;
  private readonly counters: ShadowDrawCounters = { drawCalls: 0, triangles: 0 };
  shadowDrawCalls(): number {
    return this.counters.drawCalls;
  }
  shadowTriangles(): number {
    return this.counters.triangles;
  }
  private readonly scene: Scene;
  /** What every map this controller builds reads and reports to: its scene, casters, slots and draw counters. */
  private readonly maps: ShadowMapContext;
  /** Views with their own sun maps. */
  private readonly views: ShadowViewMaps;
  /** Prediction maps by light kind (`predictionMap`), and the scene's shadow reservation. */
  private readonly predictions: ShadowPredictionMaps;
  constructor(scene: Scene) {
    this.scene = scene;
    this.maps = { scene, spatial: this.spatial, casters: this.meshes, slots: this.slots, counters: this.counters };
    this.views = new ShadowViewMaps(this.entries, this.maps);
    this.predictions = new ShadowPredictionMaps(this.maps, () => this.planSettings);
    const engine = scene.getEngine();
    const restored = engine.onContextRestoredObservable.add(() => {
      this.predictions.release();
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
      this.counters.drawCalls = 0;
      this.counters.triangles = 0;
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
    // A hidden mesh casts into no map; revealed, it joins the caster lists of the maps it can reach, which draw again
    // with it: a local light's only when the mesh is within its range, a sun's always.
    const unwatchReveals = onMeshRevealed(scene, (mesh) => {
      forgetCasterRequests(mesh);
      if (!this.meshes.has(mesh)) return;
      this.forEachGenerator((generator) => {
        if (reaches(generator, mesh)) generator.getShadowMap()?.resetRefreshCounter();
      });
    });
    // On WebGPU a hidden mesh's reveal waits for the depth pipelines of the scene view's drawn maps among those
    // (`shadow-caster-warm.ts`): a standby map samples neutrally, and one awaiting its first draw has none yet.
    setShadowCasterReach(scene, (mesh, visit) => {
      if (!this.meshes.has(mesh) || !scene.shadowsEnabled || !scene.renderTargetsEnabled) return;
      for (const entry of this.entries.values()) {
        const generator = entry.generator;
        if (!generator || entry.status !== "active" || entry.standby || awaitsFirstDraw(generator)) continue;
        if (entry.light.isEnabled() && entry.light.shadowEnabled && reaches(generator, mesh)) visit(generator);
      }
    });
    scene.onDisposeObservable.addOnce(() => {
      engine.onContextRestoredObservable.remove(restored);
      unwatchReveals();
      setShadowCasterReach(scene, undefined);
      // Their owners still await the ledger releases through their own claims.
      this.views.releaseAll();
      for (const entry of this.entries.values()) entry.generator?.dispose();
      this.predictions.dispose();
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
        this.views.forgetLight(light);
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
  /** The history the next sync ranks by: its camera, and each light holding a map (admitted or standby) and since when. */
  snapshotAdmission(): ShadowAdmissionSnapshot {
    const maps = new Map<Light, { standby: boolean; admittedAt: number }>();
    for (const entry of this.entries.values())
      if (entry.generator) maps.set(entry.light, { standby: entry.standby, admittedAt: entry.admittedAt });
    return { at: performance.now(), camera: this.selectionCamera, maps };
  }
  /**
   * Admits now as a sync at `snapshot.at` would have, by its history rather than by the maps changes since moved: its
   * camera, its holders as the incumbents (each admitted map's distance bonus, and residency as of then), standby maps
   * kept only for lights that held one then, and the holders' admission times given back. Applied to the inputs
   * `snapshot` was taken with, the maps go back to the lights that held them, so a change tried and reverted leaves
   * admission as it found it, and later syncs carry on from there.
   */
  restoreAdmission(snapshot: ShadowAdmissionSnapshot): void {
    this.restoring = snapshot;
    try {
      this.sync("admission");
    } finally {
      this.restoring = null;
    }
  }
  /** The admitted map; standby maps are neither rendered nor admitted. */
  generator(light: Light): ShadowGenerator | null {
    const entry = this.entries.get(light);
    return entry?.standby ? null : (entry?.generator ?? null);
  }
  /**
   * Lit local lights the last sync left without an admitted map but within `margin` (a distance ratio) of one: of the
   * relevant area's edge, or, with every local map taken, of the farthest holder's ranking distance (its incumbent
   * bonus included) at no lower priority. Each names the map whose defines its admission gives its receivers (its own
   * standby map, `borrowed` null; or an admitted map of its kind with these settings) and the holder it would take a
   * map from. A light that would take a map from a holder of its kind is left out (the map moves, and the exchange
   * keeps every receiver's defines); one no admitted map shares a kind with is `firstOfKind`.
   */
  nearShadowStarts(margin: number): ShadowStartPrediction[] {
    const settings = this.planSettings;
    if (!settings?.enabled || this.scene.activeCamera !== this.selectionCamera) return [];
    return predictShadowStarts(this.entries, settings, margin);
  }
  /**
   * A map of `light`'s kind (spot or point) for a variant prediction of a first shadow start of that kind, or, on
   * WebGPU, of an admission bringing a standby map back (whose casters' depth pipelines its warm render creates): built
   * as an admitted map is, with the current settings, at `PREDICTION_MAP_SIZE`, listing the scene's casters, and taken
   * off the light at once (a map the light holds stays attached), so no receiver binds it, no admission counts it and
   * it never renders a frame. One per kind, aimed at the light it predicts. Its bytes join the scene's shadow reservation only while room remains after the
   * real maps, which release it when they need that room. Null when shadows are off or there is no room.
   */
  predictionMap(light: Light): ShadowGenerator | null {
    return this.predictions.map(light);
  }
  /** Disposes the prediction maps `release` picks (all by default), and gives their bytes back. */
  releasePredictionMaps(release: (map: ShadowGenerator) => boolean = () => true): void {
    this.predictions.release(release);
  }
  /** The prediction maps held now. */
  get heldPredictionMaps(): readonly ShadowGenerator[] {
    return this.predictions.generators;
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
    return this.views.attach(camera, () => this.spatial.bounds());
  }
  /**
   * The map a pass drawn for `camera` binds for `light`: the view's own sun
   * map, or else the scene view's map, which receivers drawn for `camera`
   * fall back to binding (a sun map the ledger refused for the view samples
   * the scene view's; toggling the light's shadows off for the view instead
   * would rebuild every material's light defines twice a frame).
   */
  viewBoundGenerator(light: Light, camera: Camera): ShadowGenerator | null {
    if (light instanceof DirectionalLight)
      return this.views.generator(light, camera) ?? this.boundGenerator(light);
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
    this.views.forEachMap(({ generator }) => {
      if (generator instanceof CascadedShadowGenerator) {
        casterBounds ??= this.spatial.bounds();
        if (casterBounds)
          generator.shadowCastersBoundingInfo.reConstruct(casterBounds.min, casterBounds.max);
      }
    });
  }
  status(light: Light): ShadowLightStatus | undefined {
    return this.entries.get(light)?.status;
  }
  /** Authored request, independent of admission, visibility and global shadow enablement. */
  requestsShadow(light: Light): boolean {
    return this.entries.get(light)?.requested ?? false;
  }
  /** Authored shadow priority (`register`'s). */
  shadowPriority(light: Light): number {
    return this.entries.get(light)?.priority ?? 0;
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
  /** Faces drawn and bytes held: the scene view's maps and every view's own. */
  metrics(): { passes: number; bytes: number } {
    let passes = 0;
    let bytes = 0;
    this.views.forEachMap((map) => {
      passes += map.passes;
      bytes += map.attachmentBytes;
    });
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
  diagnostics(lights: readonly Light[] = lightsInCreationOrder(this.scene.lights)) {
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
    this.planSettings = settings;
    const camera = scene.activeCamera;
    camera?.getViewMatrix();
    const restoring = this.restoring;
    this.restoring = null;
    const previousCamera = this.selectionCamera;
    this.selectionCamera = camera;
    // A restore ranks as of its snapshot, not now: a residency that ran out since moves the map once more at the
    // next sync, from the snapshot's arrangement, so the light order (receivers' slots) comes out as a load that never
    // tried the step has it. Ranked now, the map moves straight from the step's arrangement and its exchange leaves
    // the lights in other slots.
    const selectionTime = restoring ? restoring.at : performance.now();
    const budget = readShadowAdmissionBudget(scene, settings, this.views.bytes());
    const plan = planShadowAdmission({
      entries: this.entries,
      settings,
      camera,
      previousCamera,
      restoring,
      at: selectionTime,
      budget,
      measure: (light) => cameraDistanceSquared(light, camera!),
    });
    applyShadowAdmission(plan);
    const { planned, admitted } = plan;
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
          neutralUntilRendered(entry.generator);
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
      neutralUntilRendered(generator);
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
    // Standby maps are optional reuse: they keep only room the views' own maps
    // do not hold, so retaining one never makes a capture's sun maps yield,
    // and none the views' missing mirrors will ask for once they may allocate.
    const standbyBudget = Math.max(
      0,
      Math.min(budget.bytes, availableSceneShadowBytes(scene)) - this.views.missingMirrorBytes(settings, admitted.bytes),
    );
    for (const entry of donors.reverse()) {
      const generator = entry.generator!;
      const bytes = generatorPasses(generator) * entry.mapSize ** 2 * budget.bytesPerTexel;
      const samplers = admissionSamplers(entry.light, settings);
      // The Forward light budget dropped this light for camera distance: it is
      // camera-rejected like a budget-limited one. Releasing its map would
      // dispose the generator, and readmission would rebuild every caster's
      // depth effect. Its "disabled" status hides a withdrawn request, so
      // check what the candidate filter would have said.
      const forwardLimited =
        entry.status === "disabled" &&
        entry.requested &&
        settings.enabled &&
        isForwardLightExcluded(entry.light);
      if (
        clustered ||
        // A map a reverted change created or moved keeps no standby the restored history did not have.
        (restoring && !restoring.maps.has(entry.light)) ||
        (entry.status !== "outside-relevant-area" &&
          entry.status !== "budget-limited" &&
          !forwardLimited) ||
        JSON.stringify(entry.settings) !== settingsKey() ||
        pooled >= settings.maxLocalLights ||
        admitted.bytes + standby.bytes + bytes > standbyBudget ||
        admitted.samplers + standby.samplers + samplers > budget.samplers
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
      setAwaitingFirstDraw(generator, false);
      // A continuous caster would otherwise keep redrawing the neutral map.
      const map = generator.getShadowMap();
      if (map && map.refreshRate !== RenderTargetTexture.REFRESHRATE_RENDER_ONCE)
        map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    }
    this.views.yieldTo(admitted.bytes + standby.bytes);
    this.predictions.reserved = { bytes: admitted.bytes + standby.bytes, passes: admitted.passes, samplers: admitted.samplers + standby.samplers };
    // Prediction maps keep only room the real maps leave, and go with the settings they were built with.
    this.predictions.retainWithin(settingsKey(), standbyBudget);
    this.predictions.reserve();
    // One scene-wide light invalidation covers every retained generator's defines.
    let materialsDirty = false;
    for (const entry of this.entries.values()) {
      if (entry.status !== "active") continue;
      const directionalLight = entry.light instanceof DirectionalLight;
      let mapSize = entry.mapSize;
      const previousSettings = entry.settings;
      entry.settings = settings;
      if (entry.generator) {
        applyShadowSettings(entry.generator, settings);
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
          const generator = createShadowGenerator(this.maps, entry, mapSize, settings, null, casterBounds);
          entry.generator = generator;
          // Receivers may bind the new map before its first draw (a view keeps drawing while its casters compile).
          neutralUntilRendered(generator);
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
          const requestKey = allocationRequestKey(entry.light, settings);
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
        (cascaded ? 4 : passes) * entry.mapSize ** 2 * budget.bytesPerTexel;
      if (!entry.standby) live.passes += passes;
    }
    // With the prediction maps' bytes (they draw no pass a frame shows).
    this.predictions.reserved = { ...live };
    this.predictions.reserve();
    // The restored holders' residency runs from their own admission, not from a move back.
    if (restoring)
      for (const entry of this.entries.values()) {
        const map = entry.generator && restoring.maps.get(entry.light);
        if (map) entry.admittedAt = map.admittedAt;
      }
    for (const entry of this.entries.values())
      if (entry.generator && !entry.standby) {
        fitLocalShadowDepth(entry.generator.getLight(), scene.activeCamera);
        // Without a walk this sync, apply() would compare stale caster state.
        if (castersCurrent) this.refresh.apply(entry.generator);
      }
    // Views mirror the maps admitted above, after their releases and replacements.
    this.views.sync(settings, () => {
      currentCasters();
      return casterBounds;
    });
  }
  /** Every allocated map: the scene view's (admitted or standby) and every view's own. */
  private forEachGenerator(action: (generator: ShadowGenerator) => void): void {
    for (const entry of this.entries.values()) if (entry.generator) action(entry.generator);
    this.views.forEachMap((map) => action(map.generator));
  }
  /** Caster state only drives allocated maps (admitted or standby) and their spatial queries. */
  private holdsGenerator(): boolean {
    for (const entry of this.entries.values()) if (entry.generator) return true;
    return false;
  }
}

/** Whether a caster at `mesh` can draw into `generator`'s map: a local light's within its range (its cone unchecked), a sun's always. */
function reaches(generator: ShadowGenerator, mesh: AbstractMesh): boolean {
  const light = generator.getLight();
  return light instanceof DirectionalLight || !("range" in light) || !Number.isFinite(light.range) ||
    casterWithinShadowRange(mesh, (light as LocalShadowLight).getAbsolutePosition(), light.range as number);
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
  return (
    controller?.diagnostics() ??
    lightsInCreationOrder(scene.lights).map((light) => shadowLightRow(light))
  );
}

export function sceneShadowController(scene: Scene): SceneShadowController {
  let controller = controllers.get(scene);
  if (!controller) {
    controller = new SceneShadowController(scene);
    controllers.set(scene, controller);
  }
  return controller;
}
