import type { Scene } from "@babylonjs/core/scene";
import { SHADOW_DEBUG_PARTS, type ShadowDebugPart } from "@haptic/core";
import { renderSettingsOwner } from "./render-settings";

/** Per settings owner, the parts (`SHADOW_DEBUG_PARTS`) a Play session's `shadowdebug` switched off; never saved. */
const off = new WeakMap<Scene, ReadonlySet<ShadowDebugPart>>();
const NONE: ReadonlySet<ShadowDebugPart> = new Set();

/** Whether `part` of shadow drawing is switched off for `scene` (through its settings owner, so its views follow it). */
export function shadowDebugOff(scene: Scene, part: ShadowDebugPart): boolean {
  return (off.get(renderSettingsOwner(scene)) ?? NONE).has(part);
}

/**
 * Switches `part` on or off for `scene`'s owner; true when that changed it. Apply it through
 * `SceneShadowController.setDebug`, which also has every map draw again.
 */
export function writeSceneShadowDebug(scene: Scene, part: ShadowDebugPart, enabled: boolean): boolean {
  const owner = renderSettingsOwner(scene), current = off.get(owner) ?? NONE;
  if (current.has(part) === !enabled) return false;
  const next = new Set(current);
  if (enabled) next.delete(part); else next.add(part);
  off.set(owner, next);
  return true;
}

/** `RenderDiagnostics.settings`' `shadows.debug`: the parts switched off, in `SHADOW_DEBUG_PARTS` order, or `none`. */
export function shadowDebugFingerprint(scene: Scene): string {
  const parts = SHADOW_DEBUG_PARTS.filter((part) => shadowDebugOff(scene, part));
  return parts.length ? parts.join(",") : "none";
}
