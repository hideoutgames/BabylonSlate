import { EASING_CURVES, sampleEasingCurve, type EasingCurve } from "./easing";
import type { Rng } from "./math-rng";

/**
 * Curve and range values shared by script nodes, the Inspector editors, Curve assets and the Timeline.
 * Values are plain objects keyed by Structure field name (`Min`, `Keys`, `Time`, ...), so a value read from
 * a variable, a Data Tree entry or a Curve asset is evaluated as it is.
 */

export const ENGINE_CURVE_INTERPOLATION_ENUM_ID = "engine:CurveInterpolation";
export const ENGINE_CURVE_EXTRAPOLATION_ENUM_ID = "engine:CurveExtrapolation";

/** Stable order: index values resolve through this list. The easing curves follow, without a second Linear. */
export const CURVE_INTERPOLATIONS = [
  "constant", "linear", "auto", "custom",
  ...EASING_CURVES.filter((curve) => curve !== "linear"),
] as const;
export type CurveInterpolation = "constant" | "linear" | "auto" | "custom" | EasingCurve;

export const CURVE_EXTRAPOLATIONS = ["constant", "linear", "cycle", "oscillate"] as const;
export type CurveExtrapolation = (typeof CURVE_EXTRAPOLATIONS)[number];

/** Keys closer than this in time are pushed apart, so every segment has a positive duration. */
export const MIN_CURVE_KEY_GAP = 0.001;

export interface Vec2Value { x: number; y: number }
export interface Vec3Value { x: number; y: number; z: number }
/** RGBA, as the Color pin type stores it. */
export interface ColorValue { x: number; y: number; z: number; w: number }
export interface RotatorValue { pitch: number; yaw: number; roll: number }

export interface CurveKey<V> {
  Time: number;
  Value: V;
  /** How the segment that starts at this key reaches the next key. */
  Interpolation: CurveInterpolation;
  /** Slope per second into this key, per channel; used when the key is Custom. */
  ArriveTangent: V;
  /** Slope per second out of this key, per channel; used when the key is Custom. */
  LeaveTangent: V;
}

export interface Curve<V> {
  /** Sorted by time, at least `MIN_CURVE_KEY_GAP` apart. */
  Keys: CurveKey<V>[];
  Before: CurveExtrapolation;
  After: CurveExtrapolation;
}

export interface Range<V> { Min: V; Max: V }

export type CurveKind = "float" | "vec3" | "color";
export type RangeKind = "int" | "float" | "vec2" | "vec3" | "rotator";

export type CurveValueOf<K extends CurveKind> = K extends "float" ? number : K extends "vec3" ? Vec3Value : ColorValue;
export type RangeValueOf<K extends RangeKind> =
  K extends "int" | "float" ? number : K extends "vec2" ? Vec2Value : K extends "vec3" ? Vec3Value : RotatorValue;

type AnyValue = number | Vec2Value | Vec3Value | ColorValue | RotatorValue;
type ValueKind = CurveKind | RangeKind;

const CHANNELS: Record<ValueKind, readonly string[]> = {
  int: [],
  float: [],
  vec2: ["x", "y"],
  vec3: ["x", "y", "z"],
  color: ["x", "y", "z", "w"],
  rotator: ["pitch", "yaw", "roll"],
};

function channelCount(kind: ValueKind): number {
  return kind === "int" || kind === "float" ? 1 : CHANNELS[kind].length;
}

