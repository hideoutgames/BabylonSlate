import type { Transform, Vec3 } from "./math-rng";
import { identityTransform } from "./math-rng";
import { inverseQuat, quatRotateVector, type QuatObject } from "./euler";
import { sampleSplinePath, SPLINE_SUBDIVISIONS } from "./spline-component";
import { evaluateWaterSpectrum, waterSpectrum, type WaterSpectrum } from "./water-spectrum";
import { waterHorizontalEnvelopeOf, waterWaveEnvelopeOf } from "./water-envelope";

export type WaterKind = "global" | "ocean" | "lake" | "river" | "puddle";
export type WaterColor = [number, number, number];

/**
 * Version 1 Water asset. Distances are metres and time is simulation seconds. Every water's waves are one FFT ocean
 * spectrum (`waterSpectrum`): a wind sea and an optional swell, shared by rendering, physics and queries. Built-in
 * shading is Realistic; a stylized look is a Custom Material (`materialGuid`). Assets saved with the removed Style
 * (Stylized, Painted or Toon) keep their colours and waves and draw Realistic.
 */
export interface WaterDefinition {
  shallowColor: WaterColor;
  deepColor: WaterColor;
  foamColor: WaterColor;
  opacity: number;
  roughness: number;
  reflectionStrength: number;
  depthColorDistance: number;
  /** Wind sea: about the height of a crest above the mean (spectrum significant height 2 × this). */
  waveHeight: number;
  /** Wind sea: peak wavelength (metres). */
  waveLength: number;
  waveSpeed: number;
  waveDirection: number;
  /** The long swell's crest height (metres; 0 is no swell). */
  swellHeight: number;
  /** The swell's peak wavelength (metres). */
  swellLength: number;
  /** The swell's heading (degrees). */
  swellDirection: number;
  /** Angular spread of the wind sea's headings: 0 is long parallel crests, 1 is a confused sea. */
  waveSpread: number;
  foamAmount: number;
  foamWidth: number;
  /** Whitecaps on steep crests. */
  crestFoam: number;
  /** Metres of foam around objects and terrain that intersect the surface. */
  contactFoamWidth: number;
  /** Thin foam left lingering behind breaking crests. */
  surfaceFoam: number;
  /** Sunlight scattered through wave crests seen toward the sun. */
  subsurface: number;
  density: number;
  materialGuid: string | null;
  /** Gerstner horizontal motion (0-1): 0 moves water only vertically; physics and rendering share it. */
  steepness: number;
  /** JONSWAP peak enhancement γ (1-7). */
  peakSharpness: number;
  /** Integer 0-65535 choosing the deterministic draw of the spectrum's modes. */
  waveSeed: number;
  /** Gain (0-1) of the short waves more than four wind-sea wavelengths' wavenumber up the spectrum. */
  detailWaves: number;
  /** Render only: refraction distortion strength (0-1); 0 never samples the scene copy. */
  refraction: number;
  /** Render only: reflect scene objects (screen-space or planar by quality); false reflects only the sky. */
  objectReflections: boolean;
  /** Render only: open-sea tint variation (0-1). */
  colorVariation: number;
}

export interface WaterBodyProperties {
  kind: WaterKind;
  assetGuid: string | null;
  enabled: boolean;
  width: number;
  length: number;
  depth: number;
  waveScale: number;
  flowSpeed: number;
  flowDirection: number;
  /** River control points in component-local coordinates, including elevation. */
  points: [number, number, number][];
  /** Per-point multipliers of Width, aligned with `points`. */
  widthScales: number[];
  /** River path smoothing: 0 is straight segments, 1 is a centripetal Catmull-Rom spline. */
  curvature: number;
  resolution: number;
}

