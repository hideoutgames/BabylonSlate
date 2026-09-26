/**
 * Value modes for Basic Particle Emitter properties (docs/design/particle-emitters.md,
 * "Value modes"). `PARTICLE_VALUE_SPECS` is the single table of allowed modes, ranges,
 * units and curve axes that the normalizer, the plan and the editor all read.
 */
import { PARTICLE_CURVE_MAX_KEYS, PARTICLE_CURVE_MIN_KEYS } from "@babylonslate/core";

/** Minimum key spacing. Babylon divides by the key gap and bakes GPU gradients at x/256. */
export const PARTICLE_CURVE_MIN_KEY_GAP = 1 / 256;

export type ParticleVec3Tuple = [number, number, number];
/** RGBA, each 0..1. Brightness above 1 belongs in the Material (8-bit GPU gradient). */
export type ParticleColorTuple = [number, number, number, number];
export type ParticleScalarKey = { t: number; value: number };
export type ParticleColorKey = { t: number; color: ParticleColorTuple };

export type ParticleValueMode = "constant" | "range" | "curve";
/** Curve x axis: particle age (Birth → Death) or the emitter cycle (Start → End). */
export type ParticleCurveDomain = "particleAge" | "emitterTime";
export type ParticleValueUnit =
  | "particlesPerSecond"
  | "seconds"
  | "meters"
  | "metersPerSecond"
  | "multiplier"
  | "radians"
  | "radiansPerSecond"
  | "fraction";

export type ParticleScalarValue =
  | { mode: "constant"; value: number }
  | { mode: "range"; min: number; max: number }
  | { mode: "curve"; keys: ParticleScalarKey[] };

export type ParticleColorValue =
  | { mode: "constant"; color: ParticleColorTuple }
  | { mode: "range"; min: ParticleColorTuple; max: ParticleColorTuple }
  | { mode: "curve"; keys: ParticleColorKey[] };

export type ParticleScalarSpec = {
  /** First entry is the default mode. */
  modes: readonly ParticleValueMode[];
  min: number;
  max: number;
  unit: ParticleValueUnit;
  /** Null when `"curve"` is not an allowed mode. */
  curveDomain: ParticleCurveDomain | null;
  /** Default value and the target for invalid input. */
  fallback: ParticleScalarValue;
  /** Replaces a curve with fewer than two usable keys. */
  curveFallback: ParticleScalarKey[];
};

export type ParticleColorSpec = {
  modes: readonly ParticleValueMode[];
  curveDomain: "particleAge";
  fallback: ParticleColorValue;
  curveFallback: ParticleColorKey[];
};

export type ParticleScalarPropertyId =
  | "spawn.rate"
  | "initialize.lifetime"
  | "initialize.speed"
  | "initialize.size"
  | "initialize.scale.x"
  | "initialize.scale.y"
  | "initialize.rotation.start"
  | "initialize.rotation.speed"
  | "overLife.velocity.multiplier"
  | "overLife.speedLimit.limit"
  | "overLife.drag.amount";

const flat = (value: number): ParticleScalarKey[] => [
  { t: 0, value },
  { t: 1, value },
];

function scalarSpec(
  modes: readonly ParticleValueMode[],
  min: number,
  max: number,
  unit: ParticleValueUnit,
  curveDomain: ParticleCurveDomain | null,
  fallback: ParticleScalarValue,
  curveFallback: ParticleScalarKey[],
): ParticleScalarSpec {
  return { modes, min, max, unit, curveDomain, fallback, curveFallback };
}

/** Angles are stored in radians; the editor may display degrees. */
export const PARTICLE_VALUE_SPECS: Readonly<
  Record<ParticleScalarPropertyId, ParticleScalarSpec>
