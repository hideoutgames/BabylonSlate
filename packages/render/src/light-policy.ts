import { DirectionalLight, type Light, type Scene } from "@babylonjs/core";

const authoredEnabled = new WeakMap<
  Light,
  { enabled: boolean; effective: boolean }
>();
const excluded = new WeakSet<Light>();

/** Authored state stays separate from Babylon's effective illumination state. */
export function setAuthoredLightEnabled(light: Light, enabled: boolean): void {
  authoredEnabled.set(light, {
    enabled,
    effective: enabled && !excluded.has(light),
  });
  light.setEnabled(enabled && !excluded.has(light));
  syncDirectionalLightPolicy(light.getScene());
}

export function isDirectionalLightExcluded(light: Light): boolean {
  return excluded.has(light);
}

/** Stable scene order selects one enabled sun, regardless of shadow settings. */
export function syncDirectionalLightPolicy(scene: Scene): void {
  let owner: Light | undefined;
  for (const light of scene.lights) {
    if (!(light instanceof DirectionalLight)) continue;
    const current = light.isEnabled(false);
    const previous = authoredEnabled.get(light);
    const enabled =
      !previous || current !== previous.effective ? current : previous.enabled;
    const blocked = enabled && owner !== undefined;
    if (enabled && !owner) owner = light;
    if (blocked) excluded.add(light);
    else excluded.delete(light);
    authoredEnabled.set(light, { enabled, effective: enabled && !blocked });
    if (light.isEnabled(false) !== (enabled && !blocked))
      light.setEnabled(enabled && !blocked);
  }
}