export interface WaterBuoyancyProperties {
  enabled: boolean;
  /** Zero selects twice the body's mass divided by water density. */
  volume: number;
  width: number;
  length: number;
  height: number;
  offset: [number, number, number];
  drag: number;
  angularDrag: number;
  waterActorId: string | null;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback;
const guid = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const tuple = (value: unknown, fallback: WaterColor, min: number, max: number): WaterColor => {
  const point = record(value);
  const v = Array.isArray(value) ? value : [point.x, point.y, point.z];
  return Array.isArray(v) && v.length === 3
    ? [number(v[0], fallback[0], min, max), number(v[1], fallback[1], min, max), number(v[2], fallback[2], min, max)]
    : [...fallback];
};

/** Defaults of a new Water asset: a wind sea with a longer swell across it. */
export function createDefaultWaterDefinition(): WaterDefinition {
  return {
    shallowColor: [0.43, 0.95, 1], deepColor: [0.1, 0.26, 0.35], foamColor: [1, 1, 1],
    opacity: 0.97, roughness: 0.08, reflectionStrength: 1, depthColorDistance: 6.5,
    waveHeight: 0.35, waveLength: 12, waveSpeed: 1, waveDirection: 25,
    swellHeight: 0.1, swellLength: 35, swellDirection: 70, waveSpread: 0.5,
    foamAmount: 0.6, foamWidth: 0.8, crestFoam: 0.2, contactFoamWidth: 1.2, surfaceFoam: 0.15, subsurface: 1,
    density: 1000, materialGuid: null, steepness: 0.5, peakSharpness: 3.3, waveSeed: 0,
    detailWaves: 1, refraction: 0.35, objectReflections: true, colorVariation: 0.5,
  };
}

export function normalizeWaterDefinition(value: unknown): WaterDefinition {
  const v = record(value);
  const d = createDefaultWaterDefinition();
  return {
    ...d,
    shallowColor: tuple(v.shallowColor, d.shallowColor, 0, 1),
    deepColor: tuple(v.deepColor, d.deepColor, 0, 1),
    foamColor: tuple(v.foamColor, d.foamColor, 0, 1),
    opacity: number(v.opacity, d.opacity, 0, 1),
    roughness: number(v.roughness, d.roughness, 0.02, 1),
    reflectionStrength: number(v.reflectionStrength, d.reflectionStrength, 0, 2),
    depthColorDistance: number(v.depthColorDistance, d.depthColorDistance, 0.01, 1000),
    waveHeight: number(v.waveHeight, d.waveHeight, 0, 20),
    waveLength: number(v.waveLength, d.waveLength, 0.1, 2000),
    waveSpeed: number(v.waveSpeed, d.waveSpeed, 0, 20),
    waveDirection: number(v.waveDirection, d.waveDirection, -360, 360),
    swellHeight: number(v.swellHeight, d.swellHeight, 0, 20),
    swellLength: number(v.swellLength, d.swellLength, 0.5, 2000),
    swellDirection: number(v.swellDirection, d.swellDirection, -360, 360),
    waveSpread: number(v.waveSpread, d.waveSpread, 0, 1),
    foamAmount: number(v.foamAmount, d.foamAmount, 0, 1),
    foamWidth: number(v.foamWidth, d.foamWidth, 0, 20),
    crestFoam: number(v.crestFoam, d.crestFoam, 0, 1),
    contactFoamWidth: number(v.contactFoamWidth, d.contactFoamWidth, 0, 8),
    surfaceFoam: number(v.surfaceFoam, d.surfaceFoam, 0, 1),
    subsurface: number(v.subsurface, d.subsurface, 0, 2),
    density: number(v.density, d.density, 1, 20000),
    materialGuid: guid(v.materialGuid),
    steepness: number(v.steepness, d.steepness, 0, 1),
    peakSharpness: number(v.peakSharpness, d.peakSharpness, 1, 7),
    waveSeed: Math.round(number(v.waveSeed, d.waveSeed, 0, 65535)),
    detailWaves: number(v.detailWaves, d.detailWaves, 0, 1),
    refraction: number(v.refraction, d.refraction, 0, 1),
    objectReflections: typeof v.objectReflections === "boolean" ? v.objectReflections : d.objectReflections,
    colorVariation: number(v.colorVariation, d.colorVariation, 0, 1),
  };
}

export function waterKindForClass(classId: string): WaterKind | null {
  switch (classId) {
    case "GlobalWaterVolumeComponent": return "global";
    case "WaterOceanComponent": return "ocean";
    case "WaterLakeComponent": return "lake";
    case "WaterRiverComponent": return "river";
    case "WaterPuddleComponent": return "puddle";
    default: return null;
  }
}

export function normalizeWaterBody(value: unknown, kind: WaterKind = "lake"): WaterBodyProperties {
  const v = record(value);
  const openWater = kind === "ocean" || kind === "global";
  const points = Array.isArray(v.points) ? v.points.slice(0, 128).filter((p) =>
    Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number" && Number.isFinite(n)),
  ).map((p) => tuple(p, [0, 0, 0], -100000, 100000)) : [];
  const riverPoints: [number, number, number][] = points.length >= 2 ? points : [[0, 0, -15], [0, 0, 15]];
  const scales = Array.isArray(v.widthScales) ? v.widthScales : [];
  return {
    kind, assetGuid: guid(v.assetGuid), enabled: v.enabled !== false,
    width: number(v.width, openWater ? 256 : kind === "river" ? 6 : kind === "puddle" ? 3 : 30, 0.1, 10000),
    length: number(v.length, openWater ? 256 : kind === "puddle" ? 2 : 30, 0.1, 10000),
    depth: number(v.depth, kind === "puddle" ? 0.1 : openWater ? 1000 : 5, 0.01, 10000),
    waveScale: number(v.waveScale, kind === "puddle" ? 0.03 : kind === "lake" ? 0.35 : kind === "river" ? 0.15 : 1, 0, 10),
    flowSpeed: number(v.flowSpeed, kind === "river" ? 1.5 : 0, -100, 100),
    flowDirection: number(v.flowDirection, 0, -360, 360),
    points: riverPoints,
    widthScales: riverPoints.map((_, i) => number(scales[i], 1, 0.05, 20)),
    curvature: number(v.curvature, 1, 0, 1),
    resolution: Math.round(number(v.resolution, openWater ? 96 : 48, 8, 128)),
  };
}

export function normalizeWaterBuoyancy(value: unknown): WaterBuoyancyProperties {
  const v = record(value);
  return {
    enabled: v.enabled !== false,
    volume: number(v.volume, 0, 0, 100000),
    width: number(v.width, 1, 0.01, 10000),
    length: number(v.length, 1, 0.01, 10000),
    height: number(v.height, 1, 0.01, 10000),
    offset: tuple(v.offset, [0, 0, 0], -10000, 10000),
    drag: number(v.drag, 2.5, 0, 50),
    angularDrag: number(v.angularDrag, 1, 0, 50),
    waterActorId: guid(v.waterActorId),
  };
}

export interface WaterSample {
  found: boolean;
  height: number;
  depth: number;
  normal: Vec3;
  velocity: Vec3;
  edgeDistance: number;
}

export const emptyWaterSample = (): WaterSample => ({
  found: false, height: 0, depth: 0,
  normal: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, edgeDistance: 0,
});

/** Newton steps after the Picard start when a query inverts world X/Z to its rest point. Fixed, so every host agrees. */
export const WATER_WAVE_NEWTON_STEPS = 4;
/** Inversion stops once the displaced rest point lands within this distance (metres) of the queried X/Z. */
export const WATER_WAVE_INVERT_TOLERANCE = 1e-6;
/**
 * Finite bodies fade the Gerstner horizontal offset to zero at their banks over this many horizontal envelopes
 * (`waterBankFadeLength`), so the rendered edge stays on the rest edge against walls and docks and the surface
 * covers exactly the rest footprint.
 */
export const WATER_BANK_FADE_ENVELOPES = 4;

/**
 * Slots of the `out` array written by `evaluateWaterSpectrum` (0-10 and 13) and `invertWaterWaves` (0-13). Derivatives
 * are taken with respect to the rest (Lagrangian) point x0/z0. The Jacobian J = ∂(x0 + D)/∂(x0, z0) includes the
 * identity: `jacobianXZ` is ∂x/∂z0 and `jacobianZX` is ∂z/∂x0, equal unless a bank fade varies across the point.
 */
export const WaterWaveSlot = {
  height: 0, offsetX: 1, offsetZ: 2, slopeX: 3, slopeZ: 4, jacobianXX: 5, jacobianXZ: 6, jacobianZZ: 7,
  heightRate: 8, offsetRateX: 9, offsetRateZ: 10, restX: 11, restZ: 12, jacobianZX: 13,
} as const;
export const WATER_WAVE_OUTPUT_SIZE = 14;
/** Reusable output for `evaluateWaterSpectrum` and `invertWaterWaves`. */
export const createWaterWaveOutput = (): Float64Array => new Float64Array(WATER_WAVE_OUTPUT_SIZE);

/** Whether a body moves water sideways under its crests (Steepness above 0 and a nonzero Wave Scale). */
export const waterMovesSideways = (spectrum: WaterSpectrum, scale: number): boolean => spectrum.choppiness > 0 && scale !== 0;

/** Horizontal gain of the Gerstner offset at a rest point: writes the gain and its rest-space gradient into `out` 0-2. */
export interface WaterWaveGain {
  sample(x0: number, z0: number, out: Float64Array): void;
}

const gainScratch = new Float64Array(3);

function evaluateWithGain(spectrum: WaterSpectrum, x0: number, z0: number, time: number, out: Float64Array, scale: number, gain: WaterWaveGain | undefined): void {
  if (!gain) { evaluateWaterSpectrum(spectrum, x0, z0, time, out, scale, 1, 0, 0); return; }
  gain.sample(x0, z0, gainScratch);
  evaluateWaterSpectrum(spectrum, x0, z0, time, out, scale, gainScratch[0]!, gainScratch[1]!, gainScratch[2]!);
}

/**
 * Finds the rest point whose displaced surface lies over world (x, z): a Picard start, then at most
 * `WATER_WAVE_NEWTON_STEPS` Newton steps until it lands within `WATER_WAVE_INVERT_TOLERANCE`. Leaves the evaluation at
 * that rest point in `out` 0-10 and 13 and the rest point in `out` 11-12. Without sideways motion the rest point is
 * (x, z). `gain` is a finite body's bank fade, sampled at every iterate exactly as the mesh applies it. `start` replaces
 * the Picard start, for a caller that already has a nearby rest point.
 */
export function invertWaterWaves(
  spectrum: WaterSpectrum, x: number, z: number, time: number, out: Float64Array, scale = 1, gain?: WaterWaveGain,
  start?: { x: number; z: number },
): void {
  let x0 = x, z0 = z;
  const sideways = waterMovesSideways(spectrum, scale);
  if (!(start && sideways)) evaluateWithGain(spectrum, x0, z0, time, out, scale, gain);
  if (sideways) {
    const tolerance = WATER_WAVE_INVERT_TOLERANCE * WATER_WAVE_INVERT_TOLERANCE;
    if (start) { x0 = start.x; z0 = start.z; } else { x0 = x - out[1]!; z0 = z - out[2]!; }
    let solved = false;
    for (let step = 0; step < WATER_WAVE_NEWTON_STEPS; step++) {
      evaluateWithGain(spectrum, x0, z0, time, out, scale, gain);
      const rx = x0 + out[1]! - x, rz = z0 + out[2]! - z;
      if (rx * rx + rz * rz < tolerance) { solved = true; break; }
      const a = out[5]!, b = out[6]!, c = out[13]!, d = out[7]!, det = a * d - b * c;
      if (det > 1e-6) { x0 -= (d * rx - b * rz) / det; z0 -= (a * rz - c * rx) / det; }
      else { x0 -= rx; z0 -= rz; }
    }
    if (!solved) evaluateWithGain(spectrum, x0, z0, time, out, scale, gain);
  }
  out[11] = x0; out[12] = z0;
}

/**
 * Bank fade length (world metres) of a finite body's Gerstner offset: `WATER_BANK_FADE_ENVELOPES` horizontal
 * envelopes, so the offset stays well inside every bank. Zero without sideways motion.
 */
export function waterBankFadeLength(water: WaterDefinition, scale = 1): number {
  return waterBankFadeLengthOf(waterSpectrum(water), scale);
}

/** `waterBankFadeLength` of a spectrum the caller already holds, for per-query paths. */
function waterBankFadeLengthOf(spectrum: WaterSpectrum, scale: number): number {
  return WATER_BANK_FADE_ENVELOPES * waterHorizontalEnvelopeOf(spectrum, scale);
}

/**
 * Gain of the horizontal offset at a rest point `bank` world metres inside a finite body's edge: a smoothstep from 0
 * at the bank to 1 at `fadeLength`, written to out[0], and its derivative along the bank distance, written to out[1].
 * The mesh, queries and the built-in shader share it, so they agree on the faded surface. `fadeLength` 0 (no
 * sideways motion) gives 1.
 */
export function waterBankGain(bank: number, fadeLength: number, out: Float64Array): void {
  if (!(fadeLength > 0) || bank >= fadeLength) { out[0] = 1; out[1] = 0; return; }
  const t = Math.max(0, bank / fadeLength);
  out[0] = t * t * (3 - 2 * t); out[1] = 6 * t * (1 - t) / fadeLength;
}

const vertexGain = new Float64Array(2);

/**
 * CPU reference for one water vertex, allocation-free: `evaluateWaterSpectrum` at the vertex's world rest point (x0, z0)
 * with a finite body's bank fade (`waterBankGain` of `bank`, the world metres inside the edge, over `fadeLength`; 0 for
 * open water). (gradX, gradZ) is the unit rest-space direction in which the bank distance grows; it only shapes the
 * Jacobian, never the displacement. Custom Material water without a Water Waves node displaces its mesh with this.
 */
export function evaluateWaterVertex(
  spectrum: WaterSpectrum, x0: number, z0: number, time: number, scale: number,
  bank: number, fadeLength: number, gradX: number, gradZ: number, out: Float64Array,
): void {
  waterBankGain(bank, fadeLength, vertexGain);
  evaluateWaterSpectrum(spectrum, x0, z0, time, out, scale, vertexGain[0]!, vertexGain[1]! * gradX, vertexGain[1]! * gradZ);
}

/** Bound on |H| for a body (metres): four standard deviations of the sea's height. */
export function waterWaveEnvelope(water: WaterDefinition, scale = 1): number {
  return waterWaveEnvelopeOf(waterSpectrum(water), scale);
}

/** Bound on the Gerstner horizontal offset |D| for a body (metres): λ times the height envelope. Zero at Steepness 0. */
export function waterHorizontalEnvelope(water: WaterDefinition, scale = 1): number {
  return waterHorizontalEnvelopeOf(waterSpectrum(water), scale);
}

/**
 * Eulerian surface gradient J⁻ᵀ·g of a rest-space gradient g (for example ∇rest + ∇₀H) at an evaluated point, with
 * the determinant clamped so a degenerate input never divides by zero. Writes x to out[0] and z to out[1].
 */
export function waterEulerianGradient(wave: Float64Array, gx: number, gz: number, out: Float64Array): void {
  const a = wave[5]!, b = wave[6]!, c = wave[13]!, d = wave[7]!, inv = 1 / Math.max(a * d - b * c, 1e-6);
  out[0] = (d * gx - c * gz) * inv; out[1] = (a * gz - b * gx) * inv;
}

const waveScratch = createWaterWaveOutput(), gradientScratch = new Float64Array(2);

/**
 * Surface waves under world (x, z) in world metres, independent of the volume's transform. The world point is inverted
 * to its rest point first, so height, normal (J⁻ᵀ∇H) and `velocity` (∂η/∂t at this fixed X/Z) describe the rendered
 * surface; `orbital` is the water's horizontal particle velocity. Not a runtime path (queries use `sampleWaterSurface`):
 * it is the transform-free reference surface the core water tests and the render mesh parity tests check against.
 */
export function sampleWaterWaves(water: WaterDefinition, x: number, z: number, time: number, scale = 1) {
  const spectrum = waterSpectrum(water), o = waveScratch;
  invertWaterWaves(spectrum, x, z, time, o, scale);
  let sx = o[3]!, sz = o[4]!, velocity = o[8]!;
  if (waterMovesSideways(spectrum, scale)) {
    waterEulerianGradient(o, o[3]!, o[4]!, gradientScratch);
    sx = gradientScratch[0]!; sz = gradientScratch[1]!;
    velocity = o[8]! - (sx * o[9]! + sz * o[10]!);
  }
  const n = Math.hypot(sx, 1, sz);
  return { height: o[0]!, normal: { x: -sx / n, y: 1 / n, z: -sz / n }, velocity, orbital: { x: o[9]!, z: o[10]! }, restX: o[11]!, restZ: o[12]! };
}

/** Local footprint, bank distance and sloped river elevation. */
export function waterFootprint(body: WaterBodyProperties, x: number, z: number) {
  const plane = { height: 0, slopeX: 0, slopeZ: 0, flowY: 0, flowX: Math.cos(body.flowDirection * Math.PI / 180), flowZ: Math.sin(body.flowDirection * Math.PI / 180) };
  if (body.kind === "global") return { ...plane, inside: true, edge: Infinity, edgeX: 0, edgeZ: 0 };
  if (body.kind === "ocean") {
    const ex = body.width / 2 - Math.abs(x), ez = body.length / 2 - Math.abs(z);
    return { ...plane, inside: ex >= -1e-6 && ez >= -1e-6, edge: Math.min(ex, ez), edgeX: ex < ez ? Math.sign(x) : 0, edgeZ: ex < ez ? 0 : Math.sign(z) };
  }
  if (body.kind !== "river") {
    const radius = Math.hypot(x / (body.width / 2), z / (body.length / 2));
    const gx = x / (body.width * body.width / 4), gz = z / (body.length * body.length / 4), gradient = Math.hypot(gx, gz);
    return { ...plane, inside: radius <= 1 + 1e-7, edge: gradient > 1e-6 ? (1 - radius) * radius / gradient : Math.min(body.width, body.length) / 2, edgeX: gradient > 1e-6 ? gx / gradient : 1, edgeZ: gradient > 1e-6 ? gz / gradient : 0 };
  }
  const line = waterRiverCentreline(body);
  let edge = -Infinity, height = 0, flowX = 0, flowZ = 1, slopeX = 0, slopeZ = 0, flowY = 0, edgeX = 1, edgeZ = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const vx = b.x - a.x, vz = b.z - a.z, length = Math.hypot(vx, vz);
    if (length < 1e-6) continue;
    const t = clamp(((x - a.x) * vx + (z - a.z) * vz) / (length * length), 0, 1);
    const distance = Math.hypot(x - a.x - t * vx, z - a.z - t * vz);
    // Deepest inside the swept banks, so a narrow reach beside a wide one keeps its own edge.
    const inset = a.halfWidth + t * (b.halfWidth - a.halfWidth) - distance;
    if (inset > edge) {
      edge = inset; height = a.y + t * (b.y - a.y); flowX = vx / length; flowZ = vz / length;
      edgeX = distance > 1e-6 ? (x - a.x - t * vx) / distance : -flowZ;
      edgeZ = distance > 1e-6 ? (z - a.z - t * vz) / distance : flowX;
      flowY = (b.y - a.y) / length;
      const slope = (t > 0 || i > 1) && (t < 1 || i < line.length - 1) ? flowY : 0;
      slopeX = slope * flowX; slopeZ = slope * flowZ;
    }
  }
  return { inside: edge >= -1e-7, height, edge, edgeX, edgeZ, flowX, flowY, flowZ, slopeX, slopeZ };
}

