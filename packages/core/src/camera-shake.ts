import { evaluateCurve, type Curve } from "./curves";

/** Camera Shake asset header type (`.shake.hasset`). */
export const CAMERA_SHAKE_ASSET_TYPE = "CameraShake";

/**
 * How a Camera Shake moves the view: Perlin Noise (an organic rumble), Sine Wave (a regular sway) or Curves
 * (Location, Rotation and Field Of View follow curve assets over time).
 */
export const CAMERA_SHAKE_PATTERNS = ["noise", "sine", "curves"] as const;
export type CameraShakePattern = (typeof CAMERA_SHAKE_PATTERNS)[number];
export const CAMERA_SHAKE_PATTERN_LABELS: Record<CameraShakePattern, string> = {
  noise: "Perlin Noise",
  sine: "Sine Wave",
  curves: "Curves",
};

export interface CameraShakeVector { x: number; y: number; z: number }
export interface CameraShakeRotator { pitch: number; yaw: number; roll: number }

/**
 * A Camera Shake asset's payload. Location is in the view's own axes (X right, Y up, Z forward) in world units,
 * Rotation in degrees, Field Of View in degrees; frequencies are cycles per second. Curves are asset guids.
 */
export interface CameraShakePayload {
  pattern: CameraShakePattern;
  /** Seconds the shake lasts; 0 plays until it is stopped. */
  duration: number;
  blendInTime: number;
  blendOutTime: number;
  locationAmplitude: CameraShakeVector;
  locationFrequency: CameraShakeVector;
  rotationAmplitude: CameraShakeRotator;
  rotationFrequency: CameraShakeRotator;
  fovAmplitude: number;
  fovFrequency: number;
  /** Float Curve: the strength over the shake's seconds, for every pattern; None is full strength. */
  intensityCurveGuid: string | null;
  /** Curves pattern: Vector Curve of the location offset over the shake's seconds. */
  locationCurveGuid: string | null;
  /** Curves pattern: Vector Curve of the rotation in degrees (X pitch, Y yaw, Z roll). */
  rotationCurveGuid: string | null;
  /** Curves pattern: Float Curve of the Field Of View change in degrees. */
  fovCurveGuid: string | null;
}

/** A packaged Camera Shake as Play and exported games carry it to the runtime. */
export interface CameraShakeCatalogEntry {
  guid: string;
  name: string;
  payload: CameraShakePayload;
}

/** The curve values a shake's guids name, resolved by the caller (runtime catalog or editor documents). */
export interface CameraShakeCurves {
  intensity?: Curve<number> | null;
  location?: Curve<CameraShakeVector> | null;
  rotation?: Curve<CameraShakeVector> | null;
  fov?: Curve<number> | null;
}

/** One moment of a shake, or the sum of several: the view's offset in its own axes. */
export interface CameraShakeOffset {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
  fov: number;
}

/** The longest time and the largest amplitudes, frequencies and blends a payload keeps. */
const MAX_SECONDS = 3600;
const MAX_FREQUENCY = 100;
const MAX_LOCATION = 1000;
const MAX_ROTATION = 180;
const MAX_FOV = 90;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function vector(value: unknown, max: number, fallback: CameraShakeVector): CameraShakeVector {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    x: clamp(source.x, 0, max, fallback.x),
    y: clamp(source.y, 0, max, fallback.y),
    z: clamp(source.z, 0, max, fallback.z),
  };
}

function rotator(value: unknown, max: number, fallback: CameraShakeRotator): CameraShakeRotator {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    pitch: clamp(source.pitch, 0, max, fallback.pitch),
    yaw: clamp(source.yaw, 0, max, fallback.yaw),
    roll: clamp(source.roll, 0, max, fallback.roll),
  };
}

const guid = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/** A new asset: half a second of moderate noise, as a hit would shake the view. */
export function createDefaultCameraShakePayload(): CameraShakePayload {
  return {
    pattern: "noise",
    duration: 0.5,
    blendInTime: 0.05,
    blendOutTime: 0.2,
    locationAmplitude: { x: 0.05, y: 0.05, z: 0 },
    locationFrequency: { x: 12, y: 12, z: 12 },
    rotationAmplitude: { pitch: 1, yaw: 1, roll: 1.5 },
    rotationFrequency: { pitch: 10, yaw: 10, roll: 8 },
    fovAmplitude: 0,
    fovFrequency: 5,
    intensityCurveGuid: null,
    locationCurveGuid: null,
    rotationCurveGuid: null,
    fovCurveGuid: null,
  };
}

