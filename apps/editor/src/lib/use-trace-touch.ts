import { useTouchUi } from "@haptic/editor-kit";

/** Trace controls and rows use touch sizes while Compact Mode is off. */
export function useTraceTouch(): boolean {
  return useTouchUi();
}
