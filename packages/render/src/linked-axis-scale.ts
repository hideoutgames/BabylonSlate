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

/**
 * A linked owner's scale after a group drag changed its axes freely: the
 * shown axis that changed most relative to `start` carries its factor to the
 * other shown axes (`linkedAxisScale`); hidden axes keep `current`. An
 * unchanged scale stays as it is.
 */
export function linkedScaleFromChange(
  start: Readonly<ScaleVector>,
  current: Readonly<ScaleVector>,
  mode: ViewportMode,
): ScaleVector {
  const shown = mode === "2d" ? 2 : 3;
  let axis: 0 | 1 | 2 | null = null;
  let most = 1e-9;
  for (let index = 0; index < shown; index++) {
    const from = start[index];
    const change = from === 0 ? Math.abs(current[index]) : Math.abs(current[index] / from - 1);
    if (change > most) {
      most = change;
      axis = index as 0 | 1 | 2;
    }
  }
  if (axis === null) return [...current];
  const next = linkedAxisScale(start, axis, current[axis], mode);
  for (let index = shown; index < 3; index++) next[index] = current[index];
  return next;
}