export interface WaterRiverSample { x: number; y: number; z: number; halfWidth: number }

/** Sub-segments per control segment of a curved river. */
export const WATER_RIVER_SUBDIVISIONS = SPLINE_SUBDIVISIONS;
const riverLines = new WeakMap<WaterBodyProperties, { points: unknown; scales: unknown; width: number; curvature: number; line: WaterRiverSample[] }>();

/**
 * Sampled river centreline shared by rendering, queries and editor handles.
 * Elevation and width interpolate linearly between control points so water never overshoots uphill.
 */
export function waterRiverCentreline(body: WaterBodyProperties): WaterRiverSample[] {
  const cached = riverLines.get(body);
  if (cached && cached.points === body.points && cached.scales === body.widthScales && cached.width === body.width && cached.curvature === body.curvature) return cached.line;
  const half = (i: number) => body.width * (body.widthScales?.[i] ?? 1) / 2;
  const line: WaterRiverSample[] = sampleSplinePath({ points: body.points, curvature: body.curvature, closed: false }, { linearElevation: true })
    .map(({ position: [x, y, z], segmentIndex, fraction }) => ({
      x, y, z, halfWidth: fraction === 1 ? half(segmentIndex + 1) : half(segmentIndex) + (half(segmentIndex + 1) - half(segmentIndex)) * fraction,
    }));
  riverLines.set(body, { points: body.points, scales: body.widthScales, width: body.width, curvature: body.curvature, line });
  return line;
}

