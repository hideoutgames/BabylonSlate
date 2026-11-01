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

/** A Vector Curve key's `Axes` when it sets every axis: X 1, Y 2 and Z 4. */
export const CURVE_ALL_AXES = 7;

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
  /**
   * Vector Curves only: the axes this key sets (X 1, Y 2, Z 4). Missing, zero or 7 means every axis; a key
   * that sets fewer leaves the other axes to the keys that set them, so each axis has its own keys.
   */
  Axes?: number;
}

export interface Curve<V> {
  /** Sorted by time; keys that set a common axis are at least `MIN_CURVE_KEY_GAP` apart. */
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

/**
 * The channels a key sets, as bits (X 1, Y 2, Z 4, W 8). Only Vector Curve keys set fewer than all, through
 * `Axes`; a missing, zero or non-numeric `Axes` sets every axis.
 */
export function curveKeyAxes(kind: CurveKind, key: unknown): number {
  const all = (1 << channelCount(kind)) - 1;
  if (kind !== "vec3" || !key || typeof key !== "object") return all;
  const bits = Math.trunc(finite((key as { Axes?: unknown }).Axes, all)) & all;
  return bits === 0 ? all : bits;
}

/** A key's `Axes` bits for order checks that do not know the curve's kind: every bit unless it names some. */
function axesBits(key: unknown): number {
  const axes = key && typeof key === "object" ? (key as { Axes?: unknown }).Axes : undefined;
  const bits = typeof axes === "number" && Number.isFinite(axes) ? Math.trunc(axes) & CURVE_ALL_AXES : 0;
  return bits === 0 ? -1 : bits;
}

function isSorted(keys: readonly CurveKey<unknown>[]): boolean {
  for (let index = 1; index < keys.length; index++) {
    const gap = keyTime(keys[index]) - keyTime(keys[index - 1]);
    if (!(gap >= 0)) return false;
    if (gap < MIN_CURVE_KEY_GAP * 0.5 && (axesBits(keys[index]) & axesBits(keys[index - 1])) !== 0) return false;
  }
  return true;
}

/**
 * Each axis's own keys for a Vector Curve whose keys set only some axes; null when every key sets every axis
 * (every other kind), so ordinary curves evaluate without allocating.
 */
function axisKeys(kind: CurveKind, keys: readonly CurveKey<unknown>[]): readonly (readonly CurveKey<unknown>[])[] | null {
  if (kind !== "vec3") return null;
  let partial = false;
  for (const key of keys) {
    if (curveKeyAxes(kind, key) !== CURVE_ALL_AXES) {
      partial = true;
      break;
    }
  }
  if (!partial) return null;
  return [0, 1, 2].map((axis) => keys.filter((key) => (curveKeyAxes(kind, key) >> axis) & 1));
}

/**
 * A copy with keys sorted by time, keys that set a common axis at least `MIN_CURVE_KEY_GAP` apart (a later
 * key is pushed forward), interpolation and extrapolation names resolved, and missing values and tangents
 * filled with zero. A Vector key keeps `Axes` only when it sets fewer than every axis.
 */
export function normalizeCurve<K extends CurveKind>(kind: K, curve: unknown): Curve<CurveValueOf<K>> {
  const source = curve && typeof curve === "object" ? curve as Record<string, unknown> : {};
  const zero = (value: unknown) => compose(kind, (index) => channel(value, kind, index)) as CurveValueOf<K>;
  const keys = keysOf(curve)
    .filter((key) => key && typeof key === "object")
    .map((key, order) => ({ key, order, time: keyTime(key) }))
    .sort((a, b) => a.time - b.time || a.order - b.order)
    .map(({ key }): CurveKey<CurveValueOf<K>> => {
      const axes = curveKeyAxes(kind, key);
      return {
        Time: keyTime(key),
        Value: zero(key.Value),
        Interpolation: keyInterpolation(key),
        ArriveTangent: zero(key.ArriveTangent),
        LeaveTangent: zero(key.LeaveTangent),
        ...(kind === "vec3" && axes !== CURVE_ALL_AXES ? { Axes: axes } : {}),
      };
    });
  let pushed = false;
  for (let index = 1; index < keys.length; index++) {
    const axes = curveKeyAxes(kind, keys[index]);
    // Only the nearest earlier key that sets a common axis holds this one off; Vector keys of other axes may share its time.
    for (let back = index - 1; back >= 0; back--) {
      if ((curveKeyAxes(kind, keys[back]) & axes) === 0) continue;
      const previous = keys[back]!.Time;
      if (keys[index]!.Time - previous < MIN_CURVE_KEY_GAP) {
        keys[index]!.Time = previous + MIN_CURVE_KEY_GAP;
        pushed = true;
      }
      break;
    }
  }
  // A pushed key can pass a later key of other axes; keep the list in time order.
  if (pushed && kind === "vec3") keys.sort((a, b) => a.Time - b.Time);
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

/**
 * One axis of a Vector Curve whose keys set only some axes, at `time` already inside the curve's time range
 * (Cycle and Oscillate mapped). Outside its own keys an axis holds its end value; past the curve's ends,
 * Linear (`end`, `offset`) continues the axis's end slope when its keys reach that end.
 */
function axisValue(
  axis: readonly CurveKey<unknown>[], c: number, time: number,
  end: "before" | "after" | null, offset: number, first: number, last: number,
): number {
  if (axis.length === 0) return 0;
  const axisFirst = keyTime(axis[0]);
  const axisLast = keyTime(axis[axis.length - 1]);
  let value: number;
  if (axis.length === 1 || time <= axisFirst) value = channel(axis[0]!.Value, "vec3", c);
  else if (time >= axisLast) value = channel(axis[axis.length - 1]!.Value, "vec3", c);
  else value = segmentValue(axis, segmentIndex(axis, time), "vec3", c, time);
  if (end && offset !== 0 && (end === "before" ? axisFirst <= first : axisLast >= last)) {
    value += endSlope(axis, "vec3", c, end) * offset;
  }
  return value;
}

/** `evaluateCurve` for a Vector Curve whose keys set only some axes: the whole curve's time range, each axis its own keys. */
function evaluateAxes(curve: unknown, keys: readonly CurveKey<unknown>[], axes: readonly (readonly CurveKey<unknown>[])[], time: number): Vec3Value {
  const first = keyTime(keys[0]);
  const last = keyTime(keys[keys.length - 1]);
  let t = Number.isFinite(time) ? time : first;
  let end: "before" | "after" | null = null;
  let offset = 0;
  if (last > first && (t < first || t > last)) {
    const side = t < first ? "before" : "after";
    const source = curve as { Before?: unknown; After?: unknown };
    const mode = parseCurveExtrapolation(side === "before" ? source.Before : source.After);
    const span = last - first;
    if (mode === "cycle") {
      t = first + (((t - first) % span) + span) % span;
    } else if (mode === "oscillate") {
      const phase = (((t - first) % (2 * span)) + 2 * span) % (2 * span);
      t = first + (phase > span ? 2 * span - phase : phase);
    } else {
      const edge = side === "before" ? first : last;
      if (mode === "linear") {
        end = side;
        offset = t - edge;
      }
      t = edge;
    }
  }
  return { x: axisValue(axes[0]!, 0, t, end, offset, first, last), y: axisValue(axes[1]!, 1, t, end, offset, first, last), z: axisValue(axes[2]!, 2, t, end, offset, first, last) };
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
 * and nothing but the returned value is allocated. A Vector Curve whose keys set only some axes evaluates
 * each axis from its own keys within the whole curve's time range (`evaluateAxes`).
 */
export function evaluateCurve<K extends CurveKind>(kind: K, curve: unknown, time: number): CurveValueOf<K> {
  const keys = keysOf(curve);
  const count = channelCount(kind);
  if (keys.length === 0) return compose(kind, () => 0) as CurveValueOf<K>;
  const axes = axisKeys(kind, keys);
  if (axes) return evaluateAxes(curve, keys, axes, time) as CurveValueOf<K>;
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
  const axes = axisKeys(kind, keys);
  if (!axes) return keyTangent(keys, index, kind, c, side);
  // A key that sets only some axes has its tangent among that axis's own keys, and none on the others.
  const axis = axes[c];
  const at = axis ? axis.indexOf(keys[index]!) : -1;
  return at < 0 ? 0 : keyTangent(axis!, at, kind, c, side);
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
