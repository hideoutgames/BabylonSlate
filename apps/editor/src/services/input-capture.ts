import { attachInputCapture as attachDomInputCapture } from "@haptic/input/dom";
export type { InputCaptureHandle } from "@haptic/input/dom";

/** Shared device ownership plus the editor's existing qualification inputs. */
export function attachInputCapture(canvas: HTMLCanvasElement, options: Parameters<typeof attachDomInputCapture>[1] = {}) {
  return attachDomInputCapture(canvas, { ...options,
    syntheticGamepad: () => (globalThis as { __hapticTestGamepad?: { index: number; axes: number[]; buttons: number[] } }).__hapticTestGamepad,
    syntheticTouchAxes: () => (globalThis as { __hapticTestTouchAxes?: Record<string, number> }).__hapticTestTouchAxes,
  });
}
