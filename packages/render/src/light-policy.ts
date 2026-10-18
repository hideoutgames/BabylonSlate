import {
  DirectionalLight,
  HemisphericLight,
  RectAreaLight,
  ShadowLight,
  Vector3,
  type Light,
  type Scene,
} from "@babylonjs/core";

import {
  hasClusteredLightPolicy,
  isClusteredLocalAllowed,
  isManagedClusteredLight,
} from "./clustered-light-policy";
import {
  exchangeForwardLightSlots,
  NO_FORWARD_LIGHT_SLOT_EXCHANGES,
  settleForwardLightSlots,
  type ForwardLightSlotExchange,
} from "./forward-light-slots";
import { lightingSamplerCapacity, lightSamplerCost, lightSamplerCount } from "./light-sampler-budget";

const authoredEnabled = new WeakMap<
  Light,
  { enabled: boolean; effective: boolean }
>();
const excluded = new WeakSet<Light>();
const forwardExcluded = new WeakSet<Light>();
const clusteredMembers = new WeakSet<Light>();
const forwardSelections = new WeakMap<Scene, Set<Light>>();
const scratchLightPosition = new Vector3();
// Per-call scratch, emptied before each call returns so no light stays retained.
const scratchCandidates: Light[] = [];
const scratchCandidateSet = new Set<Light>();
const scratchDistances = new Map<Light, number>();
const scratchLights: Light[] = [];
const scratchAuthored: boolean[] = [];
const scratchBudget: BudgetChange[] = [];
const scratchLeaving: Light[] = [];
const scratchEntering: Light[] = [];

/** How this sync's budget selection changed a light's Forward limit. */
const BudgetChange = { None: 0, Dropped: 1, Admitted: 2 } as const;
type BudgetChange = (typeof BudgetChange)[keyof typeof BudgetChange];

/**
 * Creation order: the stable "authored" order of a Scene's lights. The Forward
 * policy reorders `scene.lights` to keep shader slots, so order-sensitive
 * readers (clustered authored order, diagnostics) sort by this instead.
 */
export function compareLightCreation(a: Light, b: Light): number {
  return a.uniqueId - b.uniqueId;
}

export function lightsInCreationOrder(lights: readonly Light[]): Light[] {
  return lights.slice().sort(compareLightCreation);
}

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

function effectiveEnabled(light: Light, enabled: boolean): boolean {
  return (
    enabled &&
    light.intensity > 0 &&
    !excluded.has(light) &&
    (!forwardExcluded.has(light) || clusteredMembers.has(light))
  );
}

function applyEnabled(light: Light, enabled: boolean): void {
  const effective = effectiveEnabled(light, enabled);
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

/** Scene-local conventional selection; authored Enabled and priority are retained. */
export function syncForwardLightPolicy(
  scene: Scene,
  slots: number,
  localSlots = Number.MAX_SAFE_INTEGER,
): {
  requested: number;
  admitted: number;
  limited: Light[];
  samplerLimited: Light[];
  samplers: number;
  /** Lights that took a dropped light's shader index during this sync. */
  exchanges: readonly ForwardLightSlotExchange[];
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
  if (
    candidates.length > capacity ||
    countLocals(scene, candidates) > localCapacity ||
    lightSamplerCount(scene, candidates) > samplerCapacity
  )
    sortLightsByAdmission(scene, candidates, previous);
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
  }
  // Decide every light before toggling any, so receivers can be prepared for
  // the whole change. An eligible light the clustered policy kept out of the
  // candidates is limited too; fill that set once, and only when needed.
  const candidateSet = scratchCandidateSet;
  candidateSet.clear();
  const lights = scratchLights;
  const authored = scratchAuthored;
  const budget = scratchBudget;
  let exchanges: readonly ForwardLightSlotExchange[];
  try {
    for (const light of scene.lights) {
      const wasLimited = forwardExcluded.has(light);
      const isLimited = isForwardEligible(light) && !selected.has(light);
      if (isLimited) {
        forwardExcluded.add(light);
        if (!candidateSet.size) for (const candidate of candidates) candidateSet.add(candidate);
        if (!candidateSet.has(light)) limited.push(light);
      } else forwardExcluded.delete(light);
      lights.push(light);
      authored.push(isAuthoredLightEnabled(light));
      budget.push(
        isLimited === wasLimited
          ? BudgetChange.None
          : isLimited
            ? BudgetChange.Dropped
            : BudgetChange.Admitted,
      );
    }
    exchanges = exchangeSlots(scene, lights, authored, budget);
    for (let index = 0; index < lights.length; index++)
      applyEnabled(lights[index]!, authored[index]!);
    settleForwardLightSlots(scene, exchanges);
  } finally {
    lights.length = 0;
    authored.length = 0;
    budget.length = 0;
    candidates.length = 0;
    candidateSet.clear();
  }
  forwardSelections.set(scene, selected);
  return {
    requested: selected.size + limited.length,
    admitted: selected.size,
    limited,
    samplerLimited,
    samplers,
    exchanges,
  };
}

/**
 * Lights the budget admits this sync take the shader indices of those it
 * drops. Authored Enabled, intensity and parent changes keep Babylon's order.
 */
function exchangeSlots(
  scene: Scene,
  lights: readonly Light[],
  authored: readonly boolean[],
  budget: readonly BudgetChange[],
): readonly ForwardLightSlotExchange[] {
  // Clustered Forward orders lightSources itself; Babylon re-sorts a scene
  // that requires light sorting whenever a light is added or removed.
  if (hasClusteredLightPolicy(scene) || scene.requireLightSorting)
    return NO_FORWARD_LIGHT_SLOT_EXCHANGES;
  const leaving = scratchLeaving;
  const entering = scratchEntering;
  try {
    for (let index = 0; index < lights.length; index++) {
      const light = lights[index]!;
      // The first enabled sun in scene order illuminates; never move a sun
      // or fill (the budget keeps both ahead of every local light anyway).
      if (budget[index] === BudgetChange.None || isGlobalLight(light)) continue;
      const lit = light.isEnabled();
      const next =
        effectiveEnabled(light, authored[index]!) &&
        (!light.parent || light.parent.isEnabled());
      if (budget[index] === BudgetChange.Dropped && lit && !next) leaving.push(light);
      else if (budget[index] === BudgetChange.Admitted && !lit && next) entering.push(light);
    }
    // Removal alone keeps every remaining light's relative order.
    return entering.length
      ? exchangeForwardLightSlots(scene, leaving, entering)
      : NO_FORWARD_LIGHT_SLOT_EXCHANGES;
  } finally {
    leaving.length = 0;
    entering.length = 0;
  }
}

function isForwardEligible(light: Light): boolean {
  return isIlluminatingLight(light) && !excluded.has(light);
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

/** Shared authored-local ordering before clustered and conventional resource admission. */
export function sortLightsByAdmission(
  scene: Scene,
  lights: Light[],
  previous: ReadonlySet<Light>,
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
        distances.get(a)! - distances.get(b)! ||
        a.uniqueId - b.uniqueId,
    );
  } finally {
    distances.clear();
  }
}