export type WaterFootprint = ReturnType<typeof waterFootprint>;

/**
 * The volume's rest base under world (x, z) along world vertical, starting from height y: Newton iteration preserves
 * actor/component pitch, roll and signed scales. `inverse` is the inverse of the volume's rotation and `ray` world up in
 * scaled local coordinates. `distance` is world metres from y up to the base (its world rest height is y + distance).
 * Null when the base is vertical there or the iteration fails. Points outside the footprint still find the base's
 * plane (rivers: their nearest reach), with a negative `footprint.edge`.
 */
export function waterRestBase(
  body: WaterBodyProperties, transform: Transform, inverse: QuatObject, ray: Vec3, x: number, y: number, z: number,
): { distance: number; footprint: WaterFootprint } | null {
  const { x: sx, y: sy, z: sz } = transform.scale;
  const local = quatRotateVector(inverse, { x: x - transform.position.x, y: y - transform.position.y, z: z - transform.position.z });
  const origin = { x: local.x / sx, y: local.y / sy, z: local.z / sz };
  // A level volume's base lies straight below: one footprint, solved exactly.
  if (Math.abs(ray.x) < 1e-12 && Math.abs(ray.z) < 1e-12) {
    const footprint = waterFootprint(body, origin.x, origin.z), distance = (footprint.height - origin.y) / ray.y;
    return Number.isFinite(distance) ? { distance, footprint } : null;
  }
  let distance = -origin.y / ray.y;
  for (let i = 0; i < 12; i++) {
    const footprint = waterFootprint(body, origin.x + ray.x * distance, origin.z + ray.z * distance);
    const residual = origin.y + ray.y * distance - footprint.height;
    if (Math.abs(residual) < 1e-5) break;
    const derivative = ray.y - footprint.slopeX * ray.x - footprint.slopeZ * ray.z;
    if (Math.abs(derivative) < 1e-6) return null;
    distance -= residual / derivative;
  }
  const footprint = waterFootprint(body, origin.x + ray.x * distance, origin.z + ray.z * distance);
  if (!Number.isFinite(distance) || Math.abs(origin.y + ray.y * distance - footprint.height) > 0.001) return null;
  return { distance, footprint };
}

