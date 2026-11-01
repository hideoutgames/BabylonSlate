import {
  CURVE_INTERPOLATIONS,
  MIN_CURVE_KEY_GAP,
  curveKeyAxes,
  curveKeyTangent,
  evaluateCurve,
  parseCurveExtrapolation,
  parseCurveInterpolation,
  type CurveExtrapolation,
  type CurveInterpolation,
} from "@haptic/core";

/** Value kinds a curve holds; matches the built-in curve Structures. */
export type CurveEditorKind = "float" | "vec3" | "color";

/** A curve Structure value: `{ Keys, Before, After }`, keys `{ Time, Value, Interpolation, ArriveTangent, LeaveTangent }`. */
export type CurveEditorValue = { Keys: unknown[]; Before?: unknown; After?: unknown };

export type CurveChannel = { key: string; label: string; accent?: "x" | "y" | "z"; stroke: string };

export const CURVE_CHANNELS: Record<CurveEditorKind, readonly CurveChannel[]> = {
  float: [{ key: "", label: "Value", stroke: "var(--foreground)" }],
  vec3: [
    { key: "x", label: "X", accent: "x", stroke: "var(--axis-x)" },
    { key: "y", label: "Y", accent: "y", stroke: "var(--axis-y)" },
    { key: "z", label: "Z", accent: "z", stroke: "var(--axis-z)" },
  ],
  color: [
    { key: "x", label: "R", accent: "x", stroke: "var(--axis-x)" },
    { key: "y", label: "G", accent: "y", stroke: "var(--axis-y)" },
    { key: "z", label: "B", accent: "z", stroke: "var(--axis-z)" },
    { key: "w", label: "A", stroke: "var(--muted-foreground)" },
  ],
};

/**
 * One key as the editors work on it: a value and two tangents per channel, and the channels it sets as bits
 * (`axes`; every channel except on a Vector key that sets only some axes).
 */
export type EditorKey = {
  time: number;
  values: number[];
  interpolation: CurveInterpolation;
  arrive: number[];
  leave: number[];
  axes: number;
};

/** Every channel's bit for `kind`: Float 1, Vector 7, Color 15. */
export function allAxes(kind: CurveEditorKind): number {
  return (1 << CURVE_CHANNELS[kind].length) - 1;
}

/** True when `key` sets `channel`. */
export function holdsAxis(key: EditorKey, channel: number): boolean {
  return ((key.axes >> channel) & 1) === 1;
}

/**
 * Limits for hosts with stricter data (particles): a fixed 0–1 time axis, end keys locked at 0 and 1,
 * a key count range, one interpolation and a value range.
 */
export interface CurveEditorConstraints {
  fixedTime?: boolean;
  lockEnds?: boolean;
  minKeys?: number;
  maxKeys?: number;
  /** Every key uses this interpolation; the picker and tangent handles are hidden. */
  interpolation?: CurveInterpolation;
  valueMin?: number;
  valueMax?: number;
  /** Smallest gap between neighbouring keys. */
  keyGap?: number;
  /** Key times stay inside this range (a Timeline clip's 0 to Length). */
  timeRange?: readonly [number, number];
  /** Key times land on multiples of this step (a Timeline clip's frames). */
  timeSnap?: number;
  /** Before and After are always this; their pickers are hidden. */
  extrapolation?: CurveExtrapolation;
  /** Every Vector key sets every axis (a Timeline track's keys); moving one axis moves the whole key. */
  sharedKeys?: boolean;
}

export type CurveView = { t0: number; t1: number; v0: number; v1: number };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readChannels(kind: CurveEditorKind, value: unknown): number[] {
  if (kind === "float") return [finite(value)];
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return CURVE_CHANNELS[kind].map((channel) => finite(record[channel.key]));
}

function writeChannels(kind: CurveEditorKind, values: readonly number[]): unknown {
  if (kind === "float") return values[0] ?? 0;
  return Object.fromEntries(CURVE_CHANNELS[kind].map((channel, index) => [channel.key, values[index] ?? 0]));
}

