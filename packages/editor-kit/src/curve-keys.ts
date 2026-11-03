/** Key math shared by CurveField and GradientField (keys sorted by `t` in 0–1). */

/** One curve key; `t` runs 0–1 along the axis. */
export type CurveKey = { t: number; value: number };
/** One gradient stop; `color` is RGBA 0–1. */
export type GradientStop = { t: number; color: [number, number, number, number] };

/** Interior keys stay at least this far from their neighbours. */
export const KEY_NEIGHBOUR_GAP = 0.01;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