> = {
  "spawn.rate": scalarSpec(
    ["constant", "curve"],
    0,
    10000,
    "particlesPerSecond",
    "emitterTime",
    { mode: "constant", value: 20 },
    flat(20),
  ),
  "initialize.lifetime": scalarSpec(
    ["range", "constant", "curve"],
    0.01,
    60,
    "seconds",
    "emitterTime",
    { mode: "range", min: 0.8, max: 1.2 },
    flat(1),
  ),
  "initialize.speed": scalarSpec(
    ["range", "constant"],
    0,
    1000,
    "metersPerSecond",
    null,
    { mode: "range", min: 1, max: 2 },
    flat(1.5),
  ),
  "initialize.size": scalarSpec(
    ["range", "constant", "curve"],
    0,
    100,
    "meters",
    "particleAge",
    { mode: "range", min: 0.2, max: 0.4 },
    flat(0.3),
  ),
  "initialize.scale.x": scalarSpec(
    ["constant", "range"],
    0,
    100,
    "multiplier",
    null,
    { mode: "constant", value: 1 },
    flat(1),
  ),
  "initialize.scale.y": scalarSpec(
    ["constant", "range"],
    0,
    100,
    "multiplier",
    null,
    { mode: "constant", value: 1 },
    flat(1),
  ),
  "initialize.rotation.start": scalarSpec(
    ["range", "constant"],
    -2 * Math.PI,
    2 * Math.PI,
    "radians",
    null,
    { mode: "range", min: 0, max: 2 * Math.PI },
    flat(0),
  ),
  "initialize.rotation.speed": scalarSpec(
    ["constant", "range", "curve"],
    -50,
    50,
    "radiansPerSecond",
    "particleAge",
    { mode: "constant", value: 0 },
    flat(0),
  ),
  "overLife.velocity.multiplier": scalarSpec(
    ["constant", "curve"],
    0,
    100,
    "multiplier",
    "particleAge",
    { mode: "constant", value: 1 },
    [
      { t: 0, value: 1 },
      { t: 1, value: 0.25 },
    ],
  ),
  "overLife.speedLimit.limit": scalarSpec(
    ["constant", "curve"],
    0,
    1000,
    "metersPerSecond",
    "particleAge",
    { mode: "constant", value: 5 },
    flat(5),
  ),
  "overLife.drag.amount": scalarSpec(
    ["constant", "curve"],
    0,
    1,
    "fraction",
    "particleAge",
    { mode: "constant", value: 0.1 },
    flat(0.1),
  ),
};

const fadeOut = (): ParticleColorKey[] => [
  { t: 0, color: [1, 1, 1, 1] },
  { t: 1, color: [1, 1, 1, 0] },
];

/** `initialize.color`. */
export const PARTICLE_COLOR_SPEC: ParticleColorSpec = {
  modes: ["curve", "constant", "range"],
  curveDomain: "particleAge",
  fallback: { mode: "curve", keys: fadeOut() },
  curveFallback: fadeOut(),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function allowedMode(
  value: unknown,
  modes: readonly ParticleValueMode[],
): ParticleValueMode | null {
  return typeof value === "string" &&
    (modes as readonly string[]).includes(value)
    ? (value as ParticleValueMode)
    : null;
}

export function cloneScalarValue(value: ParticleScalarValue): ParticleScalarValue {
  if (value.mode === "constant") return { mode: "constant", value: value.value };
  if (value.mode === "range") return { mode: "range", min: value.min, max: value.max };
  return { mode: "curve", keys: value.keys.map((key) => ({ ...key })) };
}

export function cloneColorValue(value: ParticleColorValue): ParticleColorValue {
  if (value.mode === "constant") return { mode: "constant", color: [...value.color] };
  if (value.mode === "range") {
    return { mode: "range", min: [...value.min], max: [...value.max] };
  }
  return {
    mode: "curve",
    keys: value.keys.map((key) => ({ t: key.t, color: [...key.color] })),
  };
}

/**
 * Sorted, 2..8 keys, endpoints at t = 0 and t = 1, each key at least
 * `PARTICLE_CURVE_MIN_KEY_GAP` after the previous one. Null when fewer than two
 * usable keys remain.
 */
function normalizeKeys<K extends { t: number }>(
  value: unknown,
  parse: (entry: Record<string, unknown>, t: number) => K | null,
): K[] | null {
  if (!Array.isArray(value)) return null;
  const keys: K[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec || !isFiniteNumber(rec.t)) continue;
    const key = parse(rec, clamp(rec.t, 0, 1));
    if (key) keys.push(key);
  }
  if (keys.length < PARTICLE_CURVE_MIN_KEYS) return null;
  keys.sort((a, b) => a.t - b.t);
  const limited = keys.slice(0, PARTICLE_CURVE_MAX_KEYS);
  const last = limited.length - 1;
  limited[0]!.t = 0;
  limited[last]!.t = 1;
  for (let i = 1; i <= last; i += 1) {
    const floor = limited[i - 1]!.t + PARTICLE_CURVE_MIN_KEY_GAP;
    const ceiling = 1 - (last - i) * PARTICLE_CURVE_MIN_KEY_GAP;
    limited[i]!.t = Math.min(Math.max(limited[i]!.t, floor), ceiling);
  }
  return limited;
}

