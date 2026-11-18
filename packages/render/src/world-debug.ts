import type { Scene } from "@babylonjs/core/scene";
import { WORLD_DEBUG_PARTS, type WorldDebugPart } from "@haptic/core";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

/** The light block's define for `shadowtaps` off: every shadow lookup returns lit. */
export const WORLD_DEBUG_NO_SHADOW_TAPS_DEFINE = "HAPTIC_DEBUG_NO_SHADOW_TAPS";
/** The light block's define for `locallights` off: no point, spot or rect light is visited. */
export const WORLD_DEBUG_NO_LOCAL_LIGHTS_DEFINE = "HAPTIC_DEBUG_NO_LOCAL_LIGHTS";
/** The surface output's define for `shading` off: the colour is one constant. */
export const WORLD_DEBUG_FLAT_DEFINE = "HAPTIC_DEBUG_FLAT";

/** Per Scene, the parts a Play session's `worlddebug` switched off; never saved. Scene Layers' own Scenes never have any. */
const off = new WeakMap<Scene, ReadonlySet<WorldDebugPart>>();
const NONE: ReadonlySet<WorldDebugPart> = new Set();

/** Whether `part` of the world is switched off for `scene`. */
export function worldDebugOff(scene: Scene, part: WorldDebugPart): boolean {
  return (off.get(scene) ?? NONE).has(part);
}

/**
 * Switches `part` on or off for `scene`; true when that changed it. Every Material of the Scene re-prepares its defines
 * on its next draw (a part off compiles its variant; back on, the Material draws its own program again).
 */
export function setSceneWorldDebug(scene: Scene, part: WorldDebugPart, enabled: boolean): boolean {
  const current = off.get(scene) ?? NONE;
  if (current.has(part) === !enabled) return false;
  const next = new Set(current);
  if (enabled) next.delete(part); else next.add(part);
  off.set(scene, next);
  for (const material of scene.materials) material.markDirty(true);
  markSceneReadinessDirty(scene, "renderSettings");
  return true;
}

/** `RenderDiagnostics.settings`' `world.debug`: the parts switched off, in `WORLD_DEBUG_PARTS` order, or `none`. */
export function worldDebugFingerprint(scene: Scene): string {
  const parts = WORLD_DEBUG_PARTS.filter((part) => worldDebugOff(scene, part));
  return parts.length ? parts.join(",") : "none";
}
