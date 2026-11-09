import type { Scene } from "@babylonjs/core/scene";
import { WATER_DEBUG_PARTS, type WaterDebugPart } from "@haptic/core";
import { renderSettingsOwner } from "./render-settings";

/** Water nodes' define for `waves` off: the Water Waves node samples no spectrum per pixel. */
export const WATER_DEBUG_NO_WAVES_DEFINE = "SLATE_WATER_DEBUG_NO_WAVES";
/** Water nodes' define for `foam` off: the Water Foam node draws no shore, contact or edge foam. */
export const WATER_DEBUG_NO_FOAM_DEFINE = "SLATE_WATER_DEBUG_NO_FOAM";

/** Per settings owner, the parts (`WATER_DEBUG_PARTS`) a Play session's `waterdebug` switched off; never saved. */
const off = new WeakMap<Scene, ReadonlySet<WaterDebugPart>>();
const NONE: ReadonlySet<WaterDebugPart> = new Set();

/** The water parts switched off for `scene` (through its settings owner, so captures and layers follow its world). */
export function sceneWaterDebugOff(scene: Scene): ReadonlySet<WaterDebugPart> {
  return off.get(renderSettingsOwner(scene)) ?? NONE;
}

/** Whether `part` of water is switched off for `scene`. */
export function waterDebugOff(scene: Scene, part: WaterDebugPart): boolean {
  return sceneWaterDebugOff(scene).has(part);
}

/**
 * Switches `part` on or off for `scene`'s owner; true when that changed it. Apply it through `setSceneWaterDebug`
 * (`water-mesh.ts`), which also hides the surfaces and re-prepares their Materials.
 */
export function writeSceneWaterDebug(scene: Scene, part: WaterDebugPart, enabled: boolean): boolean {
  const owner = renderSettingsOwner(scene), current = sceneWaterDebugOff(owner);
  if (current.has(part) === !enabled) return false;
  const next = new Set(current);
  if (enabled) next.delete(part); else next.add(part);
  off.set(owner, next);
  return true;
}

/** `RenderDiagnostics.settings`' `water.debug`: the parts switched off, in `WATER_DEBUG_PARTS` order, or `none`. */
export function waterDebugFingerprint(scene: Scene): string {
  const parts = WATER_DEBUG_PARTS.filter((part) => waterDebugOff(scene, part));
  return parts.length ? parts.join(",") : "none";
}
