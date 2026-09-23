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

export function isAuthoredLightEnabled(light: Light): boolean {
  const current = light.isEnabled(false);
  const previous = authoredEnabled.get(light);
  return !previous || current !== previous.effective
    ? current
    : previous.enabled;
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

/** Authored state stays separate from Babylon's effective illumination state. */
export function setAuthoredLightEnabled(light: Light, enabled: boolean): void {
  applyEnabled(light, enabled);
  syncDirectionalLightPolicy(light.getScene());
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
    const illuminating =
      enabled &&
      light.intensity > 0 &&
      (!light.parent || light.parent.isEnabled());
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
} {
  syncDirectionalLightPolicy(scene);
  const previous = forwardSelections.get(scene) ?? new Set<Light>();
  const eligible = (light: Light) =>
    isAuthoredLightEnabled(light) &&
    light.intensity > 0 &&
    !excluded.has(light) &&
    (!light.parent || light.parent.isEnabled());
  const global = isGlobalLight;
  const local = (light: Light) =>
    !global(light) && !isManagedClusteredLight(scene, light);
  const candidates = scene.lights.filter(
    (light) =>
      eligible(light) &&
      (!local(light) || isClusteredLocalAllowed(scene, light)),
  );
  const capacity = Math.max(0, Math.floor(slots));
  const localCapacity = Math.max(0, Math.floor(localSlots));
  const samplerCapacity = lightingSamplerCapacity(scene);
  if (
    candidates.length > capacity ||
    candidates.filter(local).length > localCapacity ||
    lightSamplerCount(scene, candidates) > samplerCapacity
  )
    candidates.sort(compareLightAdmission(scene, candidates, previous));
  const selected = previous;
  selected.clear();
  let selectedLocals = 0;
  let samplers = 0, hasArea = false;
  const limited: Light[] = [];
  const samplerLimited: Light[] = [];
  for (const light of candidates) {
    const authoredLocal = local(light);
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
  for (const light of scene.lights) {
    const enabled = isAuthoredLightEnabled(light);
    if (eligible(light) && !selected.has(light)) {
      forwardExcluded.add(light);
      if (!candidates.includes(light)) limited.push(light);
    } else forwardExcluded.delete(light);
    applyEnabled(light, enabled);
  }
  forwardSelections.set(scene, selected);
  return {
    requested: selected.size + limited.length,
    admitted: selected.size,
    limited,
    samplerLimited,
    samplers,
  };
}

function isGlobalLight(light: Light): boolean {
  return light instanceof DirectionalLight || light instanceof HemisphericLight;
}

/** Shared authored-local ordering before clustered and conventional resource admission. */
export function compareLightAdmission(
  scene: Scene,
  candidates: readonly Light[],
  previous: ReadonlySet<Light>,
): (a: Light, b: Light) => number {
  const camera = scene.activeCamera;
  camera?.getViewMatrix();
  const distances = new Map<Light, number>();
  for (const light of candidates) {
    if (light instanceof ShadowLight && !isGlobalLight(light)) {
      // Excluded children never reach normal shader binding. Refresh parented
      // positions before either quality or shader-capacity selection.
      light.parent?.computeWorldMatrix(true);
      light.computeTransformedInformation();
    }
    const squared =
      camera && !isGlobalLight(light)
        ? Vector3.DistanceSquared(
            light instanceof ShadowLight && !light.parent
              ? light.position
              : light.getAbsolutePosition(),
            camera.globalPosition,
          )
        : 0;
    distances.set(
      light,
      Math.max(1, squared) / (previous.has(light) ? 1.15 : 1),
    );
  }
  return (a, b) =>
    Number(isGlobalLight(b)) - Number(isGlobalLight(a)) ||
    Number(isManagedClusteredLight(scene, b)) -
      Number(isManagedClusteredLight(scene, a)) ||
    (Number.isFinite(b.renderPriority) ? b.renderPriority : 0) -
      (Number.isFinite(a.renderPriority) ? a.renderPriority : 0) ||
    distances.get(a)! - distances.get(b)! ||
    a.uniqueId - b.uniqueId;
}
