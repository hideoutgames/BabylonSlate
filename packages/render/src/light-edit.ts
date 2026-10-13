import type { SerializedScene } from "@babylonslate/core";
import { isComponentValueOnlySceneEdit } from "./scene-transform-edit";

/**
 * Authored light values that only reach Babylon as uniforms or as per-frame
 * reads. A Range, Intensity, Color or cone-angle edit leaves every material's
 * light defines alone, so no shader variant needs compiling or re-admitting.
 * Their readiness-relevant side effects mark readiness where they happen: an
 * intensity crossing zero toggles the light's effective Enabled state (which
 * the frame graph observes), and a Range change that moves a light across a
 * shadow, clustered-light or volumetric selection boundary changes that
 * selection's own layout, which the shadow controller, light sync and effects
 * key already detect. Anything that chooses a variant (Enabled, light kind,
 * shadow casting and priority, an area light's emission texture) is excluded.
 */
const LIGHT_VALUE_PROPERTIES: ReadonlyMap<string, readonly string[]> = new Map([
  ["LightComponent", ["color", "intensity", "range", "innerAngle", "outerAngle"]],
  ["HemisphericFillLightComponent", ["color", "groundColor", "intensity"]],
  ["AreaRectLightComponent", ["color", "intensity", "width", "height"]],
]);

/** Light values changed and nothing else; EditorSceneSync still applies them in place. */
export function isLightValueOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  return isComponentValueOnlySceneEdit(previous, next, LIGHT_VALUE_PROPERTIES);
}
