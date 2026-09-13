import {
  DirectionalLight,
  HemisphericLight,
  ShadowLight,
  Vector3,
  type Light,
  type Scene,
} from "@babylonjs/core";

const authoredEnabled = new WeakMap<
  Light,
  { enabled: boolean; effective: boolean }
>();
const excluded = new WeakSet<Light>();
const forwardExcluded = new WeakSet<Light>();
const forwardSelections = new WeakMap<Scene, Set<Light>>();

function requestedEnabled(light: Light): boolean {
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
    !forwardExcluded.has(light);
  const previous = authoredEnabled.get(light);
  if (previous) {
    previous.enabled = enabled;
    previous.effective = effective;
  } else authoredEnabled.set(light, { enabled, effective });
  if (light.isEnabled(false) !== effective) light.setEnabled(effective);
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
  return forwardExcluded.has(light) && requestedEnabled(light);
}

/** Stable scene order selects one enabled sun, regardless of shadow settings. */
export function syncDirectionalLightPolicy(scene: Scene): void {
  let owner: Light | undefined;
  for (const light of scene.lights) {
    if (!(light instanceof DirectionalLight)) continue;
    const enabled = requestedEnabled(light);
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
): {
  requested: number;
  admitted: number;
  limited: Light[];
} {
  syncDirectionalLightPolicy(scene);
  const previous = forwardSelections.get(scene) ?? new Set<Light>();
  const camera = scene.activeCamera;
  camera?.getViewMatrix();
  const eligible = (light: Light) =>
    requestedEnabled(light) &&
    light.intensity > 0 &&
    !excluded.has(light) &&
    (!light.parent || light.parent.isEnabled());
  const candidates = scene.lights.filter(eligible);
  const global = (light: Light) =>
    light instanceof DirectionalLight || light instanceof HemisphericLight;
  const distance = (light: Light) => {
    const squared =
      camera && !global(light)
        ? Vector3.DistanceSquared(
            light instanceof ShadowLight && !light.parent
              ? light.position
              : light.getAbsolutePosition(),
            camera.globalPosition,
          )
        : 0;
    // An incumbent remains selected around equal-distance boundaries. A clearly
    // nearer light or explicitly higher renderPriority still replaces it.
    return Math.max(1, squared) / (previous.has(light) ? 1.15 : 1);
  };
  const capacity = Math.max(0, Math.floor(slots));
  if (candidates.length > capacity) {
    if (camera) {
      for (const light of candidates) {
        if (!(light instanceof ShadowLight) || global(light)) continue;
        // Excluded lights do not reach Babylon's shader binding path, which
        // normally refreshes this cached position. Update ancestors too, even
        // when admission runs again before the next scene render.
        light.parent?.computeWorldMatrix(true);
        light.computeTransformedInformation();
      }
    }
    candidates.sort(
      (a, b) =>
        Number(global(b)) - Number(global(a)) ||
        (Number.isFinite(b.renderPriority) ? b.renderPriority : 0) -
          (Number.isFinite(a.renderPriority) ? a.renderPriority : 0) ||
        distance(a) - distance(b) ||
        a.uniqueId - b.uniqueId,
    );
  }
  const selected = previous;
  selected.clear();
  for (let index = 0; index < Math.min(capacity, candidates.length); index++)
    selected.add(candidates[index]!);
  const limited = candidates.slice(capacity);
  for (const light of scene.lights) {
    const enabled = requestedEnabled(light);
    if (eligible(light) && !selected.has(light)) forwardExcluded.add(light);
    else forwardExcluded.delete(light);
    applyEnabled(light, enabled);
  }
  forwardSelections.set(scene, selected);
  return { requested: candidates.length, admitted: selected.size, limited };
}