/** Known fields only, each finite and in range (amplitudes and frequencies are never negative); unknown or bad values take the default. */
export function normalizeCameraShakePayload(content: unknown): CameraShakePayload {
  const source = content && typeof content === "object" ? content as Record<string, unknown> : {};
  const base = createDefaultCameraShakePayload();
  return {
    pattern: CAMERA_SHAKE_PATTERNS.includes(source.pattern as CameraShakePattern) ? source.pattern as CameraShakePattern : base.pattern,
    duration: clamp(source.duration, 0, MAX_SECONDS, base.duration),
    blendInTime: clamp(source.blendInTime, 0, MAX_SECONDS, base.blendInTime),
    blendOutTime: clamp(source.blendOutTime, 0, MAX_SECONDS, base.blendOutTime),
    locationAmplitude: vector(source.locationAmplitude, MAX_LOCATION, base.locationAmplitude),
    locationFrequency: vector(source.locationFrequency, MAX_FREQUENCY, base.locationFrequency),
    rotationAmplitude: rotator(source.rotationAmplitude, MAX_ROTATION, base.rotationAmplitude),
    rotationFrequency: rotator(source.rotationFrequency, MAX_FREQUENCY, base.rotationFrequency),
    fovAmplitude: clamp(source.fovAmplitude, 0, MAX_FOV, base.fovAmplitude),
    fovFrequency: clamp(source.fovFrequency, 0, MAX_FREQUENCY, base.fovFrequency),
    intensityCurveGuid: guid(source.intensityCurveGuid),
    locationCurveGuid: guid(source.locationCurveGuid),
    rotationCurveGuid: guid(source.rotationCurveGuid),
    fovCurveGuid: guid(source.fovCurveGuid),
  };
}

/** The curve asset guids a payload references, for dependencies and loading. */
export function cameraShakeCurveGuids(payload: CameraShakePayload): string[] {
  const guids = [payload.intensityCurveGuid];
  if (payload.pattern === "curves") guids.push(payload.locationCurveGuid, payload.rotationCurveGuid, payload.fovCurveGuid);
  return [...new Set(guids.filter((entry): entry is string => entry !== null))];
}

export const ZERO_CAMERA_SHAKE_OFFSET: Readonly<CameraShakeOffset> = Object.freeze({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, fov: 0 });

