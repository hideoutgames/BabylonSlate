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
import { configureDirectionalShadowProjection } from "./directional-shadow-projection";
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
  key: string;
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
// Minimum residency bounds camera-driven map churn; priority/camera switches
// and loss of eligibility still take effect immediately.
const SHADOW_MIN_RESIDENCY_MS = 250;
// Every Babylon 9.29 shadow filter returns fully lit at darkness 1.
const NEUTRAL_DARKNESS = 1;
const controllers = new WeakMap<Scene, SceneShadowController>();

/** An admitted map's allocation shape; a change replaces the generator. */
function allocationKey(
  mapSize: number,
  light: ShadowLight,
  cascades: number,
): string {
  return JSON.stringify([
    mapSize,
    light.needCube(),
    light instanceof DirectionalLight ? cascades : 1,
  ]);
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
  /** scene.meshes.length at the last scan, and synchronous removals since. */
  private knownMeshCount = 0;
  private removedSinceScan = 0;
  private readonly spatial = new ShadowSpatialIndex();
  private selectionCamera: Camera | null = null;
  /** Per-map closures read their current owner; a local map can move between lights. */
  private readonly slots = new WeakMap<ShadowGenerator, { entry: Entry; guard: boolean }>();
  private readonly refresh = new ShadowMapRefresh((mesh) =>
    this.spatial.invalidate(mesh),
  );
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
    scene.onNewMeshAddedObservable.add((mesh) => {
      // Babylon defers this notification. RTT-only proxies can already have
      // left the Scene before it arrives; removal must win over a stale add.
      // sync() may already have queued the mesh through the count check.
      if (!mesh.isDisposed() && !this.known.has(mesh) && scene.meshes.includes(mesh)) {
        this.known.add(mesh);
        this.pending.add(mesh);
      }
    });
    scene.onMeshRemovedObservable.add((mesh) => {
      this.removedSinceScan++;
      this.known.delete(mesh);
      this.pending.delete(mesh);
      // Only casters own a spatial leaf or generator render-list membership.
      if (!this.meshes.delete(mesh)) return;
      this.spatial.remove(mesh);
      for (const entry of this.entries.values())
        entry.generator?.removeShadowCaster(mesh, false);
    });
    scene.onBeforeRenderObservable.add(() => {
      this.drawCalls = 0;
      this.triangles = 0;
      this.sync();
    });
    // Per-camera target rendering follows active-mesh/world-matrix evaluation.
    // Catch those updates before Babylon decides whether each shadow map renders.
    scene.onBeforeRenderTargetsRenderObservable.add(() => {
      this.refreshShadowMaps();
    });
    scene.onDisposeObservable.addOnce(() => {
      engine.onContextRestoredObservable.remove(restored);
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
        key: "",
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
  /** Last completed map pass, bounded to the admitted faces/cascades. */
  effectiveBias(light: Light): readonly EffectiveShadowBias[] {
    return this.entries.get(light)?.effectiveBias ?? [];
  }
  /** Refreshes admitted maps after the owning renderer updates caster transforms. */
  refreshShadowMaps(): void {
    this.refresh.syncCasters(this.scene, this.meshes);
    for (const entry of this.entries.values())
      if (entry.generator && !entry.standby) this.refresh.apply(entry.generator);
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
  private queueUnknownMeshes(): void {
    for (const mesh of this.scene.meshes) {
      if (this.known.has(mesh)) continue;
      this.known.add(mesh);
      this.pending.add(mesh);
    }
    this.knownMeshCount = this.scene.meshes.length;
    this.removedSinceScan = 0;
  }
  diagnostics(lights: readonly Light[] = this.scene.lights) {
    return lights.map((light) => shadowLightRow(light, this.entries.get(light)));
  }
  sync(): void {
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
      if (mesh.isDisposed() || !scene.meshes.includes(mesh)) continue;
      // Shadow maps draw the selected level through its master caster, and a
      // level mirrors its master's receiveShadows.
      if (mesh.isBlocked) {
        if (this.meshes.delete(mesh)) {
          this.spatial.remove(mesh);
          for (const entry of this.entries.values())
            entry.generator?.removeShadowCaster(mesh, false);
        }
        continue;
      }
      if (!participatesInShadows(mesh)) {
        mesh.receiveShadows = false;
        if (this.meshes.delete(mesh)) {
          this.spatial.remove(mesh);
          for (const entry of this.entries.values())
            entry.generator?.removeShadowCaster(mesh, false);
        }
        continue;
      }
      const participation = authoredShadowParticipation(mesh);
      mesh.receiveShadows = participation.receiveShadows !== false;
      if (participation.castShadows === false || neverCastsShadows(mesh)) {
        if (this.meshes.delete(mesh)) {
          this.spatial.remove(mesh);
          for (const entry of this.entries.values())
            entry.generator?.removeShadowCaster(mesh, false);
        }
        continue;
      }
      this.meshes.add(mesh);
      this.spatial.add(mesh);
      partitionShadowGeometry(mesh);
      for (const entry of this.entries.values())
        entry.generator?.addShadowCaster(mesh, false);
    }
    this.pending.clear();
    // Caster participation and receiveShadows changed material defines or map
    // membership; cached strict readiness no longer applies.
    if (hadPending) markSceneReadinessDirty(scene);
    this.refresh.syncCasters(scene, this.meshes);
    const casterBounds = this.spatial.bounds();
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
    const settingsKey = JSON.stringify(settings);
    const release = (entry: Entry) => {
      if (entry.generator) {
        entry.generator.dispose();
        markSceneReadinessDirty(scene);
        invalidateShadowReceiverHandoffs(scene);
      }
      entry.generator = null;
      entry.standby = false;
      entry.effectiveBias.length = 0;
      entry.key = "";
    };
    // Release incompatible and retired maps before reserving/constructing their
    // replacements; old and new sets must never overlap outside this envelope.
    // A local map that only lost camera admission stays allocated for reuse.
    const donors: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "active" && entry.generator &&
        entry.key === allocationKey(entry.mapSize, entry.light, settings.cascades)) {
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
      const key = allocationKey(entry.mapSize, entry.light, settings.cascades);
      const index = donors.findIndex((donor) => donor.key === key &&
        (donor.generator as ReusableShadowGenerator).canMoveTo(entry.light as LocalShadowLight));
      if (index < 0) continue;
      const [donor] = donors.splice(index, 1) as [Entry];
      const generator = donor.generator as ReusableShadowGenerator;
      generator.moveTo(entry.light as LocalShadowLight);
      // Same-kind lights exchange shader light indices, so receivers keep their
      // defines and effects. Otherwise dirty them as construction/disposal would.
      if (JSON.stringify(donor.settings) !== settingsKey ||
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
      donor.key = "";
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
        JSON.stringify(entry.settings) !== settingsKey ||
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
          if (previousSettings?.distance !== settings.distance)
            configureDirectionalShadowProjection(
              entry.light,
              scene,
              settings.distance,
              mapSize,
              this.spatial,
            );
          entry.light.forceProjectionMatrixCompute();
        }
        continue;
      }
      // Halving is bounded by the normalized 4096 maximum and 256 floor. Failed
      // attempts are fully released before smaller maps reuse the reservation.
      while (mapSize >= 256) {
        const cleanup = shadowAllocationCheckpoint(scene);
        try {
          const validateAllocation = beginShadowAllocationValidation(
            scene.getEngine(),
          );
          const generator =
            directionalLight && settings.cascades > 1
              ? new CascadedShadowGenerator(
                  mapSize,
                  entry.light as DirectionalLight,
                )
              : directionalLight
                ? new ShadowGenerator(mapSize, entry.light)
                : new ReusableShadowGenerator(mapSize, entry.light as LocalShadowLight);
          const slot = { entry, guard: false };
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
            configureDirectionalShadowProjection(
              entry.light,
              scene,
              settings.distance,
              mapSize,
              this.spatial,
            );
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
            if (!preparedBias) return;
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
              return this.spatial.queryPlanes(activePlanes, casters);
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
          try {
            cleanup(entry.light.getShadowGenerator());
          } catch (cleanupError) {
            entry.reason = "shadow allocation cleanup failed";
            throw new AggregateError(
              [error, cleanupError],
              "Shadow allocation and resource cleanup failed",
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
      if (entry.generator && !entry.standby) this.refresh.apply(entry.generator);
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
