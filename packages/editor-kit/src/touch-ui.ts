import { useSyncExternalStore } from "react";

/**
 * Root class for the touch layout: 44px targets and rows instead of the
 * compact desktop density. The editor sets it from the Compact Mode
 * application setting; the `pointer-coarse:` Tailwind variant and touch CSS
 * read it. Gestures (long-press, hold-to-drag) follow the real pointer instead.
 */
export const TOUCH_UI_CLASS = "touch-ui";

/** Row height for lists and trees in the touch layout. */
export const TOUCH_ROW_HEIGHT = 44;

const listeners = new Set<() => void>();

export function isTouchUi(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains(TOUCH_UI_CLASS);
}

export function setTouchUi(enabled: boolean): void {
  if (typeof document === "undefined" || isTouchUi() === enabled) return;
  document.documentElement.classList.toggle(TOUCH_UI_CLASS, enabled);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the touch layout is on; re-renders when Compact Mode changes. */
export function useTouchUi(): boolean {
  return useSyncExternalStore(subscribe, isTouchUi, () => false);
}
