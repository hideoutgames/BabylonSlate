import {
  DirectionalLight,
  HemisphericLight,
  RectAreaLight,
  ShadowLight,
  Vector3,
  type Light,
  type Scene,
} from "@babylonjs/core";

import { lightingSamplerCapacity } from "./light-sampler-budget";

const authoredEnabled = new WeakMap<
  Light,
  { enabled: boolean; effective: boolean }
>();
const excluded = new WeakSet<Light>();
const forwardExcluded = new WeakSet<Light>();
const forwardSelections = new WeakMap<Scene, Set<Light>>();
/**
 * Lights a what-if admission ranks this many times nearer than they are (squared distances divide by the square), for
 * a variant prediction (`withForwardAdmissionPromotion`); empty otherwise.
 */
const admissionPromotions = new Map<Light, number>();
/** An admitted light ranks this much nearer (squared distance divided by it), so a slightly nearer one cannot displace it. */
const INCUMBENT_DISTANCE_BONUS = 1.15;
const scratchLightPosition = new Vector3();
// Per-call scratch, emptied before each call returns so no light stays retained.
const scratchCandidates: Light[] = [];
const scratchCandidateSet = new Set<Light>();
const scratchDistances = new Map<Light, number>();
const scratchLights: Light[] = [];
const scratchAuthored: boolean[] = [];

/**
 * Creation order: the stable "authored" order of a Scene's lights, which
 * order-sensitive readers (diagnostics) sort by.
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
    !forwardExcluded.has(light)
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
  return forwardExcluded.has(light) && isAuthoredLightEnabled(light);
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

/** What the Forward budget may admit in one sync. */
export type ForwardLightCapacity = { lights: number; locals: number; samplers: number };

/**
 * The selection of `syncForwardLightPolicy` (the light block's admission,
 * `selectHapticLights`). It ranks `candidates` (the eligible lights) itself,
 * pushes the lights it leaves out to `limited`, and those the sampler headroom
 * leaves out also to `samplerLimited`, and returns the lights it admits with
 * the lighting samplers they use. The policy then toggles the lights.
 */
export type ForwardLightSelection = (
  scene: Scene,
  candidates: Light[],
  previous: ReadonlySet<Light>,
  capacity: Readonly<ForwardLightCapacity>,
  limited: Light[],
  samplerLimited: Light[],
) => { admitted: Iterable<Light>; samplers: number };

/**
 * The scene's last Forward light selection, which its next selection favours (a copy; undefined before the first).
 * A load rehearsal takes it before a light change it tries and gives it back (`restoreForwardLightSelection`) once
 * the change is reverted, so the next selection ranks as if the change never happened.
 */
export function forwardLightSelection(scene: Scene): ReadonlySet<Light> | undefined {
  const selection = forwardSelections.get(scene);
  return selection && new Set(selection);
}

/** Makes `selection` (from `forwardLightSelection`) the one the scene's next Forward selection favours. */
export function restoreForwardLightSelection(scene: Scene, selection: ReadonlySet<Light> | undefined): void {
  if (selection) forwardSelections.set(scene, new Set(selection));
  else forwardSelections.delete(scene);
}

