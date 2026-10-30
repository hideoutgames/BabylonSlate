import {
  DirectionalLight,
  Vector3,
  type Light,
  type Scene,
  type Camera,
} from "@babylonjs/core";
import { SHADOW_CAPACITY_PROFILES, type ShadowSettings } from "@haptic/core";
import { isDirectionalLightExcluded } from "./light-policy";
import {
  ENGINE_SHADOW_BUDGET,
  otherShadowReservations,
  availableSceneShadowBytes,
  type ShadowCost,
} from "./shadow-admission";
import { SHADOW_ATLAS_BYTES_PER_TEXEL, shadowAtlasEdge } from "./shadow-atlas";
import {
  admissionPasses,
  allocationRequestKey,
  type LocalShadowLight,
  type ShadowEntry as Entry,
  type ShadowLightStatus,
} from "./shadow-entry";

// Minimum residency bounds camera-driven map churn; priority/camera switches
// and loss of eligibility still take effect immediately.
const SHADOW_MIN_RESIDENCY_MS = 250;
/** A map holder ranks this much nearer (squared distance divided by it), so a slightly nearer light cannot take its map. */
const SHADOW_INCUMBENT_DISTANCE_BONUS = 1.15;

/** The room a sync admits maps into: the shared ledger and the shadow atlas. */
export type ShadowAdmissionBudget = {
  readonly bytes: number;
  readonly passes: number;
  /**
   * The shadow atlas edge (`shadowAtlasEdge`). Spot, point and sun maps are tiles of the atlas, admitted by its
   * area; the atlas, allocated whole, takes its bytes from `bytes` once one is.
   */
  readonly atlasEdge: number;
};
/** What a sync admits by (`planShadowAdmission`). */
export type ShadowAdmissionInput = {
  /** Iterated more than once: the Map itself, never its `values()`. */
  readonly entries: ReadonlyMap<Light, Entry>;
  readonly settings: ShadowSettings;
  readonly camera: Camera | null;
  /** The last sync's selection camera. */
  readonly previousCamera: Camera | null;
  /** The selection time. */
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
  /** Sun first, then by rank, within the count and pass budgets; memory-rejected entries stay "budget-limited". */
  readonly planned: readonly Entry[];
  readonly admitted: ShadowCost;
};

/** The shared ledger's room for this scene's maps, and the shadow atlas's edge. */
export function readShadowAdmissionBudget(
  scene: Scene,
  settings: ShadowSettings,
): ShadowAdmissionBudget {
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
  return {
    bytes: byteBudget,
    passes: passBudget,
    atlasEdge: shadowAtlasEdge(scene.getEngine(), settings.profile),
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
 * distance (an incumbent's bonus included), the sun first, then within the light count and pass
 * budgets and the atlas's area. `applyShadowAdmission` writes the decisions back.
 */
export function planShadowAdmission(input: ShadowAdmissionInput): ShadowAdmissionPlan {
  const { entries, settings, camera, budget, measure } = input;
  const cameraChanged = camera !== input.previousCamera;
  const selectionTime = input.at;
  const passBudget = budget.passes;
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
  const incumbent = (entry: Entry) => Boolean(entry.generator && !entry.standby && !cameraChanged);
  const resident = (entry: Entry) => incumbent(entry) && selectionTime - entry.admittedAt < SHADOW_MIN_RESIDENCY_MS;
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
  const admitted: ShadowCost = { bytes: 0, passes: 0 };
  const atlasEdge = budget.atlasEdge;
  // Reserve the single sun before local maps regardless of local priorities.
  candidates.sort(
    (a, b) =>
      Number(b.entry.light instanceof DirectionalLight) -
      Number(a.entry.light instanceof DirectionalLight),
  );
  let plannedLocal = 0;
  let plannedPasses = 0;
  const planned = candidates.filter((decision) => {
    const light = decision.entry.light;
    const directional = light instanceof DirectionalLight;
    const passes = admissionPasses(light, settings);
    decision.reason =
      !directional && plannedLocal >= settings.maxLocalLights
        ? "local light capacity"
        : plannedPasses + passes > passBudget
          ? "shadow face/pass budget"
          : null;
    if (decision.reason) return false;
    plannedPasses += passes;
    if (!directional) plannedLocal += 1;
    return true;
  });
  // The atlas is allocated whole for its first tile.
  if (planned.length > 0)
    admitted.bytes += atlasEdge ** 2 * SHADOW_ATLAS_BYTES_PER_TEXEL;
  let atlasArea = 0;
  // The sun, admitted first, leaves the atlas room for the local maps planned into it at the level's size (a point
  // light's six faces), at most half the atlas: local maps past that halve or wait, never the sun's shadow.
  let localTiles = 0;
  for (const decision of planned)
    if (!(decision.entry.light instanceof DirectionalLight))
      localTiles += admissionPasses(decision.entry.light, settings);
  const localReserve = Math.min(localTiles * Math.min(settings.localMapSize, atlasEdge) ** 2, atlasEdge ** 2 / 2);
  // Admitted totals never exceed the planned ones, so every planned entry still
  // fits the local and pass budgets; only atlas space can reject it here.
  for (const decision of planned) {
    const entry = decision.entry;
    const directional = entry.light instanceof DirectionalLight;
    const passes = admissionPasses(entry.light, settings);
    const requestedSize = directional
      ? settings.mapSize
      : settings.localMapSize;
    // A recovery keyed to other settings no longer limits the map.
    const recovery = decision.dropRecovery ? null : entry.recovery;
    let mapSize = Math.min(requestedSize, atlasEdge);
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
    // A tile per cascade or face.
    const room = atlasEdge ** 2 - atlasArea - (directional ? localReserve : 0);
    while (mapSize >= 256 && passes * mapSize ** 2 > room) mapSize /= 2;
    if (mapSize < 256) {
      decision.reason = "shadow atlas space";
      continue;
    }
    atlasArea += passes * mapSize ** 2;
    decision.mapSize = mapSize;
    decision.reason = recovery
      ? "shadow map reduced after allocation failure"
      : mapSize < requestedSize ? "shadow map reduced by shadow atlas space" : null;
    decision.status = "active";
    admitted.passes += passes;
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