export function editorKeys(kind: CurveEditorKind, value: CurveEditorValue | null | undefined): EditorKey[] {
  const keys = Array.isArray(value?.Keys) ? value.Keys : [];
  return keys
    .filter((key): key is Record<string, unknown> => !!key && typeof key === "object")
    .map((key) => ({
      time: finite(key.Time),
      values: readChannels(kind, key.Value),
      interpolation: parseCurveInterpolation(key.Interpolation),
      arrive: readChannels(kind, key.ArriveTangent),
      leave: readChannels(kind, key.LeaveTangent),
      axes: curveKeyAxes(kind, key),
    }))
    .sort((a, b) => a.time - b.time);
}

export function curveValue(
  kind: CurveEditorKind, keys: readonly EditorKey[], before: unknown, after: unknown,
): { Keys: unknown[]; Before: CurveExtrapolation; After: CurveExtrapolation } {
  return {
    Keys: keys.map((key) => ({
      Time: key.time,
      Value: writeChannels(kind, key.values),
      Interpolation: key.interpolation,
      ArriveTangent: writeChannels(kind, key.arrive),
      LeaveTangent: writeChannels(kind, key.leave),
      ...(kind === "vec3" && key.axes !== allAxes(kind) ? { Axes: key.axes } : {}),
    })),
    Before: parseCurveExtrapolation(before),
    After: parseCurveExtrapolation(after),
  };
}

/** Value of `channel` at `time`, with the runtime's interpolation and extrapolation. */
export function sampleChannel(
  kind: CurveEditorKind, curve: ReturnType<typeof curveValue>, channel: number, time: number,
): number {
  const value = evaluateCurve(kind, curve, time);
  return readChannels(kind, value)[channel] ?? 0;
}

