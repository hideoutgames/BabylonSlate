/**
 * Hold and double-tap timing for editor gestures (Engine Settings →
 * Accessibility → Hold Time and Double-Tap Time). The editor sets it from its
 * settings; gestures read it when they start, so a change applies to the next
 * press. Native `dblclick` and the platform's own drag holds keep the system's
 * timing.
 */

/** Default hold before a stationary press opens a context menu. */
export const CONTEXT_MENU_LONG_PRESS_MS = 500;

/** Default hold before a pointer-down can become a reorder drag: half the menu hold. */
export const DRAG_ARM_MS = 250;

/** Default longest gap between the two taps of a double-tap. */
export const DOUBLE_TAP_MS = 350;

let holdMs = CONTEXT_MENU_LONG_PRESS_MS;
let doubleTapMs = DOUBLE_TAP_MS;

export function setGestureTiming(timing: { holdMs: number; doubleTapMs: number }): void {
  holdMs = timing.holdMs;
  doubleTapMs = timing.doubleTapMs;
}

/** Hold before a stationary press opens a menu (or a timeline or curve hold acts). */
export function holdDelayMs(): number {
  return holdMs;
}

/** Hold before a press can become a drag (reorder, marquee): half the menu hold. */
export function dragArmDelayMs(): number {
  return Math.round(holdMs / 2);
}

/** Longest gap between the two taps of a double-tap. */
export function doubleTapWindowMs(): number {
  return doubleTapMs;
}
