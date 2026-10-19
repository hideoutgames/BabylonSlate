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
  canonicalizeForwardLightSlots,
  exchangeForwardLightSlots,
  NO_FORWARD_LIGHT_SLOT_EXCHANGES,
  settleForwardLightSlots,
  type ForwardLightSlotExchange,
} from "./forward-light-slots";
import { lightingSamplerCapacity, lightSamplerCost, lightSamplerCount } from "./light-sampler-budget";
import { receiverSignature } from "./shadow-receiver-handoff";

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
const scratchRanked = new Set<Light>();
const scratchStable = new Set<Light>();
const scratchKinds = new Map<Light, string>();
const scratchQuotas = new Map<string, number>();
const scratchOrder: Light[] = [];
const scratchRest: Light[] = [];

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
  const capacity: Capacity = {
    lights: Math.max(0, Math.floor(slots)),
    locals: Math.max(0, Math.floor(localSlots)),
    samplers: lightingSamplerCapacity(scene),
  };
  if (
    candidates.length > capacity.lights ||
    countLocals(scene, candidates) > capacity.locals ||
    lightSamplerCount(scene, candidates) > capacity.samplers
  ) {
    sortLightsByAdmission(scene, candidates, previous);
    // Clustered Forward orders lights itself; light sorting re-sorts every receiver.
    if (!hasClusteredLightPolicy(scene) && !scene.requireLightSorting)
      keepAdmittedSlotKinds(scene, candidates, previous, capacity);
  }
  const selected = previous;
  selected.clear();
  const limited: Light[] = [];
  const samplerLimited: Light[] = [];
  const samplers = admit(scene, candidates, capacity, selected, limited, samplerLimited);
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
    const transition = exchangeSlots(scene, lights, authored, budget);
    exchanges = transition.exchanges;
    for (let index = 0; index < lights.length; index++)
      applyEnabled(lights[index]!, authored[index]!);
    settleForwardLightSlots(scene, exchanges);
    // Receivers refresh unless every toggle was a preserved exchange; then the
    // canonical order makes their defines a function of the admitted set.
    if (
      transition.leaving + transition.entering > 0 &&
      (exchanges.length !== transition.leaving ||
        exchanges.length !== transition.entering ||
        exchanges.some(({ preserved }) => !preserved))
    )
      canonicalizeForwardLightSlots(scene, (light) => isAuthoredLocal(scene, light));
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

type Capacity = { lights: number; locals: number; samplers: number };

/**
 * The budget's selection: admits `candidates` in order while the shader slots,
 * the local-light budget and the lighting samplers allow. Returns the samplers
 * the admitted lights use.
 */
function admit(
  scene: Scene,
  candidates: readonly Light[],
  capacity: Capacity,
  selected: Set<Light>,
  limited?: Light[],
  samplerLimited?: Light[],
): number {
  let selectedLocals = 0;
  let samplers = 0, hasArea = false;
  for (const light of candidates) {
    const authoredLocal = isAuthoredLocal(scene, light);
    const samplerCost = lightSamplerCost(scene, light, hasArea);
    if (selected.size >= capacity.lights || (authoredLocal && selectedLocals >= capacity.locals))
      limited?.push(light);
    else if (samplers + samplerCost > capacity.samplers) {
      limited?.push(light);
      samplerLimited?.push(light);
    } else {
      selected.add(light);
      samplers += samplerCost;
      hasArea ||= light instanceof RectAreaLight;
      if (authoredLocal) selectedLocals++;
    }
  }
  return samplers;
}

/**
 * How much nearer the camera a light of another slot kind must be before the
 * Forward budget changes which kinds it admits: it keeps its current mix
 * unless that would keep a light more than this many times farther away than
 * the nearest light it leaves out instead (or one with a lower Light Priority).
 * Every lit material compiles a new shader the first time the admitted kinds
 * change (a point admitted for a shadowed spot); a swap between lights of one
 * kind compiles nothing. Going back takes the same margin, so the mix does not
 * flip at a boundary.
 */
export const FORWARD_KIND_CHANGE_DISTANCE_RATIO = 1.25;

/**
 * When the ranked selection would change the admitted local lights' mix of
 * slot kinds (`receiverSignature`: type, cast shadows and the other per-light
 * defines), reorder `candidates` so each kind first fills as many places as it
 * held before (its nearest lights by rank), unless that keeps a light more than
 * FORWARD_KIND_CHANGE_DISTANCE_RATIO times farther than the light the ranked
 * selection would admit in its place.
 */
