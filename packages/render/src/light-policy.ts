import {
  DirectionalLight,
  HemisphericLight,
  RectAreaLight,
  ShadowLight,
  Vector3,
  type Camera,
  type Light,
  type Scene,
} from "@babylonjs/core";

import {
  isClusteredLocalAllowed,
  isManagedClusteredLight,
} from "./clustered-light-policy";
import { lightingSamplerCapacity, lightSamplerCost, lightSamplerCount } from "./light-sampler-budget";

const authoredEnabled = new WeakMap<
  Light,
  { enabled: boolean; effective: boolean }
>();
const excluded = new WeakSet<Light>();
const forwardExcluded = new WeakSet<Light>();
const clusteredMembers = new WeakSet<Light>();
const forwardSelections = new WeakMap<Scene, Set<Light>>();
/**
 * How long a local light keeps a conventional slot it just gained or lost.
 * A swap re-resolves every lit material's light defines (and rebuilds a shadow
 * caster's map unless it stands by), which costs far more than a frame, so a
 * camera hovering at a ranking boundary must not swap the same lights back and
 * forth. Priority, capacity and eligibility changes ignore the dwell.
 */
export const FORWARD_LIGHT_DWELL_MS = 1500;
type ForwardDwell = { selected: boolean; until: number };
/** Last selection of each candidate and the time before which it stays that way. */
const forwardDwells = new WeakMap<Light, ForwardDwell>();
/** A new active camera is a cut, not a drift: the dwell does not hold across it. */
const forwardCameras = new WeakMap<Scene, Camera | null>();
const scratchLightPosition = new Vector3();
// Per-call scratch, emptied before each call returns so no light stays retained.
const scratchCandidates: Light[] = [];
const scratchCandidateSet = new Set<Light>();
const scratchDistances = new Map<Light, number>();
const scratchLocks = new Map<Light, number>();

export function isAuthoredLightEnabled(light: Light): boolean {
  const current = light.isEnabled(false);
  const previous = authoredEnabled.get(light);
  return !previous || current !== previous.effective
    ? current
    : previous.enabled;
}

/** Authored Enabled, positive intensity and an enabled parent, before any budget. */
export function isIlluminatingLight(light: Light): boolean {
  return (
    isAuthoredLightEnabled(light) &&
    light.intensity > 0 &&
    (!light.parent || light.parent.isEnabled())
  );
}

function applyEnabled(light: Light, enabled: boolean): void {
  const effective =
    enabled &&
    light.intensity > 0 &&
    !excluded.has(light) &&
    (!forwardExcluded.has(light) || clusteredMembers.has(light));
  const previous = authoredEnabled.get(light);
  if (previous) {
    previous.enabled = enabled;
    previous.effective = effective;
  } else authoredEnabled.set(light, { enabled, effective });
  if (light.isEnabled(false) !== effective) light.setEnabled(effective);
}

/** A borrowed clustered child does not consume its previous conventional slot. */
export function setClusteredLightMember(light: Light, member: boolean): void {
  const enabled = isAuthoredLightEnabled(light);
  if (member) clusteredMembers.add(light);
  else clusteredMembers.delete(light);
  applyEnabled(light, enabled);
}

/**
 * Authored state stays separate from Babylon's effective illumination state.
 * A batch caller passes `syncPolicy: false` and runs syncDirectionalLightPolicy
 * once after its last change.
 */
export function setAuthoredLightEnabled(
  light: Light,
  enabled: boolean,
  syncPolicy = true,
): void {
  applyEnabled(light, enabled);
  if (syncPolicy) syncDirectionalLightPolicy(light.getScene());
}

export function isDirectionalLightExcluded(light: Light): boolean {
  return excluded.has(light);
}

export function isForwardLightExcluded(light: Light): boolean {
  return (
    !clusteredMembers.has(light) &&
    forwardExcluded.has(light) &&
    isAuthoredLightEnabled(light)
  );
}

