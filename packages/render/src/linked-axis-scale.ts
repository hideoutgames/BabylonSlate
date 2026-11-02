import type { ViewportMode } from "@haptic/core";

export type ScaleVector = [number, number, number];

/**
 * Scale after an axis handle drag while Scale is linked: the dragged axis
 * takes `value` and the other shown axes (X and Y in 2D, all three in 3D)
 * scale from `start` by the same factor, matching the Inspector's linked
 * Scale field. A zero start axis has no factor, so every shown axis takes
 * `value`; hidden axes keep their start.
 */
export function linkedAxisScale(
  start: Readonly<ScaleVector>,
  axis: 0 | 1 | 2,
  value: number,
  mode: ViewportMode,
): ScaleVector {
  const shown = mode === "2d" ? 2 : 3;
  const from = start[axis];
  const next: ScaleVector = [...start];
  for (let index = 0; index < shown; index++) {
    if (index === axis || from === 0) next[index] = value;
    else next[index] = start[index] * (value / from);
  }
  return next;
}