function keepAdmittedSlotKinds(scene: Scene, candidates: Light[], previous: ReadonlySet<Light>, capacity: Capacity): void {
  if (!previous.size) return;
  const ranked = scratchRanked;
  const stable = scratchStable;
  const kinds = scratchKinds;
  const quotas = scratchQuotas;
  try {
    admit(scene, candidates, capacity, ranked);
    // Most syncs keep their selection, and every unchanged one ends here.
    let unchanged = ranked.size === previous.size;
    for (const light of ranked) if (unchanged && !previous.has(light)) unchanged = false;
    if (unchanged) return;
    const kind = (light: Light) => {
      let value = kinds.get(light);
      if (value === undefined) kinds.set(light, (value = receiverSignature(light)));
      return value;
    };
    const change = (set: ReadonlySet<Light>, light: Light, delta: number) => {
      if (set.has(light) && isAuthoredLocal(scene, light)) quotas.set(kind(light), (quotas.get(kind(light)) ?? 0) + delta);
    };
    for (const light of candidates) {
      change(previous, light, 1);
      change(ranked, light, -1);
    }
    let sameKinds = true;
    for (const count of quotas.values()) if (count !== 0) sameKinds = false;
    if (sameKinds) return;
    // Places per kind the previous selection held, counting only lights still eligible.
    quotas.clear();
    for (const light of candidates) change(previous, light, 1);
    const order = scratchOrder;
    const rest = scratchRest;
    for (const light of candidates) {
      const quota = isAuthoredLocal(scene, light) ? (quotas.get(kind(light)) ?? 0) : 1;
      if (quota > 0) {
        if (isAuthoredLocal(scene, light)) quotas.set(kind(light), quota - 1);
        order.push(light);
      } else rest.push(light);
    }
    order.push(...rest);
    admit(scene, order, capacity, stable);
    // The nearest light only the ranked selection admits, the farthest only the stable one keeps.
    let entering: Light | undefined;
    let kept: Light | undefined;
    for (const light of candidates) {
      if (!entering && ranked.has(light) && !stable.has(light)) entering = light;
      if (stable.has(light) && !ranked.has(light)) kept = light;
    }
    if (!kept) return;
    if (entering) {
      const priority = (light: Light) => (Number.isFinite(light.renderPriority) ? light.renderPriority : 0);
      if (priority(kept) < priority(entering)) return;
      const camera = scene.activeCamera;
      if (camera) {
        const distance = (light: Light) => Vector3.DistanceSquared(admissionPosition(light), camera.globalPosition);
        if (distance(kept) > distance(entering) * FORWARD_KIND_CHANGE_DISTANCE_RATIO ** 2) return;
      }
    }
    candidates.length = 0;
    candidates.push(...order);
  } finally {
    ranked.clear();
    stable.clear();
    kinds.clear();
    quotas.clear();
    scratchOrder.length = 0;
    scratchRest.length = 0;
  }
}

type SlotTransition = {
  exchanges: readonly ForwardLightSlotExchange[];
  /** Local lights the budget turns off and on in this sync. */
  leaving: number;
  entering: number;
};
const NO_SLOT_TRANSITION: SlotTransition = { exchanges: NO_FORWARD_LIGHT_SLOT_EXCHANGES, leaving: 0, entering: 0 };

/**
 * Lights the budget admits this sync take the shader indices of those it
 * drops. Authored Enabled, intensity and parent changes keep Babylon's order.
 */
function exchangeSlots(
  scene: Scene,
  lights: readonly Light[],
  authored: readonly boolean[],
  budget: readonly BudgetChange[],
): SlotTransition {
  // Clustered Forward orders lightSources itself; Babylon re-sorts a scene
  // that requires light sorting whenever a light is added or removed.
  if (hasClusteredLightPolicy(scene) || scene.requireLightSorting)
    return NO_SLOT_TRANSITION;
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
    return {
      exchanges: entering.length
        ? exchangeForwardLightSlots(scene, leaving, entering)
        : NO_FORWARD_LIGHT_SLOT_EXCHANGES,
      leaving: leaving.length,
      entering: entering.length,
    };
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
