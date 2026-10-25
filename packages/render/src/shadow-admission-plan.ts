import {
  DirectionalLight,
  Vector3,
  type ShadowGenerator,
  type Light,
  type Scene,
  type Camera,
} from "@babylonjs/core";
import { SHADOW_CAPACITY_PROFILES, type ShadowSettings } from "@haptic/core";
import { isDirectionalLightExcluded } from "./light-policy";
import { remainingShadowSamplers } from "./light-sampler-budget";
import type { LocalShadowLight } from "./reusable-shadow-generator";
import {
  ENGINE_SHADOW_BUDGET,
  otherShadowReservations,
  availableSceneShadowBytes,
  shadowBytesPerTexel,
  type ShadowCost,
} from "./shadow-admission";
import {
  admissionPasses,
  admissionSamplers,
  allocationRequestKey,
  type ShadowEntry as Entry,
  type ShadowLightStatus,
} from "./shadow-entry";

/** A light near a shadow map, as `nearShadowStarts` predicts its start. */
export type ShadowStartPrediction = {
  light: Light;
  /**
   * An admitted map of its kind whose defines its own would give receivers; null when it holds a standby map, or when
   * no admitted map shares its kind (`firstOfKind`: `predictionMap` stands in).
   */
  borrowed: ShadowGenerator | null;
  /** No map of its kind is admitted: its start would build the first. */
  firstOfKind: boolean;
  /** The holder it would take a map from, whose receivers lose that shadow. */
  displaced: Light | null;
};
/**
 * The admission history a sync ranks by (its camera, which lights hold a map and since when) at `at`, as a load
 * rehearsal takes it before a light change it tries (`snapshotAdmission`) and gives it back once the change is
 * reverted (`restoreAdmission`).
 */
export type ShadowAdmissionSnapshot = {
  readonly at: number;
  readonly camera: Camera | null;
  readonly maps: ReadonlyMap<Light, { readonly standby: boolean; readonly admittedAt: number }>;
};
// Minimum residency bounds camera-driven map churn; priority/camera switches
// and loss of eligibility still take effect immediately.
const SHADOW_MIN_RESIDENCY_MS = 250;
/** A map holder ranks this much nearer (squared distance divided by it), so a slightly nearer light cannot take its map. */
const SHADOW_INCUMBENT_DISTANCE_BONUS = 1.15;

/** The room a sync admits maps into: the shared ledger and the device's caps. */
export type ShadowAdmissionBudget = {
  readonly bytes: number;
  readonly passes: number;
  readonly samplers: number;
  readonly bytesPerTexel: number;
  readonly maxTextureSize: number;
  readonly maxCubemapTextureSize: number;
};
/** What a sync admits by (`planShadowAdmission`). */
export type ShadowAdmissionInput = {
  /** Iterated more than once: the Map itself, never its `values()`. */
  readonly entries: ReadonlyMap<Light, Entry>;
  readonly settings: ShadowSettings;
  readonly camera: Camera | null;
  /** The last sync's selection camera; a restore compares with its snapshot's instead. */
  readonly previousCamera: Camera | null;
  readonly restoring: ShadowAdmissionSnapshot | null;
  /** The selection time: the snapshot's for a restore, otherwise now. */
  readonly at: number;
  readonly budget: ShadowAdmissionBudget;
  /** A local light's squared distance to `camera` (`cameraDistanceSquared`); called only with a camera. */
  readonly measure: (light: LocalShadowLight) => number;
};
/** One entry's admission, which `applyShadowAdmission` writes back. */
export type ShadowAdmissionDecision = {
  readonly entry: Entry;
  status: ShadowLightStatus;
  reason: string | null;
  /** The ranking distance measured now (0 for a sun or without a camera); undefined keeps the entry's last one. */
  distanceSquared: number | undefined;
  /** The entry's recovery was keyed to other settings. */
  dropRecovery: boolean;
  /** The admitted map's size; meaningful only when `status` is "active". */
  mapSize: number;
};
export type ShadowAdmissionPlan = {
  /** In entry order. */
  readonly decisions: readonly ShadowAdmissionDecision[];
  /** Sun first, then by rank, within the count, pass and sampler budgets; memory-rejected entries stay "budget-limited". */
  readonly planned: readonly Entry[];
  readonly admitted: ShadowCost;
};

/** The shared ledger's room for this scene's maps, and the device's sampler headroom and texture caps. */
export function readShadowAdmissionBudget(
  scene: Scene,
  settings: ShadowSettings,
  viewMapBytes: number,
): ShadowAdmissionBudget {
  const caps = scene.getEngine().getCaps();
  const profile = SHADOW_CAPACITY_PROFILES[settings.profile];
  const other = otherShadowReservations(scene);
  const byteBudget = Math.max(
    0,
    Math.min(
      profile.byteBudget,
      ENGINE_SHADOW_BUDGET.bytes - other.bytes,
      // View maps never cost the scene view's: they give way below.
      availableSceneShadowBytes(scene) + viewMapBytes,
    ),
  );
  const passBudget = Math.max(
    0,
    Math.min(profile.passes, ENGINE_SHADOW_BUDGET.passes - other.passes),
  );
  const samplerBudget = remainingShadowSamplers(scene);
  const bytesPerTexel = shadowBytesPerTexel(scene.getEngine());
  return {
    bytes: byteBudget,
    passes: passBudget,
    samplers: samplerBudget,
    bytesPerTexel,
    maxTextureSize: caps.maxTextureSize,
    maxCubemapTextureSize: caps.maxCubemapTextureSize,
  };
}