function finite(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Reads one channel of a loosely typed value; missing or non-finite channels read 0. */
function channel(value: unknown, kind: ValueKind, index: number): number {
  if (kind === "int" || kind === "float") return finite(value);
  if (!value || typeof value !== "object") return 0;
  return finite((value as Record<string, unknown>)[CHANNELS[kind][index]!]);
}

function compose(kind: ValueKind, read: (index: number) => number): AnyValue {
  switch (kind) {
    case "int": return Math.trunc(read(0));
    case "float": return read(0);
    case "vec2": return { x: read(0), y: read(1) };
    case "vec3": return { x: read(0), y: read(1), z: read(2) };
    case "color": return { x: read(0), y: read(1), z: read(2), w: read(3) };
    case "rotator": return { pitch: read(0), yaw: read(1), roll: read(2) };
  }
}

export function parseCurveInterpolation(value: unknown): CurveInterpolation {
  if (typeof value === "number" && Number.isInteger(value)) return CURVE_INTERPOLATIONS[value] ?? "auto";
  return typeof value === "string" && (CURVE_INTERPOLATIONS as readonly string[]).includes(value)
    ? value as CurveInterpolation
    : "auto";
}

export function parseCurveExtrapolation(value: unknown): CurveExtrapolation {
  if (typeof value === "number" && Number.isInteger(value)) return CURVE_EXTRAPOLATIONS[value] ?? "constant";
  return typeof value === "string" && (CURVE_EXTRAPOLATIONS as readonly string[]).includes(value)
    ? value as CurveExtrapolation
    : "constant";
}

// ---------------------------------------------------------------------------------------------------------
// Ranges

/** A copy with Min at most Max on every axis; crossing axes are swapped. Integer ranges truncate. */
export function normalizeRange<K extends RangeKind>(kind: K, range: unknown): Range<RangeValueOf<K>> {
  const source = range && typeof range === "object" ? range as Record<string, unknown> : {};
  const min = compose(kind, (index) => Math.min(channel(source.Min, kind, index), channel(source.Max, kind, index)));
  const max = compose(kind, (index) => Math.max(channel(source.Min, kind, index), channel(source.Max, kind, index)));
  return { Min: min, Max: max } as Range<RangeValueOf<K>>;
}

function rangeBounds(kind: RangeKind, range: unknown, index: number): [number, number] {
  const source = range && typeof range === "object" ? range as Record<string, unknown> : {};
  const a = channel(source.Min, kind, index);
  const b = channel(source.Max, kind, index);
  return a <= b ? [a, b] : [b, a];
}

/**
 * Integer ranges include both ends; other ranges draw each axis from Min up to, not including, Max, in axis
 * order (X, Y, Z or Pitch, Yaw, Roll). Draws come from `rng`, so a seeded session repeats them.
 */
export function randomInRange<K extends RangeKind>(kind: K, range: unknown, rng: Rng): RangeValueOf<K> {
  if (kind === "int") {
    const [a, b] = rangeBounds(kind, range, 0);
    const lo = Math.trunc(a);
    const hi = Math.trunc(b);
    return (hi === lo ? lo : lo + (rng.next() % (hi - lo + 1))) as RangeValueOf<K>;
  }
  return compose(kind, (index) => {
    const [lo, hi] = rangeBounds(kind, range, index);
    return lo + (hi - lo) * rng.nextFloat();
  }) as RangeValueOf<K>;
}

/** Clamps each axis of `value` into the range. */
export function clampToRange<K extends RangeKind>(kind: K, value: unknown, range: unknown): RangeValueOf<K> {
  return compose(kind, (index) => {
    const [lo, hi] = rangeBounds(kind, range, index);
    return Math.min(hi, Math.max(lo, channel(value, kind, index)));
  }) as RangeValueOf<K>;
}

/** True when `value` lies in the range, both ends included. */
export function isInRange(kind: "int" | "float", value: unknown, range: unknown): boolean {
  const [lo, hi] = rangeBounds(kind, range, 0);
  const number = channel(value, kind, 0);
  return number >= lo && number <= hi;
}

/** Min at 0 and Max at 1; Alpha is not clamped. */
export function lerpFloatRange(range: unknown, alpha: unknown): number {
  const [lo, hi] = rangeBounds("float", range, 0);
  return lo + (hi - lo) * finite(alpha);
}

/** Maps `value` from one range to the other; an empty From range maps to To's Min. */
export function mapFloatRange(value: unknown, from: unknown, to: unknown, clamp: unknown): number {
  const [lo, hi] = rangeBounds("float", from, 0);
  let alpha = hi === lo ? 0 : (finite(value) - lo) / (hi - lo);
  if (clamp) alpha = Math.min(1, Math.max(0, alpha));
  return lerpFloatRange(to, alpha);
}

// ---------------------------------------------------------------------------------------------------------
// Curves

function keysOf(curve: unknown): readonly CurveKey<unknown>[] {
  const keys = curve && typeof curve === "object" ? (curve as { Keys?: unknown }).Keys : undefined;
  return Array.isArray(keys) ? keys as CurveKey<unknown>[] : [];
}

function keyTime(key: unknown): number {
  return key && typeof key === "object" ? finite((key as { Time?: unknown }).Time) : 0;
}

function keyInterpolation(key: CurveKey<unknown>): CurveInterpolation {
  return parseCurveInterpolation(key?.Interpolation);
}

function isSorted(keys: readonly CurveKey<unknown>[]): boolean {
  for (let index = 1; index < keys.length; index++) {
    if (!(keyTime(keys[index]) - keyTime(keys[index - 1]) >= MIN_CURVE_KEY_GAP * 0.5)) return false;
  }
  return true;
}

/**
 * A copy with keys sorted by time and at least `MIN_CURVE_KEY_GAP` apart (a later key is pushed forward),
 * interpolation and extrapolation names resolved, and missing values and tangents filled with zero.
 */
export function normalizeCurve<K extends CurveKind>(kind: K, curve: unknown): Curve<CurveValueOf<K>> {
  const source = curve && typeof curve === "object" ? curve as Record<string, unknown> : {};
  const zero = (value: unknown) => compose(kind, (index) => channel(value, kind, index)) as CurveValueOf<K>;
  const keys = keysOf(curve)
    .filter((key) => key && typeof key === "object")
    .map((key, order) => ({ key, order, time: keyTime(key) }))
    .sort((a, b) => a.time - b.time || a.order - b.order)
    .map(({ key }) => ({
      Time: keyTime(key),
      Value: zero(key.Value),
      Interpolation: keyInterpolation(key),
      ArriveTangent: zero(key.ArriveTangent),
      LeaveTangent: zero(key.LeaveTangent),
    }));
  for (let index = 1; index < keys.length; index++) {
    const previous = keys[index - 1]!.Time;
    if (keys[index]!.Time - previous < MIN_CURVE_KEY_GAP) keys[index]!.Time = previous + MIN_CURVE_KEY_GAP;
  }
  return { Keys: keys, Before: parseCurveExtrapolation(source.Before), After: parseCurveExtrapolation(source.After) };
}

/**
 * Tangent of key `index` on channel `c`, per second. A Custom key uses its stored tangent; any other key uses
 * the automatic tangent: the slope through its neighbours, the slope of its only segment at either end, and
 * flat where the key is a local peak or dip, so Auto curves do not overshoot their keys.
 */
function keyTangent(
  keys: readonly CurveKey<unknown>[], index: number, kind: CurveKind, c: number, side: "arrive" | "leave",
): number {
  const key = keys[index]!;
  if (keyInterpolation(key) === "custom") {
    return channel(side === "arrive" ? key.ArriveTangent : key.LeaveTangent, kind, c);
  }
  const previous = index > 0 ? keys[index - 1] : undefined;
  const next = index + 1 < keys.length ? keys[index + 1] : undefined;
  const value = channel(key.Value, kind, c);
  if (previous && next) {
    const before = channel(previous.Value, kind, c);
    const after = channel(next.Value, kind, c);
    if ((value >= before && value >= after) || (value <= before && value <= after)) return 0;
    return (after - before) / (keyTime(next) - keyTime(previous));
  }
  if (next) return (channel(next.Value, kind, c) - value) / (keyTime(next) - keyTime(key));
  if (previous) return (value - channel(previous.Value, kind, c)) / (keyTime(key) - keyTime(previous));
  return 0;
}

/** Value of the segment from key `index` to the next key at `time`, on channel `c`. */
function segmentValue(keys: readonly CurveKey<unknown>[], index: number, kind: CurveKind, c: number, time: number): number {
  const a = keys[index]!;
  const b = keys[index + 1]!;
  const start = keyTime(a);
  const duration = keyTime(b) - start;
  const v0 = channel(a.Value, kind, c);
  const v1 = channel(b.Value, kind, c);
  if (!(duration > 0)) return v1;
  const s = (time - start) / duration;
  const interpolation = keyInterpolation(a);
  switch (interpolation) {
    case "constant": return v0;
    case "linear": return v0 + (v1 - v0) * s;
    case "auto":
    case "custom": {
      const m0 = keyTangent(keys, index, kind, c, "leave") * duration;
      const m1 = keyTangent(keys, index + 1, kind, c, "arrive") * duration;
      const s2 = s * s;
      const s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * m1;
    }
    default: return v0 + (v1 - v0) * sampleEasingCurve(interpolation, s);
  }
}

/** Slope used by Linear extrapolation past the first (`before`) or last key. */
function endSlope(keys: readonly CurveKey<unknown>[], kind: CurveKind, c: number, end: "before" | "after"): number {
  if (keys.length < 2) return 0;
  const segment = end === "before" ? 0 : keys.length - 2;
  const interpolation = keyInterpolation(keys[segment]!);
  if (interpolation === "constant") return 0;
  if (interpolation === "auto" || interpolation === "custom") {
    return end === "before"
      ? keyTangent(keys, 0, kind, c, "leave")
      : keyTangent(keys, keys.length - 1, kind, c, "arrive");
  }
  const a = keys[segment]!;
  const b = keys[segment + 1]!;
  return (channel(b.Value, kind, c) - channel(a.Value, kind, c)) / (keyTime(b) - keyTime(a));
}

/** Largest index whose key time is at or before `time`; keys must be sorted and `time` inside them. */
function segmentIndex(keys: readonly CurveKey<unknown>[], time: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keyTime(keys[mid]) <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The curve's value at `time`. Each segment follows the interpolation of the key it starts at; Before and
 * After decide the value outside the keys (Constant holds the end value, Linear continues the end slope,
 * Cycle repeats the keys and Oscillate repeats them back and forth). A curve without keys is zero, and one
 * key is a constant. Keys must be sorted by time (`normalizeCurve`); the segment is found by binary search
 * and nothing but the returned value is allocated.
 */
export function evaluateCurve<K extends CurveKind>(kind: K, curve: unknown, time: number): CurveValueOf<K> {
  const keys = keysOf(curve);
  const count = channelCount(kind);
  if (keys.length === 0) return compose(kind, () => 0) as CurveValueOf<K>;
  const first = keyTime(keys[0]);
  const last = keyTime(keys[keys.length - 1]);
  const at = Number.isFinite(time) ? time : first;
  if (keys.length === 1 || last <= first) return compose(kind, (c) => channel(keys[0]!.Value, kind, c)) as CurveValueOf<K>;

  let t = at;
  if (at < first || at > last) {
    const end = at < first ? "before" : "after";
    const source = curve as { Before?: unknown; After?: unknown };
    const mode = parseCurveExtrapolation(end === "before" ? source.Before : source.After);
    const span = last - first;
    if (mode === "cycle") {
      t = first + (((at - first) % span) + span) % span;
    } else if (mode === "oscillate") {
      const phase = (((at - first) % (2 * span)) + 2 * span) % (2 * span);
      t = first + (phase > span ? 2 * span - phase : phase);
    } else {
      const edge = keys[end === "before" ? 0 : keys.length - 1]!;
      const offset = at - (end === "before" ? first : last);
      if (count === 1) {
        const value = channel(edge.Value, kind, 0);
        return (mode === "linear" ? value + endSlope(keys, kind, 0, end) * offset : value) as CurveValueOf<K>;
      }
      return compose(kind, (c) => {
        const value = channel(edge.Value, kind, c);
        return mode === "linear" ? value + endSlope(keys, kind, c, end) * offset : value;
      }) as CurveValueOf<K>;
    }
  }
  if (t >= last) return compose(kind, (c) => channel(keys[keys.length - 1]!.Value, kind, c)) as CurveValueOf<K>;
  const index = segmentIndex(keys, t);
  if (count === 1) return segmentValue(keys, index, kind, 0, t) as CurveValueOf<K>;
  return compose(kind, (c) => segmentValue(keys, index, kind, c, t)) as CurveValueOf<K>;
}

/**
 * Tangent of key `index` on channel `c` (Float: 0; Vector and Color: x, y, z, w), per second, exactly as
 * evaluation uses it: a Custom key's stored tangent, any other key's automatic tangent. Keys must be sorted;
 * an index outside the keys is zero. Editors draw and seed tangent handles from it.
 */
export function curveKeyTangent(kind: CurveKind, curve: unknown, index: number, c: number, side: "arrive" | "leave"): number {
  const keys = keysOf(curve);
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) return 0;
  return keyTangent(keys, index, kind, c, side);
}

/** `evaluateCurve` for keys in any order: sorts a copy only when the keys are out of order. */
export function evaluateCurveAnyOrder<K extends CurveKind>(kind: K, curve: unknown, time: number): CurveValueOf<K> {
  return evaluateCurve(kind, isSorted(keysOf(curve)) ? curve : normalizeCurve(kind, curve), time);
}

/** First and last key time; zero for a curve without keys. */
export function curveTimeRange(curve: unknown): Range<number> {
  const keys = keysOf(curve);
  if (keys.length === 0) return { Min: 0, Max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const key of keys) {
    const time = keyTime(key);
    min = Math.min(min, time);
    max = Math.max(max, time);
  }
  return { Min: min, Max: max };
}

/** Lowest and highest key value of a Float Curve; zero for a curve without keys. */
export function floatCurveValueRange(curve: unknown): Range<number> {
  const keys = keysOf(curve);
  if (keys.length === 0) return { Min: 0, Max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const key of keys) {
    const value = channel(key?.Value, "float", 0);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { Min: min, Max: max };
}
