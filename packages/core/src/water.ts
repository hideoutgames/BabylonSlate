import type { Transform, Vec3 } from "./math-rng";
import { createSeededRng, identityTransform } from "./math-rng";
import { inverseQuat, quatRotateVector, type QuatObject } from "./euler";
import { sampleSplinePath, SPLINE_SUBDIVISIONS } from "./spline-component";

export type WaterStyle = "realistic" | "stylized";
/** Stylized water's look: Painted (soft, lit-looking, Sea of Thieves-like) or Toon (flat bands, white line work). */
export type WaterStylizedLook = "painted" | "toon";
export type WaterKind = "global" | "ocean" | "lake" | "river" | "puddle";
export type WaterColor = [number, number, number];
/** Classic: eight fixed swell components. Ocean: eight seeded components drawn from a JONSWAP spectrum. Both share one warp. */
export type WaterWaveModel = "classic" | "ocean";

/** Version 1 Water asset. Distances are metres and time is simulation seconds. */
export interface WaterDefinition {
  style: WaterStyle;
  /** Render only: Stylized water's look; Realistic ignores it. Assets saved without it load as Painted. */
  stylizedLook: WaterStylizedLook;
  shallowColor: WaterColor;
  deepColor: WaterColor;
  foamColor: WaterColor;
  opacity: number;
  roughness: number;
  reflectionStrength: number;
  depthColorDistance: number;
  waveHeight: number;
  waveLength: number;
  waveSpeed: number;
  waveDirection: number;
  /** 0 is rounded sine swell; 1 is sharp crests with flat troughs. */
  choppiness: number;
  /** Angular spread of the swell components: 0 is one heading, 1 is a confused sea. */
  waveSpread: number;
  rippleStrength: number;
  rippleScale: number;
  foamAmount: number;
  foamWidth: number;
  /** Whitecaps on steep crests. */
  crestFoam: number;
  /** Metres of foam around objects and terrain that intersect the surface. */
  contactFoamWidth: number;
  /** Open-water foam: wind streaks and trailing foam (Realistic) or chunky drifting foam patches (Stylized). */
  surfaceFoam: number;
  /** Sunlight scattered through wave crests seen toward the sun; Stylized also lightens wave tops. */
  subsurface: number;
  colorBands: number;
  /** Twinkling sun glints, mostly for Stylized water. */
  sparkles: number;
  density: number;
  materialGuid: string | null;
  /** Gerstner horizontal motion (0-1): 0 moves water only vertically; physics and rendering share it. */
  steepness: number;
  /** Swell source; physics and rendering share it. */
  waveModel: WaterWaveModel;
  /** Ocean Spectrum only: JONSWAP peak enhancement γ (1-7). */
  peakSharpness: number;
  /** Ocean Spectrum only: integer 0-65535 choosing the deterministic component draw. */
  waveSeed: number;
  /** Render only: gain of the FFT detail band above the analytic components (0-1). */
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

/**
 * Defaults of a new Water asset. Stylized defaults follow `look` (Realistic ignores it): Painted and Toon differ only
 * in colours, Reflection Strength, Depth Color Distance, Color Bands and Sparkles.
 */
export function createDefaultWaterDefinition(style: WaterStyle = "realistic", look: WaterStylizedLook = "painted"): WaterDefinition {
  const stylized = style === "stylized", toon = stylized && look === "toon";
  return {
    style, stylizedLook: look,
    shallowColor: toon ? [0.2, 0.86, 0.9] : stylized ? [0.1, 0.72, 0.66] : [0.1, 0.68, 0.95],
    deepColor: toon ? [0.05, 0.27, 0.7] : stylized ? [0.04, 0.21, 0.31] : [0.03, 0.15, 0.3],
    foamColor: toon ? [1, 1, 1] : stylized ? [0.97, 0.99, 1] : [0.9, 0.93, 0.94],
    opacity: stylized ? 1 : 0.97, roughness: stylized ? 0.3 : 0.04,
    reflectionStrength: toon ? 0.8 : 1, depthColorDistance: toon ? 6 : stylized ? 4 : 6.5,
    waveHeight: 0.35, waveLength: 12, waveSpeed: 1.3, waveDirection: 25,
    choppiness: stylized ? 0.2 : 0.45, waveSpread: 0.5,
    rippleStrength: stylized ? 0.35 : 0.6, rippleScale: stylized ? 1 : 1.4,
    foamAmount: stylized ? 1 : 0.6, foamWidth: stylized ? 1.2 : 0.8,
    crestFoam: 0.35, contactFoamWidth: stylized ? 0.6 : 1.2,
    surfaceFoam: stylized ? 0.4 : 0.15, subsurface: 1,
    colorBands: toon ? 3 : 0, sparkles: toon ? 0.4 : stylized ? 0.5 : 0, density: 1000, materialGuid: null,
    steepness: stylized ? 0.3 : 0.5, waveModel: "classic", peakSharpness: 3.3, waveSeed: 0,
    detailWaves: stylized ? 0 : 1, refraction: stylized ? 0.15 : 0.35, objectReflections: !stylized,
    colorVariation: 0.5,
  };
}

export function normalizeWaterDefinition(value: unknown): WaterDefinition {
  const v = record(value);
  const d = createDefaultWaterDefinition(v.style === "stylized" ? "stylized" : "realistic", v.stylizedLook === "toon" ? "toon" : "painted");
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
    waveLength: number(v.waveLength, d.waveLength, 0.1, 1000),
    waveSpeed: number(v.waveSpeed, d.waveSpeed, 0, 20),
    waveDirection: number(v.waveDirection, d.waveDirection, -360, 360),
    choppiness: number(v.choppiness, d.choppiness, 0, 1),
    waveSpread: number(v.waveSpread, d.waveSpread, 0, 1),
    rippleStrength: number(v.rippleStrength, d.rippleStrength, 0, 1),
    rippleScale: number(v.rippleScale, d.rippleScale, 0.1, 100),
    foamAmount: number(v.foamAmount, d.foamAmount, 0, 1),
    foamWidth: number(v.foamWidth, d.foamWidth, 0, 20),
    crestFoam: number(v.crestFoam, d.crestFoam, 0, 1),
    contactFoamWidth: number(v.contactFoamWidth, d.contactFoamWidth, 0, 8),
    surfaceFoam: number(v.surfaceFoam, d.surfaceFoam, 0, 1),
    subsurface: number(v.subsurface, d.subsurface, 0, 2),
    colorBands: Math.round(number(v.colorBands, d.colorBands, 0, 12)),
    sparkles: number(v.sparkles, d.sparkles, 0, 1),
    density: number(v.density, d.density, 1, 20000),
    materialGuid: guid(v.materialGuid),
    steepness: number(v.steepness, d.steepness, 0, 1),
    waveModel: v.waveModel === "ocean" || v.waveModel === "classic" ? v.waveModel : d.waveModel,
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

/**
 * Classic swell: [heading turn, relative frequency, relative amplitude, phase]; `waterWaveSet` builds the Classic
 * model from this table. Eight components with their energy spread over the band like a sea spectrum (none carries more
 * than a third of it, so no single wave train prints parallel rows) and headings fanned to both sides of Wave
 * Direction; the three longest cross at up to 0.77 × Wave Spread × 2 radians, so where distance filters out the shorter
 * ones the far sea still reads as short, crossing crests rather than long parallel rows. Their frequencies are spread so that the deep-water angular frequencies (∝ √frequency) never come back
 * into step: the slope-weighted autocorrelation Σ (k·a)²·cos(ω·τ) stays under 0.24 from the first zero crossing to
 * five peak periods (the old table's components re-aligned to 0.33 one period later, a visible ~2 s beat on short
 * Wave Lengths). Σ a² is that of the original five-component table (0.3591), so the sea's significant height is
 * unchanged.
 */
export const waterWaveComponents = [
  [0.5, 0.778, 0.198, 2.87], [-0.27, 0.894, 0.3349, 3.65], [0.2, 1.149, 0.3355, 1.55], [-0.26, 1.609, 0.2247, 0.61],
  [-0.46, 1.99, 0.1436, 5.68], [0.6, 2.558, 0.1061, 2.56], [0.9, 3.166, 0.0876, 4.53], [-0.87, 3.612, 0.0717, 4.15],
] as const;

/**
 * The swell's shared domain warp, both models: [heading turn from Wave Direction (radians), wavenumber relative to the
 * peak (2π / Wave Length), amplitude relative to Wave Length, phase, drift rate relative to the peak's angular frequency
 * √(g · 2π / Wave Length) · Wave Speed]. Every component is evaluated at the warped rest point u = x0 + W(x0, t),
 * W = Σ A·K̂·cos(K·x0 + φ − ν·t) = ∇φ (a gradient field, so ∂W/∂x0 is symmetric), so a finite set of plane waves never
 * repeats as a regular lattice: crests curve over about eight wavelengths and the local wavelength and heading drift by
 * up to `WaterWaveSet.warpStretch`. The warp travels slowly (each term once every 16 to 37 peak periods, its
 * displacement changing at a few percent of the crests' speed, so nothing swims), which keeps the components' relative
 * phases from ever returning: a fixed view never sees the same sea again, where a static warp let it recur every
 * 20 to 50 s. The rates satisfy 3ν₀ − 2ν₁ + ν₂ = 0, so the FFT band's tile blend (that combination of the terms'
 * phases) stays fixed in the world. Amplitudes of 0.26 Wave Lengths (rather than 0.2) bend crest rows enough that the
 * strongest off-axis autocorrelation of the swell's slope beyond a wavelength falls by about a third (0.28 to 0.2 on a
 * 22 m swell, 0.35 to 0.27 on a short calm one) and its sharpest spectral peak by about four times, so crest rows no
 * longer run parallel across a view; the Gerstner bound (`jacobianSlope`) takes the larger stretch into account.
 * Independent of quality, so physics and every renderer evaluate the same surface.
 */
export const waterSwellWarp = [
  [0.4, 0.125, 0.26, 0.7, 0.027], [2.5, 0.104, 0.26, 2.9, 0.061], [4.4, 0.149, 0.26, 5.1, 0.041],
] as const;
/** Terms of `waterSwellWarp`. */
export const WATER_SWELL_WARP_TERMS = waterSwellWarp.length;

/**
 * Wave groups, both models, per component slot: [envelope wavenumber relative to the component's, envelope heading turn
 * from the component's (radians), phase, depth m]. Each component's height is modulated by
 * g = (1 + m·cos(κ·ê·u − Ω·t + ψ)) / √(1 + m²/2), κ = ratio · k, which travels at the component's deep-water group velocity
 * (Ω = κ·(ê·d)·ω / 2k, half the crest speed along the component's heading): crests run through each group, growing and
 * fading as they pass, so the sea comes in sets with calmer water between them and the same crest never returns to the
 * same place after a period. Groups are 9 to 17 of their component's wavelengths long and turned well off its heading
 * (0.7 to 1.2 radians), and deep (m 0.65 to 0.85), so across a wide view each component swells and nearly vanishes in
 * its own patches: different headings lead in different places, and far water never reads as one even texture of
 * parallel rows. The √ keeps each component's mean energy (the sea's significant height). Only the height carries the
 * envelope: the Gerstner horizontal offset stays unmodulated, so the Jacobian bound (and with it Steepness's crest
 * sharpness) is unchanged. Evaluated at the warped rest point like the components themselves.
 */
export const waterWaveGroups = [
  [0.07, 0.9, 0.9, 0.8], [0.09, -0.8, 4.1, 0.85], [0.06, 1.1, 2.3, 0.85], [0.08, -1.0, 5.6, 0.8],
  [0.1, 0.7, 1.4, 0.75], [0.075, -1.2, 3.3, 0.7], [0.11, 0.8, 0.2, 0.7], [0.085, -0.9, 4.8, 0.65],
] as const;

/**
 * Swell surges, both models, per component slot: [rate A, rate B (relative to the component's angular frequency), phase
 * A, phase B]. Each component's phase gains s(t) = β·(sin(Ωa·t + ψa) + sin(Ωb·t + ψb)), the same everywhere at one
 * time, with β = `WATER_SURGE_DEPTH` × min(1, relative wavenumber / 2): its crests surge ahead and linger by up to a
 * quarter of their speed (the long components carrying the drift by less), on two slow tones in irrational ratios to
 * each other and to every other component's. A fixed set of plane waves otherwise brought a
 * still view back in step every few seconds (frame autocorrelations of 0.3 to 0.4 two to ten seconds apart, the
 * shortest swell component one dominant line in a calm view's temporal spectrum); surged, the components keep drifting
 * out of step and each spreads into a comb of sidebands. Being uniform in space, a surge changes no wavevector, so
 * slopes, the Jacobian and its Gerstner bound are untouched: only the phase and the time derivatives (the velocity
 * the orbital motion and buoyancy read) take it. Free on the GPU, whose phases arrive reduced on the CPU.
 */
export const waterWaveSurges = [
  [0.131, 0.083, 0.4, 2.9], [0.097, 0.142, 1.7, 5.2], [0.118, 0.071, 3.3, 0.8], [0.089, 0.137, 4.6, 2.2],
  [0.124, 0.077, 5.9, 3.7], [0.103, 0.149, 1.1, 4.4], [0.141, 0.092, 2.5, 6.0], [0.079, 0.127, 3.9, 1.4],
] as const;
/** Depth β (radians) of each surge tone (`waterWaveSurges`). */
export const WATER_SURGE_DEPTH = 1.1;

/** Mean and half-range of `exp(sin p - 1)`, used to centre the sharp-crest profile. */
export const WATER_CREST_MEAN = 0.465760;
export const WATER_CREST_RANGE = 0.534240;

/**
 * Wave profile blended from a sine towards sharp crests, and its phase derivative.
 * @deprecated Allocates a result per call. `evaluateWaterWaves` evaluates the same profile without allocating.
 */
export function waterWaveProfile(p: number, choppiness: number): { value: number; slope: number } {
  const sin = Math.sin(p), cos = Math.cos(p), crest = Math.exp(sin - 1);
  return {
    value: sin + ((crest - WATER_CREST_MEAN) / WATER_CREST_RANGE - sin) * choppiness,
    slope: cos + (crest * cos / WATER_CREST_RANGE - cos) * choppiness,
  };
}

/** Upper bound of the Gerstner factor q, so small or gentle waves never become needle crests. */
export const WATER_STEEPNESS_CAP = 3.5;
/** Smallest Jacobian determinant Steepness 1 can reach when every crest aligns: the surface never folds over. */
export const WATER_JACOBIAN_FLOOR = 0.1;
/** Most analytic components any wave model uses (both use eight). */
export const WATER_WAVE_MAX_COMPONENTS = 8;
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
 * Slots of the `out` array written by `evaluateWaterWaves` (0-10 and 13) and `invertWaterWaves` (0-13). Derivatives
 * are taken with respect to the rest (Lagrangian) point x0/z0. The Jacobian J = ∂(x0 + D)/∂(x0, z0) includes the
 * identity: `jacobianXZ` is ∂x/∂z0 and `jacobianZX` is ∂z/∂x0, equal unless a bank fade varies across the point.
 */
export const WaterWaveSlot = {
  height: 0, offsetX: 1, offsetZ: 2, slopeX: 3, slopeZ: 4, jacobianXX: 5, jacobianXZ: 6, jacobianZZ: 7,
  heightRate: 8, offsetRateX: 9, offsetRateZ: 10, restX: 11, restZ: 12, jacobianZX: 13,
} as const;
export const WATER_WAVE_OUTPUT_SIZE = 14;
/** Reusable output for `evaluateWaterWaves` and `invertWaterWaves`. */
export const createWaterWaveOutput = (): Float64Array => new Float64Array(WATER_WAVE_OUTPUT_SIZE);

/**
 * Scale-independent analytic components of one Water definition, cached per definition object (`waterWaveSet`).
 * Wave Scale only multiplies amplitudes, so one set serves every body that uses the asset.
 */
export interface WaterWaveSet {
  readonly model: WaterWaveModel;
  readonly count: number;
  /** Wavenumber (rad/m). */
  readonly k: Float64Array;
  /** Angular frequency (rad/s), including Wave Speed. */
  readonly omega: Float64Array;
  readonly dirX: Float64Array;
  readonly dirZ: Float64Array;
  /** Amplitude relative to Wave Height: metres per metre of Wave Height at Wave Scale 1. */
  readonly amplitude: Float64Array;
  /** Phase at the world origin and time zero (radians). */
  readonly phase: Float64Array;
  /**
   * Wavenumber relative to 2π / Wave Length; mesh spacing fades a component by `spacing · frequency · warpStretch · 4 /
   * waveLength` (the warp compresses it locally by up to `warpStretch`).
   */
  readonly frequency: Float64Array;
  /**
   * Per component, its wave group (`waterWaveGroups`): the envelope's wavevector κ·ê (rad/m), angular frequency Ω
   * (rad/s, including Wave Speed), phase and depth m.
   */
  readonly groupX: Float64Array;
  readonly groupZ: Float64Array;
  readonly groupOmega: Float64Array;
  readonly groupPhase: Float64Array;
  readonly groupDepth: Float64Array;
  /**
   * Per component, its two surge tones (`waterWaveSurge`), interleaved: angular frequencies (rad/s, including Wave
   * Speed) and phases.
   */
  readonly surgeOmega: Float64Array;
  readonly surgePhase: Float64Array;
  /**
   * `waterSwellWarp` in world units: each term's unit heading, wavenumber (rad/m), amplitude (m), phase and drift rate
   * ν (rad/s, including Wave Speed).
   */
  readonly warpDirX: Float64Array;
  readonly warpDirZ: Float64Array;
  readonly warpK: Float64Array;
  readonly warpAmplitude: Float64Array;
  readonly warpPhase: Float64Array;
  readonly warpOmega: Float64Array;
  /**
   * 1 + the largest eigenvalue ∂W/∂x0 can reach anywhere (its terms' signs taken independently): no warped wavevector is
   * longer than this many times its own.
   */
  readonly warpStretch: number;
  readonly waveHeight: number;
  readonly waveLength: number;
  readonly waveSpeed: number;
  readonly waveDirection: number;
  readonly waveSpread: number;
  readonly choppiness: number;
  readonly steepness: number;
  readonly peakSharpness: number;
  readonly waveSeed: number;
  readonly detailWaves: number;
  /**
   * S₁ = Σ k·A at Wave Scale 1 from unfiltered amplitudes (A = Wave Height · amplitude).
   */
  readonly slopeSum: number;
  /**
   * The largest Σ k·A·dᵀ·M·d (M = I + ∂W/∂x0, the warp's stretch along each heading) anywhere on the surface: S₁ plus
   * Σₜ Aₜ·Kₜ·Σᵢ kᵢ·Aᵢ·(dᵢ·K̂ₜ)², every warp term at its most stretching phase. Bounds the Jacobian (`waterWaveQ`).
   */
  readonly jacobianSlope: number;
  /** Σ A at Wave Scale 1: the horizontal envelope's sum (the Gerstner offset carries no wave groups). */
  readonly amplitudeSum: number;
  /**
   * Σ A·(1 + m)/√(1 + m²/2) at Wave Scale 1: the vertical envelope of the analytic waves (the crest profile stays within
   * ±1 and a wave group raises a component by at most that factor).
   */
  readonly heightSum: number;
  /**
   * Σ k·A²·ω·d / 2 at Wave Scale 1 and q = 1 (m/s), unwarped. Under Gerstner waves a fixed point sees the orbital
   * velocity average to −q²·scale² times this, each component weighted by dᵀ·(I + ∂W/∂x0)·d there; `waterWaveDrift`
   * cancels that, so waves rock floating objects without pushing them upwind.
   */
  readonly driftX: number;
  readonly driftZ: number;
  /** 2π / Wave Length (rad/m): the spectrum's peak wavenumber. */
  readonly peakK: number;
  /**
   * The highest wavenumber the analytic components represent (4 × peakK for both models; Classic's shortest swell is
   * 3.67 × peakK). Render-only detail (Detail Waves, the FFT band) synthesizes only wavenumbers above it.
   */
  readonly cutoffK: number;
  /**
   * Omnidirectional variance density S(k) = spectrumScale · shape(k / peakK, spectrumSharpness) (m³ at Wave Scale 1)
   * (`waterOceanSpectrumDensity`). Ocean Spectrum: the normalization its analytic components were drawn from.
   * Classic: the same JONSWAP shape normalized so the analytic band carries the Classic swell's variance.
   */
  readonly spectrumScale: number;
  /** JONSWAP peak enhancement γ of the density: Peak Sharpness for Ocean Spectrum, 3.3 for Classic. */
  readonly spectrumSharpness: number;
  /** Significant height (4σ, metres at Wave Scale 1) of the spectrum above `cutoffK`, before Detail Waves. */
  readonly detailHeight: number;
}

const TAU = 2 * Math.PI;
/** Σ a² of the Classic table: the Ocean Spectrum matches its significant height, Hs = 4·sqrt(Σ a²/2) ≈ 1.69 × Wave Height. */
const CLASSIC_ENERGY = waterWaveComponents.reduce((sum, [, , amplitude]) => sum + amplitude * amplitude, 0);
/** Analytic band in multiples of the peak wavenumber: Ocean Spectrum draws its components here, and both models' render-only detail starts above it. */
const OCEAN_BAND = [0.7, 4] as const;
/** JONSWAP peak enhancement of the Classic model's detail density (the JONSWAP mean; Peak Sharpness is Ocean Spectrum only). */
const CLASSIC_SPECTRUM_SHARPNESS = 3.3;

/** Deep-water JONSWAP shape in wavenumber (k^-3 tail), relative to the peak wavenumber; constants normalize away. */
function oceanShape(kRel: number, gamma: number): number {
  const sigma = kRel <= 1 ? 0.07 : 0.09, offset = Math.sqrt(kRel) - 1;
  return kRel ** -3 * Math.exp(-1.25 / (kRel * kRel)) * gamma ** Math.exp(-(offset * offset) / (2 * sigma * sigma));
}

/** ∫ shape d(kRel) over [low, high] (log-spaced trapezoid with a fixed step count, so every host agrees). */
function shapeIntegral(low: number, high: number, gamma: number, steps: number): number {
  let sum = 0, previous = low, previousValue = oceanShape(low, gamma);
  for (let i = 1; i <= steps; i++) {
    const k = low * (high / low) ** (i / steps), value = oceanShape(k, gamma);
    sum += (k - previous) * (value + previousValue) / 2; previous = k; previousValue = value;
  }
  return sum;
}

/** Inverse CDF of a cos² heading distribution on [-π/2, π/2] (fixed bisection, so every host agrees). */
function spreadAngle(quantile: number): number {
  let low = -Math.PI / 2, high = Math.PI / 2;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (0.5 + (middle + Math.sin(middle) * Math.cos(middle)) / Math.PI < quantile) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

type MutableWaveSet = { -readonly [K in keyof WaterWaveSet]: WaterWaveSet[K] };

function buildWaveSet(water: WaterDefinition): WaterWaveSet {
  const ocean = water.waveModel === "ocean", count = ocean ? WATER_WAVE_MAX_COMPONENTS : waterWaveComponents.length;
  const angle = water.waveDirection * Math.PI / 180;
  const set: MutableWaveSet = {
    model: ocean ? "ocean" : "classic", count,
    k: new Float64Array(count), omega: new Float64Array(count), dirX: new Float64Array(count), dirZ: new Float64Array(count),
    amplitude: new Float64Array(count), phase: new Float64Array(count), frequency: new Float64Array(count),
    groupX: new Float64Array(count), groupZ: new Float64Array(count), groupOmega: new Float64Array(count),
    groupPhase: new Float64Array(count), groupDepth: new Float64Array(count), heightSum: 0,
    surgeOmega: new Float64Array(count * 2), surgePhase: new Float64Array(count * 2),
    warpDirX: new Float64Array(WATER_SWELL_WARP_TERMS), warpDirZ: new Float64Array(WATER_SWELL_WARP_TERMS),
    warpK: new Float64Array(WATER_SWELL_WARP_TERMS), warpAmplitude: new Float64Array(WATER_SWELL_WARP_TERMS),
    warpPhase: new Float64Array(WATER_SWELL_WARP_TERMS), warpOmega: new Float64Array(WATER_SWELL_WARP_TERMS), warpStretch: 1, jacobianSlope: 0,
    waveHeight: water.waveHeight, waveLength: water.waveLength, waveSpeed: water.waveSpeed, waveDirection: water.waveDirection,
    waveSpread: water.waveSpread, choppiness: water.choppiness, steepness: water.steepness, peakSharpness: water.peakSharpness,
    waveSeed: water.waveSeed, detailWaves: water.detailWaves,
    slopeSum: 0, amplitudeSum: 0, driftX: 0, driftZ: 0, peakK: TAU / water.waveLength, cutoffK: TAU / water.waveLength * OCEAN_BAND[1],
    spectrumScale: 0, spectrumSharpness: ocean ? water.peakSharpness : CLASSIC_SPECTRUM_SHARPNESS, detailHeight: 0,
  };
  const headings = new Float64Array(count);
  if (!ocean) {
    waterWaveComponents.forEach(([turn, frequency, amplitude, phase], i) => {
      set.k[i] = 2 * Math.PI * frequency / water.waveLength;
      headings[i] = angle + turn * water.waveSpread * 2;
      set.frequency[i] = frequency; set.amplitude[i] = amplitude; set.phase[i] = phase;
    });
    // Detail above the swell follows the JONSWAP shape, scaled so the analytic band holds the Classic variance.
    set.spectrumScale = water.waveHeight * water.waveHeight * CLASSIC_ENERGY / 2
      / (set.peakK * shapeIntegral(OCEAN_BAND[0], OCEAN_BAND[1], CLASSIC_SPECTRUM_SHARPNESS, 128));
  } else {
    // Stratified log-k over the analytic band, seeded jitter inside each stratum, amplitudes from the JONSWAP density.
    const rng = createSeededRng(water.waveSeed), gamma = water.peakSharpness;
    const low = Math.log(OCEAN_BAND[0]), step = (Math.log(OCEAN_BAND[1]) - low) / count;
    let energy = 0;
    for (let i = 0; i < count; i++) {
      const relative = Math.exp(low + (i + 0.15 + 0.7 * rng.nextFloat()) * step);
      const width = Math.exp(low + (i + 1) * step) - Math.exp(low + i * step);
      set.frequency[i] = relative;
      set.k[i] = 2 * Math.PI * relative / water.waveLength;
      set.amplitude[i] = Math.sqrt(2 * oceanShape(relative, gamma) * width);
      energy += set.amplitude[i]! ** 2;
    }
    for (let i = 0; i < count; i++) set.phase[i] = rng.nextFloat() * TAU;
    const normalize = Math.sqrt(CLASSIC_ENERGY / energy);
    for (let i = 0; i < count; i++) set.amplitude[i]! *= normalize;
    // The strongest components take the central strata of the heading spread, alternating sides by seed, so the
    // dominant swell runs along Wave Direction and Wave Spread 0 is one heading (as with Classic).
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => set.amplitude[b]! - set.amplitude[a]! || a - b);
    for (let rank = 0; rank < count; rank += 2) {
      const side = rng.nextFloat() < 0.5 ? -1 : 1;
      for (let m = 0; m < 2 && rank + m < count; m++) {
        const offset = (rank / 2 + 0.5 + (rng.nextFloat() - 0.5) * 0.8) / count;
        headings[order[rank + m]!] = angle + 2 * water.waveSpread * spreadAngle(0.5 + (m === 0 ? side : -side) * offset);
      }
    }
    set.spectrumScale = water.waveHeight * water.waveHeight * normalize * normalize / set.peakK;
  }
  // Variance above the analytic band (log-spaced trapezoid plus the k^-3 tail beyond 64 × the cutoff), for render-only
  // detail bounds.
  const tailStart = OCEAN_BAND[1] * 64;
  const detail = shapeIntegral(OCEAN_BAND[1], tailStart, set.spectrumSharpness, 64) + 1 / (2 * tailStart * tailStart);
  set.detailHeight = 4 * Math.sqrt(set.spectrumScale * set.peakK * detail);
  for (let i = 0; i < count; i++) {
    set.dirX[i] = Math.cos(headings[i]!); set.dirZ[i] = Math.sin(headings[i]!);
    set.omega[i] = Math.sqrt(9.81 * set.k[i]!) * water.waveSpeed;
    const [ratio, turn, groupPhase, depth] = waterWaveGroups[i]!, envelope = ratio * set.k[i]!;
    set.groupX[i] = envelope * Math.cos(headings[i]! + turn); set.groupZ[i] = envelope * Math.sin(headings[i]! + turn);
    // Deep-water group velocity ω / 2k along the heading, seen along the envelope's own wavevector.
    set.groupOmega[i] = envelope * Math.cos(turn) * set.omega[i]! / (2 * set.k[i]!);
    set.groupPhase[i] = groupPhase; set.groupDepth[i] = depth;
    const [rateA, rateB, surgeA, surgeB] = waterWaveSurges[i]!;
    set.surgeOmega[i * 2] = rateA * set.omega[i]!; set.surgeOmega[i * 2 + 1] = rateB * set.omega[i]!;
    set.surgePhase[i * 2] = surgeA; set.surgePhase[i * 2 + 1] = surgeB;
    const amplitude = water.waveHeight * set.amplitude[i]!;
    set.amplitudeSum += amplitude; set.slopeSum += set.k[i]! * amplitude;
    set.heightSum += amplitude * (1 + depth) / Math.sqrt(1 + 0.5 * depth * depth);
    const drift = set.k[i]! * amplitude * amplitude * set.omega[i]! / 2;
    set.driftX += drift * set.dirX[i]!; set.driftZ += drift * set.dirZ[i]!;
  }
  const peakOmega = Math.sqrt(9.81 * set.peakK) * water.waveSpeed;
  waterSwellWarp.forEach(([turn, frequency, amplitude, phase, rate], t) => {
    set.warpDirX[t] = Math.cos(angle + turn); set.warpDirZ[t] = Math.sin(angle + turn);
    set.warpK[t] = set.peakK * frequency; set.warpAmplitude[t] = water.waveLength * amplitude; set.warpPhase[t] = phase;
    set.warpOmega[t] = rate * peakOmega;
  });
  set.warpStretch = 1 + warpEigenBound(set);
  set.jacobianSlope = set.slopeSum;
  for (let t = 0; t < WATER_SWELL_WARP_TERMS; t++) {
    let along = 0;
    for (let i = 0; i < count; i++) {
      const cos = set.dirX[i]! * set.warpDirX[t]! + set.dirZ[i]! * set.warpDirZ[t]!;
      along += set.k[i]! * water.waveHeight * set.amplitude[i]! * cos * cos;
    }
    set.jacobianSlope += set.warpAmplitude[t]! * set.warpK[t]! * along;
  }
  return set;
}

/**
 * The largest eigenvalue ∂W/∂x0 = −Σ A·K·sin(K·x0 + φ)·K̂K̂ᵀ can take: the largest |eigenvalue| of Σ s·A·K·K̂K̂ᵀ over
 * every sign pattern s ∈ {−1, 1} (the norm is convex in s, so a vertex of the cube attains it, and the terms' phases
 * are incommensurate, so the surface approaches every pattern somewhere).
 */
function warpEigenBound(set: WaterWaveSet): number {
  let bound = 0;
  for (let signs = 0; signs < 1 << WATER_SWELL_WARP_TERMS; signs++) {
    let xx = 0, xz = 0, zz = 0;
    for (let t = 0; t < WATER_SWELL_WARP_TERMS; t++) {
      const c = (signs >> t & 1 ? -1 : 1) * set.warpAmplitude[t]! * set.warpK[t]!, x = set.warpDirX[t]!, z = set.warpDirZ[t]!;
      xx += c * x * x; xz += c * x * z; zz += c * z * z;
    }
    const mean = (xx + zz) / 2, radius = Math.hypot((xx - zz) / 2, xz);
    bound = Math.max(bound, Math.abs(mean) + radius);
  }
  return bound;
}

/**
 * The swell's warp (`waterSwellWarp`) at rest point (x0, z0) and simulation time `time`, allocation-free: writes W
 * (`out` 0-1), the symmetric ∂W/∂x0 (`out` 2-4: xx, xz, zz) and ∂W/∂t (`out` 5-6).
 */
export function evaluateWaterSwellWarp(set: WaterWaveSet, x0: number, z0: number, out: Float64Array, time = 0): void {
  let wx = 0, wz = 0, xx = 0, xz = 0, zz = 0, tx = 0, tz = 0;
  for (let t = 0; t < WATER_SWELL_WARP_TERMS; t++) {
    const x = set.warpDirX[t]!, z = set.warpDirZ[t]!, k = set.warpK[t]!, a = set.warpAmplitude[t]!, omega = set.warpOmega[t]!;
    const p = k * (x * x0 + z * z0) + set.warpPhase[t]! - omega * time, cos = Math.cos(p), sine = Math.sin(p), sin = a * k * sine;
    wx += a * x * cos; wz += a * z * cos;
    xx -= sin * x * x; xz -= sin * x * z; zz -= sin * z * z;
    tx += a * omega * sine * x; tz += a * omega * sine * z;
  }
  out[0] = wx; out[1] = wz; out[2] = xx; out[3] = xz; out[4] = zz; out[5] = tx; out[6] = tz;
}

const waveSets = new WeakMap<WaterDefinition, WaterWaveSet>();
const sameWaves = (set: WaterWaveSet, w: WaterDefinition) => set.model === (w.waveModel === "ocean" ? "ocean" : "classic")
  && set.waveHeight === w.waveHeight && set.waveLength === w.waveLength && set.waveSpeed === w.waveSpeed
  && set.waveDirection === w.waveDirection && set.waveSpread === w.waveSpread && set.choppiness === w.choppiness
  && Object.is(set.steepness, w.steepness) && Object.is(set.peakSharpness, w.peakSharpness)
  && Object.is(set.waveSeed, w.waveSeed) && Object.is(set.detailWaves, w.detailWaves);

/**
 * Recently built wave sets, newest last: definitions with the same wave fields (every body of one asset, which each
 * hold their own copy) share one immutable set, so caches keyed on the set (shader constants, FFT layouts, slope
 * orders) are shared too. Bounded; an evicted set stays valid for the definitions that still hold it.
 */
const internedWaveSets: WaterWaveSet[] = [];
const INTERNED_WAVE_SETS = 32;

/**
 * The definition's analytic components, built once per distinct set of wave fields and rebuilt only when a wave field
 * changes. Never keyed on Wave Scale, which scripts and editor handles change live.
 */
export function waterWaveSet(water: WaterDefinition): WaterWaveSet {
  const cached = waveSets.get(water);
  if (cached && sameWaves(cached, water)) return cached;
  let set: WaterWaveSet | undefined;
  for (let i = internedWaveSets.length - 1; i >= 0; i--) if (sameWaves(internedWaveSets[i]!, water)) { set = internedWaveSets[i]!; break; }
  if (!set) {
    set = buildWaveSet(water);
    internedWaveSets.push(set);
    if (internedWaveSets.length > INTERNED_WAVE_SETS) internedWaveSets.shift();
  }
  waveSets.set(water, set);
  return set;
}

/**
 * Gerstner factor for a body's Wave Scale:
 * `steepness · min(WATER_STEEPNESS_CAP, (1 - WATER_JACOBIAN_FLOOR) / (jacobianSlope·scale))`. Horizontal motion scales
 * with amplitude, so flat water never moves sideways, and the Jacobian stays at or above the floor, so the surface
 * never folds and the inversion always converges: with M = I + ∂W/∂x0 (symmetric and positive definite),
 * det(I − S·M) = det(I − M^½·S·M^½), and M^½·S·M^½ = Σ q·a·k·sin p·(M^½d)(M^½d)ᵀ with |M^½d|² = dᵀ·M·d, so the
 * determinant stays at or above 1 − q·Σ k·A·dᵀ·M·d ≥ 1 − q·jacobianSlope.
 */
export function waterWaveQ(set: WaterWaveSet, scale = 1): number {
  if (!(set.steepness > 0)) return 0;
  return set.steepness * Math.min(WATER_STEEPNESS_CAP, (1 - WATER_JACOBIAN_FLOOR) / Math.max(set.jacobianSlope * Math.abs(scale), 1e-9));
}

const warpScratch = new Float64Array(7);

const surges = new WeakMap<WaterWaveSet, { time: number; values: Float64Array }>();
/**
 * Every component's surge (`waterWaveSurges`) at simulation time `time`: slot i holds the phase it adds and slot
 * `count + i` its rate ∂s/∂t (rad/s; the component's phase advances at −ω + that). Cached per set for the last time
 * asked, so a tick's many evaluations compute it once; the array is reused, so callers copy what they keep.
 */
export function waterWaveSurge(set: WaterWaveSet, time: number): Float64Array {
  let entry = surges.get(set);
  if (!entry) { entry = { time: Number.NaN, values: new Float64Array(set.count * 2) }; surges.set(set, entry); }
  if (entry.time !== time) {
    entry.time = time;
    const values = entry.values, omega = set.surgeOmega, phase = set.surgePhase;
    for (let i = 0; i < set.count; i++) {
      const a = omega[i * 2]! * time + phase[i * 2]!, b = omega[i * 2 + 1]! * time + phase[i * 2 + 1]!;
      const depth = WATER_SURGE_DEPTH * Math.min(1, set.frequency[i]! / 2);
      values[i] = depth * (Math.sin(a) + Math.sin(b));
      values[set.count + i] = depth * (omega[i * 2]! * Math.cos(a) + omega[i * 2 + 1]! * Math.cos(b));
    }
  }
  return entry.values;
}

/**
 * Forward Gerstner evaluation at the rest point (x0, z0), allocation-free: writes height H, horizontal offset D,
 * ∇₀H, the Jacobian J = ∂(x0 + D)/∂(x0, z0), ∂H/∂t and ∂D/∂t into `out` (`WaterWaveSlot` 0-10 and 13). The rendered
 * surface point is (x0 + Dx, rest height + H, z0 + Dz). Every component is evaluated at the warped rest point
 * u = x0 + W(x0) (`waterSwellWarp`), so the rest-space derivatives carry M = I + ∂W/∂x0: ∇₀H = M·∇ᵤH and
 * ∇₀D = ∇ᵤD·M. Each component's height rides its wave group (`waterWaveGroups`), whose envelope also enters ∇₀H and
 * ∂H/∂t; the offset D does not. `spacing` (metres between mesh vertices) fades unresolvable components (at their most
 * compressed wavelength); physics passes 0. q never depends on spacing, so mesh detail never changes horizontal motion.
 * `gain` (with its rest-space gradient) scales the horizontal offset: finite bodies pass `waterBankGain`, which fades
 * it to zero at their banks; open water passes 1.
 */
export function evaluateWaterWaves(
  set: WaterWaveSet, x0: number, z0: number, time: number, spacing: number, out: Float64Array, scale = 1,
  gain = 1, gainX = 0, gainZ = 0,
): void {
  const q = waterWaveQ(set, scale), chop = set.choppiness, waveHeight = set.waveHeight, waveLength = set.waveLength;
  const warp = warpScratch;
  evaluateWaterSwellWarp(set, x0, z0, warp, time);
  const ux = x0 + warp[0]!, uz = z0 + warp[1]!, mxx = 1 + warp[2]!, mxz = warp[3]!, mzz = 1 + warp[4]!;
  const reach = spacing * set.warpStretch * 4 / waveLength;
  let height = 0, dx = 0, dz = 0, hx = 0, hz = 0, sxx = 0, sxz = 0, szz = 0, rate = 0, dxt = 0, dzt = 0;
  const surge = waterWaveSurge(set, time), count = set.count;
  for (let i = 0; i < count; i++) {
    // The surge (`waterWaveSurges`) shifts the phase and the rate it advances at alike everywhere.
    const k = set.k[i]!, ax = set.dirX[i]!, az = set.dirZ[i]!, omega = set.omega[i]! - surge[count + i]!;
    const filter = clamp(2 - reach * set.frequency[i]!, 0, 1);
    const a = waveHeight * scale * set.amplitude[i]! * filter * filter * (3 - 2 * filter);
    const p = k * (ax * ux + az * uz) - set.omega[i]! * time + surge[i]! + set.phase[i]!;
    const sin = Math.sin(p), cos = Math.cos(p), crest = Math.exp(sin - 1);
    const value = sin + ((crest - WATER_CREST_MEAN) / WATER_CREST_RANGE - sin) * chop;
    const slope = cos + (crest * cos / WATER_CREST_RANGE - cos) * chop;
    // Wave group (`waterWaveGroups`): the height's envelope g and its derivatives; the offset below carries none.
    const gx = set.groupX[i]!, gz = set.groupZ[i]!, depth = set.groupDepth[i]!, norm = 1 / Math.sqrt(1 + 0.5 * depth * depth);
    const gp = gx * ux + gz * uz - set.groupOmega[i]! * time + set.groupPhase[i]!;
    const g = (1 + depth * Math.cos(gp)) * norm, gs = depth * norm * Math.sin(gp) * value;
    height += a * g * value;
    hx += a * (g * k * ax * slope - gs * gx);
    hz += a * (g * k * az * slope - gs * gz);
    rate += a * (gs * set.groupOmega[i]! - g * omega * slope);
    if (q > 0) {
      // D = Σ q·a·d·cos p: water gathers under each crest (sin p = 1) and spreads in the troughs.
      const d = q * a, dk = d * k * sin, dw = d * omega * sin;
      dx += d * ax * cos; dz += d * az * cos;
      sxx += dk * ax * ax; sxz += dk * ax * az; szz += dk * az * az;
      dxt += dw * ax; dzt += dw * az;
    }
  }
  // The travelling warp moves the evaluation point u at ∂W/∂t: the height rate gains ∇ᵤH·∂W/∂t and the offset rate
  // −S·∂W/∂t (∂p/∂t gains k·d·∂W/∂t).
  const wtx = warp[5]!, wtz = warp[6]!;
  rate += hx * wtx + hz * wtz;
  dxt -= sxx * wtx + sxz * wtz; dzt -= sxz * wtx + szz * wtz;
  out[0] = height; out[1] = gain * dx; out[2] = gain * dz;
  out[3] = mxx * hx + mxz * hz; out[4] = mxz * hx + mzz * hz;
  // J = I + gain·∇₀D + D ⊗ ∇₀gain, with ∇₀D = −S·M, S = Σ q·a·k·sin p·d ⊗ d.
  out[5] = 1 - gain * (sxx * mxx + sxz * mxz) + dx * gainX; out[6] = -gain * (sxx * mxz + sxz * mzz) + dx * gainZ;
  out[13] = -gain * (sxz * mxx + szz * mxz) + dz * gainX; out[7] = 1 - gain * (sxz * mxz + szz * mzz) + dz * gainZ;
  out[8] = rate; out[9] = gain * dxt; out[10] = gain * dzt;
}

/** Horizontal gain of the Gerstner offset at a rest point: writes the gain and its rest-space gradient into `out` 0-2. */
export interface WaterWaveGain {
  sample(x0: number, z0: number, out: Float64Array): void;
}

const gainScratch = new Float64Array(3);

function evaluateWithGain(
  set: WaterWaveSet, x0: number, z0: number, time: number, spacing: number, out: Float64Array, scale: number, gain: WaterWaveGain | undefined,
): void {
  if (!gain) { evaluateWaterWaves(set, x0, z0, time, spacing, out, scale); return; }
  gain.sample(x0, z0, gainScratch);
  evaluateWaterWaves(set, x0, z0, time, spacing, out, scale, gainScratch[0]!, gainScratch[1]!, gainScratch[2]!);
}

/**
 * Finds the rest point whose displaced surface lies over world (x, z): a Picard start, then at most
 * `WATER_WAVE_NEWTON_STEPS` Newton steps until it lands within `WATER_WAVE_INVERT_TOLERANCE` (det J ≥
 * WATER_JACOBIAN_FLOOR without a bank fade, so each step is well defined). Leaves the evaluation at that rest point in
 * `out` 0-10 and 13 and the rest point in `out` 11-12. With q = 0 the rest point is (x, z). `gain` is a finite body's
 * bank fade, sampled at every iterate exactly as the mesh applies it. `start` (with q > 0) replaces the Picard start, for
 * a caller that already has a nearby rest point.
 */
export function invertWaterWaves(
  set: WaterWaveSet, x: number, z: number, time: number, spacing: number, out: Float64Array, scale = 1, gain?: WaterWaveGain,
  start?: { x: number; z: number },
): void {
  let x0 = x, z0 = z;
  const gerstner = waterWaveQ(set, scale) > 0;
  if (!(start && gerstner)) evaluateWithGain(set, x0, z0, time, spacing, out, scale, gain);
  if (gerstner) {
    const tolerance = WATER_WAVE_INVERT_TOLERANCE * WATER_WAVE_INVERT_TOLERANCE;
    if (start) { x0 = start.x; z0 = start.z; } else { x0 = x - out[1]!; z0 = z - out[2]!; }
    let solved = false;
    for (let step = 0; step < WATER_WAVE_NEWTON_STEPS; step++) {
      evaluateWithGain(set, x0, z0, time, spacing, out, scale, gain);
      const rx = x0 + out[1]! - x, rz = z0 + out[2]! - z;
      if (rx * rx + rz * rz < tolerance) { solved = true; break; }
      const a = out[5]!, b = out[6]!, c = out[13]!, d = out[7]!, det = a * d - b * c;
      if (det > 1e-6) { x0 -= (d * rx - b * rz) / det; z0 -= (a * rz - c * rx) / det; }
      else { x0 -= rx; z0 -= rz; }
    }
    if (!solved) evaluateWithGain(set, x0, z0, time, spacing, out, scale, gain);
  }
  out[11] = x0; out[12] = z0;
}

/**
 * Bank fade length (world metres) of a finite body's Gerstner offset: `WATER_BANK_FADE_ENVELOPES` horizontal
 * envelopes, so the offset stays well inside every bank and the faded surface never folds. Zero without Gerstner.
 */
export function waterBankFadeLength(water: WaterDefinition, scale = 1): number {
  return WATER_BANK_FADE_ENVELOPES * waterHorizontalEnvelope(water, scale);
}

/**
 * Gain of the horizontal offset at a rest point `bank` world metres inside a finite body's edge: a smoothstep from 0
 * at the bank to 1 at `fadeLength`, written to out[0], and its derivative along the bank distance, written to out[1].
 * The mesh, queries and the built-in shader share it, so they agree on the faded surface. `fadeLength` 0 (no
 * Gerstner) gives 1.
 */
export function waterBankGain(bank: number, fadeLength: number, out: Float64Array): void {
  if (!(fadeLength > 0) || bank >= fadeLength) { out[0] = 1; out[1] = 0; return; }
  const t = Math.max(0, bank / fadeLength);
  out[0] = t * t * (3 - 2 * t); out[1] = 6 * t * (1 - t) / fadeLength;
}

const vertexGain = new Float64Array(2);

/**
 * CPU reference for one rendered water vertex, allocation-free: `evaluateWaterWaves` at the vertex's world rest point
 * (x0, z0) with its mesh `spacing` filter and a finite body's bank fade (`waterBankGain` of `bank`, the world metres
 * inside the edge, over `fadeLength`; 0 for open water). (gradX, gradZ) is the unit rest-space direction in which the
 * bank distance grows; it only shapes the Jacobian, never the displacement. The built-in water vertex shader
 * (`SLATE_WATER_GPU_WAVES`) evaluates exactly this from its uniforms; the CPU mesh path (Custom Material water) and
 * tests call it, so the GPU and CPU surfaces agree to float32 precision.
 */
export function evaluateWaterVertex(
  set: WaterWaveSet, x0: number, z0: number, time: number, spacing: number, scale: number,
  bank: number, fadeLength: number, gradX: number, gradZ: number, out: Float64Array,
): void {
  waterBankGain(bank, fadeLength, vertexGain);
  evaluateWaterWaves(set, x0, z0, time, spacing, out, scale, vertexGain[0]!, vertexGain[1]! * gradX, vertexGain[1]! * gradZ);
}

/**
 * Mean horizontal velocity (m/s) added to queried water velocity with Gerstner waves. A fixed point under Gerstner
 * waves sees the orbital velocity average to −q²·scale²·Σ k·A²·ω·d / 2 (upwind), while a support carried along the
 * orbit sees a zero mean. `couplingRate` (1/s) is how quickly a floating support relaxes toward the water's velocity:
 * component i is cancelled by the share ω²/(ω² + rate²) such a support still sees. The default 0 (a fixed point, such
 * as Sample Water Surface) cancels it fully; buoyancy passes its drag rate. Either way the waves rock objects without
 * a net push, and only the current carries them. Zero at Steepness 0.
 * The warp (`waterSwellWarp`) stretches each component's local wavenumber along its heading by dᵀ·M·d (M = I + ∂W/∂x0)
 * and the mean scales with it: given the world X/Z (`x`, `z`) the term is that point's at simulation time `time` (the
 * warp travels slowly), so a support anywhere sees no net push; without them it is the warp's spatial mean (M = I).
 */
export function waterWaveDrift(
  set: WaterWaveSet, scale: number, out: { x: number; z: number }, couplingRate = 0, x = Number.NaN, z = Number.NaN, time = 0,
): { x: number; z: number } {
  const factor = (waterWaveQ(set, scale) * scale) ** 2;
  const local = Number.isFinite(x) && Number.isFinite(z);
  if ((!(couplingRate > 0) && !local) || factor === 0) { out.x = factor * set.driftX; out.z = factor * set.driftZ; return out; }
  const rate = couplingRate * couplingRate;
  let mxx = 1, mxz = 0, mzz = 1;
  if (local) {
    evaluateWaterSwellWarp(set, x, z, warpScratch, time);
    mxx += warpScratch[2]!; mxz = warpScratch[3]!; mzz += warpScratch[4]!;
  }
  // Each component at its surged angular frequency (`waterWaveSurge`) at that time.
  let sumX = 0, sumZ = 0;
  const surge = waterWaveSurge(set, time);
  for (let i = 0; i < set.count; i++) {
    const omega = set.omega[i]! - surge[set.count + i]!, amplitude = set.waveHeight * set.amplitude[i]!, ax = set.dirX[i]!, az = set.dirZ[i]!;
    const stretch = ax * ax * mxx + 2 * ax * az * mxz + az * az * mzz;
    const drift = set.k[i]! * amplitude * amplitude * omega / 2 * stretch * (omega * omega / (omega * omega + rate));
    sumX += drift * ax; sumZ += drift * az;
  }
  out.x = factor * sumX; out.z = factor * sumZ;
  return out;
}

/** Floats per component written by `waterWaveShaderConstants`: three vec4s. */
export const WATER_WAVE_SHADER_STRIDE = 12;

/**
 * Per-component GPU constants for one surface, relative to a world origin (the floating origin, so shaders evaluate
 * small eye-relative coordinates) at the current simulation time. For component i, `out[i·12 …]` holds
 * (dir.x, dir.z, k, ω), (amplitude · scale, phase, q · amplitude · scale, frequency · warpStretch · 4 / Wave Length) and
 * its wave group (κê.x, κê.z, group phase, depth m). Both phases, `(k·dir·origin − ω·time + s(t) + φ) mod 2π` (s the
 * surge, `waterWaveSurge`) and `(κê·origin − Ω·time + ψ) mod 2π`, are reduced in float64, so a shader evaluates `p = k·dot(dir, u − origin) + phase`
 * and the group's `dot(κê, u − origin) + group phase` at the warped rest point u (`waterSwellWarpShaderConstants`) with
 * no large-argument trigonometry on mobile GPUs. Returns the count.
 */
export function waterWaveShaderConstants(set: WaterWaveSet, scale: number, originX: number, originZ: number, time: number, out: Float32Array | Float64Array): number {
  const q = waterWaveQ(set, scale), surge = waterWaveSurge(set, time);
  for (let i = 0; i < set.count; i++) {
    const k = set.k[i]!, ax = set.dirX[i]!, az = set.dirZ[i]!, omega = set.omega[i]!, a = set.waveHeight * scale * set.amplitude[i]!;
    const phase = (k * (ax * originX + az * originZ) - omega * time + surge[i]! + set.phase[i]!) % TAU, o = i * WATER_WAVE_SHADER_STRIDE;
    const gx = set.groupX[i]!, gz = set.groupZ[i]!, group = (gx * originX + gz * originZ - set.groupOmega[i]! * time + set.groupPhase[i]!) % TAU;
    out[o] = ax; out[o + 1] = az; out[o + 2] = k; out[o + 3] = omega;
    out[o + 4] = a; out[o + 5] = phase < 0 ? phase + TAU : phase; out[o + 6] = q * a;
    out[o + 7] = set.frequency[i]! * set.warpStretch * 4 / set.waveLength;
    out[o + 8] = gx; out[o + 9] = gz; out[o + 10] = group < 0 ? group + TAU : group; out[o + 11] = set.groupDepth[i]!;
  }
  return set.count;
}

/** Floats per warp term written by `waterSwellWarpShaderConstants`: one vec4. */
export const WATER_SWELL_WARP_STRIDE = 4;

/**
 * The swell warp's GPU constants relative to a world origin at simulation time `time`, as `waterWaveShaderConstants`:
 * per term, (K.x, K.z, A / |K|, phase) with the phase `(K·origin + φ − ν·time) mod 2π` reduced in float64, so a shader
 * evaluates W = Σ K·(A/|K|)·cos(dot(K, xz − origin) + phase) and ∂W/∂x0 = −Σ K ⊗ K·(A/|K|)·sin(…) at eye-relative points.
 */
export function waterSwellWarpShaderConstants(set: WaterWaveSet, originX: number, originZ: number, out: Float32Array | Float64Array, time = 0): void {
  for (let t = 0; t < WATER_SWELL_WARP_TERMS; t++) {
    const k = set.warpK[t]!, x = set.warpDirX[t]!, z = set.warpDirZ[t]!, o = t * WATER_SWELL_WARP_STRIDE;
    const phase = (k * (x * originX + z * originZ) + set.warpPhase[t]! - set.warpOmega[t]! * time) % TAU;
    out[o] = k * x; out[o + 1] = k * z; out[o + 2] = set.warpAmplitude[t]! / k; out[o + 3] = phase < 0 ? phase + TAU : phase;
  }
}

/**
 * Variance density S(k) (m³ at Wave Scale 1) of the sea the analytic components belong to, for both wave models:
 * render-only detail synthesizes k above `set.cutoffK` from it, so the bands never double count. Headings follow Wave
 * Direction plus 2 · Wave Spread · Θ, Θ distributed as cos²Θ on [−π/2, π/2].
 */
export function waterOceanSpectrumDensity(set: WaterWaveSet, k: number): number {
  return k > 0 ? set.spectrumScale * oceanShape(k / set.peakK, set.spectrumSharpness) : 0;
}

/**
 * Bound on |H| for a body (metres): every analytic component at the top of its wave group plus the Detail Waves band (4σ
 * of the spectrum above the cutoff).
 */
export function waterWaveEnvelope(water: WaterDefinition, scale = 1): number {
  const set = waterWaveSet(water);
  return Math.abs(scale) * (set.heightSum + set.detailHeight * set.detailWaves);
}

/** Bound on the Gerstner horizontal offset |D| for a body (metres): q · Σ A. Zero at Steepness 0. */
export function waterHorizontalEnvelope(water: WaterDefinition, scale = 1): number {
  const set = waterWaveSet(water);
  return waterWaveQ(set, scale) * Math.abs(scale) * set.amplitudeSum;
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
 * Surface waves under world (x, z) in world metres, independent of the volume's transform (spacing filters distant
 * geometry only). The world point is inverted to its rest point first, so height, normal (J⁻ᵀ∇H) and `velocity`
 * (∂η/∂t at this fixed X/Z) describe the rendered surface; `orbital` is the water's horizontal particle velocity.
 */
export function sampleWaterWaves(water: WaterDefinition, x: number, z: number, time: number, scale = 1, spacing = 0) {
  const set = waterWaveSet(water), o = waveScratch;
  invertWaterWaves(set, x, z, time, spacing, o, scale);
  let sx = o[3]!, sz = o[4]!, velocity = o[8]!;
  if (waterWaveQ(set, scale) > 0) {
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

const surfaceScratch = createWaterWaveOutput(), driftScratch = { x: 0, z: 0 }, bankScratch = new Float64Array(2);
const gainScratchOut = new Float64Array(2), slopeScratch = new Float64Array(2), bankGain = new BankGain();

/**
 * The mean-drift term (m/s) `sampleWaterSurface` adds to X/Z water velocity at a sample `edgeDistance` metres inside
 * a body (`waterWaveDrift`, faded with the horizontal offset near finite banks), at world X/Z (`x`, `z`) and simulation
 * time `time` when given. Buoyancy swaps the fixed-point term (`couplingRate` 0) for its supports' coupling rate, so
 * hulls with any drag rock in place instead of drifting.
 */
export function waterSurfaceDrift(
  water: WaterDefinition, body: WaterBodyProperties, edgeDistance: number, out: { x: number; z: number }, couplingRate = 0,
  x = Number.NaN, z = Number.NaN, time = 0,
): { x: number; z: number } {
  const set = waterWaveSet(water);
  waterWaveDrift(set, body.waveScale, out, couplingRate, x, z, time);
  if (body.kind !== "global") {
    waterBankGain(edgeDistance, waterBankFadeLength(water, body.waveScale), gainScratchOut);
    const fade = gainScratchOut[0]! * gainScratchOut[0]!;
    out.x *= fade; out.z *= fade;
  }
  return out;
}

/**
 * World-space waves first: the world X/Z inverts to the rest point whose displaced surface lies above it, which
 * meets the transformed volume's base along world vertical (so tilted volumes and rivers match the mesh exactly);
 * waves then add their height there. `inside` and bank distance use that rest point, like the rendered surface.
 * Finite bodies fade the horizontal offset to zero at their banks (`waterBankGain`), so their displaced surface
 * covers exactly the rest footprint: a point outside it returns at once, without inverting the waves.
 * Velocity is the current plus, in X/Z, the wave's horizontal orbital (particle) velocity with its mean drift
 * (`waterSurfaceDrift`), and in Y the Eulerian rate of surface height at this fixed X/Z. Steepness 0 reproduces the
 * vertical-only results exactly.
 */
export function sampleWaterSurface(
  water: WaterDefinition, body: WaterBodyProperties, position: Vec3, time: number,
  transform: Transform = identityTransform(),
): WaterSample {
  if (!body.enabled || ![time, position.x, position.y, position.z].every(Number.isFinite)) return emptyWaterSample();
  const { x: sx, y: sy, z: sz } = transform.scale;
  if (Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz)) < 1e-6) return emptyWaterSample();
  const inverse = inverseQuat(transform.rotation);
  const up = quatRotateVector(inverse, { x: 0, y: 1, z: 0 });
  const ray = { x: up.x / sx, y: up.y / sy, z: up.z / sz };
  if (Math.abs(ray.y) < 1e-6) return emptyWaterSample();
  const set = waterWaveSet(water), scale = body.waveScale, wave = surfaceScratch, gerstner = waterWaveQ(set, scale) > 0;
  let hit = waterRestBase(body, transform, inverse, ray, position.x, position.y, position.z);
  if (!hit?.footprint.inside) return emptyWaterSample();
  if (gerstner) {
    const fadeLength = body.kind === "global" ? 0 : waterBankFadeLength(water, scale);
    let gain: WaterWaveGain | undefined;
    // A rest point within the fade band lies at most one horizontal envelope from the query; further inside, the
    // rest point is unfaded and the plain inversion is exact.
    if (fadeLength > 0 && waterBankDistance(hit.footprint, transform, bankScratch) < fadeLength + waterHorizontalEnvelope(water, scale)) {
      Object.assign(bankGain, { body, transform, inverse, ray, y: position.y, fadeLength });
      gain = bankGain;
    }
    invertWaterWaves(set, position.x, position.z, time, 0, wave, scale, gain);
    bankGain.body = null;
    hit = waterRestBase(body, transform, inverse, ray, wave[11]!, position.y, wave[12]!);
    if (!hit?.footprint.inside) return emptyWaterSample();
  } else {
    invertWaterWaves(set, position.x, position.z, time, 0, wave, scale);
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
    const drift = waterSurfaceDrift(water, body, edgeDistance, driftScratch, 0, position.x, position.z, time);
    velocity.x += wave[9]! + drift.x; velocity.z += wave[10]! + drift.z;
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