/** Invalid input or a mode the spec does not allow becomes `spec.fallback`. */
export function normalizeScalarValue(
  value: unknown,
  spec: ParticleScalarSpec,
): ParticleScalarValue {
  const rec = asRecord(value);
  const mode = allowedMode(rec?.mode, spec.modes);
  if (!rec || !mode) return cloneScalarValue(spec.fallback);
  if (mode === "constant") {
    if (!isFiniteNumber(rec.value)) return cloneScalarValue(spec.fallback);
    return { mode, value: clamp(rec.value, spec.min, spec.max) };
  }
  if (mode === "range") {
    if (!isFiniteNumber(rec.min) || !isFiniteNumber(rec.max)) {
      return cloneScalarValue(spec.fallback);
    }
    const a = clamp(rec.min, spec.min, spec.max);
    const b = clamp(rec.max, spec.min, spec.max);
    return { mode, min: Math.min(a, b), max: Math.max(a, b) };
  }
  const keys = normalizeKeys<ParticleScalarKey>(rec.keys, (entry, t) =>
    isFiniteNumber(entry.value)
      ? { t, value: clamp(entry.value, spec.min, spec.max) }
      : null,
  );
  return {
    mode,
    keys: keys ?? spec.curveFallback.map((key) => ({ ...key })),
  };
}

function parseColor(value: unknown): ParticleColorTuple | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const channels = value.slice(0, 4);
  if (!channels.every(isFiniteNumber)) return null;
  return channels.map((channel) => clamp(channel, 0, 1)) as ParticleColorTuple;
}

/** Channels are clamped to 0..1; invalid input becomes `spec.fallback`. */
export function normalizeColorValue(
  value: unknown,
  spec: ParticleColorSpec,
): ParticleColorValue {
  const rec = asRecord(value);
  const mode = allowedMode(rec?.mode, spec.modes);
  if (!rec || !mode) return cloneColorValue(spec.fallback);
  if (mode === "constant") {
    const color = parseColor(rec.color);
    return color ? { mode, color } : cloneColorValue(spec.fallback);
  }
  if (mode === "range") {
    const min = parseColor(rec.min);
    const max = parseColor(rec.max);
    return min && max ? { mode, min, max } : cloneColorValue(spec.fallback);
  }
  const keys = normalizeKeys<ParticleColorKey>(rec.keys, (entry, t) => {
    const color = parseColor(entry.color);
    return color ? { t, color } : null;
  });
  return {
    mode,
    keys:
      keys ??
      spec.curveFallback.map((key) => ({ t: key.t, color: [...key.color] })),
  };
}

/** Index of the segment containing x and the ratio inside it (Babylon `GradientHelper`). */
function curveSegment(
  keys: readonly { t: number }[],
  x: number,
): { from: number; to: number; ratio: number } {
  const last = keys.length - 1;
  if (x <= keys[0]!.t) return { from: 0, to: 0, ratio: 0 };
  if (x >= keys[last]!.t) return { from: last, to: last, ratio: 0 };
  let i = 0;
  while (i < last - 1 && x > keys[i + 1]!.t) i += 1;
  const span = keys[i + 1]!.t - keys[i]!.t;
  return { from: i, to: i + 1, ratio: span > 0 ? (x - keys[i]!.t) / span : 0 };
}

