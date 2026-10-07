import { attachInputCapture as attachDomInputCapture } from "@babylonslate/input/dom";
export type { InputCaptureHandle } from "@babylonslate/input/dom";

/** Shared device ownership plus the editor's existing qualification inputs. */
export function attachInputCapture(canvas: HTMLCanvasElement, options: Parameters<typeof attachDomInputCapture>[1] = {}) {
  return attachDomInputCapture(canvas, { ...options,
    syntheticGamepad: () => (globalThis as { __babylonslateTestGamepad?: { index: number; axes: number[]; buttons: number[] } }).__babylonslateTestGamepad,
    syntheticTouchAxes: () => (globalThis as { __babylonslateTestTouchAxes?: Record<string, number> }).__babylonslateTestTouchAxes,
  });
}