/**
 * World-metre bank distance of a local footprint (as the mesh and `edgeDistance` measure it; negative outside) and, in
 * `gradient`, the world X/Z direction in which it grows (inward).
 */
export function waterBankDistance(footprint: WaterFootprint, transform: Transform, gradient: Float64Array): number {
  const { x: sx, z: sz } = transform.scale;
  const outward = quatRotateVector(transform.rotation, { x: footprint.edgeX / sx, y: 0, z: footprint.edgeZ / sz });
  const length = Math.hypot(outward.x, outward.y, outward.z) || 1;
  gradient[0] = -outward.x / length; gradient[1] = -outward.z / length;
  return footprint.edge / length;
}

/** Bank fade of one finite body, sampled at query inversion iterates exactly as the mesh applies it at vertices. */
class BankGain implements WaterWaveGain {
  body: WaterBodyProperties | null = null;
  transform: Transform = identityTransform();
  inverse: QuatObject = { x: 0, y: 0, z: 0, w: 1 };
  ray: Vec3 = { x: 0, y: 1, z: 0 };
  y = 0;
  fadeLength = 0;
  private readonly gradient = new Float64Array(2);
  private readonly gain = new Float64Array(2);
  sample(x0: number, z0: number, out: Float64Array): void {
    const hit = this.body ? waterRestBase(this.body, this.transform, this.inverse, this.ray, x0, this.y, z0) : null;
    // Off the base there is no horizontal motion (the fade is zero at and beyond every bank).
    if (!hit) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
    waterBankGain(waterBankDistance(hit.footprint, this.transform, this.gradient), this.fadeLength, this.gain);
    out[0] = this.gain[0]!; out[1] = this.gain[1]! * this.gradient[0]!; out[2] = this.gain[1]! * this.gradient[1]!;
  }
}