/** A local light's squared distance to `camera`, from its current world transform. */
export function cameraDistanceSquared(light: LocalShadowLight, camera: Camera): number {
  // Shadow-limited lights may never bind a material. Refresh their
  // parents explicitly rather than ranking a stale transformedPosition.
  light.parent?.computeWorldMatrix(true);
  light.computeTransformedInformation();
  return Vector3.DistanceSquared(
    light.parent ? light.getAbsolutePosition() : light.position,
    camera.globalPosition,
  );
}

/**
 * Which lights hold a map, and at what size, without writing to the entries: ranked by priority, residency and camera
 * distance (an incumbent's bonus included), the sun first, then within the light count, pass, sampler and memory
 * budgets. `applyShadowAdmission` writes the decisions back.
 */
export function planShadowAdmission(input: ShadowAdmissionInput): ShadowAdmissionPlan {
  const { entries, settings, camera, restoring, budget, measure } = input;
  const cameraChanged = camera !== (restoring ? restoring.camera : input.previousCamera);
  const selectionTime = input.at;
  const {
    bytes: byteBudget,
    passes: passBudget,
    samplers: samplerBudget,
    bytesPerTexel,
  } = budget;
  const measureDistance = (decision: ShadowAdmissionDecision) => {
    const light = decision.entry.light;
    decision.distanceSquared = camera && !(light instanceof DirectionalLight) ? measure(light) : 0;
    return decision.distanceSquared;
  };
  const decisions = [...entries.values()].map((entry): ShadowAdmissionDecision => ({
    entry, status: "disabled", reason: null, distanceSquared: undefined, dropRecovery: false, mapSize: 0,
  }));
  const candidates = decisions.filter((decision) => {
    const entry = decision.entry;
    // Healthy entries build no request key.
    if (entry.recovery && entry.recovery.requestKey !== allocationRequestKey(entry.light, settings))
      decision.dropRecovery = true;
    if (isDirectionalLightExcluded(entry.light)) {
      decision.status = "non-illuminating";
      return false;
    }
    if (!entry.light.isEnabled() || entry.light.intensity <= 0) {
      // A Forward-dropped light keeps its map on standby, which ranks by distance.
      if (entry.generator) measureDistance(decision);
      return false;
    }
    if (!entry.requested) {
      decision.status = "not-requested";
      return false;
    }
    if (!settings.enabled) {
      decision.status = "shadows-disabled";
      return false;
    }
    if (entry.failedKey !== "" && entry.failedKey === allocationRequestKey(entry.light, settings)) {
      decision.status = "allocation-failed";
      decision.reason =
        "shadow allocation failed at minimum size; awaiting settings change or context recovery";
      return false;
    }
    const distanceSquared = measureDistance(decision);
    if (camera && !(entry.light instanceof DirectionalLight) &&
      distanceSquared > (settings.distance + entry.light.range) ** 2) {
      decision.status = "outside-relevant-area";
      return false;
    }
    decision.status = "budget-limited";
    return true;
  });
  // Nearest relevant lights win independently of brightness. A short minimum
  // residency and squared-distance bonus stabilize camera boundaries without
  // preventing an authored-priority change or a newly possessed camera.
  // A restored history ranks by the maps its snapshot held, not the ones a reverted change moved.
  const held = (entry: Entry) => restoring
    ? restoring.maps.get(entry.light)
    : entry.generator ? entry : undefined;
  const incumbent = (entry: Entry) => {
    const map = held(entry);
    return Boolean(map && !map.standby && !cameraChanged);
  };
  const resident = (entry: Entry) => incumbent(entry) &&
    selectionTime - held(entry)!.admittedAt < SHADOW_MIN_RESIDENCY_MS;
  // Every candidate was measured above.
  const distance = (decision: ShadowAdmissionDecision) =>
    decision.distanceSquared! / (incumbent(decision.entry) ? SHADOW_INCUMBENT_DISTANCE_BONUS : 1);
  candidates.sort(
    (a, b) =>
      b.entry.priority - a.entry.priority ||
      Number(resident(b.entry)) - Number(resident(a.entry)) ||
      distance(a) - distance(b) ||
      a.entry.light.uniqueId - b.entry.light.uniqueId,
  );
  const admitted: ShadowCost = { bytes: 0, passes: 0, samplers: 0 };
  const reserveLocalMaps =
    settings.maxLocalLights > 0 &&
    candidates.some((decision) => !(decision.entry.light instanceof DirectionalLight));
  // Reserve the single sun before local maps regardless of local priorities.
  candidates.sort(
    (a, b) =>
      Number(b.entry.light instanceof DirectionalLight) -
      Number(a.entry.light instanceof DirectionalLight),
  );
  let plannedLocal = 0;
  let plannedPasses = 0;
  let plannedSamplers = 0;
  let remainingLocalFaces = 0;
  const planned = candidates.filter((decision) => {
    const light = decision.entry.light;
    const directional = light instanceof DirectionalLight;
    const passes = admissionPasses(light, settings);
    const samplers = admissionSamplers(light, settings);
    decision.reason =
      !directional && plannedLocal >= settings.maxLocalLights
        ? "local light capacity"
        : plannedPasses + passes > passBudget
          ? "shadow face/pass budget"
          : plannedSamplers + samplers > samplerBudget
            ? "material sampler headroom"
            : null;
    if (decision.reason) return false;
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
  for (const decision of planned) {
    const entry = decision.entry;
    const directional = entry.light instanceof DirectionalLight;
    const passes = admissionPasses(entry.light, settings);
    const samplers = admissionSamplers(entry.light, settings);
    const requestedSize = directional
      ? settings.mapSize
      : settings.localMapSize;
    // A recovery keyed to other settings no longer limits the map.
    const recovery = decision.dropRecovery ? null : entry.recovery;
    let mapSize = Math.min(requestedSize, budget.maxTextureSize);
    if (entry.light.needCube())
      mapSize = Math.min(mapSize, budget.maxCubemapTextureSize);
    if (recovery) mapSize = Math.min(mapSize, recovery.mapSize);
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
      decision.reason = "shadow attachment memory budget";
      continue;
    }
    decision.mapSize = mapSize;
    decision.reason = recovery
      ? "shadow map reduced after allocation failure"
      : mapSize < requestedSize
        ? "shadow map reduced by memory or texture capability"
        : null;
    decision.status = "active";
    admitted.bytes += peakPasses * mapSize ** 2 * bytesPerTexel;
    admitted.passes += passes;
    admitted.samplers += samplers;
  }
  return { decisions, planned: planned.map((decision) => decision.entry), admitted };
}

/** Writes a plan's decisions to its entries. */
export function applyShadowAdmission(plan: ShadowAdmissionPlan): void {
  for (const decision of plan.decisions) {
    const entry = decision.entry;
    entry.status = decision.status;
    entry.reason = decision.reason;
    if (decision.dropRecovery) entry.recovery = null;
    if (decision.distanceSquared !== undefined) entry.distanceSquared = decision.distanceSquared;
    if (decision.status === "active") {
      entry.mapSize = decision.mapSize;
      entry.resetAllocation = false;
    }
  }
}

/** `SceneShadowController.nearShadowStarts` under the effective settings the last sync admitted by. */
export function predictShadowStarts(
  entries: ReadonlyMap<Light, Entry>,
  settings: ShadowSettings,
  margin: number,
): ShadowStartPrediction[] {
  const key = JSON.stringify(settings);
  const kind = (entry: Entry) => `${entry.light.getClassName()}:${entry.light.needCube()}`;
  const holders = [...entries.values()].filter((entry) =>
    entry.status === "active" && entry.generator && !entry.standby && !(entry.light instanceof DirectionalLight));
  const rank = (entry: Entry) => entry.distanceSquared / SHADOW_INCUMBENT_DISTANCE_BONUS;
  let farthest: Entry | undefined;
  for (const holder of holders)
    if (!farthest || holder.priority < farthest.priority || (holder.priority === farthest.priority && rank(holder) > rank(farthest)))
      farthest = holder;
  const full = holders.length >= settings.maxLocalLights;
  const starts: Array<ShadowStartPrediction & { distanceSquared: number }> = [];
  for (const entry of entries.values()) {
    if (entry.light instanceof DirectionalLight || !entry.light.isEnabled() || entry.light.intensity <= 0) continue;
    const outside = entry.status === "outside-relevant-area";
    if (!outside && !(entry.status === "budget-limited" && entry.reason === "local light capacity")) continue;
    if (outside && entry.distanceSquared > ((settings.distance + entry.light.range) * margin) ** 2) continue;
    let displaced: Entry | undefined;
    if (full) {
      if (!farthest || entry.priority < farthest.priority ||
        (entry.priority === farthest.priority && entry.distanceSquared > rank(farthest) * margin ** 2)) continue;
      if (!entry.generator && kind(farthest) === kind(entry) && JSON.stringify(farthest.settings) === key) continue;
      displaced = farthest;
    }
    const borrowed = entry.generator ? null : holders.find((holder) => holder !== displaced && kind(holder) === kind(entry) &&
      JSON.stringify(holder.settings) === key && (holder.generator!.getShadowMap()?.renderList?.length ?? 0) > 0)?.generator;
    starts.push({
      light: entry.light, borrowed: borrowed ?? null, firstOfKind: borrowed === undefined,
      displaced: displaced?.light ?? null, distanceSquared: entry.distanceSquared,
    });
  }
  return starts.sort((a, b) => a.distanceSquared - b.distanceSquared)
    .map(({ light, borrowed, firstOfKind, displaced }) => ({ light, borrowed, firstOfKind, displaced }));
}