/** Piecewise linear, clamped to the end keys outside [0, 1]. Empty curves read 0. */
export function sampleScalarCurve(
  keys: readonly ParticleScalarKey[],
  x: number,
): number {
  if (keys.length === 0) return 0;
  const { from, to, ratio } = curveSegment(keys, x);
  const a = keys[from]!.value;
  return a + (keys[to]!.value - a) * ratio;
}

export function sampleColorCurve(
  keys: readonly ParticleColorKey[],
  x: number,
): ParticleColorTuple {
  if (keys.length === 0) return [0, 0, 0, 0];
  const { from, to, ratio } = curveSegment(keys, x);
  const a = keys[from]!.color;
  const b = keys[to]!.color;
  return a.map((channel, i) => channel + (b[i]! - channel) * ratio) as ParticleColorTuple;
}

/** Smallest and largest value the property can produce (a curve spans its keys). */
export function scalarValueBounds(value: ParticleScalarValue): {
  min: number;
  max: number;
} {
  if (value.mode === "constant") return { min: value.value, max: value.value };
  if (value.mode === "range") return { min: value.min, max: value.max };
  const values = value.keys.map((key) => key.value);
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Mode switch that keeps the look: constant v → range [v, v] or a flat curve;
 * range → its midpoint or a min → max ramp; curve → its first key or the span
 * of its keys. A mode the spec does not allow leaves the value unchanged.
 */
export function convertScalarValueMode(
  value: ParticleScalarValue,
  mode: ParticleValueMode,
  spec: ParticleScalarSpec,
): ParticleScalarValue {
  if (value.mode === mode || !spec.modes.includes(mode)) {
    return cloneScalarValue(value);
  }
  if (mode === "constant") {
    const bounds = scalarValueBounds(value);
    return {
      mode,
      value:
        value.mode === "curve"
          ? value.keys[0]!.value
          : (bounds.min + bounds.max) / 2,
    };
  }
  if (mode === "range") return { mode, ...scalarValueBounds(value) };
  const bounds = scalarValueBounds(value);
  return {
    mode,
    keys: [
      { t: 0, value: bounds.min },
      { t: 1, value: value.mode === "range" ? bounds.max : bounds.min },
    ],
  };
}

function colorBounds(value: ParticleColorValue): {
  min: ParticleColorTuple;
  max: ParticleColorTuple;
} {
  if (value.mode === "constant") {
    return { min: [...value.color], max: [...value.color] };
  }
  if (value.mode === "range") return { min: [...value.min], max: [...value.max] };
  const channel = (i: number, pick: (...values: number[]) => number): number =>
    pick(...value.keys.map((key) => key.color[i]!));
  return {
    min: [0, 1, 2, 3].map((i) => channel(i, Math.min)) as ParticleColorTuple,
    max: [0, 1, 2, 3].map((i) => channel(i, Math.max)) as ParticleColorTuple,
  };
}

/** The colour counterpart of `convertScalarValueMode`, channel by channel. */
export function convertColorValueMode(
  value: ParticleColorValue,
  mode: ParticleValueMode,
  spec: ParticleColorSpec,
): ParticleColorValue {
  if (value.mode === mode || !spec.modes.includes(mode)) {
    return cloneColorValue(value);
  }
  if (mode === "constant") {
    if (value.mode === "curve") {
      return { mode, color: [...value.keys[0]!.color] };
    }
    const { min, max } = colorBounds(value);
    return {
      mode,
      color: min.map((channel, i) => (channel + max[i]!) / 2) as ParticleColorTuple,
    };
  }
  if (mode === "range") return { mode, ...colorBounds(value) };
  const { min, max } = colorBounds(value);
  return {
    mode,
    keys: [
      { t: 0, color: min },
      { t: 1, color: value.mode === "range" ? max : [...min] },
    ],
  };
}
