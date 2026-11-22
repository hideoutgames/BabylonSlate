import type { Scene } from "@babylonjs/core/scene";
import { WORLD_DEBUG_PARTS, type WorldDebugPart } from "@haptic/core";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

/** The light block's define for `shadowtaps` off: every shadow lookup returns lit. */
export const WORLD_DEBUG_NO_SHADOW_TAPS_DEFINE = "HAPTIC_DEBUG_NO_SHADOW_TAPS";
/** The light block's define for `locallights` off: no point, spot or rect light is visited. */
export const WORLD_DEBUG_NO_LOCAL_LIGHTS_DEFINE = "HAPTIC_DEBUG_NO_LOCAL_LIGHTS";
/** The surface output's define for `shading` off: the colour is one constant. */
export const WORLD_DEBUG_FLAT_DEFINE = "HAPTIC_DEBUG_FLAT";

/**
 * Per Scene, the parts a Play session's `worlddebug` switched away from their default; never saved. Scene Layers' own
 * Scenes never have any.
 */
const switched = new WeakMap<Scene, ReadonlySet<WorldDebugPart>>();
const NONE: ReadonlySet<WorldDebugPart> = new Set();

/**
 * The parts off by default: `mergedmarches`, the merged half-resolution march pass, an opt-in until a native GPU proves
 * it (`merged-marches.ts`).
 */
const DEFAULT_OFF: ReadonlySet<WorldDebugPart> = new Set(["mergedmarches"]);

/**
 * The parts that change no Material's program: those of the view's graph (`liveSceneEffectsKey`), and
 * `spritebatching`, which the Play view applies itself (`syncWorldSpriteBatching` in `create-engine.ts`).
 */
const PROGRAM_FREE_PARTS: ReadonlySet<WorldDebugPart> = new Set(["geometryonce", "geometryoncescissor", "mergedmarches", "spritebatching"]);

/** Whether `part` of the world is switched off for `scene`. */
export function worldDebugOff(scene: Scene, part: WorldDebugPart): boolean {
  return DEFAULT_OFF.has(part) !== (switched.get(scene) ?? NONE).has(part);
}

/**
 * Switches `part` on or off for `scene`; true when that changed it. A part a shader reads has every Material of the
 * Scene re-prepare its defines on its next draw (a part off compiles its variant; back on, the Material draws its own
 * program again). The geometry repeat parts and `mergedmarches` change no Material's program: they change the view's
 * graph (`liveSceneEffectsKey`), which builds again with or without the repeat pass (`geometryRepeat`), or with the
 * half-resolution marches in one pass or in their own (`SpatialEffectsGraph`).
 */
export function setSceneWorldDebug(scene: Scene, part: WorldDebugPart, enabled: boolean): boolean {
  if (worldDebugOff(scene, part) === !enabled) return false;
  const next = new Set(switched.get(scene) ?? NONE);
  if (next.has(part)) next.delete(part); else next.add(part);
  switched.set(scene, next);
  if (!PROGRAM_FREE_PARTS.has(part)) for (const material of scene.materials) material.markDirty(true);
  markSceneReadinessDirty(scene, "renderSettings");
  return true;
}

/**
 * The geometry pass's repeat (`worlddebug geometryonce off` or `geometryoncescissor off`): `full`, a second whole pass;
 * `scissor`, a second pass under a 1x1 scissor; `none`. `full` wins when both are off.
 */
export function geometryRepeat(scene: Scene): "none" | "full" | "scissor" {
  return worldDebugOff(scene, "geometryonce") ? "full" : worldDebugOff(scene, "geometryoncescissor") ? "scissor" : "none";
}

/**
 * `RenderDiagnostics.settings`' `world.debug`: the parts switched from their default, in `WORLD_DEBUG_PARTS` order (a
 * part off by default as `<part> on`), or `none`.
 */
export function worldDebugFingerprint(scene: Scene): string {
  const parts = WORLD_DEBUG_PARTS.filter((part) => (switched.get(scene) ?? NONE).has(part))
    .map((part) => DEFAULT_OFF.has(part) ? `${part} on` : part);
  return parts.length ? parts.join(",") : "none";
}