/** Stable scene order selects one enabled sun, regardless of shadow settings. */
export function syncDirectionalLightPolicy(scene: Scene): void {
  let owner: Light | undefined;
  for (const light of scene.lights) {
    if (!(light instanceof DirectionalLight)) continue;
    const enabled = isAuthoredLightEnabled(light);
    const illuminating = isIlluminatingLight(light);
    const blocked = illuminating && owner !== undefined;
    if (illuminating && !owner) owner = light;
    if (blocked) excluded.add(light);
    else excluded.delete(light);
    applyEnabled(light, enabled);
  }
}

/**
 * Scene-local conventional selection; authored Enabled and priority are
 * retained. `now` (milliseconds) times the dwell of a changed local selection.
 */
export function syncForwardLightPolicy(
  scene: Scene,
  slots: number,
  localSlots = Number.MAX_SAFE_INTEGER,
  now = performance.now(),
): {
  requested: number;
  admitted: number;
  limited: Light[];
  samplerLimited: Light[];
  samplers: number;
} {
  syncDirectionalLightPolicy(scene);
  const previous = forwardSelections.get(scene) ?? new Set<Light>();
  const candidates = scratchCandidates;
  candidates.length = 0;
  for (const light of scene.lights)
    if (
      isForwardEligible(light) &&
      (!isAuthoredLocal(scene, light) || isClusteredLocalAllowed(scene, light))
    )
      candidates.push(light);
  const capacity = Math.max(0, Math.floor(slots));
  const localCapacity = Math.max(0, Math.floor(localSlots));
  const samplerCapacity = lightingSamplerCapacity(scene);
  const camera = scene.activeCamera;
  const cameraCut = forwardCameras.has(scene) && forwardCameras.get(scene) !== camera;
  forwardCameras.set(scene, camera);
  if (
    candidates.length > capacity ||
    countLocals(scene, candidates) > localCapacity ||
    lightSamplerCount(scene, candidates) > samplerCapacity
  ) {
    const locks = scratchLocks;
    locks.clear();
    if (!cameraCut)
      for (const light of candidates) {
        const dwell = forwardDwells.get(light);
        if (dwell && dwell.until > now) locks.set(light, dwell.selected ? 1 : -1);
      }
    try {
      sortLightsByAdmission(scene, candidates, previous, locks);
    } finally {
      locks.clear();
    }
  }
  const selected = previous;
  selected.clear();
  let selectedLocals = 0;
  let samplers = 0, hasArea = false;
  const limited: Light[] = [];
  const samplerLimited: Light[] = [];
  for (const light of candidates) {
    const authoredLocal = isAuthoredLocal(scene, light);
    const samplerCost = lightSamplerCost(scene, light, hasArea);
    if (
      selected.size >= capacity ||
      (authoredLocal && selectedLocals >= localCapacity)
    )
      limited.push(light);
    else if (samplers + samplerCost > samplerCapacity) {
      limited.push(light);
      samplerLimited.push(light);
    }
    else {
      selected.add(light);
      samplers += samplerCost;
      hasArea ||= light instanceof RectAreaLight;
      if (authoredLocal) selectedLocals++;
    }
    if (authoredLocal) noteForwardSelection(light, selected.has(light), now);
  }
  // Test membership in the candidates snapshot rather than re-deriving it:
  // applyEnabled can change a descendant light's eligibility mid-loop. Fill
  // the set once, and only when an eligible light went unselected.
  const candidateSet = scratchCandidateSet;
  candidateSet.clear();
  for (const light of scene.lights) {
    const enabled = isAuthoredLightEnabled(light);
    const eligible = isForwardEligible(light);
    if (eligible && !selected.has(light)) {
      forwardExcluded.add(light);
      if (!candidateSet.size) for (const candidate of candidates) candidateSet.add(candidate);
      if (!candidateSet.has(light)) limited.push(light);
    } else forwardExcluded.delete(light);
    // An ineligible light starts over, undwelled, when it becomes eligible again.
    if (!eligible) forwardDwells.delete(light);
    applyEnabled(light, enabled);
  }
  candidates.length = 0;
  candidateSet.clear();
  forwardSelections.set(scene, selected);
  return {
    requested: selected.size + limited.length,
    admitted: selected.size,
    limited,
    samplerLimited,
    samplers,
  };
}

