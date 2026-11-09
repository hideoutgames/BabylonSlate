import {
  setGestureTiming,
  setReducedMotion,
  setScrubSnapStrength,
  subscribeSystemReducedMotion,
  systemPrefersReducedMotion,
} from "@haptic/editor-kit";
import type { EngineSettings } from "@haptic/vfs";

/** The `--touch-target` token Touch Target Size multiplies. */
export const BASE_TOUCH_TARGET_PX = 44;

export type AccessibilityPresentation = Pick<
  EngineSettings,
  "touchTargetScale" | "textSizePercent" | "holdTimeMs" | "doubleTapTimeMs" | "numberSnapStrength"
>;

/**
 * Applies the Engine Settings → Accessibility values that live outside React:
 * the root touch target and font size, gesture timing and scrub snapping.
 * Defaults clear the root overrides so the stylesheet tokens apply.
 */
export function applyAccessibilityPresentation(
  settings: AccessibilityPresentation,
  root: HTMLElement = document.documentElement,
): void {
  if (settings.touchTargetScale === 1) root.style.removeProperty("--touch-target");
  else root.style.setProperty("--touch-target", `${BASE_TOUCH_TARGET_PX * settings.touchTargetScale}px`);
  root.style.fontSize = settings.textSizePercent === 100 ? "" : `${settings.textSizePercent}%`;
  setGestureTiming({ holdMs: settings.holdTimeMs, doubleTapMs: settings.doubleTapTimeMs });
  setScrubSnapStrength(settings.numberSnapStrength);
}

/**
 * Keeps `data-reduced-motion` current for Reduce Motion: On and Off override
 * the device; System follows it, including later changes. Returns the cleanup.
 */
export function followReduceMotion(mode: EngineSettings["reduceMotion"]): () => void {
  const apply = () =>
    setReducedMotion(mode === "on" || (mode === "system" && systemPrefersReducedMotion()));
  apply();
  return mode === "system" ? subscribeSystemReducedMotion(apply) : () => {};
}
