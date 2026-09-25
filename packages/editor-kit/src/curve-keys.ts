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

/** Rounds away float noise from repeated nudges before values are stored. */
export function roundKeyTime(t: number): number {
  return Math.round(t * 10000) / 10000;
}

/** Endpoints stay at 0 and 1; interior keys stay between their neighbours. */
export function clampKeyTime(
  times: readonly number[],
  index: number,
  t: number,
): number {
  const last = times.length - 1;
  if (index <= 0) return 0;
  if (index >= last) return 1;
  const low = times[index - 1]! + KEY_NEIGHBOUR_GAP;
  const high = times[index + 1]! - KEY_NEIGHBOUR_GAP;
  if (low > high) return times[index]!;
  return roundKeyTime(clampNumber(t, low, high));
}

/** Midpoint of the widest gap, or null when no gap can take another key. */
export function widestGapInsertion(
  times: readonly number[],
): { index: number; t: number } | null {
  let best = -1;
  let index = -1;
  for (let i = 0; i + 1 < times.length; i += 1) {
    const gap = times[i + 1]! - times[i]!;
    if (gap > best) {
      best = gap;
      index = i + 1;
    }
  }
  if (index < 0 || best < KEY_NEIGHBOUR_GAP * 2) return null;
  return { index, t: roundKeyTime((times[index - 1]! + times[index]!) / 2) };
}

/**
 * Coarse-pointer hit width as a fraction of the track: the distance to the
 * nearest neighbour, so enlarged boxes centred on each key never overlap.
 */
export function keyHitFraction(times: readonly number[], index: number): number {
  const left = index > 0 ? times[index]! - times[index - 1]! : 1;
  const right = index < times.length - 1 ? times[index + 1]! - times[index]! : 1;
  return Math.max(0, Math.min(left, right, 1));
}

/** Linear sample, matching how Babylon lerps factor gradients between keys. */
export function sampleCurve(keys: readonly CurveKey[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0]!.t) return keys[0]!.value;
  for (let i = 1; i < keys.length; i += 1) {
    const next = keys[i]!;
    if (t <= next.t) {
      const previous = keys[i - 1]!;
      const span = next.t - previous.t;
      const f = span > 0 ? (t - previous.t) / span : 0;
      return previous.value + (next.value - previous.value) * f;
    }
  }
  return keys[keys.length - 1]!.value;
}

/** Linear RGBA sample between the surrounding stops. */
export function sampleGradient(
  stops: readonly GradientStop[],
  t: number,
): GradientStop["color"] {
  const first = stops[0];
  if (!first) return [0, 0, 0, 0];
  if (t <= first.t) return [...first.color];
  for (let i = 1; i < stops.length; i += 1) {
    const next = stops[i]!;
    if (t <= next.t) {
      const previous = stops[i - 1]!;
      const span = next.t - previous.t;
      const f = span > 0 ? (t - previous.t) / span : 0;
      return previous.color.map(
        (channel, index) => channel + (next.color[index]! - channel) * f,
      ) as GradientStop["color"];
    }
  }
  return [...stops[stops.length - 1]!.color];
}