function isForwardEligible(light: Light): boolean {
  return isIlluminatingLight(light) && !excluded.has(light);
}

/** The first sighting starts undwelled; a change of selection holds for the dwell. */
function noteForwardSelection(light: Light, selected: boolean, now: number): void {
  const dwell = forwardDwells.get(light);
  if (!dwell) forwardDwells.set(light, { selected, until: 0 });
  else if (dwell.selected !== selected) {
    dwell.selected = selected;
    dwell.until = now + FORWARD_LIGHT_DWELL_MS;
  }
}

function isAuthoredLocal(scene: Scene, light: Light): boolean {
  return !isGlobalLight(light) && !isManagedClusteredLight(scene, light);
}

function countLocals(scene: Scene, lights: readonly Light[]): number {
  let count = 0;
  for (const light of lights) if (isAuthoredLocal(scene, light)) count++;
  return count;
}

export function isGlobalLight(light: Light): boolean {
  return light instanceof DirectionalLight || light instanceof HemisphericLight;
}

/** Area lights inherit Light.getAbsolutePosition(), which is the origin. Rank
 * them where Babylon's shader transfer places them. */
function admissionPosition(light: Light): Vector3 {
  if (light instanceof RectAreaLight)
    return light.parent
      ? Vector3.TransformCoordinatesToRef(
          light.position,
          light.parent.getWorldMatrix(),
          scratchLightPosition,
        )
      : light.position;
  return light instanceof ShadowLight && !light.parent
    ? light.position
    : light.getAbsolutePosition();
}

/**
 * Shared authored-local ordering before clustered and conventional resource
 * admission. `locks` ranks a light inside its dwell: 1 keeps its slot ahead of
 * unlocked lights, -1 waits behind them. Priority still outranks a lock.
 */
export function sortLightsByAdmission(
  scene: Scene,
  lights: Light[],
  previous: ReadonlySet<Light>,
  locks?: ReadonlyMap<Light, number>,
): void {
  const camera = scene.activeCamera;
  camera?.getViewMatrix();
  const distances = scratchDistances;
  distances.clear();
  try {
    for (const light of lights) {
      if (
        (light instanceof ShadowLight || light instanceof RectAreaLight) &&
        !isGlobalLight(light)
      ) {
        // Excluded children never reach normal shader binding. Refresh parented
        // positions before either quality or shader-capacity selection.
        light.parent?.computeWorldMatrix(true);
        if (light instanceof ShadowLight) light.computeTransformedInformation();
      }
      const squared =
        camera && !isGlobalLight(light)
          ? Vector3.DistanceSquared(
              admissionPosition(light),
              camera.globalPosition,
            )
          : 0;
      distances.set(
        light,
        Math.max(1, squared) / (previous.has(light) ? 1.15 : 1),
      );
    }
    lights.sort(
      (a, b) =>
        Number(isGlobalLight(b)) - Number(isGlobalLight(a)) ||
        Number(isManagedClusteredLight(scene, b)) -
          Number(isManagedClusteredLight(scene, a)) ||
        (Number.isFinite(b.renderPriority) ? b.renderPriority : 0) -
          (Number.isFinite(a.renderPriority) ? a.renderPriority : 0) ||
        (locks?.get(b) ?? 0) - (locks?.get(a) ?? 0) ||
        distances.get(a)! - distances.get(b)! ||
        a.uniqueId - b.uniqueId,
    );
  } finally {
    distances.clear();
  }
}