/** Rounds away float noise from nudges and drags before values are stored. */
export function roundTime(time: number): number {
  return Math.round(time * 10000) / 10000;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Where key `index` may move: between its neighbours, or pinned to 0 / 1 when ends are locked. */
export function clampKeyTimeTo(
  keys: readonly EditorKey[], index: number, time: number, constraints: CurveEditorConstraints = {},
): number {
  const gap = constraints.keyGap ?? MIN_CURVE_KEY_GAP;
  const last = keys.length - 1;
  if (constraints.lockEnds && index === 0) return 0;
  if (constraints.lockEnds && index === last) return 1;
  const range = constraints.timeRange;
  let low = index > 0 ? keys[index - 1]!.time + gap : constraints.fixedTime ? 0 : range ? range[0] : Number.NEGATIVE_INFINITY;
  let high = index < last ? keys[index + 1]!.time - gap : constraints.fixedTime ? 1 : range ? range[1] : Number.POSITIVE_INFINITY;
  if (low > high) { low = keys[index]!.time; high = keys[index]!.time; }
  return roundTime(clampNumber(snapTime(time, constraints), low, high));
}

/** `time` on the constraints' step, inside their range. */
export function snapTime(time: number, constraints: CurveEditorConstraints = {}): number {
  const step = constraints.timeSnap;
  const snapped = step && step > 0 ? Math.round(time / step) * step : time;
  const range = constraints.timeRange;
  return range ? clampNumber(snapped, range[0], range[1]) : snapped;
}

export function clampValue(value: number, constraints: CurveEditorConstraints = {}): number {
  return clampNumber(
    value,
    Number.isFinite(constraints.valueMin) ? constraints.valueMin! : Number.NEGATIVE_INFINITY,
    Number.isFinite(constraints.valueMax) ? constraints.valueMax! : Number.POSITIVE_INFINITY,
  );
}

/** Midpoint of the widest gap; after the last key (or at 0) when there are fewer than two keys. */
export function insertionTime(keys: readonly EditorKey[], constraints: CurveEditorConstraints = {}): { index: number; time: number } | null {
  const gap = constraints.keyGap ?? MIN_CURVE_KEY_GAP;
  if (keys.length === 0) return { index: 0, time: 0 };
  if (keys.length === 1) return constraints.fixedTime ? null : { index: 1, time: keys[0]!.time + 1 };
  let best = -1;
  let index = -1;
  for (let i = 0; i + 1 < keys.length; i += 1) {
    const width = keys[i + 1]!.time - keys[i]!.time;
    if (width > best) { best = width; index = i + 1; }
  }
  if (index < 0 || best < gap * 2) return null;
  return { index, time: roundTime((keys[index - 1]!.time + keys[index]!.time) / 2) };
}

/** A new key at `time` that leaves the curve's shape as it was: values sampled, slopes estimated. */
export function keyAt(
  kind: CurveEditorKind, keys: readonly EditorKey[], time: number, constraints: CurveEditorConstraints = {},
): EditorKey {
  const curve = curveValue(kind, keys, "constant", "constant");
  const count = CURVE_CHANNELS[kind].length;
  const values = Array.from({ length: count }, (_, channel) => clampValue(sampleChannel(kind, curve, channel, time), constraints));
  const h = 1e-3;
  const slope = Array.from({ length: count }, (_, channel) =>
    (sampleChannel(kind, curve, channel, time + h) - sampleChannel(kind, curve, channel, time - h)) / (2 * h));
  const previous = [...keys].reverse().find((key) => key.time <= time);
  const interpolation = constraints.interpolation ?? previous?.interpolation ?? "auto";
  return { time, values, interpolation, arrive: [...slope], leave: [...slope], axes: allAxes(kind) };
}

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * The view that frames every visible key. A fixed time axis shows 0–1 and a value axis from the
 * constraint range (or 0 up to a rounded headroom); otherwise both axes pad the keys and the
 * sampled curve, so overshoot stays in view. `timePad` is the share of the key span shown on
 * each side, where the plot hatches the extrapolated curve.
 */
export function fitView(
  kind: CurveEditorKind, keys: readonly EditorKey[], visible: readonly boolean[], constraints: CurveEditorConstraints = {},
  timePad = 0.05,
): CurveView {
  const channels = CURVE_CHANNELS[kind].map((_, index) => index).filter((index) => visible[index] !== false);
  if (constraints.fixedTime) {
    const values = keys.flatMap((key) => channels.map((channel) => key.values[channel]!));
    const v0 = Number.isFinite(constraints.valueMin) ? constraints.valueMin! : Math.min(0, ...values);
    const v1 = Number.isFinite(constraints.valueMax) ? constraints.valueMax! : niceCeil(Math.max(1, ...values) * 1.25);
    return { t0: 0, t1: 1, v0, v1: v1 > v0 ? v1 : v0 + 1 };
  }
  if (keys.length === 0) return { t0: 0, t1: 1, v0: 0, v1: 1 };
  let t0 = keys[0]!.time;
  let t1 = keys[keys.length - 1]!.time;
  if (t1 - t0 < 1e-6) { t0 -= 0.5; t1 += 0.5; }
  const curve = curveValue(kind, keys, "constant", "constant");
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const channel of channels) {
    for (let step = 0; step <= 32; step += 1) {
      const value = sampleChannel(kind, curve, channel, t0 + ((t1 - t0) * step) / 32);
      v0 = Math.min(v0, value);
      v1 = Math.max(v1, value);
    }
  }
  if (!Number.isFinite(v0)) { v0 = 0; v1 = 1; }
  if (v1 - v0 < 1e-6) { v0 -= 0.5; v1 += 0.5; }
  const padding = (t1 - t0) * timePad;
  const valuePad = (v1 - v0) * 0.1;
  return { t0: t0 - padding, t1: t1 + padding, v0: v0 - valuePad, v1: v1 + valuePad };
}