const surfaceScratch = createWaterWaveOutput(), bankScratch = new Float64Array(2);
const slopeScratch = new Float64Array(2), bankGain = new BankGain();

/**
 * What `sampleWaterSurface` derives from a body's pose alone: the inverse of its rotation and world up in scaled local
 * coordinates (`ray`, null when the scale or the base's slope leaves no surface). A caller sampling one pose many
 * times computes it once, and passes it back with that same `transform`.
 */
export interface WaterSurfaceFrame { readonly inverse: QuatObject; readonly ray: Vec3 | null }

export function waterSurfaceFrame(transform: Transform): WaterSurfaceFrame {
  const { x: sx, y: sy, z: sz } = transform.scale;
  const inverse = inverseQuat(transform.rotation);
  if (Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz)) < 1e-6) return { inverse, ray: null };
  const up = quatRotateVector(inverse, { x: 0, y: 1, z: 0 });
  const ray = { x: up.x / sx, y: up.y / sy, z: up.z / sz };
  return { inverse, ray: Math.abs(ray.y) < 1e-6 ? null : ray };
}

/**
 * World-space waves first: the world X/Z inverts to the rest point whose displaced surface lies above it, which
 * meets the transformed volume's base along world vertical (so tilted volumes and rivers match the mesh exactly);
 * waves then add their height there. `inside` and bank distance use that rest point, like the rendered surface.
 * Finite bodies fade the horizontal offset to zero at their banks (`waterBankGain`), so their displaced surface
 * covers exactly the rest footprint: a point outside it returns at once, without inverting the waves.
 * Velocity is the current plus, in X/Z, the wave's horizontal orbital (particle) velocity, and in Y the Eulerian rate
 * of surface height at this fixed X/Z. Steepness 0 reproduces the vertical-only results exactly.
 */