/** A 32-bit integer hash of a lattice point and a seed. */
function hash(index: number, seed: number): number {
  let h = (Math.imul(index | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * One-dimensional Perlin gradient noise in [-1, 1]: a random slope at each whole number, blended with the quintic
 * fade, so it passes through 0 at whole numbers and changes smoothly between them. Deterministic for a seed.
 */
export function perlinNoise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = hash(i, seed) / 0x7fffffff - 1;
  const g1 = hash(i + 1, seed) / 0x7fffffff - 1;
  const fade = f * f * f * (f * (f * 6 - 15) + 10);
  // The two slopes meet at most 0.5 apart; doubling fills [-1, 1].
  return Math.max(-1, Math.min(1, 2 * (g0 * f + (g1 * (f - 1) - g0 * f) * fade)));
}

/** A playing shake's clock: seconds since it started (excluding pauses), when a stop began its blend out, and its seed. */
export interface CameraShakeClock {
  time: number;
  /** The `time` at which Stop began blending out; null while it plays on. */
  stoppingAt: number | null;
  seed: number;
}

/** Whether the shake has ended: its Duration is over, or its stop's blend out is. */
export function cameraShakeFinished(shake: CameraShakePayload, clock: CameraShakeClock): boolean {
  if (shake.duration > 0 && clock.time >= shake.duration) return true;
  return clock.stoppingAt !== null && clock.time - clock.stoppingAt >= shake.blendOutTime;
}

/** The blend weight at the clock's time: blend in, blend out before Duration's end or after a stop, and the Intensity Curve. */
export function cameraShakeWeight(shake: CameraShakePayload, clock: CameraShakeClock, curves: CameraShakeCurves = {}): number {
  const t = clock.time;
  let weight = shake.blendInTime > 0 ? Math.min(1, t / shake.blendInTime) : 1;
  if (shake.duration > 0 && shake.blendOutTime > 0) weight = Math.min(weight, (shake.duration - t) / shake.blendOutTime);
  if (clock.stoppingAt !== null) weight = Math.min(weight, shake.blendOutTime > 0 ? 1 - (t - clock.stoppingAt) / shake.blendOutTime : 0);
  if (curves.intensity) weight *= evaluateCurve("float", curves.intensity, t);
  return Math.max(0, weight);
}

const CHANNELS = ["x", "y", "z", "pitch", "yaw", "roll", "fov"] as const;

/**
 * The shake's offset at its clock's time, times `scale`, without its blend weight. Noise and Sine Wave take each
 * channel's amplitude and frequency (noise channels draw from the seed, so two shakes of one asset differ); Curves
 * reads the curves at the shake's seconds.
 */
export function cameraShakeRawOffset(shake: CameraShakePayload, clock: CameraShakeClock, curves: CameraShakeCurves = {}): CameraShakeOffset {
  const t = clock.time;
  if (shake.pattern === "curves") {
    const location = curves.location ? evaluateCurve("vec3", curves.location, t) : null;
    const rotation = curves.rotation ? evaluateCurve("vec3", curves.rotation, t) : null;
    return {
      x: location?.x ?? 0, y: location?.y ?? 0, z: location?.z ?? 0,
      pitch: rotation?.x ?? 0, yaw: rotation?.y ?? 0, roll: rotation?.z ?? 0,
      fov: curves.fov ? evaluateCurve("float", curves.fov, t) : 0,
    };
  }
  const amplitude: Record<(typeof CHANNELS)[number], number> = {
    ...shake.locationAmplitude, ...shake.rotationAmplitude, fov: shake.fovAmplitude,
  };
  const frequency: Record<(typeof CHANNELS)[number], number> = {
    ...shake.locationFrequency, ...shake.rotationFrequency, fov: shake.fovFrequency,
  };
  const out = { ...ZERO_CAMERA_SHAKE_OFFSET };
  CHANNELS.forEach((channel, index) => {
    if (amplitude[channel] === 0) return;
    const phase = t * frequency[channel];
    const wave = shake.pattern === "sine" ? Math.sin(2 * Math.PI * phase) : perlinNoise1(phase, clock.seed + index * 7919);
    out[channel] = amplitude[channel] * wave;
  });
  return out;
}

/** The shake's weighted offset at its clock's time, times `scale`. */
export function sampleCameraShake(shake: CameraShakePayload, clock: CameraShakeClock, scale = 1, curves: CameraShakeCurves = {}): CameraShakeOffset {
  const weight = cameraShakeWeight(shake, clock, curves) * (Number.isFinite(scale) ? scale : 0);
  const raw = cameraShakeRawOffset(shake, clock, curves);
  const out = { ...ZERO_CAMERA_SHAKE_OFFSET };
  if (weight === 0) return out;
  for (const channel of CHANNELS) out[channel] = raw[channel] * weight;
  return out;
}

/** `into` plus `offset`, channel by channel; returns `into`. */
export function addCameraShakeOffset(into: CameraShakeOffset, offset: Readonly<CameraShakeOffset>): CameraShakeOffset {
  for (const channel of CHANNELS) into[channel] += offset[channel];
  return into;
}

/** World shake strength at `distance` from the epicenter: 1 within Inner Radius, 0 past Outer Radius, `(1 - t)^falloff` between. */
export function worldCameraShakeScale(distance: number, innerRadius: number, outerRadius: number, falloff: number): number {
  if (!Number.isFinite(distance)) return 0;
  const inner = Math.max(0, innerRadius);
  if (distance <= inner) return 1;
  const outer = Math.max(inner, outerRadius);
  if (distance >= outer) return 0;
  const t = (distance - inner) / (outer - inner);
  return Math.pow(1 - t, Math.max(0, Number.isFinite(falloff) ? falloff : 1));
}