/** Zooms `view` by `factor` (above 1 zooms in) around the normalised point (`fx`, `fy`). */
export function zoomView(view: CurveView, factor: number, fx: number, fy: number, timeAxis = true): CurveView {
  const scale = 1 / Math.max(0.05, Math.min(20, factor));
  const t = view.t0 + (view.t1 - view.t0) * fx;
  const v = view.v1 - (view.v1 - view.v0) * fy;
  return {
    t0: timeAxis ? t - (t - view.t0) * scale : view.t0,
    t1: timeAxis ? t + (view.t1 - t) * scale : view.t1,
    v0: v - (v - view.v0) * scale,
    v1: v + (view.v1 - v) * scale,
  };
}

/**
 * Polyline points (0–100 view space) for one channel, sampled from `from` to `to` (fractions of the view's
 * width; outside 0–1 reaches past the view's edges). Empty when the range is empty or there are no keys.
 */
export function channelPoints(
  kind: CurveEditorKind, curve: ReturnType<typeof curveValue>, channel: number, view: CurveView, samples = 96,
  from = 0, to = 1,
): string {
  if (curve.Keys.length === 0 || !(to > from)) return "";
  const points: string[] = [];
  const count = Math.max(2, Math.ceil(samples * (to - from)));
  for (let step = 0; step <= count; step += 1) {
    const fx = from + ((to - from) * step) / count;
    const value = sampleChannel(kind, curve, channel, view.t0 + (view.t1 - view.t0) * fx);
    const fy = (view.v1 - value) / (view.v1 - view.v0);
    points.push(`${(fx * 100).toFixed(2)},${(clampNumber(fy, -1, 2) * 100).toFixed(2)}`);
  }
  return points.join(" ");
}

/** Ruler ticks across `[min, max]`: a 1, 2, 2.5 or 5 step about `spacing` px apart, its decimals, and half-step minors. */
export function rulerTicks(min: number, max: number, pixels: number, spacing: number): { step: number; decimals: number; major: number[]; minor: number[] } {
  const span = max - min;
  if (!(span > 0) || !(pixels > 0)) return { step: 1, decimals: 0, major: [], minor: [] };
  const raw = span / Math.max(1, pixels / spacing);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const mantissa = fraction < 1.5 ? 1 : fraction < 2.25 ? 2 : fraction < 3.5 ? 2.5 : fraction < 7.5 ? 5 : 10;
  const step = mantissa * magnitude;
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9) + (mantissa === 2.5 ? 1 : 0));
  const major: number[] = [];
  const minor: number[] = [];
  const first = Math.ceil(min / (step / 2) - 1e-9);
  for (let index = first; index * (step / 2) <= max + 1e-9 && major.length + minor.length < 400; index += 1) {
    const value = Math.abs(index * (step / 2)) < step * 1e-6 ? 0 : index * (step / 2);
    (index % 2 === 0 ? major : minor).push(value);
  }
  return { step, decimals, major, minor };
}

/** Tangent of `keys[index]` on `channel`, per second, as the runtime evaluates it (Auto keys get the automatic one). */
export function keyTangent(
  kind: CurveEditorKind, keys: readonly EditorKey[], index: number, channel: number, side: "arrive" | "leave",
): number {
  return curveKeyTangent(kind, curveValue(kind, keys, "constant", "constant"), index, channel, side);
}

/**
 * `keys` with key `index` switched to Custom, every channel's tangents seeded from the ones it plays with
 * now, so the curve keeps its shape until a handle moves.
 */
export function withCustomTangents(kind: CurveEditorKind, keys: readonly EditorKey[], index: number): EditorKey[] {
  const next = keys.map((key) => ({ ...key, values: [...key.values], arrive: [...key.arrive], leave: [...key.leave] }));
  const key = next[index];
  if (!key || key.interpolation === "custom") return next;
  key.arrive = key.values.map((_, channel) => keyTangent(kind, keys, index, channel, "arrive"));
  key.leave = key.values.map((_, channel) => keyTangent(kind, keys, index, channel, "leave"));
  key.interpolation = "custom";
  return next;
}

/** Interpolations offered by the picker, in the enum's order. */
export const INTERPOLATION_OPTIONS: readonly CurveInterpolation[] = CURVE_INTERPOLATIONS;