/** Scene-local selection; authored Enabled and priority are retained. */
export function syncForwardLightPolicy(
  scene: Scene,
  slots: number,
  localSlots: number,
  select: ForwardLightSelection,
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
  for (const light of scene.lights) if (isForwardEligible(light)) candidates.push(light);
  const capacity: ForwardLightCapacity = {
    lights: Math.max(0, Math.floor(slots)),
    locals: Math.max(0, Math.floor(localSlots)),
    samplers: lightingSamplerCapacity(scene),
  };
  const selected = previous;
  const limited: Light[] = [];
  const samplerLimited: Light[] = [];
  const selection = select(scene, candidates, previous, capacity, limited, samplerLimited);
  selected.clear();
  for (const light of selection.admitted) selected.add(light);
  // Decide every light before toggling any, so receivers can be prepared for
  // the whole change. Fill the candidate set once, and only when needed.
  const candidateSet = scratchCandidateSet;
  candidateSet.clear();
  const lights = scratchLights;
  const authored = scratchAuthored;
  try {
    for (const light of scene.lights) {
      const isLimited = isForwardEligible(light) && !selected.has(light);
      if (isLimited) {
        forwardExcluded.add(light);
        if (!candidateSet.size) for (const candidate of candidates) candidateSet.add(candidate);
        if (!candidateSet.has(light)) limited.push(light);
      } else forwardExcluded.delete(light);
      lights.push(light);
      authored.push(isAuthoredLightEnabled(light));
    }
    for (let index = 0; index < lights.length; index++)
      applyEnabled(lights[index]!, authored[index]!);
  } finally {
    lights.length = 0;
    authored.length = 0;
    candidates.length = 0;
    candidateSet.clear();
  }
  forwardSelections.set(scene, selected);
  return {
    requested: selected.size + limited.length,
    admitted: selected.size,
    limited,
    samplerLimited,
    samplers: selection.samplers,
  };
}

function isForwardEligible(light: Light): boolean {
  return isIlluminatingLight(light) && !excluded.has(light);
}

export function isGlobalLight(light: Light): boolean {
  return light instanceof DirectionalLight || light instanceof HemisphericLight;
}

/** A light's squared distance to the camera as the Forward ranking sees it, a what-if promotion included. */
function rankingDistanceSquared(light: Light, camera: { globalPosition: Vector3 }): number {
  const promotion = admissionPromotions.get(light) ?? 1;
  return Vector3.DistanceSquared(admissionPosition(light), camera.globalPosition) / (promotion * promotion);
}

/**
 * Runs `admit` (a lighting sync) with `light` ranked `factor` times nearer than it is, in the Forward ranking: what the budget would admit once the camera brings it that much nearer. Only a variant
 * prediction does this, on admission it then restores.
 */
export function withForwardAdmissionPromotion<T>(light: Light, factor: number, admit: () => T): T {
  admissionPromotions.set(light, factor);
  try {
    return admit();
  } finally {
    admissionPromotions.delete(light);
  }
}

/**
 * The authored local lights the Forward budget leaves out that are nearest its cut-off, in rank order: each one
 * whose distance is within `margin` times that of the farthest admitted local light (with that light's incumbent
 * bonus), so a camera move of that ratio could admit it. Empty while every candidate fits.
 */
export function nearForwardAdmissions(scene: Scene, margin: number): Light[] {
  const camera = scene.activeCamera;
  const selected = forwardSelections.get(scene);
  if (!camera || !selected?.size) return [];
  let cutoff = 0;
  const limited: [Light, number][] = [];
  for (const light of scene.lights) {
    if (!isForwardEligible(light) || isGlobalLight(light) || !isAuthoredLightEnabled(light)) continue;
    const squared = Math.max(1, rankingDistanceSquared(light, camera));
    if (selected.has(light)) cutoff = Math.max(cutoff, squared / INCUMBENT_DISTANCE_BONUS);
    else if (forwardExcluded.has(light)) limited.push([light, squared]);
  }
  if (!cutoff) return [];
  return limited.filter(([, squared]) => squared <= cutoff * margin * margin)
    .sort((a, b) => a[1] - b[1] || a[0].uniqueId - b[0].uniqueId).map(([light]) => light);
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

/** Authored-local ordering before resource admission. */
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
          ? rankingDistanceSquared(light, camera)
          : 0;
      distances.set(
        light,
        Math.max(1, squared) / (previous.has(light) ? INCUMBENT_DISTANCE_BONUS : 1),
      );
    }
    lights.sort(
      (a, b) =>
        Number(isGlobalLight(b)) - Number(isGlobalLight(a)) ||
        (Number.isFinite(b.renderPriority) ? b.renderPriority : 0) -
          (Number.isFinite(a.renderPriority) ? a.renderPriority : 0) ||
        distances.get(a)! - distances.get(b)! ||
        a.uniqueId - b.uniqueId,
    );
  } finally {
    distances.clear();
  }
}
