import { attachInputCapture as attachDomInputCapture } from "@haptic/input/dom";
export type { InputCaptureHandle } from "@haptic/input/dom";

/** Shared device ownership plus the editor's existing qualification inputs. */
export function attachInputCapture(canvas: HTMLCanvasElement, options: Parameters<typeof attachDomInputCapture>[1] = {}) {
  // Browser tests drive a synthetic gamepad only in bundles that can enter Test Mode; the build folds this condition,
  // so production output keeps no test hook.
  if (!(import.meta.env.DEV || import.meta.env.VITE_TEST_MODE === "true" || import.meta.env.VITE_TEST_QUERY === "true")) {
    return attachDomInputCapture(canvas, options);
  }
  return attachDomInputCapture(canvas, { ...options,
    syntheticGamepad: () => (globalThis as { __hapticTestGamepad?: { index: number; axes: number[]; buttons: number[] } }).__hapticTestGamepad,
  });
}