export function sampleWaterSurface(
  water: WaterDefinition, body: WaterBodyProperties, position: Vec3, time: number,
  transform: Transform = identityTransform(), frame?: WaterSurfaceFrame,
): WaterSample {
  if (!body.enabled || ![time, position.x, position.y, position.z].every(Number.isFinite)) return emptyWaterSample();
  const { inverse, ray } = frame ?? waterSurfaceFrame(transform);
  if (!ray) return emptyWaterSample();
  const { x: sx, y: sy, z: sz } = transform.scale;
  const spectrum = waterSpectrum(water), scale = body.waveScale, wave = surfaceScratch, gerstner = waterMovesSideways(spectrum, scale);
  let hit = waterRestBase(body, transform, inverse, ray, position.x, position.y, position.z);
  if (!hit?.footprint.inside) return emptyWaterSample();
  if (gerstner) {
    const horizontal = waterHorizontalEnvelopeOf(spectrum, scale);
    const fadeLength = body.kind === "global" ? 0 : waterBankFadeLengthOf(spectrum, scale);
    let gain: WaterWaveGain | undefined;
    // A rest point within the fade band lies at most one horizontal envelope from the query; further inside, the
    // rest point is unfaded and the plain inversion is exact.
    if (fadeLength > 0 && waterBankDistance(hit.footprint, transform, bankScratch) < fadeLength + horizontal) {
      Object.assign(bankGain, { body, transform, inverse, ray, y: position.y, fadeLength });
      gain = bankGain;
    }
    invertWaterWaves(spectrum, position.x, position.z, time, wave, scale, gain);
    bankGain.body = null;
    hit = waterRestBase(body, transform, inverse, ray, wave[11]!, position.y, wave[12]!);
    if (!hit?.footprint.inside) return emptyWaterSample();
  } else {
    invertWaterWaves(spectrum, position.x, position.z, time, wave, scale);
  }
  const footprint = hit.footprint;
  let distance = hit.distance;
  const normal = quatRotateVector(transform.rotation, {
    x: -footprint.slopeX / sx,
    y: 1 / sy,
    z: -footprint.slopeZ / sz,
  });
  if (Math.abs(normal.y) < 1e-6) return emptyWaterSample();
  const velocity = quatRotateVector(transform.rotation, {
    x: footprint.flowX * body.flowSpeed * sx,
    y: footprint.flowY * body.flowSpeed * sy,
    z: footprint.flowZ * body.flowSpeed * sz,
  });
  const flowLength = Math.hypot(velocity.x, velocity.z);
  if (flowLength > 1e-6) {
    const speed = Math.abs(body.flowSpeed) / flowLength;
    velocity.x *= speed; velocity.y *= speed; velocity.z *= speed;
  }
  const edgeDistance = footprint.edge / (Math.hypot(footprint.edgeX / sx, footprint.edgeZ / sz) || 1);
  if (gerstner) {
    // Eulerian slope J⁻ᵀ(∇rest + ∇H) at the rest point, and the height rate under this fixed X/Z as water moves past.
    waterEulerianGradient(wave, wave[3]! - normal.x / normal.y, wave[4]! - normal.z / normal.y, slopeScratch);
    const ex = slopeScratch[0]!, ez = slopeScratch[1]!;
    normal.x = -ex; normal.z = -ez;
    velocity.x += wave[9]!; velocity.z += wave[10]!;
    velocity.y += wave[8]! - (ex * wave[9]! + ez * wave[10]!);
  } else {
    const n = Math.hypot(wave[3]!, 1, wave[4]!);
    normal.x = normal.x / normal.y + (-wave[3]! / n) / (1 / n);
    normal.z = normal.z / normal.y + (-wave[4]! / n) / (1 / n);
    velocity.y += wave[8]!;
  }
  normal.y = 1;
  const magnitude = Math.hypot(normal.x, 1, normal.z);
  distance += wave[0]!;
  return {
    found: true, height: position.y + distance, depth: distance,
    normal: { x: normal.x / magnitude, y: normal.y / magnitude, z: normal.z / magnitude },
    velocity, edgeDistance,
  };
}
