import {
  BaseTexture, Color3, Constants, DirectionalLight, HemisphericLight, MaterialPluginBase, Matrix, PBRMaterial, type MaterialDefines, RawTexture, ShaderLanguage,
  Texture, ThinTexture, Vector3, type AbstractEngine, type AbstractMesh, type Effect, type Material, Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import {
  WATER_CREST_MEAN, WATER_CREST_RANGE, WATER_FFT_CASCADES_MAX, WATER_JACOBIAN_FLOOR, WATER_SWELL_WARP_STRIDE, WATER_SWELL_WARP_TERMS, WATER_WAVE_MAX_COMPONENTS,
  WATER_WAVE_SHADER_STRIDE, waterBankFadeLength, waterSwellWarpShaderConstants, waterWaveQ, waterWaveSet, waterWaveShaderConstants, waterWaveSurge,
  type WaterBodyProperties, type WaterDefinition,
  type WaterShadingDetail, type WaterWaveSet,
} from "@babylonslate/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { waterFftForSurface, type WaterFftResult } from "./water-fft";
import { WATER_FFT_CASCADE_TURNS, waterFftLayout } from "./water-fft-spectrum";
import { invalidateSceneLighting } from "./scene-lighting";
import type { WaterContactField } from "./water-contact-field";
import { WATER_FIELD_DEPTH_RANGE, WATER_FIELD_FINE_DEPTH_SPAN, WATER_FIELD_SHORE_RANGE as SHORE, WATER_FIELD_TERRAIN_ALPHA, type WaterField } from "./water-field";
import { waterPlanarReflectionForCamera, type WaterPlanarReflection } from "./water-planar-reflection";
import type { WaterQualityDeviceClamp } from "./water-quality-device";
import { sceneHasWaterRemovals, sceneWaterRemovals, waterRemovalShapeVector, waterRemovalWorldRadius } from "./water-removal-mesh";
import { WATER_SCENE_COPY_SKY_DEPTH, WATER_SCENE_COPY_SKY_THRESHOLD, isMainWaterPass, waterSceneCopyForPass, type WaterSceneCopy } from "./water-scene-copy";

/**
 * Wind-chop octaves: [heading offset (radians), wavenumber multiplier, slope, speed, phase].
 * Sharp-crested `exp(sin - 1)` waves with a little domain drag read as wind chop rather than
 * the regular interference of plain sines. All are world-space and advect with the current.
 * Realistic evaluates `CHOP_TIER`'s share of them plus `CAPILLARY_OCTAVES`; Stylized up to three (`STYLIZED_CHOP_TIER`).
 * Their directions, wavenumbers and clock phases are uniforms (`detailConstants`).
 */
const DETAIL_OCTAVES = [
  [0.0, 1.0, 0.22, 1.0, 0.0], [0.9, 1.61, 0.2, 0.93, 1.7], [-0.7, 2.59, 0.17, 1.07, 4.1],
  [2.1, 4.17, 0.14, 0.9, 2.3], [-1.9, 6.71, 0.11, 1.1, 5.6], [0.35, 10.8, 0.08, 0.95, 0.9],
] as const;
/**
 * Realistic only: capillary ripples down to about a fifteenth of the chop's base wavelength, in the same format. Their
 * slopes stay high like real wind ripples, so close water breaks reflections into fine glitter; they only shade
 * (no crest height or domain drag) and fade with the pixel footprint along their own direction. The finest (High up)
 * resolves only within a few metres of the camera.
 */
const CAPILLARY_OCTAVES = [
  [1.25, 17.4, 0.18, 1.0, 3.3], [-2.45, 28.1, 0.17, 0.96, 0.4], [2.75, 45.3, 0.15, 1.04, 2.2], [-0.55, 73.9, 0.13, 0.98, 5.1],
] as const;
/** Slope variance an octave carries when fully resolved (see `swLostDetail`). */
const octaveVariance = (slope: number) => 0.07 * slope * slope;
/**
 * Temporal filtering of Realistic's chop octaves and capillaries: an octave whose phase advances more than about
 * `TEMPORAL_FADE` radians per frame at 30 frames per second (its deep-water angular frequency times its speed and Wave
 * Speed) fades out of the shading normal and adds its slope variance to the filtered roughness, as one too fine for the
 * pixel does. At 24 to 30 frames per second the finest capillaries otherwise jump about a quarter of their wavelength
 * between frames, so the sun's glints on them strobe instead of travelling. Uniform-only arithmetic, every tier.
 */
const TEMPORAL_FADE = [0.6, 1.3] as const;
const TEMPORAL_FRAME = 1 / 30;

/**
 * Metres over which an open-water edge (a finite body's bank over no terrain while a terrain field is bound, such as an
 * ocean's outer edge) fades out instead of drawing a shore.
 */
const OPEN_EDGE_FADE = 6;
/** Metres over which a body's edge over water-covered terrain (short of the terrain's shoreline) fades out. */
const OPEN_EDGE_FADE_TERRAIN = 2.5;
/** The surf zone's depth range in Wave Heights (full breaking at the first, none past the second) and the wake's decay in cycles⁻¹. */
const SURF_DEPTH = [1.3, 3.4] as const;
const SURF_WAKE = 3.8;
/** Furthest metres the swash runs up a beach (the run-up's width on a gentle slope). */
const SWASH_REACH_MAX = 10;
/** Metres of depth over which water thins to nothing at a gentle shore (`swShoreSoft`). */
const SOFT_SHORE_DEPTH = 0.4;
/**
 * Refraction bends by the swell and the first chop octaves only (Realistic, Stylized): the finer chop, the capillaries and the FFT
 * band move the bed at a frequency the eye reads as jelly, and stay in the shading normal alone.
 */
const REFRACTION_OCTAVES = [3, 2] as const;
/** Largest refracted screen shift (pixels of the scene copy) near the camera, and far away, over `REFRACTION_FAR` metres of view depth. */
const REFRACTION_SHIFT_PX = [28, 3] as const;
const REFRACTION_FAR = [6, 60] as const;
/** Compile-time style switch: each material compiles only its own style's shading. */
const WATER_STYLIZED_DEFINE = "SLATE_WATER_STYLIZED";
/** Within Stylized, the Stylized Look switch: Toon when set, Painted otherwise (`paintedSource`, `toonSource`). */
const WATER_TOON_DEFINE = "SLATE_WATER_TOON";
/**
 * Built-in water evaluates the swell in its vertex shader from the same uniforms the fragment uses: the mesh uploads a
 * static rest grid and only the clock advances. Custom Material water keeps CPU-displaced vertices.
 */
export const WATER_GPU_WAVES_DEFINE = "SLATE_WATER_GPU_WAVES";
/**
 * The surface blends with other water bodies (`evaluateWaterBlend`): the mesh carries `slateWaterBlend` per vertex
 * (swell height scale, Gerstner offset scale, ownership margin, partner-colour share), its bank distance is the blended
 * union shoreline and its rest grid already holds the blended rest height. Compiled only into bodies with neighbours, so
 * water that blends with nothing pays nothing.
 */
export const WATER_BLEND_DEFINE = "SLATE_WATER_BLEND";
/** The colours a blending surface mixes toward by its partner-colour share (`WaterMaterialPlugin.partner`). */
const BLEND_COLOR_UNIFORMS = ["slateWaterBlendShallow", "slateWaterBlendDeep", "slateWaterBlendFoam", "slateWaterBlendAbsorb", "slateWaterBlendThrough"] as const;
/** Per-asset colour uniforms the fragment reads through blended locals (`blendColors`), in `BLEND_COLOR_UNIFORMS` order. */
const COLOR_UNIFORMS = ["slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterAbsorb", "slateWaterThrough"] as const;
const COLOR_LOCALS = ["swShallowU", "swDeepU", "swFoamU", "swAbsorbU", "swThroughU"] as const;
/**
 * Numeric shading tier, 0-3, from the device-clamped project Water Shading Detail (`WATER_SHADING_TIERS`). Shader terms
 * compile per tier (`#if SLATE_WATER_QUALITY >= n`); terms a tier drops add their slope variance to the filtered
 * roughness, so lower tiers look like filtered higher tiers rather than glassier water.
 */
export const WATER_QUALITY_DEFINE = "SLATE_WATER_QUALITY";
export const WATER_SHADING_TIERS: Readonly<Record<WaterShadingDetail, number>> = { low: 0, medium: 1, high: 2, ultra: 3 };
/** Tier the constructor declares (and that unbound materials compile): High. */
const DEFAULT_TIER = WATER_SHADING_TIERS.high;
/**
 * Asset features that compile out when their value is zero, on every tier: Sparkles, Crest Foam, Surface Foam and
 * Subsurface. Changing a value across zero recompiles that asset's water.
 */
export const WATER_FEATURE_DEFINES = {
  sparkles: "SLATE_WATER_SPARKLES", crestFoam: "SLATE_WATER_CREST_FOAM", surfaceFoam: "SLATE_WATER_SURFACE_FOAM", subsurface: "SLATE_WATER_SSS",
} as const satisfies Partial<Record<keyof WaterDefinition, string>>;
const FEATURES = Object.entries(WATER_FEATURE_DEFINES) as Array<[keyof typeof WATER_FEATURE_DEFINES, string]>;
const Q = WATER_QUALITY_DEFINE;
/**
 * Scene-copy and reflection features. Each compiles only where it can run: device-effective project Water quality,
 * the asset's intent (Refraction above 0, Object Reflections) and, for the two that sample the view's scene copy, a
 * copy registered for the render pass being drawn (`isMainWaterPass`). Classic frames, captures, previews and Low or
 * Medium water therefore compile none of the code they do not run.
 *
 * - `SLATE_WATER_REFRACTION`: the refracted scene copy replaces the blended background.
 * - `SLATE_WATER_SSR`: a screen-space march against the copy's linear depth, `SLATE_WATER_SSR_STEPS` steps
 *   (Reflection Steps, a compile-time loop bound).
 * - `SLATE_WATER_PLANAR`: the view's planar reflection, for flat bodies at Planar quality; a uniform says per draw
 *   whether this body is the view's dominant one (otherwise it marches, when the copy exists, or keeps the sky).
 */
export const WATER_OBJECT_DEFINES = {
  refraction: "SLATE_WATER_REFRACTION", screenSpace: "SLATE_WATER_SSR", screenSpaceSteps: "SLATE_WATER_SSR_STEPS", planar: "SLATE_WATER_PLANAR",
} as const;
const { refraction: REFRACTION, screenSpace: SSR, screenSpaceSteps: SSR_STEPS, planar: PLANAR } = WATER_OBJECT_DEFINES;
/** Sampler of the view's scene copy (rgb linear colour, a linear view depth); one binding serves both features. */
export const WATER_SCENE_SAMPLER = "slateWaterSceneSampler";
/** Sampler of the view's planar reflection. */
export const WATER_PLANAR_SAMPLER = "slateWaterPlanarSampler";
/** Preprocessor tests for the copy's sampler and for an object reflection term. */
const SAMPLES_COPY = `defined(${REFRACTION}) || defined(${SSR})`;
const REFLECTS_OBJECTS = `defined(${SSR}) || defined(${PLANAR})`;
/** Binary refinement steps after the march's first hit. */
const SSR_REFINE_STEPS = 4;
/** Longest reflected ray the march follows (world units), shortened to the view's far plane. */
const SSR_MAX_DISTANCE = 500;
/**
 * Thickness (metres) an object is assumed to have behind its visible surface, base plus per metre of view depth (also
 * well above the copy's half-float depth precision): a reflected ray this far behind a surface still hits it.
 */
const SSR_THICKNESS = [0.2, 0.03] as const;
/** Bound where a copy or planar feature has no source this draw: Babylon binds its empty texture (alpha 0). */
const EMPTY_TEXTURE = new ThinTexture(null);
/**
 * How far along the reflected ray (times the eye's distance to the water point) the planar lookup follows it: content
 * that far away moves with half the ray's tilt, the sky (beyond) somewhat less than it should and objects at the
 * waterline somewhat more.
 */
const PLANAR_REACH = 1;
/** Refraction: screen offset per unit of view-space tilt, per metre of water behind the surface, at Refraction 1. */
const REFRACTION_SHIFT = 1.2;
/** Water thickness (metres) beyond which the refracted shift stops growing. */
const REFRACTION_DEPTH_CAP = 3;
/**
 * FFT ocean detail (`waterFftForSurface`), compiled where device-effective FFT Ocean Detail is on and the asset's
 * Detail Waves is above 0: the number of cascades sampled (`#if SLATE_WATER_FFT >= c`), 0 compiling every FFT term out.
 * The define follows quality and asset intent only, never readiness: until the band is ready the shader samples a
 * placeholder at gain 0, which leaves the analytic surface exactly as it is without the define, and a band that becomes
 * ready (or is rebuilt) never recompiles the water.
 */
export const WATER_FFT_DEFINE = "SLATE_WATER_FFT";
/**
 * The cascades the vertex stage samples (`#if SLATE_WATER_FFT_VERTEX >= c`): `SLATE_WATER_FFT` where this surface's
 * finest rest-grid spacing resolves the band's first cascade (under half its shortest wavelength, where the vertex
 * mesh filter starts to pass it), otherwise 0. Every cascade's vertex weight is exactly 0 on a grid that coarse, so
 * compiling the vertex part out changes no vertex; High's band stays per-pixel on Global Water and large volumes.
 */
export const WATER_FFT_VERTEX_DEFINE = "SLATE_WATER_FFT_VERTEX";
/** The band's 2D-array texture: one binding shared by the vertex stage (displacement) and the fragment (slopes). */
export const WATER_FFT_SAMPLER = "slateWaterFftSampler";
const FFT = WATER_FFT_DEFINE, FFT_VERTEX = WATER_FFT_VERTEX_DEFINE;
/**
 * Per cascade c, (1 / patch size, uv offset x, uv offset z, upper band edge k_hi): the uv offset is
 * fract(floating origin / patch size) + 0.5 / N from the CPU in float64, so eye-relative rest points sample the
 * world-anchored band without large coordinates. k_hi (rad/m, the cascade's shortest wavelength) is both stages' fade
 * frequency: the vertex mesh filter and the fragment footprint fade.
 */
const FFT_CASCADE_UNIFORMS = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => `slateWaterFftCascade${c}`);
/**
 * Uniforms of the band: `slateWaterFft` = (g = Detail Waves · Wave Scale, 0 until the band is ready; Steepness, the
 * horizontal scale before the bank fade; view footprint per metre of view depth and its constant part, metres per pixel)
 * and the cascades'.
 */
const FFT_UNIFORMS = ["slateWaterFft", ...FFT_CASCADE_UNIFORMS];
/**
 * k_hi of every cascade while the band is not ready (or does not match the compiled cascades): faded at any footprint
 * or mesh spacing above a few nanometres, so both stages skip every tap and pay only the fade arithmetic until it is.
 */
const FFT_FADED = 1e9;
/**
 * The fragment's fade of each FFT cascade over its highest wavenumber times the pixel footprint (radians per pixel),
 * as the chop octaves fade: gone before its shortest waves are under about four and a half pixels long. The swell's
 * own, later curve (0.6 to 2.2) let a cascade's shortest waves reach three pixels, where the sun's lobe and the
 * Fresnel, both far from linear in the normal, alias them into crawling diagonal hatching across the sun path.
 */
const FFT_FRAGMENT_FADE = [0.45, 1.4] as const;
/** Lowest tier evaluating each realistic chop octave, capillary, and Stylized chop octave. */
const CHOP_TIER = [0, 0, 1, 1, 2, 2] as const;
const CAPILLARY_TIER = [1, 2, 2, 2] as const;
const STYLIZED_CHOP_TIER = [0, 1, 2] as const;
/**
 * Radians each chop octave's phase (Realistic's, and Stylized's first three) drifts across the large and the medium
 * anti-tiling noise: its crests wander instead of running straight, so crossing octaves never form a regular lattice.
 */
const CHOP_PHASE_DRIFT = [[3.1, 2.2], [-4.3, -2.5], [5.2, 1.8], [-6.1, -2.0], [7.4, 1.4], [-8.2, -1.6]] as const;
/**
 * The chop's slow phase shift: each octave's phase also gains `CHOP_SHIFT[i]` radians times a rotating mix of the
 * centred large and gust noises, (cos θ · (large − ½) + sin θ · (gust − ½)), θ = `CHOP_SHIFT_RATE` × the first octave's
 * angular frequency × time (`slateWaterChopShift`, from the CPU). An octave is a plane wave, so without it a point saw
 * the same chop again every period (Painted's top view correlated 0.35 a period later); with it each patch of sea
 * drifts slowly in and out of step with its neighbours (about a 50 s cycle, the crests' speed changing by a few
 * percent), so the chop never repeats in time. Two MADs per octave; uniform-only otherwise.
 */
const CHOP_SHIFT = [2.6, -3.1, 3.4, -2.8, 3.2, -3.5] as const;
const CHOP_SHIFT_RATE = 0.031;
/**
 * Short-crested chop: each octave's strength rides an envelope whose wavevector is turned this far (radians, the sign
 * alternating between octaves) off the octave's heading, at `CHOP_CREST_K` of its wavenumber, between 0.55 and 1.45
 * (mean 1, so the chop keeps its overall strength). The envelopes travel forward through the chop on two clocks
 * (`slateWaterChopShift.z` and `.w`, reduced on the CPU): a at `CHOP_GROUP_RATE` of the first octave's angular frequency
 * and b at √2 times that. Octave i's envelope phase is m·a + n·b, (m, n) = `CHOP_GROUP_TURNS[i]`, about a quarter of its
 * own angular frequency, so after one of its periods its crests have grown or faded rather than returning to the same
 * place. The rate is 1 / (3 + φ) rather than a round quarter, so when the first octave's envelope comes round again
 * its crests stand about 0.4 of a wavelength from where they were, and the two line up again only after many periods
 * (Low evaluates that octave alone). Whole multiples of wrapped clocks stay continuous as they wrap, and with the clocks' rates in an irrational
 * ratio no two octaves' envelopes share a period and the envelopes never return together (one clock with whole
 * multiples brought every envelope back at once, about every 6 s on the default chop).
 */
const CHOP_CREST_TURN = 1.22;
const CHOP_CREST_K = 0.7;
const CHOP_GROUP_RATE = 0.2165;
const CHOP_GROUP_TURNS = [[1, 0], [0, 1], [-1, 2], [1, 1], [2, 1], [1, 2]] as const;
/**
 * Chop phase modulation: each octave's phase also gains A · sin(Ω·t + ψ), its depth A between about 0.6 and 2.3 radians
 * across the gust and large noises (tens of metres), Ω a whole combination (m, n) = `CHOP_FM_TURNS[i]` of the envelope
 * clocks (`slateWaterChopShift.z` and `.w`, about a third to a half of the octave's own angular frequency) and ψ a
 * world phase from the gust noise. A plane wave's crests otherwise pass every point at one frequency, so a still view of
 * calm water (where the chop carries most of the slope) bobbed at the first octave's period with one dominant line in
 * its temporal spectrum; modulated, the crests surge and linger by a third of their speed and the octave's energy
 * spreads over sidebands Ω apart, the carrier keeping a Bessel J0(A)² share (none near A = 2.4). A varies over
 * tens of metres, so the octave's local wavenumber changes by a few percent at most. One sine per octave.
 */
const CHOP_FM_DEPTH = 1.45;
const CHOP_FM_TURNS = [[0, 1], [1, 1], [2, 1], [1, 2], [3, 1], [2, 2]] as const;
/**
 * A second, slow modulation tone per octave (`CHOP_FM_SLOW_TURNS[i]`, a difference of the envelope clocks: 4% to 16%
 * of the first octave's angular frequency), as deep, with its world phase from the large noise. One tone alone still
 * let a still view see the same chop a carrier period later (a frame autocorrelation of about 0.4 two seconds on, the
 * Painted calm's beat); with two tones in an irrational ratio the octave's sidebands form a dense comb and that falls to
 * about 0.06 (a model of the first octave over 20 s), while the crests' speed changes by at most a fifth more. One more
 * sine per octave.
 */
const CHOP_FM_SLOW_TURNS = [[-1, 1], [2, -1], [-5, 4], [5, -3], [-4, 3], [3, -2]] as const;
function chopFm(i: number): string {
  const depth = `${f(CHOP_FM_DEPTH)} * (0.4 + 0.75 * swGust + 0.45 * swLarge)`;
  return ` + ${depth} * (sin(dot(U.slateWaterChopShift.zw, vec2(${f(CHOP_FM_TURNS[i]![0])}, ${f(CHOP_FM_TURNS[i]![1])})) + swGust * 4.0 + ${f(0.9 + i * 1.7)})`
    + ` + sin(dot(U.slateWaterChopShift.zw, vec2(${f(CHOP_FM_SLOW_TURNS[i]![0])}, ${f(CHOP_FM_SLOW_TURNS[i]![1])})) + swLarge * 6.0 + ${f(2.0 + i * 2.3)}))`;
}
/** The short-crest envelope (a factor) of the chop octave whose uniform vec4 (dir.x, dir.z, k, phase) is `octave`. */
function chopCrests(octave: string, i: number): string {
  const turn = i % 2 ? CHOP_CREST_TURN : -CHOP_CREST_TURN, c = Math.cos(turn), s = Math.sin(turn);
  return `(0.55 + 0.9 * (0.5 - 0.5 * cos(${octave}.z * ${f(CHOP_CREST_K)} * dot(vec2(${f(c)} * ${octave}.x - ${f(s)} * ${octave}.y, ${f(s)} * ${octave}.x + ${f(c)} * ${octave}.y), swChop) + ${f(1.3 + i * 2.1)} - dot(U.slateWaterChopShift.zw, vec2(${f(CHOP_GROUP_TURNS[i]![0])}, ${f(CHOP_GROUP_TURNS[i]![1])})))))`;
}
/**
 * Toon's crest lines seed each crest of the dominant swell component by its index, counted modulo this many crests
 * (thousands of wavelengths apart, never in one view), so the count stays exact in float32 however long the clock runs.
 */
const CREST_COUNT_PERIOD = 4096;
/** Frequencies (per metre) of the shared large and gust noises; the chop warp sizes its amplitude to each. */
const LARGE_NOISE = 0.07, GUST_NOISE = 0.013;
/**
 * Slope variance of wind ripples below the smallest capillary octave, per unit of chop gain squared: added to the GGX
 * roughness (within the sea-state cap). A wind-roughened sea never mirrors the sky sharply, so close reflections of
 * cloud edges soften into sky colour instead of printing hard blotches; the sharp sun glints on the resolved facets come
 * from the facet glint term (`swGlint`), not from this lobe. Ripple Strength 0 keeps a mirror.
 */
const OCEAN_SUB_CAPILLARY_VARIANCE = 0.003;
/**
 * Aerial perspective (every look), scaled from the view's far plane so the editor's shorter one and Play's longer one
 * haze alike: water is half hazed (toward the horizon sky) at `WATER_HAZE_HALF` of the range, and a ramp from
 * `WATER_HAZE_EDGE[0]` to `WATER_HAZE_EDGE[1]` of it takes it fully there, so the far clip (and Global Water's own
 * edge, which lies beyond it) never shows as a line. The range is capped at `WATER_HAZE_MAX_RANGE` metres, so a very
 * long far plane still hazes at atmospheric distances.
 */
const WATER_HAZE_HALF = 0.4;
const WATER_HAZE_EDGE = [0.75, 0.97] as const;
const WATER_HAZE_MAX_RANGE = 8000;
/** `slateWaterHaze` for a far plane: (per-metre rate of the exponential haze, ramp start, ramp end, 0) in metres. */
export function waterHazeConstants(far: number, out: Float64Array = new Float64Array(4)): Float64Array {
  const range = Math.min(WATER_HAZE_MAX_RANGE, far > 0 ? far : 1000);
  out[0] = Math.LN2 / (WATER_HAZE_HALF * range);
  out[1] = range * WATER_HAZE_EDGE[0];
  out[2] = range * WATER_HAZE_EDGE[1];
  out[3] = 0;
  return out;
}
/** Realistic: wavelength-neutral scattering per absorption path unit, on top of each channel's absorption. */
const TURBIDITY = 1.6;
/**
 * Realistic: underwater daylight. A bed under water is lit by sunlight already filtered on its way down and by the blue
 * light of the water around it, not by the white sky light the scene lit it with, so what shows through cools toward a
 * neutral, slightly blue grey (`UNDERWATER_COOL` of the way, within the first half metre) before the per-channel
 * absorption tints it: sand under clear shallows reads cyan rather than green. Wet sand is also darker than dry sand
 * (water fills its pores): a submerged bed keeps `UNDERWATER_WET` of its light, so shallows read as a bed under water
 * rather than as a glow around the shore.
 */
const UNDERWATER_COOL = 0.68;
const UNDERWATER_TINT = [0.9, 1.0, 1.1] as const;
const UNDERWATER_WET = 0.78;
/**
 * Realistic Low: the floor colour its own bed light assumes (linear albedo: wet sand, cooled as above and a little
 * bluer, since the real bed it passes at one transmittance keeps its own yellow), and the share of the real bed it keeps
 * above its fastest-fading channel (more would pass the sand's red and grey the shallows).
 */
const LOW_BED = [0.3, 0.33, 0.37] as const;
const LOW_BED_SHOWS = 0.2;
/**
 * Low and Medium evaluate only this many swell components (the largest slopes) in the fragment shader; High and Ultra
 * all eight. The vertex shader keeps all, so the geometry is always the physics surface; a skipped component's slope
 * counts as roughness and resolved slope instead (`slateWaterSea`).
 */
const LOW_SWELL_COMPONENTS = 3;
const MEDIUM_SWELL_COMPONENTS = 6;
/**
 * Painted: the primary swell's height and slope scale is this times the root-sum-square of its components'
 * amplitudes, so it reads the same however many components share the energy (it reproduces the sum of the original
 * single-train table's primary components).
 */
const PRIMARY_RMS = 1.43;
/**
 * How steep the sea is for the looks' thresholds (breaking, wind streaks, roughness caps, a storm's gloom): this times
 * the swell's root-sum-square slope √Σ(k·a)², which equals the original five-component table's Σ k·a, so seas read as
 * steep as they were tuned whatever number of components shares the slope.
 */
const SEA_STATE_RMS = 2.114;
/** Lowest tier whose fragment evaluates swell slot i. */
const swellTier = (i: number) => i >= MEDIUM_SWELL_COMPONENTS ? 2 : i >= LOW_SWELL_COMPONENTS ? 1 : 0;
const SWELL_DIRECTION = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => `slateWaterSwellDir${i}`);
const SWELL_AMPLITUDE = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => `slateWaterSwellAmp${i}`);
/** Each component's wave group (`waterWaveShaderConstants`' third vec4): (κê.x, κê.z, group phase, depth m). */
const SWELL_GROUP = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => `slateWaterSwellGroup${i}`);
/** The shared kernel's swell warp (`waterSwellWarpShaderConstants`): per term (K.x, K.z, A / |K|, phase). */
const SWELL_WARP = Array.from({ length: WATER_SWELL_WARP_TERMS }, (_, t) => `slateWaterSwellWarp${t}`);

/**
 * The swell's warp at an eye-relative rest point (`waterSwellWarp`): declares `<prefix>Warp` (W) and, with `gradient`,
 * `<prefix>WarpG` (∂W/∂x0 as xx, xz, zz) and `<prefix>WarpM` (I + ∂W/∂x0), so the swell is evaluated at
 * `rest + <prefix>Warp` exactly as the shared kernel does. GLSL-shaped; ALU only.
 */
function swellWarpSource(prefix: string, rest: string, gradient: boolean): string {
  const terms = SWELL_WARP.map((name, t) => `
vec4 ${prefix}WW${t} = U.${name};
float ${prefix}WP${t} = dot(${prefix}WW${t}.xy, ${rest}) + ${prefix}WW${t}.w;
${prefix}Warp += ${prefix}WW${t}.xy * (${prefix}WW${t}.z * cos(${prefix}WP${t}));${gradient ? `
${prefix}WarpG -= vec3(${prefix}WW${t}.x * ${prefix}WW${t}.x, ${prefix}WW${t}.x * ${prefix}WW${t}.y, ${prefix}WW${t}.y * ${prefix}WW${t}.y) * (${prefix}WW${t}.z * sin(${prefix}WP${t}));` : ""}`).join("");
  return `
vec2 ${prefix}Warp = vec2(0.0);${gradient ? `
vec3 ${prefix}WarpG = vec3(0.0);` : ""}${terms}${gradient ? `
vec3 ${prefix}WarpM = vec3(1.0 + ${prefix}WarpG.x, ${prefix}WarpG.y, 1.0 + ${prefix}WarpG.z);` : ""}`;
}
const CHOP_UNIFORMS = DETAIL_OCTAVES.map((_, i) => `slateWaterChop${i}`);
const CAPILLARY_UNIFORMS = CAPILLARY_OCTAVES.map((_, i) => `slateWaterCapillary${i}`);

/** `code` from `tier` up, `otherwise` below it; every directive on its own line. Code blocks start with a newline. */
function fromTier(tier: number, code: string, otherwise = ""): string {
  if (tier <= 0) return code;
  return `\n#if ${Q} >= ${tier}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;
}
const ifDefined = (define: string, code: string, otherwise = "") => `\n#ifdef ${define}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;
/** Sparkles exist from Medium up and only when the asset's Sparkles is above zero; otherwise `swSpark` is 0. */
const sparkled = (code: string) => ifDefined(WATER_FEATURE_DEFINES.sparkles, fromTier(1, code, `
float swSpark = 0.0;`), `
float swSpark = 0.0;`);

/**
 * Realistic foam's bubble web (`swWeb`): a Worley pattern over a 3 × 3 cell neighbourhood with feature points anywhere
 * in their cell (jitter 0.9), unrolled because loops do not pass `toWgsl`. Squared distances are compared, so only the
 * two nearest take a square root. With that jitter its cells are irregular polygons, so the borders read as bubbles
 * rather than a square lattice.
 */
const FOAM_WEB_CELLS = [-1, 0, 1].flatMap((j) => [-1, 0, 1].map((i) => [i, j] as const)).map(([i, j], n) => `
  vec2 r${n} = vec2(${(i + 0.05).toFixed(2)}, ${(j + 0.05).toFixed(2)}) + swHash2(b + vec2(${i.toFixed(1)}, ${j.toFixed(1)})) * 0.9 - f;
  float d${n} = dot(r${n}, r${n});
  n2 = min(n2, max(n1, d${n}));
  n1 = min(n1, d${n});`).join("");

/**
 * Realistic bed caustics (`swCaustic`, High up): an iterated, self-warping trigonometric field (after the widely used
 * tileable water caustic) whose thin bright filaments bend and merge like focused sunlight. Unrolled (loops do not pass
 * `toWgsl`); each iteration advances at its own speed. Its input is radians of a 2π tile, wrapped first: the field also
 * depends on the point's magnitude.
 */
const CAUSTIC_ITERATIONS = [0, 1, 2, 3].map((n) => `
  t = tm * ${(1 - 3.5 / (n + 1)).toFixed(6)};
  i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
  c += 1.0 / max(length(vec2(p.x / max(abs(sin(i.x + t)), 0.002), p.y / max(abs(cos(i.y + t)), 0.002))) * 0.005, 0.0001);`).join("");

/**
 * Realistic sun glitter (`swGlitter`): one glint per cell of a world grid in rest (Lagrangian) space, so glints ride
 * the waves instead of sliding over them. A glint is a small peaked spot (compact profile (1 − r² / 4σ²)⁴ out to two
 * `GLITTER_SIGMA`, in cells) seen through a Gaussian pixel filter (`GLITTER_PIXEL` pixels): its world covariance gains
 * the filter's image under the pixel footprint, keeping its energy, so a glint thinner than a pixel spreads over about
 * one and dims instead of flickering on and off between pixels. Each glint lives for `GLITTER_SHARE` of a slow cycle
 * (1.4 to 4 s), growing from a point to its full size and shrinking back smoothly (its size rather than only its
 * brightness, so a glint bright enough to saturate still appears and leaves gradually). `GLITTER_NORM` divides by the
 * field's mean (the spot's integral, (π · 4 / 5) σ², times the mean of its squared size, share / 2), so the field
 * averages 1 and only redistributes the sun lobe's light. Cells are at least `GLITTER_CELL_PX` pixels across in their
 * most compressed direction (two grid levels crossfaded, nested, each seeded by its absolute level, so nothing pops as
 * the footprint changes) and at least `GLITTER_CELL_MIN` metres.
 */
const GLITTER_SIGMA = 0.1;
const GLITTER_PIXEL = 0.42;
const GLITTER_SHARE = 0.4;
const GLITTER_JITTER = 0.4;
/** Glint sizes (times `GLITTER_SIGMA`, uniform over the range) and the lattice bend (cells; see `swGlitter`). */
const GLITTER_SIZE = [0.6, 1.4] as const;
const GLITTER_WARP = 0.45;
const GLITTER_CELL_PX = 3;
const GLITTER_CELL_MIN = 0.01;
/** Mean of size² over `GLITTER_SIZE`. */
const GLITTER_SIZE2 = (GLITTER_SIZE[1] ** 3 - GLITTER_SIZE[0] ** 3) / (3 * (GLITTER_SIZE[1] - GLITTER_SIZE[0]));
const GLITTER_NORM = 1 / ((Math.PI * 4 / 5) * GLITTER_SIGMA * GLITTER_SIGMA * GLITTER_SIZE2 * (GLITTER_SHARE / 2));
/**
 * The share of the sun lobe the glitter leaves smooth under the glints, and the brightest a glint may concentrate it:
 * far away the sun's path is a road of bright dashes over dark water, not a milky sheet.
 */
const GLITTER_BASE = 0.18;
const GLITTER_MAX = 12;
/**
 * Specular antialiasing: a lobe drawn on a normal that varies across the pixel widens by that variation, the per-axis
 * slope variance a Gaussian pixel filter of this variance (pixels²) sees through the slope's screen derivatives
 * (Toksvig- and Kaplanyan-style), so normal detail the pixel cannot sample densely enough never sparkles into salt.
 */
const PIXEL_SLOPE_FILTER = 0.15;
/** Caps of that variance (sun lobes widen at most this much from it). */
const PIXEL_SLOPE_CAP = 0.012;

const f = (n: number) => n.toFixed(6);

/** GLSL-shaped source that also compiles as WGSL after `toWgsl`; see `waterShaderSource`. */
const HELPERS = `
float swHash(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += vec3(dot(q, q.yzx + vec3(33.33)));
  return fract((q.x + q.y) * q.z);
}
float swNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (vec2(3.0) - 2.0 * t);
  return mix(mix(swHash(i), swHash(i + vec2(1.0, 0.0)), t.x), mix(swHash(i + vec2(0.0, 1.0)), swHash(i + vec2(1.0, 1.0)), t.x), t.y);
}
vec2 swHash2(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * vec3(0.1031, 0.103, 0.0973));
  q += vec3(dot(q, q.yzx + vec3(33.33)));
  return fract(vec2(q.x + q.y, q.x + q.z) * vec2(q.z, q.y));
}
float swGlitter(vec2 uvIn, vec2 fxIn, vec2 fyIn, float t, float level) {
  // A smooth, bounded bend of the lattice (its Jacobian carried into the pixel footprint), so no row or column of
  // cells runs straight across the sea: glints never line up into rails as the view moves along them.
  // (WGSL parameters are immutable, so the bent lattice and footprint are new locals.)
  vec2 wc = vec2(cos(uvIn.y * 0.61 + level * 1.7), cos(uvIn.x * 0.73 + level * 2.9)) * vec2(${f(GLITTER_WARP * 0.61)}, ${f(GLITTER_WARP * 0.73)});
  vec2 uv = uvIn + vec2(sin(uvIn.y * 0.61 + level * 1.7), sin(uvIn.x * 0.73 + level * 2.9)) * ${f(GLITTER_WARP)};
  vec2 fx = vec2(fxIn.x + wc.x * fxIn.y, fxIn.y + wc.y * fxIn.x);
  vec2 fy = vec2(fyIn.x + wc.x * fyIn.y, fyIn.y + wc.y * fyIn.x);
  vec2 id = floor(uv);
  vec2 h = swHash2(id + vec2(41.0, 13.0) + vec2(7.13, 3.71) * level);
  vec2 d = fract(uv) - vec2(0.5) - (h - vec2(0.5)) * ${f(GLITTER_JITTER)};
  float life = sin(min(fract(h.x * 13.71 + h.y * 5.37 + t * (0.25 + 0.45 * fract(h.x * 3.1 + h.y * 7.7))) * ${f(1 / GLITTER_SHARE)}, 1.0) * 3.141593);
  // Glints differ in size, so near water never reads as confetti of equal dots.
  float size = ${f(GLITTER_SIZE[0])} + ${f(GLITTER_SIZE[1] - GLITTER_SIZE[0])} * fract(h.x * 7.31 + h.y * 2.17);
  float s2 = ${f(GLITTER_SIGMA ** 2)} * life * life * size * size;
  float sxx = s2 + ${f(GLITTER_PIXEL ** 2)} * (fx.x * fx.x + fy.x * fy.x);
  float sxy = ${f(GLITTER_PIXEL ** 2)} * (fx.x * fx.y + fy.x * fy.y);
  float syy = s2 + ${f(GLITTER_PIXEL ** 2)} * (fx.y * fx.y + fy.y * fy.y);
  float det = max(sxx * syy - sxy * sxy, 0.0000001);
  float q = (d.x * d.x * syy - 2.0 * d.x * d.y * sxy + d.y * d.y * sxx) / det;
  float core = max(0.0, 1.0 - q * 0.25);
  core *= core;
  return core * core * s2 * ${f(GLITTER_NORM)} / sqrt(det);
}
// Painted's sun mark in one cell of \`uv\` (cells; \`ux\`, \`uy\` its screen derivatives): a streak with
// half-axes \`radii\` (cells, its length varying from cell to cell) along \`ax\` (across the view) and across it,
// jittered within its cell; about half the cells hold none. The lattice is bent by a smooth, bounded warp (its
// Jacobian carried into the derivatives), so marks never line up in rows and columns. Its edge is antialiased by how
// fast its shape function changes per pixel, and a streak thinner than a couple of pixels spreads over them and dims by
// its coverage instead of flickering between pixels. It is lit for \`share\` of a 2.2 to 5 s cycle with a smooth rise
// and fall.
float swMark(vec2 uvIn, vec2 uxIn, vec2 uyIn, vec2 ax, vec2 radiiIn, float share, float t, vec2 seed) {
  vec2 wc = vec2(cos(uvIn.y * 0.53 + seed.x), cos(uvIn.x * 0.67 + seed.y)) * vec2(0.212, 0.268);
  vec2 uv = uvIn + vec2(sin(uvIn.y * 0.53 + seed.x), sin(uvIn.x * 0.67 + seed.y)) * 0.4;
  vec2 ux = vec2(uxIn.x + wc.x * uxIn.y, uxIn.y + wc.y * uxIn.x);
  vec2 uy = vec2(uyIn.x + wc.x * uyIn.y, uyIn.y + wc.y * uyIn.x);
  vec2 h = swHash2(floor(uv) + seed);
  vec2 ay = vec2(-ax.y, ax.x);
  vec2 d = fract(uv) - vec2(0.5) - ax * ((h.x - 0.5) * 0.1) - ay * ((h.y - 0.5) * 0.36);
  vec2 radii = radiiIn * vec2(0.55 + 0.55 * fract(h.x * 5.31 + h.y * 2.77), 1.0);
  vec2 e = vec2(dot(d, ax), dot(d, ay)) / radii;
  float r = length(e);
  vec2 g = e / (radii * max(r, 0.0001));
  float aa = abs(g.x * dot(ux, ax) + g.y * dot(ux, ay)) + abs(g.x * dot(uy, ax) + g.y * dot(uy, ay));
  float shape = smoothstep(-aa, max(aa, 0.25), 1.0 - r) * min(1.0, 2.0 / (1.0 + aa));
  float life = sin(min(fract(h.x * 37.13 + t * (0.2 + 0.25 * h.y)) / share, 1.0) * 3.141593);
  return shape * life * life * step(0.45, fract(h.x * 11.7 + h.y * 3.3));
}
vec2 swWeb(vec2 p) {
  vec2 b = floor(p);
  vec2 f = p - b;
  float n1 = 8.0;
  float n2 = 8.0;${FOAM_WEB_CELLS}
  float s1 = sqrt(n1);
  return vec2(s1, sqrt(n2) - s1);
}
float swCaustic(vec2 uv, float tm) {
  vec2 p = fract(uv * 0.159155) * 6.283185 - vec2(250.0);
  vec2 i = p;
  float c = 1.0;
  float t = 0.0;${CAUSTIC_ITERATIONS}
  c = 1.17 - pow(c * 0.25, 1.4);
  c = c * c;
  c = c * c;
  return c * c;
}
`;

/** Realistic, or a Stylized look: Painted (`SLATE_WATER_TOON` off) or Toon. */
type WaterShaderStyle = "realistic" | "painted" | "toon";

/**
 * One realistic chop octave or capillary: the footprint along its own direction from High up, isotropic below, times
 * its temporal fade (`TEMPORAL_FADE`).
 */
function footprintFade(prefix: string, i: number, k: string, dir: string, speed: number): string {
  const temporal = `(1.0 - smoothstep(${f(TEMPORAL_FADE[0])}, ${f(TEMPORAL_FADE[1])}, sqrt(9.81 * ${k}) * ${f(speed * TEMPORAL_FRAME)} * U.slateWaterWaves.z))`;
  return fromTier(2, `
float ${prefix}${i} = (1.0 - smoothstep(0.4, 1.4, ${k} * (abs(dot(${dir}, swFootX)) + abs(dot(${dir}, swFootY))))) * ${temporal};`, `
float ${prefix}${i} = (1.0 - smoothstep(0.4, 1.4, ${k} * swFoot * 0.64)) * ${temporal};`);
}

/**
 * Refraction (`SLATE_WATER_REFRACTION`), right after the bottom estimate: the view ray bends by the surface tilt (in
 * view space), more through thicker water and less far away, and reads the view's scene copy there. A shifted ray
 * that lands on something in front of the water (an object above it) keeps the straight ray, so nothing above the
 * surface leaks into it. The copy's depth also bounds the bottom estimate (similar triangles along the view ray), so
 * absorption follows whatever actually lies below: the bed shows through shallows, deep water fades to its colour.
 * Orthographic views (`projection[3][3]` is 1) bend by the same view-space amount at every distance, and their view
 * rays are parallel: the bound follows the camera's forward axis instead of the ray through the eye. `scale` shortens
 * the bend and its cap (Realistic: what lies under clear water wobbles with the waves rather than smearing sideways).
 * GLSL-shaped; `SW_FRAG_COORD` and the copy helpers are bound per language.
 */
function refractionSource(scale = 1): string {
  return ifDefined(REFRACTION, `
vec2 swScreenUv = SW_FRAG_COORD.xy * U.slateWaterScreen.xy;
float swWaterZ = abs((S.view * vec4(IN.vPositionW, 1.0)).z);
float swSceneZ0 = swSceneDepth(swScreenUv);
vec2 swRefrSlope = swGradient + swDetailMid * swChopGain;
vec2 swTiltV = (S.view * vec4(-swRefrSlope.x, 0.0, -swRefrSlope.y, 0.0)).xy;
float swRefrDepth = min(max(swSceneZ0 - swWaterZ, 0.0), ${f(REFRACTION_DEPTH_CAP)});
float swOrtho = S.projection[3][3];
vec2 swRefrShift = swTiltV * vec2(S.projection[0][0], S.projection[1][1]) * (U.slateWaterScreen.z * ${f(REFRACTION_SHIFT * scale)} * swRefrDepth * mix(1.0 / max(swWaterZ, 0.05), 1.0, swOrtho));
swRefrShift = swRefrShift * min(1.0, mix(${f(REFRACTION_SHIFT_PX[0] * scale)}, ${f(REFRACTION_SHIFT_PX[1] * scale)}, smoothstep(${f(REFRACTION_FAR[0])}, ${f(REFRACTION_FAR[1])}, swWaterZ)) * U.slateWaterScreen.x / max(length(swRefrShift), 0.000001));
vec2 swRefrUv = swScreenUv + swRefrShift;
float swSceneZ1 = swSceneDepth(swRefrUv);
float swLeak = step(swSceneZ1, swWaterZ);
swRefrUv = mix(swRefrUv, swScreenUv, swLeak);
float swSceneZ = mix(swSceneZ1, swSceneZ0, swLeak);
vec3 swBackground = swSceneColor(swRefrUv);
// Beside the silhouette of something in front of the water, a downsampled copy texel holds that object (its
// nearest depth): there the copy is not what lies behind this point, so the pixel keeps the blended surface.
float swRefracts = step(swWaterZ, swSceneZ);
// Height lost per metre of view depth along this pixel's view ray.
float swDropPerDepth = mix(abs(S.vEyePosition.y - IN.vPositionW.y) / max(swWaterZ, 0.001), abs(S.view[1][2]), swOrtho);
swDepth = mix(swDepth, min(swDepth, max(swSceneZ - swWaterZ, 0.0) * swDropPerDepth), swRefracts);`);
}

/**
 * Object reflections (`SLATE_WATER_SSR`, `SLATE_WATER_PLANAR`) along `ray` (a world direction): `swObjRefl` holds
 * linear colour and coverage, 0 where nothing was found (the sky or environment reflection stays). The planar
 * reflection looks up where the reflected ray, followed `PLANAR_REACH` times the eye's distance beyond this fragment's
 * eye-relative position, projects through the mirrored view-projection, at the uv the planar browser proof reads back
 * on both backends (0.5 + 0.5·clip.xy/clip.w). On flat water the reflected ray continues the mirrored view ray, so
 * this is the fragment's own mirror point at any reach; on waves the lookup moves with the reflected ray, as the
 * environment and the march do, rather than by a small fixed shift that left wavy water mirror-flat. Its alpha is
 * coverage and display views store it display-encoded. Without it (another body is the view's dominant one), the
 * screen-space march runs. Sharp hits fade out as the surface gets rough.
 */
function objectReflectionSource(ray: string, roughness: string): string {
  return `
#if ${REFLECTS_OBJECTS}
vec4 swObjRefl = vec4(0.0);
vec3 swReflRay = ${ray};
swReflRay = normalize(vec3(swReflRay.x, max(swReflRay.y, 0.02), swReflRay.z));${ifDefined(PLANAR, `
if (U.slateWaterPlanar.x > 0.5) {
  float swPlanarReach = length(S.vEyePosition.xyz - IN.vPositionW) * U.slateWaterPlanar.z;
  vec4 swPlanarClip = U.slateWaterPlanarMatrix * vec4(IN.vPositionW + swReflRay * swPlanarReach, 1.0);
  vec2 swPlanarUv = swPlanarClip.xy / max(swPlanarClip.w, 0.000001) * 0.5 + vec2(0.5);
  vec4 swPlanarHit = swPlanarTexel(swPlanarUv);
  vec3 swPlanarColor = swPlanarHit.rgb / max(swPlanarHit.a, 0.001);
  swObjRefl = vec4(mix(swPlanarColor, SW_TO_LINEAR(swPlanarColor), U.slateWaterPlanar.y), swPlanarHit.a);
}`)}${ifDefined(SSR, `
if (U.slateWaterPlanar.x < 0.5) {
  swObjRefl = swMarch(IN.vPositionW, swReflRay);
}`)}
swObjRefl.a = swObjRefl.a * (1.0 - smoothstep(0.2, 0.45, ${roughness}));
#endif`;
}

/**
 * Per-language samplers and helpers of the scene-copy and reflection features, declared only with their defines.
 * Refraction filters the copy's colour; depth is read from the nearest texel (filtered depth would halo silhouettes),
 * and a reflection hit takes its colour from that same texel. All reads use an explicit level, so they are legal in
 * any control flow.
 */
function objectHelpers(wgsl: boolean): string {
  const copy = wgsl ? `
var ${WATER_SCENE_SAMPLER}Sampler: sampler;
var ${WATER_SCENE_SAMPLER}: texture_2d<f32>;
fn swSceneColor(uv: vec2f) -> vec3f { return textureSampleLevel(${WATER_SCENE_SAMPLER}, ${WATER_SCENE_SAMPLER}Sampler, uv, 0.0).rgb; }
fn swSceneTexel(uv: vec2f) -> vec4f {
  let swSize = vec2i(textureDimensions(${WATER_SCENE_SAMPLER}, 0));
  return textureLoad(${WATER_SCENE_SAMPLER}, clamp(vec2i(uv * vec2f(swSize)), vec2i(0), swSize - vec2i(1)), 0);
}
fn swSceneDepth(uv: vec2f) -> f32 { return swSceneTexel(uv).a; }
fn swSceneTexelUv() -> vec2f { return 1.0 / vec2f(textureDimensions(${WATER_SCENE_SAMPLER}, 0)); }` : `
uniform sampler2D ${WATER_SCENE_SAMPLER};
vec3 swSceneColor(vec2 uv) { return texture2DLodEXT(${WATER_SCENE_SAMPLER}, uv, 0.0).rgb; }
vec4 swSceneTexel(vec2 uv) {
  ivec2 swSize = textureSize(${WATER_SCENE_SAMPLER}, 0);
  return texelFetch(${WATER_SCENE_SAMPLER}, clamp(ivec2(uv * vec2(swSize)), ivec2(0), swSize - ivec2(1)), 0);
}
float swSceneDepth(vec2 uv) { return swSceneTexel(uv).a; }
vec2 swSceneTexelUv() { return 1.0 / vec2(textureSize(${WATER_SCENE_SAMPLER}, 0)); }`;
  const planar = wgsl ? `
var ${WATER_PLANAR_SAMPLER}Sampler: sampler;
var ${WATER_PLANAR_SAMPLER}: texture_2d<f32>;
fn swPlanarTexel(uv: vec2f) -> vec4f { return textureSampleLevel(${WATER_PLANAR_SAMPLER}, ${WATER_PLANAR_SAMPLER}Sampler, uv, 0.0); }` : `
uniform sampler2D ${WATER_PLANAR_SAMPLER};
vec4 swPlanarTexel(vec2 uv) { return texture2DLodEXT(${WATER_PLANAR_SAMPLER}, uv, 0.0); }`;
  return `\n#if ${SAMPLES_COPY}${copy}\n#endif${ifDefined(SSR, marchSource(wgsl))}${ifDefined(PLANAR, planar)}\n`;
}

/** `code` only when the band (or, with `FFT_VERTEX`, its vertex part) is compiled in; every directive on its own line. */
const ifFft = (code: string, cascades = 1, define = FFT) => `\n#if ${define} >= ${cascades}${code}\n#endif`;

/**
 * The band's sampler and its tap, per language, for either stage: an explicit level (the band has no mips), legal in
 * any control flow and in the vertex stage. The vertex stage declares it only with its part of the band (`define`
 * `SLATE_WATER_FFT_VERTEX`); then both stages declare the same binding (one WebGL2 texture unit, one WebGPU binding
 * visible to both). GLSL ES has no default precision for array samplers.
 */
function fftHelpers(wgsl: boolean, define = FFT): string {
  return ifFft(wgsl ? `
var ${WATER_FFT_SAMPLER}Sampler: sampler;
var ${WATER_FFT_SAMPLER}: texture_2d_array<f32>;
fn swFftTap(uv: vec2f, layer: f32) -> vec4f { return textureSampleLevel(${WATER_FFT_SAMPLER}, ${WATER_FFT_SAMPLER}Sampler, uv, i32(layer), 0.0); }` : `
uniform highp sampler2DArray ${WATER_FFT_SAMPLER};
vec4 swFftTap(vec2 uv, float layer) { return textureLod(${WATER_FFT_SAMPLER}, vec3(uv, layer), 0.0); }`, 1, define) + "\n";
}

/**
 * Anti-tiling of the band's first cascade, whose periodic patch (2 to 4 Wave Lengths) is the band's largest: a second
 * copy, offset by golden-ratio fractions of the patch, crossfades with the first by `<prefix>TileW` (variance
 * preserving), so no patch repeats unchanged. The weight is a slow beat of the swell warp's own phases (3·K₀ − 2·K₁ +
 * K₂, about two Wave Lengths across; integer combinations of the CPU-reduced phases stay world-anchored), shared by
 * both stages, so the vertex displacement and the fragment's slopes blend alike. Two more taps, High and Ultra only.
 */
function fftTileWeight(prefix: string, warpPhase: string): string {
  return `
float ${prefix}TileW = 0.5 + 0.5 * sin(3.0 * ${warpPhase}0 - 2.0 * ${warpPhase}1 + ${warpPhase}2);
float ${prefix}TileN = 1.0 / sqrt(${prefix}TileW * ${prefix}TileW + (1.0 - ${prefix}TileW) * (1.0 - ${prefix}TileW));`;
}
function fftTileBlend(prefix: string, uv: string, a: string, b: string): string {
  return `
  vec4 ${a}x = swFftTap(${uv} + vec2(0.381966, 0.618034), 0.0);
  vec4 ${b}x = swFftTap(${uv} + vec2(0.381966, 0.618034), 1.0);
  ${a} = (${a} * ${prefix}TileW + ${a}x * (1.0 - ${prefix}TileW)) * ${prefix}TileN;
  ${b} = (${b} * ${prefix}TileW + ${b}x * (1.0 - ${prefix}TileW)) * ${prefix}TileN;`;
}

/** Cosine and sine of cascade `c`'s texture-frame turn (`WATER_FFT_CASCADE_TURNS`). */
const fftTurn = (c: number) => [Math.cos(WATER_FFT_CASCADE_TURNS[c]!), Math.sin(WATER_FFT_CASCADE_TURNS[c]!)] as const;
/** A world X/Z vector in cascade `c`'s turned frame, R(−θ)·v (unchanged for the unturned first cascade). */
function fftTurnIn(c: number, v: string): string {
  const [cos, sin] = fftTurn(c);
  return c === 0 ? v : `vec2(dot(${v}, vec2(${f(cos)}, ${f(sin)})), dot(${v}, vec2(${f(-sin)}, ${f(cos)})))`;
}
/** A vector of cascade `c`'s turned frame back in world X/Z, R(θ)·v. */
function fftTurnOut(c: number, v: string): string {
  const [cos, sin] = fftTurn(c);
  return c === 0 ? v : `vec2(dot(${v}, vec2(${f(cos)}, ${f(-sin)})), dot(${v}, vec2(${f(sin)}, ${f(cos)})))`;
}
/** A symmetric ∂D tensor (xx, xz, zz) of cascade `c`'s turned frame back in world X/Z, R(θ)·J·R(θ)ᵀ. */
function fftTurnTensor(c: number, j: string): string {
  const [cos, sin] = fftTurn(c), cc = cos * cos, ss = sin * sin, cs = cos * sin;
  return c === 0 ? j : `vec3(dot(${j}, vec3(${f(cc)}, ${f(-2 * cs)}, ${f(ss)})), dot(${j}, vec3(${f(cs)}, ${f(cc - ss)}, ${f(-cs)})), dot(${j}, vec3(${f(ss)}, ${f(2 * cs)}, ${f(cc)})))`;
}

/**
 * FFT ocean detail in the fragment (`SLATE_WATER_FFT`), after the shared noises. Each cascade is sampled at this
 * fragment's rest point (the band is Lagrangian, like the swell: detail rides the waves instead of sliding over
 * them), turned into the cascade's own frame (`WATER_FFT_CASCADE_TURNS`, its outputs turned back to the world, so the
 * cascades' patches tile along different axes), and fades with the rest-plane pixel footprint along its longer axis, by the same curve as the swell components
 * on the cascade's highest wavenumber, so no cascade aliases or shimmers; each cascade's strength also drifts with a
 * world noise (the large one for the first, the medium one for the rest), so its periodic patch never shows as a
 * repeating tile. Its rest-space slope and Jacobian terms (layer 2c + 1, and ∂Dx/∂z in layer 2c) are scaled by
 * g = Detail Waves · Wave Scale and, for the horizontal terms, λ = Steepness · bank gain. The band's Jacobian joins
 * the analytic one, scaled down where their determinant would fall below `WATER_JACOBIAN_FLOOR`, and replaces it for
 * the Jacobian foam; the band's slope reaches the shading normal through that combined Jacobian (J⁻ᵀ∇H) while the
 * swell keeps its own. Faded cascades add nothing to the filtered roughness: the chop octaves and capillaries, which
 * cover the same wavelengths, already widen the sun's lobe by the slope they lose, so distant water keeps the look it
 * has without the band. GLSL-shaped; `swFftTap` is bound per language.
 */
function fftFragmentSource(): string {
  const floor = f(WATER_JACOBIAN_FLOOR);
  const cascades = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => {
    const code = `
vec4 swFftC${c} = U.${FFT_CASCADE_UNIFORMS[c]};
float swFftFd${c} = 1.0 - smoothstep(${f(FFT_FRAGMENT_FADE[0])}, ${f(FFT_FRAGMENT_FADE[1])}, swFftC${c}.w * swFftReach);
float swFftM${c} = 0.55 + 0.9 * ${c === 0 ? "swLarge" : "swMedium"};
if (swFftFd${c} > 0.0) {
  vec2 swFftUv${c} = ${fftTurnIn(c, "swRest")} * swFftC${c}.x + swFftC${c}.yz;
  vec4 swFftA${c} = swFftTap(swFftUv${c}, ${f(2 * c)});
  vec4 swFftB${c} = swFftTap(swFftUv${c}, ${f(2 * c + 1)});${c === 0 ? fftTileBlend("swFft", "swFftUv0", "swFftA0", "swFftB0") : ""}
  float swFftF${c} = swFftFd${c} * swFftM${c};
  swFftGrad += ${fftTurnOut(c, `swFftB${c}.xy`)} * swFftF${c};
  swFftJ += ${fftTurnTensor(c, `vec3(swFftB${c}.z, swFftA${c}.w, swFftB${c}.w)`)} * swFftF${c};
}`;
    return c === 0 ? code : ifFft(code, c + 1);
  }).join("");
  return ifFft(`
vec4 swFft = U.slateWaterFft;
swFft = vec4(swFft.x * swBlendH, swFft.yzw);
float swFftReach = max(length(swFootX), length(swFootY));${fftTileWeight("swFft", "swSwellWP")}
vec2 swFftGrad = vec2(0.0);
vec3 swFftJ = vec3(0.0);${cascades}
swFftGrad = swFftGrad * swFft.x;
swFftJ = swFftJ * (swFft.x * swFft.y * swGain);
float swFftDet = (swJxx + swFftJ.x) * (swJzz + swFftJ.z) - (swJxz + swFftJ.y) * (swJzx + swFftJ.y);
float swFftKeep = mix(1.0, clamp((swDetJ - ${floor}) / max(swDetJ - swFftDet, 0.000001), 0.0, 1.0), step(swFftDet, ${floor}));
swFftJ = swFftJ * swFftKeep;
float swFftJxx = swJxx + swFftJ.x;
float swFftJxz = swJxz + swFftJ.y;
float swFftJzx = swJzx + swFftJ.y;
float swFftJzz = swJzz + swFftJ.z;
swDetJ = swFftJxx * swFftJzz - swFftJxz * swFftJzx;
vec2 swFftSlope = vec2(swFftJzz * swFftGrad.x - swFftJzx * swFftGrad.y, swFftJxx * swFftGrad.y - swFftJxz * swFftGrad.x) / max(swDetJ, ${f(WATER_JACOBIAN_FLOOR / 2)});`);
}

/**
 * FFT ocean detail in the vertex stage (`SLATE_WATER_GPU_WAVES` with `SLATE_WATER_FFT_VERTEX`), after the swell and before
 * the bank fade: (Dx, H, Dz) of each cascade at this vertex's rest point, scaled by g and λ = Steepness (the bank fade
 * then scales the horizontal part with the swell's). A cascade fades by the swell's mesh filter on the cascade's
 * shortest wavelength (its upper band edge k_hi: full weight while the reach is under a quarter of it, none from half
 * of it, the mesh's Nyquist limit), with the reach the larger of the mesh spacing and twice the view footprint at the
 * vertex (metres per pixel at its view depth). The band has no mips, so a vertex point-samples every wavelength of a
 * cascade it keeps: only cascades the mesh resolves completely displace it, and the fragment carries the rest, so no
 * part of the band aliases into the geometry or crawls along silhouettes. The horizontal detail shrinks where it would
 * fold the mesh: the combined determinant (the swell's `swvShear` plus the band's ∂D terms) stays at or above
 * `WATER_JACOBIAN_FLOOR`. Faded cascades skip their taps.
 */
function fftVertexSource(): string {
  const floor = f(WATER_JACOBIAN_FLOOR);
  const cascades = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => {
    const code = `
vec4 swvFc${c} = U.${FFT_CASCADE_UNIFORMS[c]};
float swvFw${c} = clamp(2.0 - swvReach * swvFc${c}.w * ${f(4 / TAU)}, 0.0, 1.0);
swvFw${c} = swvFw${c} * swvFw${c} * (3.0 - 2.0 * swvFw${c});
if (swvFw${c} > 0.0) {
  vec2 swvFu${c} = ${fftTurnIn(c, "swvRest")} * swvFc${c}.x + swvFc${c}.yz;
  vec4 swvFa${c} = swFftTap(swvFu${c}, ${f(2 * c)});
  vec4 swvFb${c} = swFftTap(swvFu${c}, ${f(2 * c + 1)});${c === 0 ? fftTileBlend("swvF", "swvFu0", "swvFa0", "swvFb0") : ""}
  swvFftH += swvFa${c}.y * swvFw${c};
  swvFftD += ${fftTurnOut(c, `swvFa${c}.xz`)} * swvFw${c};
  swvFftJ += ${fftTurnTensor(c, `vec3(swvFb${c}.z, swvFa${c}.w, swvFb${c}.w)`)} * swvFw${c};
}`;
    return c === 0 ? code : ifFft(code, c + 1, FFT_VERTEX);
  }).join("");
  return ifFft(`
vec4 swvFft = U.slateWaterFft;${fftTileWeight("swvF", "swvWP")}
float swvReach = max(swvSpacing, 2.0 * (swvFft.z * abs((S.view * worldPos).z) + swvFft.w));
float swvFftH = 0.0;
vec2 swvFftD = vec2(0.0);
vec3 swvFftJ = vec3(0.0);${cascades}
float swvJxx = 1.0 - swvGain * (swvShear.x * swvWarpM.x + swvShear.y * swvWarpM.y);
float swvJxz = -swvGain * (swvShear.x * swvWarpM.y + swvShear.y * swvWarpM.z);
float swvJzx = -swvGain * (swvShear.y * swvWarpM.x + swvShear.z * swvWarpM.y);
float swvJzz = 1.0 - swvGain * (swvShear.y * swvWarpM.y + swvShear.z * swvWarpM.z);
float swvDetA = swvJxx * swvJzz - swvJxz * swvJzx;
vec3 swvJb = swvFftJ * (swvFft.x * swvFft.y * swvGain);
float swvDetB = (swvJxx + swvJb.x) * (swvJzz + swvJb.z) - (swvJxz + swvJb.y) * (swvJzx + swvJb.y);
float swvKeep = mix(1.0, clamp((swvDetA - ${floor}) / max(swvDetA - swvDetB, 0.000001), 0.0, 1.0), step(swvDetB, ${floor}));
swvH += swvFftH * swvFft.x;
swvD += swvFftD * (swvFft.x * swvFft.y * swvKeep);`, 1, FFT_VERTEX);
}

/**
 * The screen-space march (`SLATE_WATER_SSR`), per language (loops do not pass `toWgsl`). The reflected ray runs from
 * the eye-relative surface point until the march distance (`slateWaterScreen.w`), the screen edge or just short of
 * the eye; `SLATE_WATER_SSR_STEPS` samples are evenly spaced on screen along it, with depth interpolated
 * perspective-correctly (also exact for orthographic views).
 * - A sample is a hit when the ray lies behind the copy's depth there and crossed that depth during the step, not
 *   when it passes behind something in front of the whole step.
 * - When the ray only passes the depth the previous sample saw while this sample sees something farther (the far
 *   side of a face, such as the top of a wall, shorter on screen than one step), one probe where the ray reached
 *   that depth catches it.
 * - Bisection refines the hit, which stands only on the surface its texel holds (within `SSR_THICKNESS`) and takes
 *   that texel's colour: a refinement that settles beside a silhouette misses (the sky stays) instead of reflecting
 *   the background there. A downsampled copy (below full resolution) averages each texel's colour but keeps its
 *   nearest depth, so a silhouette texel blends the object with what lies behind it: the hit then takes the colour
 *   of the neighbouring texel away from the farther side (four depth loads and one texel load, only on a hit). The
 *   hit fades out over the outer half of the thickness rather than ending in a step, so the copy's silhouette texels
 *   feather a reflected outline instead of tearing it into stair-stepped fragments.
 * Hits fade toward the screen edge and the end of the march; one whose scene point lies under the water plane is
 * rejected (the copy holds submerged geometry), and hits fade in over the first quarter metre above it, so a beach
 * meeting the water reflects no stair-stepped edge of the copy's texels along its waterline. Returns linear colour and
 * coverage.
 */
function marchSource(wgsl: boolean): string {
  const steps = SSR_STEPS, refine = SSR_REFINE_STEPS, base = f(SSR_THICKNESS[0]), slope = f(SSR_THICKNESS[1]);
  return wgsl ? `
fn swMarchAt(swC0w: f32, swC1w: f32, swU: f32) -> f32 { return swU * swC0w / max(swU * swC0w + (1.0 - swU) * swC1w, 0.000001); }
fn swMarch(swOrigin: vec3f, swRay: vec3f) -> vec4f {
  let swC0 = scene.viewProjection * vec4f(swOrigin, 1.0);
  let swDir = scene.viewProjection * vec4f(swRay, 0.0);
  let swLength = min(uniforms.slateWaterScreen.w, 0.9 * swC0.w / max(-swDir.w, 0.00001));
  let swC1 = swC0 + swDir * swLength;
  let swN0 = swC0.xy / swC0.w;
  let swN1 = swC1.xy / swC1.w;
  let swSpan = swN1 - swN0;
  let swSide = mix(vec2f(-1.0), vec2f(1.0), step(vec2f(0.0), swSpan));
  let swExit = (swSide - swN0) / (max(abs(swSpan), vec2f(0.00001)) * swSide);
  let swEnd = clamp(min(swExit.x, swExit.y), 0.0, 1.0);
  let swZ0 = (scene.view * vec4f(swOrigin, 1.0)).z;
  let swForward = sign(swZ0);
  let swD0 = swZ0 * swForward;
  let swD1 = (scene.view * vec4f(swOrigin + swRay * swLength, 1.0)).z * swForward;
  var swPrevU: f32 = 0.0;
  var swPrevZ: f32 = swD0;
  var swPrevScene: f32 = 65000.0;
  var swA: f32 = 0.0;
  var swB: f32 = -1.0;
  for (var swI: i32 = 1; swI <= ${steps}; swI++) {
    let swU = swEnd * f32(swI) / f32(${steps});
    let swRayZ = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swU));
    let swSceneZ = swSceneDepth(mix(swN0, swN1, swU) * 0.5 + 0.5);
    let swThick = ${base} + ${slope} * swRayZ;
    if (swRayZ > swSceneZ) {
      if (swSceneZ > swPrevZ - swThick) { swA = swPrevU; swB = swU; break; }
    } else if (swRayZ > swPrevScene && swPrevZ <= swPrevScene) {
      let swProbeU = swMarchAt(swC1.w, swC0.w, clamp((swPrevScene - swD0) / max(swD1 - swD0, 0.000001), 0.0, 1.0));
      if (abs(swPrevScene - swSceneDepth(mix(swN0, swN1, swProbeU) * 0.5 + 0.5)) < swThick) { swA = swPrevU; swB = swProbeU; break; }
    }
    swPrevU = swU;
    swPrevZ = swRayZ;
    swPrevScene = swSceneZ;
  }
  if (swB < 0.0) { return vec4f(0.0); }
  for (var swJ: i32 = 0; swJ < ${refine}; swJ++) {
    let swM = 0.5 * (swA + swB);
    let swMidZ = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swM));
    if (swMidZ > swSceneDepth(mix(swN0, swN1, swM) * 0.5 + 0.5)) { swB = swM; } else { swA = swM; }
  }
  let swUv = mix(swN0, swN1, swB) * 0.5 + 0.5;
  let swS = swMarchAt(swC0.w, swC1.w, swB);
  let swRayZ = mix(swD0, swD1, swS);
  let swThickHit = ${base} + ${slope} * swRayZ;
  var swHit: vec4f = swSceneTexel(swUv);
  let swTexel = swSceneTexelUv();
  if (swTexel.x > uniforms.slateWaterScreen.x * 1.01) {
    let swFar = swHit.a + swThickHit;
    let swAway = vec2f(
      step(swFar, swSceneDepth(swUv - vec2f(swTexel.x, 0.0))) - step(swFar, swSceneDepth(swUv + vec2f(swTexel.x, 0.0))),
      step(swFar, swSceneDepth(swUv - vec2f(0.0, swTexel.y))) - step(swFar, swSceneDepth(swUv + vec2f(0.0, swTexel.y))));
    if (dot(swAway, swAway) > 0.0) {
      let swInner = swSceneTexel(swUv + swAway * swTexel);
      if (abs(swInner.a - swHit.a) < swThickHit) { swHit = vec4f(swInner.rgb, swHit.a); }
    }
  }
  let swEye = scene.vEyePosition.xyz;
  let swPoint = swOrigin + swRay * (swLength * swS);
  let swSceneY = swEye.y + (swPoint.y - swEye.y) * swHit.a / max(swRayZ, 0.000001);
  let swEdge = min(swUv, vec2f(1.0) - swUv);
  let swFade = smoothstep(0.0, 0.06, min(swEdge.x, swEdge.y)) * (1.0 - smoothstep(0.7, 1.0, swS)) * smoothstep(swOrigin.y - 0.05, swOrigin.y + 0.25, swSceneY)
    * (1.0 - smoothstep(swThickHit * 0.5, swThickHit, abs(swRayZ - swHit.a)));
  return vec4f(swHit.rgb, swFade);
}` : `
float swMarchAt(float swC0w, float swC1w, float swU) { return swU * swC0w / max(swU * swC0w + (1.0 - swU) * swC1w, 0.000001); }
vec4 swMarch(vec3 swOrigin, vec3 swRay) {
  vec4 swC0 = viewProjection * vec4(swOrigin, 1.0);
  vec4 swDir = viewProjection * vec4(swRay, 0.0);
  float swLength = min(slateWaterScreen.w, 0.9 * swC0.w / max(-swDir.w, 0.00001));
  vec4 swC1 = swC0 + swDir * swLength;
  vec2 swN0 = swC0.xy / swC0.w;
  vec2 swN1 = swC1.xy / swC1.w;
  vec2 swSpan = swN1 - swN0;
  vec2 swSide = mix(vec2(-1.0), vec2(1.0), step(vec2(0.0), swSpan));
  vec2 swExit = (swSide - swN0) / (max(abs(swSpan), vec2(0.00001)) * swSide);
  float swEnd = clamp(min(swExit.x, swExit.y), 0.0, 1.0);
  float swZ0 = (view * vec4(swOrigin, 1.0)).z;
  float swForward = sign(swZ0);
  float swD0 = swZ0 * swForward;
  float swD1 = (view * vec4(swOrigin + swRay * swLength, 1.0)).z * swForward;
  float swPrevU = 0.0;
  float swPrevZ = swD0;
  float swPrevScene = 65000.0;
  float swA = 0.0;
  float swB = -1.0;
  for (int swI = 1; swI <= ${steps}; swI++) {
    float swU = swEnd * float(swI) / float(${steps});
    float swRayZ = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swU));
    float swSceneZ = swSceneDepth(mix(swN0, swN1, swU) * 0.5 + 0.5);
    float swThick = ${base} + ${slope} * swRayZ;
    if (swRayZ > swSceneZ) {
      if (swSceneZ > swPrevZ - swThick) { swA = swPrevU; swB = swU; break; }
    } else if (swRayZ > swPrevScene && swPrevZ <= swPrevScene) {
      float swProbeU = swMarchAt(swC1.w, swC0.w, clamp((swPrevScene - swD0) / max(swD1 - swD0, 0.000001), 0.0, 1.0));
      if (abs(swPrevScene - swSceneDepth(mix(swN0, swN1, swProbeU) * 0.5 + 0.5)) < swThick) { swA = swPrevU; swB = swProbeU; break; }
    }
    swPrevU = swU;
    swPrevZ = swRayZ;
    swPrevScene = swSceneZ;
  }
  if (swB < 0.0) { return vec4(0.0); }
  for (int swJ = 0; swJ < ${refine}; swJ++) {
    float swM = 0.5 * (swA + swB);
    float swMidZ = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swM));
    if (swMidZ > swSceneDepth(mix(swN0, swN1, swM) * 0.5 + 0.5)) { swB = swM; } else { swA = swM; }
  }
  vec2 swUv = mix(swN0, swN1, swB) * 0.5 + 0.5;
  float swS = swMarchAt(swC0.w, swC1.w, swB);
  float swRayZ = mix(swD0, swD1, swS);
  float swThickHit = ${base} + ${slope} * swRayZ;
  vec4 swHit = swSceneTexel(swUv);
  vec2 swTexel = swSceneTexelUv();
  if (swTexel.x > slateWaterScreen.x * 1.01) {
    // A downsampled copy keeps each texel's nearest depth but averages its colour: at a silhouette the texel blends
    // the object with what lies behind it, so the colour comes from the neighbour away from the farther side.
    float swFar = swHit.a + swThickHit;
    vec2 swAway = vec2(
      step(swFar, swSceneDepth(swUv - vec2(swTexel.x, 0.0))) - step(swFar, swSceneDepth(swUv + vec2(swTexel.x, 0.0))),
      step(swFar, swSceneDepth(swUv - vec2(0.0, swTexel.y))) - step(swFar, swSceneDepth(swUv + vec2(0.0, swTexel.y))));
    if (dot(swAway, swAway) > 0.0) {
      vec4 swInner = swSceneTexel(swUv + swAway * swTexel);
      if (abs(swInner.a - swHit.a) < swThickHit) { swHit = vec4(swInner.rgb, swHit.a); }
    }
  }
  vec3 swEye = vEyePosition.xyz;
  vec3 swPoint = swOrigin + swRay * (swLength * swS);
  float swSceneY = swEye.y + (swPoint.y - swEye.y) * swHit.a / max(swRayZ, 0.000001);
  vec2 swEdge = min(swUv, vec2(1.0) - swUv);
  float swFade = smoothstep(0.0, 0.06, min(swEdge.x, swEdge.y)) * (1.0 - smoothstep(0.7, 1.0, swS)) * smoothstep(swOrigin.y - 0.05, swOrigin.y + 0.25, swSceneY)
    * (1.0 - smoothstep(swThickHit * 0.5, swThickHit, abs(swRayZ - swHit.a)));
  return vec4(swHit.rgb, swFade);
}`;
}

/**
 * Swell, wind chop, contacts and depth shared by every style and look; Stylized runs fewer chop octaves, and Painted
 * also gathers the primary swell and bends its chop domain finer.
 */
function surfaceSource(style: WaterShaderStyle): string {
  const realistic = style === "realistic", painted = style === "painted";
  // The shared kernel's components (`waterWaveShaderConstants`) at this fragment's warped rest point (`swRestW`): the
  // same swell, crest profile and Gerstner offset the mesh, queries and buoyancy use. Phases arrive reduced on the CPU
  // relative to the floating origin, so no large-argument trigonometry runs here. Slots hold the components by
  // descending slope, so Low's first three and Medium's first six are the ones that shape the light most. Each fades
  // by its local (warped) wavevector k·M·d across the pixel footprint.
  const swell = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => fromTier(swellTier(i), `
vec4 swWD${i} = U.${SWELL_DIRECTION[i]};
vec4 swWA${i} = U.${SWELL_AMPLITUDE[i]};
vec4 swWG${i} = U.${SWELL_GROUP[i]};
float swK${i} = swWD${i}.z;
vec2 swD${i} = swWD${i}.xy;
vec2 swDm${i} = swD${i} + vec2(dot(swSwellWarpG.xy, swD${i}), dot(swSwellWarpG.yz, swD${i}));
float swP${i} = swK${i} * dot(swD${i}, swRestW) + swWA${i}.y;
float swA${i} = swWA${i}.x * swBlendH;
float swFd${i} = 1.0 - smoothstep(0.6, 2.2, swK${i} * (abs(dot(swDm${i}, swFootX)) + abs(dot(swDm${i}, swFootY))));
// The component's wave group (\`waterWaveGroups\`): its height envelope, which the Gerstner offset below does not carry.
float swGn${i} = (1.0 / sqrt(1.0 + 0.5 * swWG${i}.w * swWG${i}.w));
float swGq${i} = dot(swWG${i}.xy, swRestW) + swWG${i}.z;
float swG${i} = (1.0 + swWG${i}.w * cos(swGq${i})) * swGn${i};
float swF${i} = swFd${i} * swA${i} * swG${i};
float swS${i} = sin(swP${i});
float swC${i} = cos(swP${i});
float swE${i} = exp(swS${i} - 1.0);
float swHv${i} = mix(swS${i}, (swE${i} - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swChopShape);
swHeight += swHv${i} * swF${i};
swGradient += swD${i} * (mix(swC${i}, swE${i} * swC${i} / ${f(WATER_CREST_RANGE)}, swChopShape) * swK${i} * swF${i});${fromTier(2, `
// The envelope's own slope (High up; about a sixteenth of the crest's, so lower tiers leave it out).
swGradient -= swWG${i}.xy * (swWG${i}.w * swGn${i} * sin(swGq${i}) * swHv${i} * swFd${i} * swA${i});`)}
swFold += swK${i} * swF${i} * mix(swS${i}, swE${i} * (swS${i} - swC${i} * swC${i}) / ${f(WATER_CREST_RANGE)}, swChopShape);
swResolved += swK${i} * swFd${i} * swA${i};${realistic ? `
swLost += swK${i} * swA${i} * swK${i} * swA${i} * (1.0 - swFd${i} * swFd${i});` : painted ? `
// The primary swell: components near the dominant wavelength, which Painted shades as the big readable waves.
float swPw${i} = 1.0 - smoothstep(1.3, 2.2, swK${i} * swPrimLen);
swPrimH += mix(swS${i}, (swE${i} - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swChopShape) * swF${i} * swPw${i};
swPrimG += swD${i} * (mix(swC${i}, swE${i} * swC${i} / ${f(WATER_CREST_RANGE)}, swChopShape) * swK${i} * swF${i} * swPw${i});
swPrimAmp += swA${i} * swA${i} * swPw${i} * swPw${i};` : ""}
float swQ${i} = swWA${i}.z * swFd${i} * swBlendD;
swOffset += swD${i} * (swQ${i} * swC${i});
swShear += vec3(swD${i}.x * swD${i}.x, swD${i}.x * swD${i}.y, swD${i}.y * swD${i}.y) * (swQ${i} * swK${i} * swS${i});`)).join("");
  // Low and Medium: the swell components they skip still count as resolved slope (faded like their last one) and,
  // Realistic, as roughness, so they widen the sun path instead of vanishing (the CPU sums the skipped slots for the
  // compiled tier).
  const skipped = (last: number) => `
swResolved += U.slateWaterSea.w * swFd${last} * swBlendH;${realistic ? `
swLost += U.slateWaterSea.z * swBlendH * swBlendH;` : ""}`;
  const lowSwell = fromTier(2, "", fromTier(1, skipped(MEDIUM_SWELL_COMPONENTS - 1), skipped(LOW_SWELL_COMPONENTS - 1)));
  const detail = realistic
    ? DETAIL_OCTAVES.map(([, , slope, speed], i) => fromTier(CHOP_TIER[i]!, `
vec4 swOC${i} = U.${CHOP_UNIFORMS[i]};
// The large noise drifts each octave's phase by its own amount, so crossing octaves never lock into a lattice; the
// medium one bends it harder, so its crests curve within a few metres.
float swOX${i} = swOC${i}.z * dot(swOC${i}.xy, swChop) + swOC${i}.w + swLarge * ${f(CHOP_PHASE_DRIFT[i]![0])} + swMedium * ${f(CHOP_PHASE_DRIFT[i]![1] * 1.6)} + swChopShift * ${f(CHOP_SHIFT[i]!)}${chopFm(i)};
float swOW${i} = exp(sin(swOX${i}) - 1.0);
float swOCs${i} = cos(swOX${i});${footprintFade("swOFd", i, `swOC${i}.z`, `swOC${i}.xy`, speed)}
// Anti-tiling: each octave's strength drifts with the shared noises (in patches a few metres wide, the longer octaves
// wider), and the two octaves of each pair drift in opposition, so where one crossing direction dominates the other
// fades: no lattice. Short crests: an oblique envelope (\`CHOP_CREST_TURN\` off the octave's heading, static in the
// chop's domain, so crests grow and fade as they travel through it) breaks every crest into lengths of about one and a
// half wavelengths, so no octave runs in even parallel rows (corduroy).
float swOA${i} = ${f(slope)} * swOFd${i} * (0.25 + 1.5 * ${i % 2 === 0 ? "" : "(1.0 - "}smoothstep(0.3, 0.7, mix(swMedium, swLarge, ${f(0.5 - Math.floor(i / 2) * 0.2)}))${i % 2 === 0 ? "" : ")"})
  * ${chopCrests(`swOC${i}`, i)};
swDetail += swOC${i}.xy * (swOW${i} * swOCs${i} * swOA${i});
swChopH += (swOW${i} - 0.37) * swOA${i};
swChop -= swOC${i}.xy * (swOW${i} * swOCs${i} * 0.3 / swOC${i}.z);
swLostDetail += ${f(octaveVariance(slope))} * (1.0 - swOFd${i} * swOFd${i});${i === REFRACTION_OCTAVES[0] - 1 ? "\nswDetailMid = swDetail;" : ""}`, `
swLostDetail += ${f(octaveVariance(slope))};`)).join("")
    : DETAIL_OCTAVES.slice(0, STYLIZED_CHOP_TIER.length).map(([, , slope], i) => fromTier(STYLIZED_CHOP_TIER[i]!, `
vec4 swOC${i} = U.${CHOP_UNIFORMS[i]};${painted ? `
// As Realistic: each octave's phase drifts across the shared noises and the octaves of a pair fade in opposition, so
// crossing octaves never lock into ribs or a dimple lattice. Painted bends the phase twice as hard across the medium
// noise and fades the pairs across it too (patches a few metres wide), so its chop is short-crested: crests a
// wavelength or two long instead of even rows across the foreground.
float swOX${i} = swOC${i}.z * dot(swOC${i}.xy, swChop) + swOC${i}.w + (swLarge * ${f(CHOP_PHASE_DRIFT[i]![0])} + swMedium * ${f(CHOP_PHASE_DRIFT[i]![1] * 2)}) * swDriftK + swChopShift * ${f(CHOP_SHIFT[i]!)}${chopFm(i)};` : `
// As Realistic's: the shared noises drift each octave's phase and, in opposition between neighbours, its strength, so
// crossing octaves never lock into ribs or a dimple lattice.
float swOX${i} = swOC${i}.z * dot(swOC${i}.xy, swChop) + swOC${i}.w + swLarge * ${f(CHOP_PHASE_DRIFT[i]![0])} + swMedium * ${f(CHOP_PHASE_DRIFT[i]![1])} + swChopShift * ${f(CHOP_SHIFT[i]!)}${chopFm(i)};`}
float swOW${i} = exp(sin(swOX${i}) - 1.0);
float swOCs${i} = cos(swOX${i});
float swOA${i} = ${f(slope * (1 - Math.min(0.85, i * 0.14)))} * (1.0 - smoothstep(0.3, 1.1, swOC${i}.z * swFoot)) * ${painted
    ? `(0.25 + 1.5 * ${i % 2 === 0 ? "" : "(1.0 - "}smoothstep(0.3, 0.7, mix(swMedium, swLarge, 0.35))${i % 2 === 0 ? "" : ")"})`
    : `(0.35 + 1.3 * ${i % 2 === 0 ? "" : "(1.0 - "}smoothstep(0.3, 0.7, mix(swMedium, swLarge, 0.6))${i % 2 === 0 ? "" : ")"})`}
  * ${chopCrests(`swOC${i}`, i)};
swDetail += swOC${i}.xy * (swOW${i} * swOCs${i} * swOA${i});
swChopH += (swOW${i} - 0.37) * swOA${i};
swChop -= swOC${i}.xy * (swOW${i} * swOCs${i} * 0.3 / swOC${i}.z);${i === REFRACTION_OCTAVES[1] - 1 ? "\nswDetailMid = swDetail;" : ""}`)).join("");
  const capillaries = realistic ? CAPILLARY_OCTAVES.map(([, , slope, speed], i) => fromTier(CAPILLARY_TIER[i]!, `
vec4 swCC${i} = U.${CAPILLARY_UNIFORMS[i]};
float swCX${i} = swCC${i}.z * dot(swCC${i}.xy, swRippleDomain) + swCC${i}.w;${footprintFade("swCFd", i, `swCC${i}.z`, `swCC${i}.xy`, speed)}
swDetail += swCC${i}.xy * (exp(sin(swCX${i}) - 1.0) * cos(swCX${i}) * ${f(slope)} * swCFd${i} * swRipplePatch);
swLostDetail += ${f(octaveVariance(slope))} * (1.0 - swCFd${i} * swCFd${i});`, `
swLostDetail += ${f(octaveVariance(slope))};`)).join("") : "";
  return `
vec2 swWorld = swPosW.xz;
float swTime = U.slateWaterMotion.x;
// Blending (\`SLATE_WATER_BLEND\`): this vertex's share of the blended swell height and Gerstner offset relative to the
// body's own constants; 1 (folded away) on water that blends with nothing.
#ifdef ${WATER_BLEND_DEFINE}
float swBlendH = IN.vSlateWaterBlend.x;
float swBlendD = IN.vSlateWaterBlend.y;
#else
float swBlendH = 1.0;
float swBlendD = 1.0;
#endif
// Filtering footprint on the rest plane under this pixel's view ray. Unlike derivatives of the displaced mesh it
// is smooth across triangles, so partly faded octaves never reveal the tessellation.
float swEyeAbove = abs(S.vEyePosition.y - IN.vPositionW.y + IN.vSlateWater.x);
vec2 swRestXZ = viewDirectionW.xz * (swEyeAbove / max(abs(viewDirectionW.y), 0.001));
vec2 swFootX = dFdx(swRestXZ);
vec2 swFootY = dFdy(swRestXZ);
float swFoot = length(swFootX) + length(swFootY);
// Aerial perspective (every look; \`slateWaterHaze\`): the share of the view's light that the air has replaced with the
// horizon's by this distance: an exponential, plus a ramp that makes the last stretch before the far plane fully hazed,
// so no look ever ends in an edge. Scene fog takes precedence: the exponential only acts on what fog leaves (the ramp
// stays, its horizon colour being the fog's). Orthographic views have no eye distance to haze by.
float swEyeDist = length(S.vEyePosition.xyz - IN.vPositionW);
#ifdef FOG
float swAirKeep = max(toLinearSpace(CalcFogFactor()), 0.0);
#else
float swAirKeep = 1.0;
#endif
float swAirOn = 1.0 - S.projection[3][3];
float swAir = 1.0 - (1.0 - (1.0 - exp(-swEyeDist * U.slateWaterHaze.x)) * swAirKeep * swAirOn) * (1.0 - smoothstep(U.slateWaterHaze.y, U.slateWaterHaze.z, swEyeDist) * swAirOn);
vec2 swFlowed = swWorld - IN.vSlateWaterFlow.xy * swTime;
// Rest (Lagrangian) point of this fragment relative to the floating origin: the interpolated Gerstner offset is
// exact for the displaced triangle, since the mesh adds it to a planar rest grid.
vec2 swRest = IN.vPositionW.xz - IN.vSlateWaterFlow.zw;
float swHeight = 0.0;
vec2 swGradient = vec2(0.0);
// Crest sharpness a*k*(-P''): positive and largest on steep, sharp crests.
float swFold = 0.0;
// Sum of k*a over every component (CPU), and the resolved share this fragment evaluates.
float swSteep = U.slateWaterSea.x * swBlendH;
// How steep the sea is, for thresholds (CPU, \`SEA_STATE_RMS\`); swSteep stays the sum that resolved slope is measured against.
float swSeaState = U.slateWaterSwellInfo.w * swBlendH;
float swResolved = 0.0;${realistic ? `
float swLost = 0.0;
float swLostDetail = 0.0;` : painted ? `
float swPrimLen = U.slateWaterWaves.y * 0.159155;
float swPrimH = 0.0;
vec2 swPrimG = vec2(0.0);
float swPrimAmp = 0.0;` : ""}
float swChopShape = U.slateWaterShape.x;
// Unfaded Gerstner offset and S = sum(q*a*k*sin(p) * d d^T) (xx, xz, zz) at the warped rest point, filtered like the swell.
vec2 swOffset = vec2(0.0);
vec3 swShear = vec3(0.0);
// The shared kernel's warp: every component is evaluated at u = rest + W(rest), and rest-space derivatives carry
// M = I + dW/drest (swSwellWarpM, symmetric): grad H = M grad_u H, grad D = grad_u D M.${swellWarpSource("swSwell", "swRest", true)}
vec2 swRestW = swRest + swSwellWarp;
${swell}${lowSwell}
swGradient = vec2(dot(swSwellWarpM.xy, swGradient), dot(swSwellWarpM.yz, swGradient));${painted ? `
swPrimG = vec2(dot(swSwellWarpM.xy, swPrimG), dot(swSwellWarpM.yz, swPrimG));
// The primary swell's height scale: its components' root-sum-square, not their sum, so a crest reads as tall whether one
// component carries the swell or several share it (${f(PRIMARY_RMS)} keeps a single dominant train's scale).
swPrimAmp = ${f(PRIMARY_RMS)} * sqrt(swPrimAmp);` : ""}
vec3 swBaseNormal = normalize(IN.vSlateWaterBaseNormal);
float swBaseX = swBaseNormal.x / max(0.001, swBaseNormal.y);
float swBaseZ = swBaseNormal.z / max(0.001, swBaseNormal.y);
// Finite bodies fade the horizontal offset to zero at their banks (\`waterBankGain\`), from the interpolated bank
// distance; its rest-space gradient comes from screen derivatives and is a unit vector for a distance field.
float swFadeLength = max(U.slateWaterSwellInfo.x * swBlendD, 0.000001);
float swFadeOn = step(0.000001, U.slateWaterSwellInfo.x * swBlendD);
float swBankT = clamp(IN.vSlateWater.y / swFadeLength, 0.0, 1.0);
float swGain = mix(1.0, swBankT * swBankT * (3.0 - 2.0 * swBankT), swFadeOn);
vec2 swRestDx = dFdx(swRest);
vec2 swRestDy = dFdy(swRest);
float swBankDx = dFdx(IN.vSlateWater.y);
float swBankDy = dFdy(IN.vSlateWater.y);
vec2 swBankGrad = vec2(swBankDx * swRestDy.y - swBankDy * swRestDx.y, swRestDx.x * swBankDy - swRestDy.x * swBankDx);
vec2 swGainGrad = swBankGrad / max(length(swBankGrad), 0.000001) * (6.0 * swBankT * (1.0 - swBankT) / swFadeLength * swFadeOn);
// J = I + gain * grad(D) + D grad(gain)^T with grad(D) = -S M. The swell's Eulerian slope is J^-T (rest slope + grad H);
// det J < 1 where water gathers.
float swJxx = 1.0 - swGain * (swShear.x * swSwellWarpM.x + swShear.y * swSwellWarpM.y) + swOffset.x * swGainGrad.x;
float swJxz = swOffset.x * swGainGrad.y - swGain * (swShear.x * swSwellWarpM.y + swShear.y * swSwellWarpM.z);
float swJzx = swOffset.y * swGainGrad.x - swGain * (swShear.y * swSwellWarpM.x + swShear.z * swSwellWarpM.y);
float swJzz = 1.0 - swGain * (swShear.y * swSwellWarpM.y + swShear.z * swSwellWarpM.z) + swOffset.y * swGainGrad.y;
float swDetJ = swJxx * swJzz - swJxz * swJzx;
vec2 swRestSlope = swGradient - vec2(swBaseX, swBaseZ);
swGradient = vec2(swBaseX, swBaseZ) + vec2(swJzz * swRestSlope.x - swJzx * swRestSlope.y, swJxx * swRestSlope.y - swJxz * swRestSlope.x) / max(swDetJ, ${f(WATER_JACOBIAN_FLOOR / 2)});
// Shared noises: Low evaluates two and derives the rest; Medium four; High and Ultra add the contact ripple noise.
// Their value-noise lattices are turned to different fixed angles, so no two share the world axes: their cell grids
// never line up into rectangles or a common grid across the sea.
vec2 swFlowedR = vec2(dot(swFlowed, vec2(0.958244, -0.285952)), dot(swFlowed, vec2(0.285952, 0.958244)));
vec2 swWorldL = vec2(dot(swWorld, vec2(0.862807, -0.505533)), dot(swWorld, vec2(0.505533, 0.862807)));
float swMedium = swNoise(swFlowedR * 0.43 + vec2(swTime * 0.03, 0.0));${realistic ? `
float swLarge = swNoise(swWorldL * ${f(LARGE_NOISE)});` : `
// Stylized posterises its colour drifts, where a value noise's cell grid would show as soft-edged rectangles: the
// medium noise bends the large one's domain (by up to about a third of a cell), so the drifts curve instead. The bend
// fades where the medium noise would alias, so distant drifts never speckle.
float swLarge = swNoise(swWorldL * ${f(LARGE_NOISE)} + vec2(swMedium - 0.5, 0.5 - swMedium) * (0.7 * (1.0 - smoothstep(0.6, 1.6, swFoot))));`}${fromTier(1, `
float swFine = swNoise(swFlowed * 2.9 - vec2(0.0, swTime * 0.09));
// Gusts roughen or calm wide patches.
float swGust = swNoise(vec2(dot(swWorld, vec2(0.479426, 0.877583)), dot(swWorld, vec2(-0.877583, 0.479426))) * ${f(GUST_NOISE)} + vec2(swTime * 0.004, 0.0));`, `
float swFine = swMedium;
float swGust = swLarge;`)}${fftFragmentSource()}
// Anti-tiling: a bounded warp bends the chop domain, so crests curve and cross differently across the sea. (A rotation
// about the world origin would compress the chop without limit far from it.) Each component's amplitude suits its
// noise's frequency, so the warp never stretches the chop much; Low's gust is its large noise, so that one shrinks.${fromTier(1, `
vec2 swChop = swFlowed + vec2(swLarge - 0.5, swGust - 0.5) * vec2(2.4, 9.0);`, `
vec2 swChop = swFlowed + vec2(swLarge - 0.5, swGust - 0.5) * vec2(2.4, ${f(9 * GUST_NOISE / LARGE_NOISE)});`)}
// Colour Variation's drifts: the two wide noises mixed, with edges bent by the medium one. Either wide noise alone shows
// its cell grid as soft-edged rectangles (the gust's cells are about 77 m); mixed with each other and the medium noise
// (six times finer than the large one) their edges curve and their cells no longer line up.
float swDrift = swLarge * 0.5 + swGust * 0.3 + swMedium * 0.2;${realistic || painted ? fromTier(1, `
// Bend it at a finer scale too, so crossing octaves never settle into a regular quilt in the sun's reflection; the
// fine part fades before its noise would alias.
swChop += vec2(swMedium - 0.5, (swFine - 0.5) * (1.0 - smoothstep(0.3, 1.0, swFoot))${realistic ? "" : " * 0.35"}) * 0.6;`) : ""}
vec2 swDetail = vec2(0.0);
// The chop octaves refraction bends by (\`REFRACTION_OCTAVES\`): the medium-frequency part of \`swDetail\`, kept apart from the fine
// octaves, whose high-frequency wobble would make the bed under the water shimmer like jelly.
vec2 swDetailMid = vec2(0.0);
float swChopH = 0.0;
// The chop's slow phase shift (\`CHOP_SHIFT\`): a rotating mix of the two wide noises.
float swChopShift = U.slateWaterChopShift.x * (swLarge - 0.5) + U.slateWaterChopShift.y * (swGust - 0.5);${painted ? fromTier(1, `
float swDriftK = 1.0;`, `
// Low's single octave would bend into swirls under the full drift.
float swDriftK = 0.5;`) : ""}
${detail}${fromTier(1, "", `
swDetailMid = swDetail;`)}${realistic ? fromTier(1, `
// Capillaries ride a noise-bent domain and gather in drifting patches, so they never form a regular lattice.
vec2 swRippleDomain = swChop + (vec2(swFine, swMedium) - vec2(0.5)) * 0.45;${fromTier(3, `
float swRipplePatch = (0.6 + 0.8 * swMedium) * (0.55 + 0.9 * swFine);`, `
float swRipplePatch = 0.6 + 0.8 * swMedium;`)}`) : ""}${capillaries}
// What meets the water: terrain shoreline and true depth, and objects crossing the surface.
// Values stay continuous at the field's edges and range limits, so derivative-based antialiasing never spikes.
float swFieldShore = mix(${f(SHORE[1])}, swTerrainShore, swFieldOn);
float swKnown = swField.a * swFieldOn;
// Distance to the object waterline at this fragment's rendered height (metres; contacts sampled in the cut code).
float swObject = abs(swContactSigned);
// Open-water edges: where a terrain field is bound but holds no terrain under this point, the mesh's own bank is no
// shore (an ocean's outer edge, a lake reaching past a landscape's border). It neither foams nor swashes there, and the
// water fades out over \`OPEN_EDGE_FADE\` metres instead (\`swOpenFade\`, applied to the final coverage). Without any
// terrain field the bank stays the shore, as for a body that only meets meshes.
float swOpenEdge = U.slateWaterFieldInfo.x * (1.0 - smoothstep(0.0, 0.1, swField.a * swFieldOn));${style === "toon" ? `
float swOpenAny = swOpenEdge;
float swOpenW = ${f(OPEN_EDGE_FADE)};` : `
// The same where the body ends over water-covered terrain, its bank metres short of the terrain's own shoreline (a
// lake drawn smaller than its basin): no shore there either, and the water thins out over \`OPEN_EDGE_FADE_TERRAIN\`
// metres instead of standing as a cut sheet above the bed. Toon keeps its rim there (its banks are drawn lines).
float swOpenAny = max(swOpenEdge, swKnown * smoothstep(0.5, 2.5, swFieldShore - max(0.0, IN.vSlateWater.y)));
float swOpenW = mix(${f(OPEN_EDGE_FADE_TERRAIN)}, ${f(OPEN_EDGE_FADE)}, swOpenEdge);`}
float swBankV = mix(IN.vSlateWater.y, max(IN.vSlateWater.y, ${f(SHORE[1])}), swOpenAny);
float swOpenFade = mix(1.0, smoothstep(0.0, swOpenW, IN.vSlateWater.y), swOpenAny);
// Soft waterline (every look but Toon, whose banks are drawn lines): over known terrain the water thins to nothing over its
// last \`SOFT_SHORE_DEPTH\` metres of depth instead of ending in a cut, and over a few centimetres where the bed drops away fast
// (a wall, a cliff: the terrain slope \`swShoreSlope\` near 1), so it stays crisp there.
float swShoreSoft = mix(1.0, smoothstep(0.0, mix(${f(SOFT_SHORE_DEPTH)}, 0.06, smoothstep(0.35, 1.0, swShoreSlope)), swTerrainDepth), swKnown);
float swBank = min(min(max(0.0, swBankV), max(0.0, swFieldShore)), ${f(SHORE[1])});
float swBodyDepth = max(0.01, IN.vSlateWater.z);
float swFoamWidth = max(0.001, U.slateWaterMotion.w);
float swCalm = smoothstep(0.0, swFoamWidth * 2.0 + 0.5, swBank);
// Shore swash and surf (render only, every look, ALU; \`waterSwashConstants\` on the CPU). One swash cycle per two waves of
// the steepest swell slot (\`SWASH_RATE\`): shifted along the shore by half of that slower spatial phase (so it rolls along a coast as
// the swell's crests do) and by the large noise, and counted (\`slateWaterSwash.y\`) so each wave keeps its own reach as
// the clock wraps. Each wave's reach varies by a hash of its count and by the slot's wave group here (sets of larger
// waves). A bore rushes up quickly (the first 30% of the cycle) and drains back slowly. Over known terrain the backwash
// uncovers the shallows down to D (\`slateWaterSwash.w\`) of water, at most 6 m from the waterline: the water there
// gives way (\`swSwashCover\`) to a wet film that dries over about a cycle (\`swSwashWet\`, time since the edge passed),
// the bore's front carries foam that thins as it drains, and its furthest reach leaves a stranded line. Bores
// (\`swBorePhase\`, cycles behind the nearest bore front) travel shoreward through the surf at κ (\`slateWaterSwash.z\`)
// and arrive as the next run-up. Open water (beyond the surf) skips all of it.
float swShoreRest = max(0.0, min(max(0.0, swBankV), mix(${f(SHORE[1])}, mix(${f(SHORE[0])}, ${f(SHORE[1])}, swField.r), swKnown)));
// Rest depth for breaking: the terrain's where known, else a shelving bank's estimate.
float swBreakDepth = mix(swBodyDepth * (1.0 - exp(-swShoreRest * 0.3 / swBodyDepth)), max(0.0, swTerrainDepth - IN.vSlateWater.x), swKnown);
float swSwashZone = swKnown * step(0.000001, U.slateWaterSwash.w);
float swSwashX = min(U.slateWaterSwash.w / max(swShoreSlope, 0.02), ${f(SWASH_REACH_MAX)});
float swSurfW = clamp(swSwashX * 2.5 + swFoamWidth * 4.0, 2.0, 22.0);
float swShoreHere = max(swFieldShore, 0.0);
float swSwashCover = 1.0;
float swSwashWet = 0.0;
float swSwashFoam = 0.0;
float swSwashRun = 0.0;
float swSwashBack = 0.0;
// Signed distance from the swash edge toward open water (metres; far positive off terrain), for hard-edged looks.
float swSwashEdgeS = 1000.0;
float swBore = 0.0;
float swBorePhase = 0.5;
float swBoreOn = 0.0;
if (U.slateWaterSwash.w > 0.0 && swShoreRest < swSurfW && (swSwashZone > 0.0 || U.slateWaterWaves.x > 0.35 * swBreakDepth)) {
  float swPsi = (U.slateWaterSwash.x - ${f(SWASH_SPATIAL * SWASH_RATE)} * swK0 * dot(swD0, swRest)) * 0.159155 + swLarge * 0.6;
  float swCyc = floor(swPsi);
  float swSwU = swPsi - swCyc;
  float swCycN = swCyc + U.slateWaterSwash.y;
  swCycN -= ${f(SWASH_COUNT_PERIOD)} * floor(swCycN / ${f(SWASH_COUNT_PERIOD)});
  float swSet = clamp(0.55 + 0.45 * swG0, 0.5, 1.15);
  float swReach = min((0.5 + 0.5 * swHash(vec2(swCycN, 41.0))) * swSet, 1.0);
  float swRunUp = clamp(swSwU / 0.3, 0.0, 1.0);
  float swDn = clamp((swSwU - 0.3) / 0.7, 0.0, 1.0);
  swSwashBack = step(0.3, swSwU);
  swSwashRun = mix(1.0 - (1.0 - swRunUp) * (1.0 - swRunUp), 1.0 - swDn * sqrt(swDn), swSwashBack) * swReach;
  float swEdgeX = swSwashX * (1.0 - swSwashRun);
  float swAAX = swFoot * 0.7 + 0.02;
  // The water thins to nothing over the last eighth of the excursion toward the edge (a thin sheet, not a cut).
  swSwashCover = mix(1.0, smoothstep(swEdgeX - 2.0 * swAAX, swEdgeX + swSwashX * 0.22, swShoreHere), swSwashZone);
  swSwashEdgeS = mix(1000.0, swShoreHere - swEdgeX, swSwashZone);
  // The bore's foamy front on the water side of the edge, thinning as it drains.
  float swFrontW = swSwashX * 0.26 + swFoamWidth * 0.3 + swAAX;
  float swFrontS = swShoreHere - swEdgeX;
  float swFront = smoothstep(-swAAX, swAAX * 0.5, swFrontS) * (1.0 - smoothstep(swFrontW * 0.25, swFrontW, swFrontS)) * mix(1.0, exp(-swDn * 3.0), swSwashBack) * (0.6 + 0.4 * swReach);${fromTier(1, `
  // Its furthest reach leaves a stranded line that fades as the water drains.
  float swStrandW = swFoamWidth * 0.12 + swAAX;
  float swStrand = (1.0 - smoothstep(swStrandW * 0.4, swStrandW, abs(swShoreHere - swSwashX * (1.0 - swReach)))) * swSwashBack * exp(-swDn * 2.0) * 0.8;
  swSwashFoam = max(swFront, swStrand) * swSwashZone;
  // Wet film: time since the backwash uncovered this point (this cycle's, else the last cycle's), so the wet band lags
  // the swash and dries where only the larger waves reach.
  float swNeed = 1.0 - swShoreHere / max(swSwashX, 0.001);
  float swCycP = swCycN - 1.0;
  swCycP += ${f(SWASH_COUNT_PERIOD)} * step(swCycP, -0.5);
  float swReachP = min((0.5 + 0.5 * swHash(vec2(swCycP, 41.0))) * swSet, 1.0);
  float swNeedC = swNeed / max(swReach, 0.01);
  float swNeedP = swNeed / max(swReachP, 0.01);
  float swPassC = 0.3 + 0.7 * pow(max(1.0 - swNeedC, 0.000001), 0.6667);
  float swPassP = 0.3 + 0.7 * pow(max(1.0 - swNeedP, 0.000001), 0.6667);
  float swSince = mix(swSwU + 1.0 - swPassP + step(1.0, swNeedP) * 3.0, swSwU - swPassC, step(swNeedC, 1.0) * step(swPassC, swSwU));
  swSwashWet = exp(-swSince * 1.4) * step(0.0, swNeed) * swSwashZone;
  // Bores: cycles behind the nearest front travelling shoreward through the surf, each as strong as the run-up it brings.
  float swPsiB = swPsi + U.slateWaterSwash.z * swShoreRest * 0.159155;
  float swBoreC = floor(swPsiB);
  swBorePhase = swPsiB - swBoreC;
  float swBoreN = swBoreC + U.slateWaterSwash.y;
  swBoreN -= ${f(SWASH_COUNT_PERIOD)} * floor(swBoreN / ${f(SWASH_COUNT_PERIOD)});
  float swBoreSpan = 6.283185 / max(U.slateWaterSwash.z, 0.001);
  // Bores break only where the water is shallow for the swell (rest depth under about two and a half Wave Heights, as
  // the surf's own criterion), so calm lakes and steep banks get no rings of foam standing off the shore, and wide
  // patches of the coast (the medium noise) see none, so a bore never reads as one continuous ring. Coasts facing the
  // steepest slot's travel take the full bores; lee coasts, which the swell reaches only by wrapping round, a quarter:
  // the fronts arrive from the windward side instead of ringing an island evenly.
  swBoreOn = (0.35 + 0.65 * swHash(vec2(swBoreN, 41.0))) * swSet * smoothstep(swSwashX * 0.5, swSwashX + swFoamWidth, swShoreRest)
    * (1.0 - smoothstep(swSurfW * 0.5, swSurfW, swShoreRest))
    * smoothstep(0.35, 0.8, U.slateWaterWaves.x / max(swBreakDepth, 0.02)) * (0.2 + 0.8 * smoothstep(0.3, 0.6, swMedium))
    * (0.25 + 0.75 * smoothstep(0.5, -0.5, dot(swShoreNormal, swD0)));
  // A foam band about a Foam Width behind each front (metres: bores are tens of metres apart for long swell).
  swBore = max(1.0 - smoothstep(0.0, swFoamWidth * 1.2 + 0.3, swBorePhase * swBoreSpan), 1.0 - smoothstep(0.0, swFoot * 1.5 + 0.02, (1.0 - swBorePhase) * swBoreSpan)) * swBoreOn;`, `
  // Low: the front alone, and a film that dries through the backwash.
  swSwashFoam = swFront * swSwashZone * 0.75;
  swSwashWet = (1.0 - swSwashCover) * (0.3 + 0.5 * (1.0 - swDn));`)}
}
// Surf zone (every look, ALU; \`swSurfGate\` is 0 in open water, on calm water and past a landscape's edge, which skip it): the
// waves break where the water is under about two Wave Heights deep (so a gentle beach breaks over a wide band, a steep one
// over a narrow one), and the breaking is the swell's own. White water stands on each crest of the steepest slot's phase
// (\`swBrkG\`: cycles from the crest, ahead positive) and trails seaward behind it, patchy along the crest (a noise per wave),
// so foam patches advance shoreward with the crests; between them long streaks, stretched along the seaward direction (the
// terrain's gradient where measured, else the bank's), trail out from the swash and drift slowly back to sea. \`swSurfBreak\` is
// the density (0-1) every look's foam composite takes; Toon thresholds it into its hard-edged shapes.
float swSurfGate = (1.0 - smoothstep(${f(SURF_DEPTH[0])} * U.slateWaterWaves.x, ${f(SURF_DEPTH[1])} * U.slateWaterWaves.x, swBreakDepth)) * smoothstep(0.02, 0.1, U.slateWaterWaves.x)
  * (1.0 - swOpenAny) * smoothstep(0.0, swSwashX * 0.5 + 0.5, swShoreRest);
float swSurfBreak = 0.0;
float swBrkG = 0.0;
if (swSurfGate > 0.0) {
  vec2 swBrkBank = swBankGrad / max(length(swBankGrad), 0.000001);
  vec2 swBrkN = mix(swBrkBank, swShoreNormal / max(length(swShoreNormal), 0.0001), step(0.5, length(swShoreNormal)));
  float swBrkA = dot(swWorld, vec2(-swBrkN.y, swBrkN.x));
  float swBrkB = dot(swWorld, swBrkN);
  float swBrkQ = (swP0 - 1.570796) * 0.159155;
  swBrkG = fract(swBrkQ + 0.5) - 0.5;
  float swBrkWake = mix(exp(swBrkG * ${f(SURF_WAKE)}) * smoothstep(-0.5, -0.3, swBrkG), 1.0 - smoothstep(0.0, 0.07, swBrkG), step(0.0, swBrkG));${fromTier(1, `
  float swBrkPatch = swNoise(vec2(swBrkA * 0.4 + 11.0 * floor(swBrkQ + 0.5), 3.7));
  float swBrkStreak = swNoise(vec2(swBrkA * 0.55 + swMedium * 1.5, swBrkB * 0.08 - swTime * 0.015) + vec2(5.3, 1.7));`, `
  float swBrkPatch = swMedium;
  float swBrkStreak = swLarge;`)}
  float swBrkTrail = smoothstep(0.4, 0.75, swBrkStreak) * exp(-max(swShoreRest - swSwashX * 0.5, 0.0) / (6.0 + swFoamWidth * 3.0));
  swSurfBreak = swSurfGate * clamp(swBrkWake * (0.4 + 0.9 * swBrkPatch) * 1.2 + swBrkTrail * 0.7 + 0.16, 0.0, 1.0);
}
// Small waves around objects that cut the surface: they travel outward at the deep-water speed of their
// wavelength (wavenumber and clock phase from the CPU), fade with distance, and a drifting noise bends and breaks
// them so they never read as perfect rings.
float swContactW = max(0.05, U.slateWaterShape.w);
float swOutside = max(swContactSigned, 0.0);${fromTier(1, `
float swRippleNoise = swNoise(swWorld * 1.3 + vec2(swTime * 0.13, swTime * -0.07));`, `
float swRippleNoise = swMedium;`)}
float swRipplePhase = U.slateWaterRipple.x * swOutside + U.slateWaterRipple.y + swRippleNoise * 2.6;
float swRippleAA = 1.0 - smoothstep(0.6, 1.8, fwidth(swRipplePhase));
// Distances clamp at the contact range: fade out before it, so open water carries no ripple residue.
float swNearContact = 1.0 - smoothstep(0.55, 0.95, swObject / max(0.001, U.slateWaterContactInfo.y));
// Downstream: along the current where the water flows, otherwise downwind.
vec2 swFlowV = IN.vSlateWaterFlow.xy;
float swFlowSpeed = length(swFlowV);
vec2 swWakeDir = mix(U.slateWaterRipple.zw, swFlowV / max(swFlowSpeed, 0.0001), smoothstep(0.05, 0.4, swFlowSpeed));
swWakeDir = swWakeDir / max(length(swWakeDir), 0.0001);
// Contacts follow the swell at the hull (every look, ALU; open water skips it). The steepest slot's phase at the nearest
// hull point (this fragment's, carried back along the contact direction) times the water's rise and fall there:
// \`swHullPulse\` grows from the trough as the water climbs the hull, peaks with the crest and decays as it drops (foam
// that clings briefly, \`swHullCling\`), scaled by how far the swell moves at the hull (\`swHullAmt\`; a calm surface
// keeps a steady collar). \`swRingEnv\` sends one burst of ripples outward per rise, at the ripples' group speed
// (\`slateWaterContactInfo.w\` = ω over it), and \`swLeePuff\` sheds foam downstream in puffs that drift with the wake.
float swHullPulse = 0.55;
float swHullCling = 0.0;
float swHullAmt = 0.0;
float swRingEnv = 1.0;
float swLeePuff = 0.5;
float swHullV = 0.0;
if (swNearContact > 0.0) {
  float swHullQ = swK0 * swOutside * dot(swD0, swContactDir) - swP0;
  swHullV = fract((swHullQ - 1.570796) * 0.159155);
  swHullCling = smoothstep(0.5, 0.56, swHullV) * exp(-max(swHullV - 0.5, 0.0) * 4.5) * (1.0 - smoothstep(0.9, 1.0, swHullV));
  swHullAmt = clamp(swA0 * swG0 * 10.0, 0.0, 1.0);
  swHullPulse = mix(0.55, smoothstep(0.05, 0.5, swHullV) * (1.0 - smoothstep(0.5, 0.56, swHullV)) + swHullCling, swHullAmt);
  float swRingC = 0.5 + 0.5 * cos(swHullQ - U.slateWaterContactInfo.w * swOutside - 1.9);
  swRingEnv = mix(1.0, 0.2 + 1.3 * swRingC * swRingC * swRingC, swHullAmt);
  swLeePuff = smoothstep(0.25, 0.85, 0.5 + 0.5 * cos(swHullQ - U.slateWaterContactInfo.w * 1.4 * swOutside)) * smoothstep(-0.1, 0.7, dot(swContactDir, swWakeDir));
}
float swRippleFade = exp(-swOutside / (swContactW * 1.4)) * smoothstep(-0.05, 0.08, swContactSigned) * swRippleAA * swNearContact * swRingEnv;${fromTier(1, `
float swAgitate = exp(-swObject / swContactW) * swRippleAA * swNearContact;`, `
float swAgitate = 0.0;`)}
vec2 swRipple = swContactDir * (cos(swRipplePhase) * swRippleFade * (0.1 + 0.3 * U.slateWaterMotion.z) * (0.45 + 0.55 * swRippleNoise));
// Rougher seas carry steeper chop (CPU factor in slateWaterTerms.w).
float swChopGain = U.slateWaterMotion.z * (0.35 + 0.65 * swCalm + swAgitate) * ${realistic ? "(0.7 + 0.6 * swGust) * U.slateWaterTerms.w" : "(0.5 + swGust)"};
vec2 swSlope = swGradient + swDetail * swChopGain + swRipple;${ifFft(`
swSlope += swFftSlope;`)}
normalW = normalize(vec3(swBaseX - swSlope.x, 1.0, swBaseZ - swSlope.y));
// The swell alone, without chop: the large-scale wave shape used for lighting through crests.
vec3 swSwellNormal = normalize(vec3(swBaseX - swGradient.x, 1.0, swBaseZ - swGradient.y));

// Bottom estimate: a shelving bank with an irregular floor, capped by the component Depth.
float swShelf = 0.28 + 0.35 * swLarge;
float swDepth = mix(swBodyDepth * (1.0 - exp(-swBank * swShelf / swBodyDepth)), max(0.0, swTerrainDepth), swKnown);${realistic ? `
// The terrain field's own depth, before refraction bounds it by the scene copy.
float swFieldDepth = swDepth;` : `
// The bed under this point, before refraction bounds it by whatever lies nearer.
float swBedDepth = swDepth;`}${refractionSource(realistic ? 0.55 : 1)}${realistic ? ifDefined(REFRACTION, `
// Over known terrain the field's depth is smooth and exact, while the copy's nearest-texel depth steps from texel to
// texel around it (stair-stepped blocks in the shallows' colour, caustics and surf): the field's stands unless the copy
// shows something clearly nearer than the bed (a rock or an object under the surface), and always in the thinnest water.
swDepth = mix(swDepth, swFieldDepth, swKnown * max(1.0 - smoothstep(0.5, 1.5, swFieldDepth), 1.0 - smoothstep(0.25, 0.6, (swFieldDepth - swDepth) / max(swFieldDepth, 0.3))));`) : ""}
float swAbsorb = max(0.01, U.slateWaterLook.y);
float swTone = 1.0 - exp(-swDepth * 2.0 / swAbsorb);
float swCrest = swHeight / max(0.001, U.slateWaterWaves.x);
// Crest sharpness relative to what the waves can reach (CPU denominator), gated by how steep the sea is (long gentle
// swell and small lake waves never break) and by how much of the swell is still resolved, so distant filtered swell
// never breaks in regular rows.
float swFoldN = swFold / U.slateWaterSea.y;
// Jacobian foam: on steep seas, Gerstner crests that gather water (det J below 1) break like sharp crests. Steepness
// normalizes det J to the sea, so the sea's own slope gates it: small lake waves never foam on every crest.
swFoldN = mix(swFoldN, max(swFoldN, (1.0 - swDetJ) / ${f(1 - WATER_JACOBIAN_FLOOR)} * smoothstep(0.2, 0.5, swSeaState)), U.slateWaterSwellInfo.y);
float swRough = smoothstep(0.08, 0.5, swSeaState) * smoothstep(0.5, 0.9, swResolved / max(0.0001, swSteep));
vec2 swWindDir = U.slateWaterRipple.zw;

vec3 swL = U.slateWaterSun.xyz;
vec3 swSun = U.slateWaterSunColor.rgb * U.slateWaterSun.w;
vec3 swAmb = U.slateWaterLight.rgb;
float swFoamAmount = U.slateWaterFoam.w;
// Contact foam keeps its own strength: a low Foam Amount calms shores and crests but still marks every
// waterline on objects; only a Foam Amount near zero (or Contact Foam Width 0) removes it (CPU, slateWaterTerms.x).
float swContactStrength = U.slateWaterTerms.x;
${realistic ? ifDefined(WATER_FEATURE_DEFINES.sparkles, fromTier(1, `
// Sun glints on a jittered world grid; they twinkle and fade before they would alias.
vec2 swSparkUv = swFlowed * 0.9 * U.slateWaterMotion.y;
vec2 swCellId = floor(swSparkUv);
float swRnd = swHash(swCellId);
vec2 swJitter = vec2(swHash(swCellId + vec2(17.0, 3.0)), swHash(swCellId + vec2(5.0, 29.0))) - vec2(0.5);
vec2 swDelta = fract(swSparkUv) - vec2(0.5) - swJitter * 0.6;
float swTwinkle = pow(max(0.0, sin(swTime * (2.0 + swRnd * 3.0) + swRnd * 40.0)), 10.0);
float swCore = max(0.0, 1.0 - length(swDelta) * 7.0);
float swSparkBase = swCore * swCore * swTwinkle * smoothstep(0.4, 0.5, swRnd) * (1.0 - smoothstep(0.1, 0.35, swFoot * 0.9 * U.slateWaterMotion.y)) * U.slateWaterLook.z * min(1.0, U.slateWaterSun.w);`, `
float swSparkBase = 0.0;`), `
float swSparkBase = 0.0;`) : ""}
`;
}

/**
 * Realistic ("open ocean"): lit PBR (unlit at Low, see `configureWaterMaterial`). Everything here is premultiplied by
 * coverage; `CUSTOM_FRAGMENT_BEFORE_FOG` divides by alpha so standard blending yields reflection + specular + (1 - F) *
 * (T * background + (1 - T) * in-scattered light).
 *
 * - Value structure: the body is Deep Color lit by the sky and by the sun entering the water, darker in troughs. The
 *   reflection carries the Schlick Fresnel of the facet itself (the lifted reflection ray below only steers the sky
 *   lookup), so faces turned to the eye show the dark body, faces turned away and the far sea mirror the bright horizon
 *   sky, and distance haze takes the far sea to a pure reflection of the horizon.
 * - Colour: water absorbs red first (per channel from Shallow Color, Medium up), so what shows through takes the
 *   water's hue with depth; Shallow Color only tints the body over shallows and under foam.
 * - Crests: thin crest tops glow green-teal with sunlight through them (Subsurface: a translucency lobe toward the sun,
 *   the sun's colour after the water's absorption), outside the Fresnel weighting, and every crest glows a little with
 *   skylight, so crests separate from the troughs under any sky.
 * - Roughness: detail a pixel cannot resolve roughens it (the filtered slope variance plus centimetre wind ripples, under
 *   a sea-state cap), so reflections of cloud edges stay soft and blur further with distance.
 * - Sky: without an environment or skybox the reflection is an analytic sky from the scene (`slateWaterSky`): mostly its
 *   hemispheric light's colour, its fog colour (or background) at the horizon, warmed by a low sun, with a sun aureole,
 *   blurred by the filtered roughness.
 * - Sun: Babylon's GGX lobe, log-compressed where bright; close by, facet glints on the resolved ripple faces; far away
 *   the lobe is broken into glints on world cells sized to the pixel footprint (a few pixels across, about one down), so
 *   perspective stretches far glints into horizontal dashes. Low: one smooth lobe stretched along the view.
 * - Foam: one density field (shore swash, depth-limited surf, caps on high sharp swell crests of a steep enough sea and
 *   the wind-streaked residue they leave, straight wind lines) thresholds a bubble web: foam is white, fresh foam dense,
 *   older foam thins into translucent lace with milky aerated water under it.
 * - Contacts: a narrow churned collar at each object's waterline that opens into lace and stretches downstream (the
 *   current, or downwind), and from High a trailing wake read from two upstream contact-field taps.
 * - Shallows: refracting water draws caustics on the bed, and keeps the terrain field's smooth depth at the waterline.
 * - Shores: the shared swash (`surfaceSource`): bores roll in through the surf and run up the beach with a foamy front
 *   that drains back, leaving a stranded line and uncovered shallows under a drying wet film; crests break where the
 *   water is shallow for its waves, and the thinnest water darkens the bed under it (a wet band, from the water alone).
 * - Contacts pulse with the swell at the hull (`swHullPulse`), cling briefly as the water drops, send ripples out in
 *   bursts and shed puffs downstream.
 */
function realisticSource(): string {
  const crestFoam = WATER_FEATURE_DEFINES.crestFoam, surfaceFoam = WATER_FEATURE_DEFINES.surfaceFoam;
  return surfaceSource("realistic") + `
vec3 swV = viewDirectionW;
// The chop normal before the horizon treatment: in-scatter, the crest glow and the glitter see the actual facets.
vec3 swWaveN = normalW;
float swGraze = 1.0 - clamp(swV.y, 0.0, 1.0);
float swGraze2 = swGraze * swGraze;
float swGraze4 = swGraze2 * swGraze2;
float swGraze8 = swGraze4 * swGraze4;
// Pixel footprint on the water (metres).${fromTier(1, `
float swPxM = sqrt(length(swFootX) * length(swFootY));`, `
float swPxM = swFoot * 0.5;`)}
// Far away a pixel averages many facets, and the chop, capillaries and FFT band are filtered away by their own footprint
// fades: the swell is not, so mid-distance water keeps its slope (banding and shading under the sun) and only a part
// (\`swFar\`, a third of the way to the mean surface: half the swell, toward level) is averaged, which softens ruler-straight
// bands; the slope it averages away roughens it. Toward the horizon the chop flattens into the swell as well. Hazed water
// is level (see \`swHaze\`): its mirror is the horizon band itself.
float swFar = smoothstep(0.1, 1.5, swPxM);
vec3 swMeanN = normalize(swSwellNormal + vec3(0.0, 1.0, 0.0));
float swHaze = 1.0 - (1.0 - swAir * smoothstep(0.3, 0.85, swGraze)) * (1.0 - 0.85 * smoothstep(0.98, 0.9985, swGraze));
normalW = normalize(mix(mix(normalW, swSwellNormal, swGraze8 * swGraze4 * 0.6), swMeanN, swFar * 0.45));
normalW = normalize(mix(normalW, swBaseNormal, swHaze * swHaze));
// Fresnel sees this facet normal; the shading normal below only steers the reflected sky lookup.
vec3 swFresN = normalW;
// Detail filtered away at a distance still roughens the surface, bounded by a sea-state cap (CPU): reflections blur
// more with distance, so cloud detail melts into sky colour toward the horizon. Wide wind slicks and rougher patches
// (the shared wide noises) vary it.
float swSlick = 0.6 + 0.8 * smoothstep(0.2, 0.8, swGust * 0.55 + swLarge * 0.45);
// Aerial perspective (\`swHaze\`: the shared \`swAir\`, at grazing views): toward the horizon the far sea becomes a pure
// mirror of the horizon sky and melts into it. In that haze the blur relaxes and the lifted ray drops back toward the
// horizon, so the farthest water mirrors the sky's own horizon band (the colour drawn right above it) rather than a
// blurred average of the clouds higher up: no seam.
float swHazeSharp = 1.0 - 0.97 * swHaze;
swSlopeVariance = min((swLost + swLostDetail * swChopGain * swChopGain * 0.85) * swSlick + swFar * 0.008, U.slateWaterTerms.z) * swHazeSharp;
// Keep reflected rays above the horizon, a little higher for rougher water so its blurred lobe stays in the sky: below it
// the water would reflect only more water. A smooth maximum leaves no plateau of identical directions on wave backs.
// The shading normal becomes the half vector toward the lifted reflection; the Fresnel stays the facet's own.
vec3 swRefl = reflect(-swV, normalW);
float swReflFloor = mix(0.02 + sqrt(swSlopeVariance) * 1.2, 0.004, swHaze);
float swReflRawY = swRefl.y;
float swReflLift = swRefl.y + log(1.0 + exp(30.0 * (swReflFloor - swRefl.y))) / 30.0;
swRefl.y = mix(swRefl.y, swReflLift, step(0.0, swV.y));
normalW = normalize(swV + normalize(swRefl));
// Wind ripples below the smallest capillary octave (centimetres) tilt every facet a little; calm water stays a mirror.
swSlopeVariance = min(swSlopeVariance + ${f(OCEAN_SUB_CAPILLARY_VARIANCE)} * swChopGain * swChopGain * swHazeSharp, U.slateWaterTerms.z);
// Specular antialiasing (\`PIXEL_SLOPE_FILTER\`): the shading normal's own variation across this pixel (its slope's
// screen derivatives) widens the lobe and the reflection's blur, so resolved detail the pixel cannot sample densely
// enough never sparkles into salt or crawls from frame to frame. Outside the sea-state cap: it is filtering, not sea
// state.
vec2 swShadeSlope = normalW.xz / max(normalW.y, 0.1);
vec2 swShadeDx = dFdx(swShadeSlope);
vec2 swShadeDy = dFdy(swShadeSlope);
float swShadeVar = min((dot(swShadeDx, swShadeDx) + dot(swShadeDy, swShadeDy)) * ${f(PIXEL_SLOPE_FILTER / 2)}, ${f(PIXEL_SLOPE_CAP)});
swSlopeVariance += swShadeVar * swHazeSharp;
float swNdotV = clamp(dot(swFresN, swV), 0.0, 1.0);
// Facets turned nearly edge-on to the eye are mostly hidden behind the waves in front of them (masking): the eye sees
// those instead, so no visible facet reflects as if seen at a lower angle than about half the view's own.
float swFresX = 1.0 - max(swNdotV, 0.5 * clamp(swV.y, 0.0, 1.0) + 0.04);
float swFresX2 = swFresX * swFresX;
float swFres = 0.02 + 0.98 * swFresX2 * swFresX2 * swFresX;
// Art direction: close water looked down into shows its body more than the sky (reflections stay full toward grazing).
swFres *= 1.0 - 0.5 * smoothstep(0.06, 0.4, swV.y);
swFres = mix(swFres, 1.0, swHaze);
// Beer-Lambert absorption down to the floor and back along the refracted ray (water IOR 1.333).
float swCosT = sqrt(1.0 - (1.0 - swNdotV * swNdotV) * 0.5625);
// Clear water: Depth Color Distance is how deep the floor stays visible. Absorption runs over a much longer path (the
// slowest channel over five times that), so clear shallows keep the bed's own light and only red goes within the first
// metres; a little wavelength-neutral scattering (\`${f(TURBIDITY)}\` per path unit) hands the bed over to the in-scattered body.
float swPath = swDepth * (1.0 + 1.0 / swCosT) / (swAbsorb * 5.0);
// Visibility: past about a third of the Depth Color Distance the floor fades into the water's own colour, so a seabed
// that ends (a landscape's edge) or drops off never shows its edge, and deep water reads as one body.
float swVisible = 1.0 - smoothstep(0.35, 0.85, swDepth / swAbsorb);${fromTier(1, `
// Per channel (from Shallow Color, CPU): red goes first, so sand under shallows turns turquoise and what shows through
// takes the water's hue with depth. Opacity caps the path (CPU, slateWaterThrough.w), not each channel.
vec3 swTransmitRgb = exp(-min(swPath, U.slateWaterThrough.w) * U.slateWaterAbsorb.rgb - vec3(swPath * ${f(TURBIDITY)})) * swVisible;
float swTransmit = dot(swTransmitRgb, vec3(0.3, 0.59, 0.11));`, `
// Low has no refracted copy to tint, and blending passes one transmittance for every channel, which cannot remove the
// bed's red. It passes the real bed at its fastest-fading channel's transmittance plus a share (\`LOW_BED_SHOWS\`) of
// the rest up to the mean, so what lies there still shows, and draws the remaining green and blue itself: a cooled,
// wet sand floor (\`LOW_BED\`) through the per-channel absorption. Its shallows thus take the same cyan as the
// per-channel tiers' instead of a grey veil over the bed.
vec3 swLowBedT = exp(-min(swPath, U.slateWaterThrough.w) * U.slateWaterAbsorb.rgb - vec3(swPath * ${f(TURBIDITY)})) * swVisible;
float swLowT = dot(swLowBedT, vec3(0.3, 0.59, 0.11));
float swLowMin = min(swLowBedT.r, min(swLowBedT.g, swLowBedT.b));
float swTransmit = swLowMin + (swLowT - swLowMin) * ${f(LOW_BED_SHOWS)};
vec3 swTransmitRgb = vec3(swTransmit);
// The water's own light covers, per channel, only what the full transmittance leaves, as on the per-channel tiers:
// over sand its blue never veils the bed's cyan.
vec3 swScatterT = swLowBedT;
swLowBedT = max(swLowBedT - vec3(swTransmit), vec3(0.0));`)}${ifDefined(REFRACTION, `
// Where the copy holds no geometry behind the water (its sky depth), there is no floor in view: open water transmits
// no background (the sky colour behind it never tints the sea), and its in-scattered light fills in.
float swVoid = step(${f(WATER_SCENE_COPY_SKY_DEPTH * 0.9)}, swSceneZ);
swTransmitRgb *= 1.0 - swVoid;
swTransmit *= 1.0 - swVoid;
// Thin water at a shoreline: the copy's depth is one nearest texel, so a hard in-front test flips from texel to texel
// into a dithered checker there; a tolerance band (wider far away) blends the refracted and blended paths instead.
swRefracts = smoothstep(-0.03, 0.03 + swWaterZ * 0.004, swSceneZ - swWaterZ);
// Where the terrain field knows the bed lies under this water, the copy's texel holds that bed (unless something stands
// well in front of the surface): the refracted path stands, so the copy's nearest-texel depth never flips shallows
// between the two paths from texel to texel.
swRefracts = max(swRefracts, swKnown * smoothstep(0.02, 0.12, swFieldDepth) * smoothstep(-0.6, -0.2, swSceneZ - swWaterZ));`)}${fromTier(2, `
// Sun caustics on the bed (High up, ALU only): the surface focuses sunlight into a soft, slowly morphing shimmer of
// bright filaments on shallow floors, over darker cells (\`swCaustic\`, evaluated where the refracted view ray meets the
// floor and bent by a slow noise). The lines blur toward their mean with depth and before they would alias, weaken with
// depth, and need a clear sun some way up. \`swCaustics\` is the floor's light factor less one.
// Natural caustics are a soft shimmer, not a pool's hard net: modest contrast, falling off as 1 / (1 + depth), with a
// sun some way up (its incidence) and a clear sun; none where no floor shows, so open ocean, overcast skies and distant
// water skip the field (it reads no derivatives, so the branch is legal in any control flow).
float swCauFade = (1.0 - smoothstep(0.08, 0.3, swFoot * 1.6)) / (1.0 + 0.45 * swDepth) * smoothstep(0.0, 0.25, swDepth)
  * smoothstep(0.1, 0.45, swL.y) * swL.y * U.slateWaterSky.w * min(U.slateWaterSun.w, 1.5) * swVisible;
float swCaustics = 0.0;
if (swCauFade > 0.0) {
  vec3 swRefrDir = refract(-swV, swWaveN, 0.75);
  vec2 swBedXZ = swWorld + swRefrDir.xz * (swDepth / max(-swRefrDir.y, 0.3));
  // About 4 m per tile; a slow, wide bend keeps the tile from repeating.
  vec2 swBedP = swBedXZ * 1.6 + (vec2(swNoise(swBedXZ * 0.11 + vec2(3.1, swTime * 0.02)), swNoise(swBedXZ * 0.11 + vec2(swTime * -0.015, 7.7))) - vec2(0.5)) * 1.6;
  float swCauField = mix(swCaustic(swBedP, swTime * 0.45 + 23.0), 0.12, smoothstep(0.0, 1.0, swDepth * 0.15 + swFoot * 2.5))
    * (0.55 + 0.9 * swNoise(swBedXZ * 0.3 + vec2(swTime * -0.04, 1.7)));
  swCaustics = (swCauField * 1.25 - 0.15) * swCauFade;
}`, `
float swCaustics = 0.0;`)}
vec4 swSunShape = U.slateWaterSunShape;
float swCrestPhase = clamp(swCrest * 0.5 + 0.5, 0.0, 1.0);
// The body: Deep Color lit by the sky and by the sun entering the water (less of a low sun, CPU) on facets facing it.
// The resolved chop shades it too, so even water looked straight down into shows its ripples.
float swSlopeLit = max(dot(normalize(mix(swSwellNormal, swWaveN, 0.6)), swL), 0.0);
vec3 swBodyLight = swAmb * 0.9 + swSun * (swSunShape.w * (0.15 + 0.6 * swSlopeLit));
// Volume: troughs are deep and dark, crests thin and lit. Seen from above the swell's interference would print a
// lattice into the colour, so the contrast fades out toward top-down views and drifts with the large noise.
float swVolumeGain = (0.15 + 0.85 * swGraze2) * (0.55 + 0.6 * swLarge);
float swVolume = mix(1.0, 0.45 + 1.05 * smoothstep(0.05, 0.95, swCrestPhase), min(swVolumeGain, 1.0));
// Color Variation: wide drifts of slightly lighter and darker water (value, not hue).
float swPatch = (smoothstep(0.25, 0.8, swDrift) - 0.5) * U.slateWaterSwellInfo.z;
vec3 swScatterCol = U.slateWaterDeep.rgb * (1.0 + 0.6 * swPatch);
// Clear water scatters little: over shallows the body leans only a little toward a dimmer Shallow Color, since the
// bed's light through the per-channel absorption carries their colour (Low draws that bed light itself).
swScatterCol = mix(swScatterCol, U.slateWaterShallow.rgb * 0.3, (1.0 - swTone) * 0.4);
// Under an overcast or stormy sky (CPU, slateWaterHorizon.w: a sky light the sun does not outshine) no sunlight
// reaches into the water to colour it: the body greys toward a cool slate and the sea takes the sky's colour.
float swOvercast = U.slateWaterHorizon.w;
swScatterCol = mix(swScatterCol, vec3(dot(swScatterCol, vec3(0.3, 0.59, 0.11))) * vec3(0.85, 1.0, 1.12), 0.5 * swOvercast);
vec3 swScatter = swScatterCol * swBodyLight * swVolume;
// Crest glow (Subsurface), added outside the Fresnel weighting so it still shows at grazing angles.
vec3 swGlow = vec3(0.0);${ifDefined(WATER_FEATURE_DEFINES.subsurface, `
// Light through thin crest tops and chop tips: sunlight entering a crest scatters out toward an eye looking into the
// sun (a translucency lobe around the sun direction bent by the facet), in the sun's colour after the water's
// absorption (CPU, slateWaterThrough: green-teal for the default colours, none for a sun on the horizon). A little
// skylight glows through every crest whatever the view, so crests separate from the troughs under any sky.
// Thin crests vary along their length (the wide noise), so the long swell crests never glow as unbroken lines that
// converge toward the horizon like rays. Only the upper part of a crest is thin enough (the swell's height, its Gerstner
// crest factor on Low too), and the glow fades with distance, where crests are no longer resolved: a broad lobe around
// the sun's line would otherwise tint a whole wedge of open sea like glowing shallows, fixed to the view like a lens
// effect.
float swThin = smoothstep(0.62, 1.0, swCrestPhase + swChopH * 0.4) * (1.0 - swFar) * exp(-swEyeDist * 0.012) * (0.3 + 0.9 * smoothstep(0.25, 0.75, swLarge));
vec3 swSssDir = normalize(swL + swWaveN * 0.3);
float swSssView = clamp(-dot(swV, swSssDir), 0.0, 1.0);
swSssView *= swSssView;
swSssView *= swSssView;
// Skylight through crests takes Shallow Color with blue held to green, like the sunlight (CPU, slateWaterThrough).
swGlow = (U.slateWaterThrough.rgb * (0.1 + 2.6 * swSssView) + vec3(U.slateWaterShallow.r, U.slateWaterShallow.g, min(U.slateWaterShallow.b, U.slateWaterShallow.g)) * swAmb * 0.05) * (swThin * U.slateWaterLook.w);
// Open-water crests glow a muted sea green, not the saturated cyan of a shallow lagoon: part of the way to grey.
swGlow = mix(swGlow, vec3(dot(swGlow, vec3(0.3, 0.59, 0.11))) * vec3(0.8, 1.05, 1.1), 0.4);
swScatter += U.slateWaterThrough.rgb * (smoothstep(0.2, 0.9, swFoldN) * swRough * 0.07 * U.slateWaterLook.w);`)}

// Foam: a bubble web (Medium up) and clumpy noise, thresholded by a foam density (Crest-style), so dense foam is solid,
// then opens round holes, thins into lace and breaks into scattered fragments as it decays. From High a finer web
// layers small bubbles into it. The slope warp is bounded, so storm slopes never shred it.
vec2 swWarp = swSlope / (1.0 + length(swSlope)) * 0.3;
// Foam is drawn out along the wind (its bubbles and lace stretch into streaks downwind), and bent by the medium noises.
// A strong wind (Crest Foam well above its default) draws it out about twice as far again, into streaks.
vec2 swFoamUv = vec2(dot(swFlowed, swWindDir) * mix(0.75, 0.36, smoothstep(0.5, 0.95, U.slateWaterShape.z)), dot(swFlowed, vec2(-swWindDir.y, swWindDir.x)) * 1.5) + swWarp + vec2(swMedium - 0.5, swFine - 0.5) * 0.8;
float swFoamFade = smoothstep(0.3, 0.9, swFoot * 1.6);
float swClump = swNoise(swFoamUv * 0.5 + vec2(7.3, swTime * 0.02));${fromTier(1, `
float swBlob = swNoise(swFoamUv * 1.7 + vec2(1.9, swTime * -0.05));${fromTier(2, `
// Churn: two phases of the web crossfade, each re-seeded while it is invisible, so foam evolves in place.
float swChurnT = swTime * 0.12;
float swChurnA = fract(swChurnT);
float swChurnB = fract(swChurnT + 0.5);
vec2 swChurnDrift = vec2(0.22, -0.13);
vec2 swWebUv = swFoamUv + (vec2(swBlob, swClump) - vec2(0.5)) * 0.5;
vec2 swWebA = swWeb(swWebUv + vec2(0.37, 0.71) * (floor(swChurnT) * 7.0) + swChurnDrift * swChurnA);
vec2 swWebB = swWeb(swWebUv + vec2(0.37, 0.71) * (floor(swChurnT + 0.5) * 7.0 + 3.0) + swChurnDrift * swChurnB);
float swChurnMix = 1.0 - abs(1.0 - 2.0 * swChurnA);
// Dense foam opens round holes around the web's points; thinning foam keeps only the web's borders, so it frays into
// thin strands of lace (streaked along the wind with the domain) instead of thick, flat worms.
float swLaceRaw = max(0.9 * smoothstep(0.36, 0.88, mix(swWebB.x, swWebA.x, swChurnMix)), 1.0 - smoothstep(0.0, 0.18, mix(swWebB.y, swWebA.y, swChurnMix)));
float swWebScale = 1.0;
// Small bubbles: a web about a third the size, averaged out before it would alias.
float swBubbles = mix(smoothstep(0.28, 0.8, swWeb(swFoamUv * 2.7 + vec2(3.1, swTime * 0.07)).x), 0.45, smoothstep(0.1, 0.3, swFoot * 3.0));`, `
// Medium's single web, at about twice the large web's scale and a little thicker.
vec2 swWebM = swWeb(swFoamUv * 1.8 + (vec2(swBlob, swClump) - vec2(0.5)) * 0.9 + vec2(3.1, swTime * 0.07));
float swLaceRaw = max(0.9 * smoothstep(0.33, 0.88, swWebM.x), 1.0 - smoothstep(0.0, 0.24, swWebM.y));
float swWebScale = 1.8;
float swBubbles = 0.45;`)}
// The web: 0 at its jittered points, rising to 1 between them, so thresholding it opens round holes of their own sizes
// that grow as the foam thins until strands thick at their junctions and thin between them are left, as decaying foam
// does. (Thresholding the cells' borders drew thin, even veins: a network of cracks.) The cells curve with the blob
// noise. Before a cell shrinks to a few pixels it gives way to a mottle of the blob noise, so mid-distance foam keeps
// texture instead of thresholding into flat polygons.
float swLace = mix(swLaceRaw, 0.3 + 0.5 * swBlob, smoothstep(0.12, 0.35, swFoot * 1.1 * swWebScale));
float swFoamTex = clamp(swLace * 0.6 + swClump * 0.22 + swBlob * 0.08 + swBubbles * 0.15 - 0.02, 0.0, 1.0);`, `
// Low evaluates no cell pattern: a ridged noise, stretched a little along the wind, draws one network of wiggly lines
// (several bands of a noise would draw nested contour rings) that breaks the clumps into streaky lace, fading to its
// mean before it would alias.
vec2 swLowFoamUv = vec2(dot(swFoamUv, swWindDir), dot(swFoamUv, vec2(-swWindDir.y, swWindDir.x))) * vec2(1.0, 2.4);
float swLace = mix(1.0 - abs(swNoise(swLowFoamUv + vec2(3.1, swTime * 0.05)) * 2.0 - 1.0), 0.5, smoothstep(0.2, 0.5, swFoot * 2.6));
float swBlob = swClump;
float swBubbles = 0.5;
float swFoamTex = smoothstep(0.08, 0.9, swClump * 0.5 + swLace * 0.45 + 0.03);`)}
// Shores (the shared swash, see surfaceSource): the wash band widens as each bore runs up and narrows as it drains;
// over terrain the bore's front carries dense foam up the beach and its furthest reach leaves a stranded line as the
// backwash uncovers the wet sand. Where the water is shallow for its waves, crests break into surf, and bores roll in
// through it, each leaving thinner foam behind its front.
float swWash = max(exp(-swBank / (swFoamWidth * (0.7 + 1.6 * swSwashRun))) * (0.35 + 0.45 * swSwashRun) * (1.0 - 0.6 * swSwashZone), swSwashFoam);
// Over known terrain the field's smooth depth, not the refraction copy's nearest-texel bound, whose steps would cut the
// surf into stair-stepped blocks.
float swRestDepth = max(mix(swDepth, swFieldDepth, swKnown) - IN.vSlateWater.x, 0.02);
// Only near a real shore: where nothing is known the bank distance is clamped to the shore range.
float swSurf = smoothstep(0.35, 0.9, U.slateWaterWaves.x / swRestDepth) * (1.0 - smoothstep(8.0, 12.0, swBank / swFoamWidth)) * smoothstep(0.0, 0.3, swBank)
  * (1.0 - smoothstep(${f(SHORE[1] * 0.5)}, ${f(SHORE[1] * 0.95)}, swBank));
float swSurfFoam = swSurf * max(smoothstep(0.0, 0.6, swCrest + swChopH * 0.6), 0.5 * smoothstep(-0.8, 0.2, swCrest)) * 0.75;
// Each bore leaves thinner foam behind it that decays over a few Foam Widths.
float swBoreTrail = exp(-swBorePhase * 6.283185 / max(U.slateWaterSwash.z, 0.001) / (swFoamWidth * 4.0));
swSurfFoam = max(swSurfFoam, min(max(swBore * 1.5, swBoreOn * 0.5 * swBoreTrail), 1.0) * (0.7 + 0.3 * swSurf));
swSurfFoam = max(swSurfFoam, swSurfBreak * 0.95);
vec2 swWindUv = vec2(dot(swFlowed, swWindDir), dot(swFlowed, vec2(-swWindDir.y, swWindDir.x)));
float swCap = 0.0;
float swCapCore = 0.0;
float swTrail = 0.0;
// Storm weight (\`swStorm\`, 0 below about half Crest Foam): set with the caps below.
float swStorm = 0.0;${ifDefined(crestFoam, `
// Whitecaps: high, sharp swell crests break (Crest Foam sets coverage; the chop's own crests never do) in zones that
// drift downwind, once the sea is steep enough: a gentle sea never breaks, so its open water carries no stray foam,
// while a storm caps most of its crests. Fresh caps cover the crest top; the residue they leave on the crest's back face
// is drawn out downwind into streaks that thin and fade behind it.
float swSea = smoothstep(0.25, 0.55, swSeaState) * smoothstep(0.5, 0.9, swResolved / max(0.0001, swSteep));
float swBack = max(dot(swGradient, swWindDir), 0.0) / max(0.0001, swSeaState);${fromTier(2, `
float swBreakZone = swNoise(swWorld * 0.045 - swWindDir * (swTime * 0.12) + vec2(5.1, 2.7));`, fromTier(1, `
float swBreakZone = 1.0 - swLarge;`, `
// Low's gust is its large noise: its breaking zones take the large noise inverted, broken up by the medium one.
float swBreakZone = (1.0 - swLarge) * 0.7 + swMedium * 0.3;`))}
// Caps sit on the high crests themselves, so even a stormy sea keeps dark glossy water between its breakers.
float swBreak = swFoldN * 1.3 + smoothstep(0.55, 0.95, swCrestPhase) * 0.4 + (swBreakZone - 0.5) * 1.1 + (swGust - 0.5) * 0.4;
float swCapDrive = swBreak * swSea * smoothstep(0.4, 0.75, swCrestPhase);
// Storm weight: Crest Foam well above its default on a sea steep enough to break (see storm breaking below).
swStorm = smoothstep(0.5, 0.95, U.slateWaterShape.z) * swSea;${fromTier(1, `
float swCapT = 1.5 - 1.1 * U.slateWaterShape.z;`, `
// Low's foam texture is smoother, so its caps are a little rarer, and thinner (below), so they never read as solid blobs.
float swCapT = 1.56 - 1.1 * U.slateWaterShape.z;`)}
// In a storm the breaking spreads over the whole sea instead, so whole swell crests never whiten as unbroken bands.
swCapT += 0.45 * swStorm;
swCapCore = smoothstep(swCapT, swCapT + 0.35, swCapDrive) * U.slateWaterTerms.y;
swCap = max(swCapCore * (0.75 + 0.25 * smoothstep(0.25, 0.65, swClump)), smoothstep(swCapT - 0.3, swCapT + 0.15, swCapDrive) * 0.4 * U.slateWaterTerms.y);
// Residue behind breaking crests, on their back faces, fading with distance from the crest. It follows the same breaking
// zones as the caps, so it trails real breakers rather than every wave's back.
float swTrailDrive = (swFoldN * 0.6 + swBack * 0.5 + smoothstep(0.55, 0.95, swCrestPhase) * 0.3 + (swBreakZone - 0.5) * 1.4 + (swGust - 0.5) * 0.3)
  * swSea * smoothstep(0.15, 0.55, swCrestPhase);
float swTrailOn = smoothstep(swCapT - 0.6, swCapT - 0.1, swTrailDrive) * U.slateWaterTerms.y;
// Storm breaking: in a strong wind (Crest Foam well above its default) on a sea steep enough to break, the wind chop
// breaks as well as the swell's high crests. Steep crests, the swell's windward backs and chop crests in the drifting
// breaking zones whiten wherever they occur, so whitecaps scatter over the whole sea as broken patches that the bubble
// web frays into lace, and leave soft streaks downwind, while dark water stays between them. Below about half Crest Foam
// (or on a gentle sea) only the swell's high crests break, as above.
// Breakers sit on the crests: the swell's own height drives them and its troughs never break (the windward backs only
// carry the trails below).
float swStormDrive = (swFoldN * 1.6 + (swCrestPhase - 0.55) * 1.1 + swBack * 0.2 + swChopH * 0.25 + (swBreakZone - 0.5) * 0.7 + (swGust - 0.5) * 0.4) * swRough
  * smoothstep(0.3, 0.6, swCrestPhase + swChopH * 0.3);${fromTier(1, `
float swStormK = U.slateWaterShape.z * 0.85;`, `
// Low's foam has no web to break caps into lace, so its storm caps form a little later and stay smaller.
float swStormK = U.slateWaterShape.z * 0.6 - 0.15;`)}
float swStormOn = swStorm * U.slateWaterTerms.y;
swCap = max(swCap, max(smoothstep(1.0 - swStormK, 1.7 - swStormK, swStormDrive) * (0.55 + 0.45 * smoothstep(0.25, 0.65, swClump)),
  smoothstep(0.7 - swStormK, 1.4 - swStormK, swStormDrive) * 0.35) * swStormOn);
swCapCore = max(swCapCore, smoothstep(1.5 - swStormK, 2.3 - swStormK, swStormDrive) * swStormOn);${fromTier(1, `
// Cores ease in and keep the pattern's holes (more faintly), so dense caps never read as flat paint with a hard rim.
// Below a storm's Crest Foam a lone cap stays lace; dense cores belong to real breakers only.
swCapCore *= swCapCore * (0.15 + 0.85 * smoothstep(0.25, 0.6, swFoamTex)) * smoothstep(0.35, 0.8, U.slateWaterShape.z);
// The residue is drawn out downwind into streaks about five times longer than wide that drift with the wind.
vec2 swTrailUv = swWindUv * vec2(0.16, 0.8) + vec2(swTime * -0.05, (swMedium - 0.5) * 0.6) + swWarp;
float swTrailTex = swNoise(swTrailUv) * 0.65 + swNoise(swTrailUv * vec2(2.3, 2.1) + vec2(4.1, 1.7)) * 0.35;
swTrail = swTrailOn * smoothstep(0.42, 0.8, swTrailTex) * 0.75;
// A storm's breakers leave soft streaks stretched along the wind behind them, not thin scratches.
float swStormTrailTex = swNoise(swWindUv * vec2(0.35, 1.1) + swWarp + vec2(swTime * 0.05, 0.0));
swTrail = max(swTrail, smoothstep(0.75 - swStormK, 1.2 - swStormK, swStormDrive + swBack * swRough * 0.8) * smoothstep(0.2, 0.9, swStormTrailTex) * swStormOn);`, `
swCapCore = 0.0;
// Low has no dense cores: its caps' density follows the streaky foam texture, so they open into streaks and holes.
swCap *= 0.45 + 0.5 * smoothstep(0.25, 0.75, swFoamTex);
// Low: the same residue drawn out downwind with one noise, a little softer.
swTrail = swTrailOn * smoothstep(0.42, 0.8, swNoise(swWindUv * vec2(0.16, 0.8) + vec2(swTime * -0.05, (swMedium - 0.5) * 0.6) + swWarp)) * 0.6;`)}`)}
float swStreak = 0.0;${ifDefined(surfaceFoam, `
// Wind streaks: on a sea steep enough to break, the foam its breakers leave is drawn out along the wind into long,
// meandering streaks metres apart. They are contour lines of a value noise stretched about eleven times along the wind
// and bent by the wide noises, so their spacing, width and course vary and they never form a regular set of lines; they
// break into runs and fray into the foam pattern (see the composition below), and they drift downwind with the foam.
// A gentle sea carries none, a fresh breeze a few faint ones, a storm many. Surface Foam sets their strength and width.
// They are soft bands a few tens of centimetres wide that fade out with distance before they would alias. (Thin,
// static lines used to run straight across the sea and, far away, kept a faint average that perspective drew into
// streaks converging on the horizon.) ALU only, so Low draws them too.
float swStreakAmt = U.slateWaterSunColor.w;
float swStreakSea = smoothstep(0.45, 0.8, swSeaState) * smoothstep(0.5, 0.9, swResolved / max(0.0001, swSteep));
vec2 swStreakP = swWindUv - vec2(swTime * 0.45, 0.0);
vec2 swStreakUv = vec2(swStreakP.x * 0.035, swStreakP.y * 0.38 + (swLarge - 0.5) * 2.4 + (swGust - 0.5) * 1.6);
float swStreakN = swNoise(swStreakUv) * 0.7 + swNoise(swStreakUv * vec2(2.1, 2.7) + vec2(5.3, 1.9)) * 0.3;
float swStreakR = 1.0 - abs(swStreakN * 2.0 - 1.0);
float swStreakAA = fwidth(swStreakR) * 1.5;
float swStreakRun = swNoise(vec2(swStreakP.x * 0.06, swStreakP.y * 0.22) + vec2(13.1, 7.7));
float swStreakW = (0.08 + 0.1 * swStreakAmt) * (0.6 + 0.8 * swStreakRun);
float swStreakLine = smoothstep(1.0 - swStreakW * 1.8 - swStreakAA, 1.0 - swStreakW * 0.2, swStreakR);
swStreak = swStreakLine * (1.0 - smoothstep(0.1, 0.35, swStreakAA)) * smoothstep(0.4, 0.75, swStreakRun)
  * swStreakSea * (0.15 + 0.85 * swStreakAmt) * swCalm;`)}
// Residue and wind streaks join the caps, swash and surf in one density, so the same bubble web thresholds them all:
// decaying foam breaks into wind-drawn scraps of lace rather than translucent sheets netted with the web.
// Low has no web: its streaks break into translucent scraps instead (below).${fromTier(1, `
float swStreakD = swStreak * 0.8;`, `
float swStreakD = 0.0;`)}
float swDensity = clamp(max(max(swWash, swCap), max(max(swTrail * mix(0.6, 0.85, swStorm), swStreakD), swSurfFoam)), 0.0, 1.0);
// Thinning foam softens: its holes open gradually, over at least a couple of pixels.
float swFoamSoft = 0.07 + 0.15 * (1.0 - swDensity) + fwidth(swFoamTex) * 1.5;
// Even the densest foam keeps a few bubble holes.
float swFoamCut = 1.0 - 0.72 * swDensity;
// Where the pattern is too fine to resolve, foam keeps the coverage its density would give. Thin foam is translucent,
// and no density at all leaves no trace of the web (open water carries no faint net).
float swRealFoam = mix(smoothstep(swFoamCut, swFoamCut + swFoamSoft, swFoamTex), swDensity * swDensity * (3.0 - 2.0 * swDensity) * 0.8, swFoamFade)
  * (0.3 + 0.7 * swDensity) * smoothstep(0.0, 0.12, swDensity);
// How deep inside the foam this point lies: thick fresh foam is brighter than its fraying lace.
float swFoamThick = mix(clamp((swFoamTex - swFoamCut) * 2.5, 0.0, 1.0), swDensity, swFoamFade) * smoothstep(0.15, 0.75, swDensity);
${fromTier(1, "", `
// Low's smoother pattern would let the faintest foam through as stray scribbles where the bubble web would show only a
// few thin borders: very thin foam fades out.
swRealFoam *= smoothstep(0.08, 0.35, swDensity);
// Wind streaks break up into scraps of foam strung along the wind, as the lit tiers' web breaks them, instead of running
// as unbroken white lines that read as scratches across the sea. The foam texture's lace runs along the wind too, so
// the round clumps cut the runs a few metres long (fading to their mean before they would alias).
swRealFoam = max(swRealFoam, swStreak * 0.5 * smoothstep(0.35, 0.8, swFoamTex) * mix(smoothstep(0.3, 0.65, swClump), 0.5, swFoamFade));`)}
// Fresh cores are dense foam, as bright as the caps, so they stand out against a bright sky's reflection, but they keep
// the pattern's holes and some translucency, so even a storm's caps never read as painted blobs.
swRealFoam = max(swRealFoam, swCapCore * 0.65);
swFoamThick = max(swFoamThick, swCapCore * 0.8);
// The swash line hugs the moving waterline, wider as a wave runs up.
// Over terrain the swash front takes its place (the waterline itself is bare while the backwash drains).
float swShoreLine = (1.0 - smoothstep(0.0, (0.35 * swFoamWidth + 0.1) * (0.6 + swSwashRun), swBank)) * (1.0 - 0.85 * swSwashZone);
swRealFoam = max(swRealFoam, swShoreLine * (0.5 + 0.4 * smoothstep(0.2, 0.5, mix(swFoamTex, 0.45, swFoamFade))));
// Contact foam: a narrow churned collar where the water meets an object that breaks, within about half a contact
// width, into translucent lace; ripple crests carry a few flecks further out. The band stretches downstream (the
// current where the water flows, otherwise downwind) into a trail. Low keeps the band and line only.
float swObjectW = swObject / (1.0 + 1.4 * max(dot(swContactDir, swWakeDir), 0.0));
float swContactLine = 1.0 - smoothstep(0.0, 0.1 * swContactW + 0.05 + fwidth(swObject), swObject + (swBlob - 0.5) * 0.06 * swContactW);
float swWake = 0.0;${fromTier(2, `
// Wake: a point downstream of an object trails its foam. Two contact-field taps upstream (at 0.4 and 0.8 of the contact
// range) find the object; the plume widens with distance at about the Kelvin angle and thins as it trails.
if (swContactOn > 0.5) {
  float swRange = U.slateWaterContactInfo.y;
  vec2 swWakeUv = swWakeDir * (swRange * 0.4) * U.slateWaterContactBounds.zw;
  float swWakeD1 = (dot(swContactAt(swContactUv - swWakeUv), swLayerW) * 2.0 - 1.0) * swRange;
  float swWakeD2 = (dot(swContactAt(swContactUv - swWakeUv * 2.0), swLayerW) * 2.0 - 1.0) * swRange;
  float swWakeW = swContactW * 0.35 + swRange * 0.1;
  swWake = max((1.0 - smoothstep(swWakeW * 0.2, swWakeW, swWakeD1)) * 0.5, (1.0 - smoothstep(swWakeW * 0.4, swWakeW * 1.7, swWakeD2)) * 0.3);
  swWake = swWake * smoothstep(0.0, 0.3, swContactSigned) * (0.2 + 0.8 * swClump);
}`)}
// The collar pulses with the swell at the hull: it pushes out and thickens as the water climbs, and as it drops a wider,
// thinner ring of foam clings briefly before it drains (\`swHullPulse\`, \`swHullCling\`).
float swHullW = swContactW * (0.55 + 0.8 * swHullPulse)${fromTier(2, " * 1.35", "")};
float swHullRing = swHullCling * exp(-abs(swObjectW - swContactW * 0.22) / (swContactW * 0.12)) * 0.55;${fromTier(1, `
// Lee puffs: foam shed downstream with each rise drifts away in clumps, within about a Contact Foam Width (over two,
// small floats trailed long marbled ribbons several times their own size).
float swLee = swLeePuff * exp(-swOutside / (swContactW * 1.1)) * smoothstep(0.0, 0.2, swContactSigned) * 0.45 * swNearContact;
float swHug = clamp(exp(-swObjectW / swHullW * 7.0) * (0.3 + 1.0 * swClump) * (0.7 + 0.5 * swHullPulse) + (swHullRing + swLee) * (0.3 + 0.9 * swClump)
  + max(0.0, cos(swRipplePhase)) * swRippleFade * 0.1 * swClump + swWake * 0.8, 0.0, 1.0);
// Bubbly patches: the low-frequency clumps carry the bubbles, so thinning foam breaks into islands of lace.
float swPatchTex = mix(smoothstep(0.12, 0.85, (swClump * 0.5 + swBlob * 0.5) * (0.75 + 0.25 * swBubbles) + swLace * 0.3), 0.45, swFoamFade);
float swHugSoft = 0.1 + 0.14 * (1.0 - swHug) + fwidth(swPatchTex) * 1.5;
float swHugCut = 1.0 - swHug * 0.9;
// Thinner foam is sparser and more translucent, and opens into the bubble web's holes rather than ending in a cut-out
// edge: only the dense collar right at the object is solid. Away from every object (no hug) none is left: the web's
// brightest borders would otherwise pass the cut there and net the whole open sea in a faint, regular crackle.
float swRealContact = smoothstep(swHugCut - swHugSoft * 0.5, swHugCut + swHugSoft, swPatchTex) * (0.15 + 0.75 * swHug) * mix(0.45 + 0.55 * swLace, 1.0, swHug * swHug)
  * smoothstep(0.0, 0.08, swHug);
swRealContact = max(swRealContact, swContactLine * (0.65 + 0.3 * smoothstep(0.2, 0.6, swPatchTex)));${fromTier(2, `
// High up the collar reads a little denser and wider at a distance (the ring and wake were faint beside the swell).
swRealContact = min(swRealContact * 1.25, 1.0);`)}`, `
float swHug = clamp(exp(-swObjectW / swHullW * 8.0) * (0.4 + 1.1 * swClump) * (0.7 + 0.5 * swHullPulse), 0.0, 1.0);
float swRealContact = max(smoothstep(0.35, 0.85, swHug) * (0.25 + 0.6 * swHug) * (0.6 + 0.4 * swLace), swContactLine * 0.8);`)}
// Aerial perspective fades distant foam into the horizon sky with the water, so far breakers never pile into a bright
// band along the horizon.
float swFoam = clamp(max(swRealFoam * swFoamAmount * 1.35 * (1.0 - 0.7 * swHaze), swRealContact * swContactStrength), 0.0, 1.0);
swFoamThick = max(swFoamThick, smoothstep(0.5, 1.0, swRealContact * swContactStrength));
// Air churned under foam turns the water around it milky turquoise, without a pattern.
float swAerated = max(max(swCap * swCap, max(swWash, swSurfFoam)) * swFoamAmount, swHug * 0.6);
swTransmit *= 1.0 - swAerated * 0.35;
swTransmitRgb *= 1.0 - swAerated * 0.35;${fromTier(1, `
vec3 swScatterT = swTransmitRgb;`, `
swScatterT *= 1.0 - swAerated * 0.35;`)}
swScatter += U.slateWaterShallow.rgb * swBodyLight * (swAerated * 0.1);
// Overcast or storm: the light through crests and churned water greys with the body (see swScatterCol).
swScatter = mix(swScatter, vec3(dot(swScatter, vec3(0.3, 0.59, 0.11))) * vec3(0.85, 1.0, 1.12), 0.5 * swOvercast);
swGlow = mix(swGlow, vec3(dot(swGlow, vec3(0.3, 0.59, 0.11))) * vec3(0.85, 1.0, 1.12), 0.5 * swOvercast);
// Wet bed: the thinnest water at a terrain waterline darkens what lies under it, as a film filling sand's pores does.
// It reads the terrain field's smooth depth, not the refraction copy's blocky nearest-texel bound.
float swWetDepth = max(0.3 + 0.2 * swSwashRun, min(fwidth(swFieldDepth) * 8.0, 1.2));
float swWet = (1.0 - smoothstep(0.0, swWetDepth, swFieldDepth)) * swKnown * (1.0 - smoothstep(0.4, 0.9, swFoam));
// Where the backwash has uncovered the shallows, the water gives way to its wet film (\`swSwashWet\`), which darkens
// the sand and dries as the swash lags behind.
float swFilm = (1.0 - swSwashCover) * swSwashWet;
swWet = max(swWet * swSwashCover, swFilm * (1.0 - smoothstep(0.4, 0.9, swFoam)));

// The sun. Medium and up: Babylon's GGX lobe on the shading normal (widened by the filtered slope variance) carries the
// broad sun path, log-compressed where it is bright (swSpecSquash, more with distance) so its core never flattens into
// a slab with hard edges. Close by, where the lobe is dimmed (swSpecKeep), a narrow lobe on the resolved facets
// themselves (swGlint) draws the sharp glints: the sun's mirror image on actual ripple faces. Far away, where no facet is
// resolved, the lobe is broken into glints (swSpecMod, weighted by swSpecModW in the composition): world cells sized to
// the pixel footprint, a few pixels across and about one down, keep about the lobe's mean but concentrate it into
// glints over a dimmer path; perspective stretches them into horizontal dashes. Low draws water unlit and carries one
// smooth analytic lobe instead.
float swFarSun = smoothstep(0.01, 0.08, swPxM);
${fromTier(1, `
float swSpecSquash = 0.35 + 0.9 * swFarSun;
float swSpecKeep = 0.35 + 0.65 * swFarSun;`, `
// Low's single analytic lobe has no glints to break it up: it is compressed harder, so it never reads as a chrome slab.
float swSpecSquash = 1.2 + 1.6 * swFarSun;
float swSpecKeep = 1.0;`)}
float swSpecMod = 1.0;
float swSpecModW = 0.0;
vec3 swHalf = normalize(swV + swL);
float swSunX = 1.0 - clamp(dot(swV, swHalf), 0.0, 1.0);
float swSunX2 = swSunX * swSunX;
float swSunFres = 0.02 + 0.98 * swSunX2 * swSunX2 * swSunX;
// Sea slopes fall off like a Gaussian, not like GGX's long tail: a glint that needs a facet tilted far from the swell
// (a sun behind or high above the eye) is rare, so steep chop crests never light up as rows of white scratches.
float swHalfCos = max(dot(swSwellNormal, swHalf), 0.05);
float swSunReach = mix(1.0, exp(-(1.0 - swHalfCos * swHalfCos) / (swHalfCos * swHalfCos * 0.12)), step(0.0001, U.slateWaterSun.w));
// Glitter (\`swGlitter\`, every tier): glints anchored to the water's rest surface (they ride the waves) on a world grid
// whose cells are at least \`GLITTER_CELL_PX\` pixels across in their most compressed direction (perspective draws far
// glints out into horizontal dashes), two nested levels crossfaded by the footprint. Each glint is filtered by the pixel
// and lit over a smooth lifetime, so the path shimmers instead of flickering; the field averages 1, so it only gathers
// the lobe's light into glints over a dimmer path.
vec2 swGlitterP = swRest + U.slateWaterOrigin.xz - IN.vSlateWaterFlow.xy * swTime;
float swGlitterLevel = max(log2(max(length(swFootX), length(swFootY)) * ${f(GLITTER_CELL_PX / GLITTER_CELL_MIN)}), 0.0);
float swGlitterL = floor(swGlitterLevel) + 1.0;
float swGlitterScale = exp2(-swGlitterL) * ${f(1 / GLITTER_CELL_MIN)};
float swGlitterField = mix(
  swGlitter(swGlitterP * swGlitterScale, swFootX * swGlitterScale, swFootY * swGlitterScale, swTime, swGlitterL),
  swGlitter(swGlitterP * (swGlitterScale * 0.5), swFootX * (swGlitterScale * 0.5), swFootY * (swGlitterScale * 0.5), swTime, swGlitterL + 1.0),
  fract(swGlitterLevel));
float swGlitterMod = min(${f(GLITTER_BASE)} + ${f(1 - GLITTER_BASE)} * swGlitterField, ${f(GLITTER_MAX)});${fromTier(1, `
// Facet glints: a lobe about three degrees wide around the sun's mirror direction on the resolved facets (chop and
// capillaries). The facet normal's own variation across the pixel (its slope's screen derivatives) widens the lobe, so
// a glint narrower than a pixel spreads over one instead of sparkling, and lowers its peak by the square of that factor:
// a facet the pixel does not resolve hands its light to the broad lobe (which that variance widens too) rather than
// spreading a mirror's brightness into a white slab. They also fade as the facets stop being resolved.
float swGlintX = 1.0 - clamp(dot(reflect(-swV, swWaveN), swL), 0.0, 1.0);
vec2 swWaveDx = dFdx(swSlope);
vec2 swWaveDy = dFdy(swSlope);
float swGlintS2 = ${f(1 / 900)} + 4.0 * min((dot(swWaveDx, swWaveDx) + dot(swWaveDy, swWaveDy)) * ${f(PIXEL_SLOPE_FILTER / 2)}, ${f(PIXEL_SLOPE_CAP)});
float swGlintKeep = ${f(1 / 900)} / swGlintS2;
float swGlintNear = 1.0 - smoothstep(0.03, 0.2, swPxM);
// A facet mirroring the sun shows the sun's own radiance, warmed a little: far brighter than the sky, so it saturates.
vec3 swGlint = min(swSun * vec3(1.0, 0.96, 0.88) * (swSunFres * step(0.0, swL.y) * 30.0 * swGlintKeep * swGlintKeep * exp(-swGlintX / swGlintS2) * swGlintNear * swSunReach * U.slateWaterSky.w), vec3(6.0));
float swGlitterFar = smoothstep(0.025, 0.09, swPxM);
// The broad lobe gathers into glints at every distance: close by the same unresolved capillaries break it.
swSpecModW = U.slateWaterSky.w;
swSpecMod = swGlitterMod;
// Close by, the capillaries no tier resolves break each facet's mirror image of the sun into small glints (the same
// stable, surface-riding glitter), so sun-facing chop faces sparkle instead of shining as smooth chrome blobs.
swGlint = min(swGlint * mix(1.0, swGlitterField, 0.96 * (1.0 - swGlitterFar) * U.slateWaterSky.w), vec3(6.0));`, `
// One smooth analytic lobe and no glint cells, so it never reads as static: the half vector's slope away from the
// half-flattened swell (Low resolves no chop to break it up, so whole sun-facing swell faces never light as slabs),
// spread more along the view than across it, so the path stretches toward the eye like a real sun path. Its variance
// includes the shading normal's variation across the pixel (\`swSlopeVariance\`), so the lobe never aliases.
vec3 swLowN = normalize(mix(normalW, vec3(0.0, 1.0, 0.0), 0.4));
vec2 swLowFwd = -swV.xz / max(length(swV.xz), 0.0001);
vec2 swLowDev = swHalf.xz / max(swHalf.y, 0.2) - swLowN.xz / max(swLowN.y, 0.2);
float swLowAlong = dot(swLowDev, swLowFwd);
float swLowAcross = dot(swLowDev, vec2(-swLowFwd.y, swLowFwd.x));
float swLowVar = U.slateWaterOrigin.w * U.slateWaterOrigin.w * 0.5 + swSlopeVariance + 0.004;
float swLowH2 = max(swHalf.y, 0.2) * max(swHalf.y, 0.2);
float swLowD = exp(-(swLowAlong * swLowAlong * 0.4 + swLowAcross * swLowAcross) / (2.0 * swLowVar)) / (6.2832 * swLowVar * 1.58 * swLowH2 * swLowH2);
// Without Smith shadowing the lobe would smear across grazing water; a cheap fade stands in for it.
vec3 swGlint = min(swSun * (swSunFres * step(0.0, swL.y) * swLowD / (4.0 * max(swNdotV, 0.1)) * (0.3 + 0.7 * smoothstep(0.05, 0.4, swNdotV))), vec3(6.0));
float swLowL = dot(swGlint, vec3(0.3, 0.59, 0.11)) * swSpecSquash + 0.0001;
swGlint = swGlint * (swSunReach * log(1.0 + swLowL) / swLowL);
// The same glitter as the lit tiers' (ALU only) gathers the smooth lobe into glints over a dimmer path, so Low's sun
// path glitters instead of reading as one pale slab. Under an overcast or stormy sky (slateWaterSky.w) the sun does not
// stand out, so its path stays a soft sheen. Close by, where a slope-space lobe fans out across the screen, it is
// dimmed a little, so the path narrows toward the eye, and its glints keep less contrast, so they never read as
// confetti over the swell. Close by its glints gather on the facets that actually turn the sun toward the eye (Low's
// resolved normal, a narrow lobe), so they follow the waves instead of sprinkling evenly over the path.
vec2 swLowFacetD = swHalf.xz / max(swHalf.y, 0.2) - swWaveN.xz / max(swWaveN.y, 0.2);
float swLowFacet = exp(-dot(swLowFacetD, swLowFacetD) / (2.0 * (0.006 + swShadeVar)));
float swLowFacetFar = smoothstep(0.05, 0.4, swPxM);
swGlint *= mix(0.4 + 0.6 * swLowFacet, 1.0, swLowFacetFar);
swGlint = min(swGlint * (mix(1.0, swGlitterMod, smoothstep(0.35, 0.9, U.slateWaterSky.w) * mix(0.05 + 0.95 * swLowFacet, 1.0, swLowFacetFar)) * (0.55 + 0.45 * swFarSun)), vec3(6.0));`)}
${sparkled(`
// The sparkles' lobe (about exp(-40 (1 - cos))) widens by the shading normal's variation across the pixel, keeping
// its energy.
float swRL = 1.0 - max(dot(reflect(-swV, normalW), swL), 0.0);
float swRS2 = 0.025 + 4.0 * swShadeVar;
float swSpark = swSparkBase * 3.0 * (0.025 / swRS2) * exp(-swRL / swRS2) * (1.0 - swFoam);`)}
#ifndef REFLECTION
// No environment or skybox: an analytic sky from the scene (\`slateWaterSky\`): its background colour overhead and its
// horizon colour (the fog colour with fog on) low, warmed around the sun's azimuth while the sun is low, with an
// aureole around the sun itself; rough water mirrors a blurred version. Reflection Strength scales it.
vec3 swSkyDir = normalize(swRefl);
float swSkyH = 1.0 - clamp(swSkyDir.y, 0.0, 1.0);
swSkyH = swSkyH * swSkyH * swSkyH;
vec3 swSkyRefl = mix(U.slateWaterSky.rgb, U.slateWaterHorizon.rgb, swSkyH);
float swSkyAz = clamp(dot(swSkyDir.xz / max(length(swSkyDir.xz), 0.0001), swSunShape.xy), 0.0, 1.0);
swSkyAz *= swSkyAz;
swSkyAz *= swSkyAz;
float swSkyLowSun = swSunShape.z;
float swAura = max(dot(swSkyDir, swL), 0.0);
swAura *= swAura;
swAura *= swAura;
swAura *= swAura;
float swAura64 = swAura * swAura;
swAura64 *= swAura64;
swAura64 *= swAura64;
// A low sun warms the whole horizon and, much more, the sky around its own azimuth: at sunset grazing water takes the
// glowing horizon's colour rather than the cool sky overhead.
// The glow takes the sun's colour deepened (squared), as a sunset sky's horizon is more saturated than the light itself;
// toward the sun's azimuth it replaces most of the cool sky light there.
swSkyRefl += swSun * (U.slateWaterSunColor.rgb * (swSkyH * swSkyLowSun * (0.25 + 0.35 * swSkyAz)) + vec3(swAura * (0.03 + 0.08 * swSkyLowSun) + swAura64 * 0.25));
swSkyRefl = mix(swSkyRefl, swSun * U.slateWaterSunColor.rgb * 0.8 + swSkyRefl * 0.4, swSkyH * swSkyLowSun * swSkyAz * 0.85);
swSkyRefl = mix(swSkyRefl, mix(U.slateWaterSky.rgb, U.slateWaterHorizon.rgb, 0.55) + swSun * (swSkyLowSun * (0.1 + 0.2 * swSkyAz)), smoothstep(0.05, 0.35, sqrt(swSlopeVariance)) * 0.5);
swSkyRefl *= U.slateWaterDeep.w;
#endif

// Foam is matte and lit: PBR shades it as albedo, and its roughness and coverage remove the mirror.
// Over known terrain the water also thins out over its last few centimetres of depth, so a bank never shows a hard lip.
float swEdgeFade = smoothstep(0.0, 0.2, swBank + 0.02) * swShoreSoft;
// Uncovered by the backwash, only the wet film is left: no water body, a faint sheen of sky and sun on the wet sand.
float swWaterFade = swEdgeFade * swSwashCover;
float swSheen = swSwashCover + swFilm * 0.4;
float swGloss = (1.0 - swFoam) * swEdgeFade * swSheen;
float swBodyGloss = (1.0 - swFoam) * swWaterFade;
// Foam is a neutral white scatterer: thick fresh foam is a little brighter than its fraying lace, which reads thinner
// through its lower coverage rather than through a grey colour.
// Its bubbles shade one another, so foam keeps an inner texture under any light instead of reading as flat paint.
surfaceAlbedo = U.slateWaterFoam.rgb * ((0.82 + 0.18 * swFoamThick) * (0.72 + 0.28 * smoothstep(0.15, 0.75, swFoamTex)) * swFoam * swEdgeFade);
swMatte = swFoam;
// The water's own light covers, per channel, what the transmittance leaves: over a bright bed its colour is the bed's
// light through the absorption, never a glow of its own.
vec3 swEmissive = swScatter * (vec3(1.0) - swScatterT) * ((1.0 - swFres) * swBodyGloss)
  + swGlow * ((1.0 - swFres) * swBodyGloss)
  + (swGlint + vec3(swSpark) * swSun) * swGloss;${fromTier(1, "", `
// The floor is not one even colour: wide, soft patches (the medium noise) keep its shallows from reading as a glow.
swEmissive += vec3(${LOW_BED.map(f).join(", ")}) * swLowBedT * (swAmb * 0.6 + swSun * max(swL.y, 0.0)) * ((1.0 - swFres) * (1.0 - swFoam) * swBodyGloss * (0.75 + 0.5 * swMedium));`)}
#ifndef ${REFRACTION}
// Without the refracted copy the caustics add their light over a known floor, through the water that shows it.
swEmissive += swSun * swTransmitRgb * (max(swCaustics, 0.0) * 0.15 * swKnown * (1.0 - swFres) * swBodyGloss);
#endif${fromTier(1, `
// Foam scatters skylight from every side: a little fill keeps it the brightest thing on the sea even under a dull sky.
swEmissive += surfaceAlbedo * swAmb * 0.25;`, `
// Low is unlit: the sun and sky light the foam here, as bright as Medium's lit foam (the environment adds its own).
swEmissive += surfaceAlbedo * (swSun * max(dot(swWaveN, swL), 0.0) * 0.4 + swAmb * 0.85);`)}
alpha = (1.0 - (1.0 - swFres * swSheen) * mix(1.0, swTransmit, swSwashCover) * (1.0 - swFoam)) * swEdgeFade;
// The wet band darkens what blends under it: coverage without light.
alpha = max(alpha, swWet * mix(0.35, 0.5, 1.0 - swSwashCover) * swEdgeFade);${ifDefined(REFRACTION, `
// The refracted scene replaces the blended background: the light transmitted through the water is the copy behind
// this point, tinted by the per-channel absorption and darkened under the wet band, so coverage keeps only the shore
// fade. It stays apart from the water's own light (\`swRefracted\`, see CUSTOM_FRAGMENT_BEFORE_FOG).
// Underwater daylight (\`UNDERWATER_COOL\`, \`UNDERWATER_WET\`): the bed's light cools toward a neutral blue-grey and
// darkens as wet sand does within the first half metre.
float swUnder = 1.0 - exp(-swDepth * 5.0);
swBackground = mix(swBackground, vec3(dot(swBackground, vec3(0.3, 0.59, 0.11))) * vec3(${UNDERWATER_TINT.map(f).join(", ")}), ${f(UNDERWATER_COOL)} * swUnder) * (1.0 - ${f(1 - UNDERWATER_WET)} * swUnder);
// Caustics concentrate the sunlight that reaches the floor into bright lines over dimmer cells.
swBackground *= 1.0 + swCaustics;
float swRefractedWeight = (1.0 - swFres) * swTransmit * (1.0 - swFoam) * swWaterFade * swRefracts;
vec3 swRefracted = swBackground * swTransmitRgb * mix(vec3(1.0), vec3(0.72, 0.68, 0.62), swWet) * ((1.0 - swFres) * (1.0 - swFoam) * swWaterFade * swRefracts);
// Uncovered shallows blend their film over the scene instead (the darkening above).
alpha = mix(alpha, max(alpha, swWaterFade), swRefracts);`)}
${objectReflectionSource("normalize(mix(reflect(-swV, swSwellNormal), normalize(swRefl), 0.25))", "sqrt(sqrt(U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w + 2.0 * swSlopeVariance))")}
#if ${REFLECTS_OBJECTS}
// A found object is one sharp sample of what a rough, wavy pixel mirrors: its coverage softens so the sky or
// environment shows through. Facets whose mirror ray pointed below the horizon reflect only the lifted ray, so those
// keep the sky; facets tilted far from the swell's own mirror direction hit stray parts of the scene, filtered
// roughness blurs the reflection toward the sky, and the hit mask's one-pixel edges are feathered. Objects are found
// along the swell's mirror ray (a quarter of the facet's own), so what they reflect is one wobbling mirror image that
// the chop's facets break up through this coverage: per-facet rays hit unrelated texels of the copy from pixel to
// pixel, which drew an island's beach as scattered, stair-stepped pale blocks on the water around it.
float swObjDeviation = length(normalize(swRefl) - reflect(-swV, swSwellNormal));
swObjRefl.a *= smoothstep(-0.01, 0.03, swReflRawY) * (1.0 - smoothstep(0.1, 0.4, swObjDeviation)) * (1.0 - 0.6 * smoothstep(0.02, 0.15, sqrt(swSlopeVariance)));
// Where neighbouring pixels' rays still fan out far wider than their view rays (steep swell some way off), each pixel's
// hit is an unrelated sample of the copy, so a found object would break into stair-stepped blocks of the copy's texels
// rather than a wobbling reflection: there the sky or environment shows instead.
swObjRefl.a *= 1.0 - smoothstep(12.0, 48.0, length(fwidth(swReflRay)) / max(length(fwidth(swV)), 0.00001));
swObjRefl.a *= 1.0 - 0.8 * min(fwidth(swObjRefl.a), 1.0);
#endif
`;
}

/** Whether a scene-copy tap read sky (no geometry nearer than the copy's sky depth): 1 or 0. */
const skyHit = (tap: string) => `step(${f(WATER_SCENE_COPY_SKY_THRESHOLD)}, ${tap}.a)`;
const skyTap = (name: string, x: number, y: string) => `
vec4 ${name} = swSceneTexel(vec2(${f(x)}, ${y}));`;
/**
 * Stylized, where the view's scene copy exists (`SAMPLES_COPY`; it holds the sky and opaque objects but not the water):
 * the real sky just above the horizon, read at fixed points across the screen on the row where the camera's heading
 * meets the horizon, so every pixel reads the same texels (no seams where rounding changes rows). Declares `swFwdH`,
 * `swHorOn` (0 with the horizon off screen), `swHorY` (that row) and `swHorSum` / `swHorN`, the sky taps' colour sum
 * and count (taps behind objects drop out): two taps, two more from High.
 */
function horizonCopySource(): string {
  return `
vec2 swFwdH = vec2(S.view[0][2], S.view[2][2]);
swFwdH = swFwdH / max(length(swFwdH), 0.0001);
vec4 swHorClip = S.viewProjection * vec4(swFwdH.x, 0.05, swFwdH.y, 0.0);
float swHorRaw = swHorClip.y / max(swHorClip.w, 0.0001) * 0.5 + 0.5;
float swHorOn = step(0.0001, swHorClip.w) * smoothstep(0.0, 0.03, swHorRaw) * (1.0 - smoothstep(0.96, 0.99, swHorRaw));
float swHorY = clamp(swHorRaw, 0.002, 0.998);${skyTap("swHorT0", 0.25, "swHorY")}${skyTap("swHorT1", 0.75, "swHorY")}
vec3 swHorSum = swHorT0.rgb * ${skyHit("swHorT0")} + swHorT1.rgb * ${skyHit("swHorT1")};
float swHorN = ${skyHit("swHorT0")} + ${skyHit("swHorT1")};${fromTier(2, `${skyTap("swHorT2", 0.06, "swHorY")}${skyTap("swHorT3", 0.94, "swHorY")}
swHorSum += swHorT2.rgb * ${skyHit("swHorT2")} + swHorT3.rgb * ${skyHit("swHorT3")};
swHorN += ${skyHit("swHorT2")} + ${skyHit("swHorT3")};`)}`;
}

/**
 * Stylized Painted (`SLATE_WATER_TOON` off): unlit but lit-looking water in the spirit of Sea of Thieves.
 *
 * The swell shapes big readable waves: navy troughs, blue-teal flanks and turquoise tops by the primary swell's height,
 * and a Fresnel reflection on the swell's own normal, so faces turned to the eye show the water's body while crests and
 * wave backs mirror the sky. Steep views shade a phase-bent copy of the swell, so its few components never print a
 * lattice from above; close up the chop's crests are painted ridges and the light falls on the ripples in soft steps. A
 * luminous emerald band glows on the faces just under each crest seen at grazing angles, strongest looking toward the
 * sun (Subsurface). The sky is a soft painted gradient leaning toward the water's hue: the view's scene copy read at
 * fixed points from Medium up (where refraction runs), otherwise an analytic sky from the scene's background colour,
 * sky light and sun. The sun draws a glossy sheen on the swell and a path of crisp marks (a world grid lit where the
 * chop's facets turn the sun to the eye, a finer grid near the eye), a warm halo on far water and, from Medium, star
 * sparkles. Shallows absorb red first so the bed turns turquoise, with drifting caustics on it. Foam is soft lace with
 * round holes: caps on the primary swell's crests where the sea is steep, ribbons trailing down the wave backs, wind
 * streaks, a lacy shore band with wash lines, and a thin collar with a small wreath at every object. Every term is ALU
 * on Low; Medium adds the copy-sampled sky, two lace octaves, a second wash band, drifting streaks and sparkles; High
 * and Ultra soften the sky with two more copy taps and add the lace's holes and a finer octave.
 */
function paintedSource(): string {
  const { crestFoam, surfaceFoam, subsurface, sparkles } = WATER_FEATURE_DEFINES;
  // Seen from above, the swell's few components interfere into a regular lattice of identical bumps. For the shading of
  // steep views each component's phase drifts across the shared noises (so its crests curve) and its strength drifts
  // too (paired in opposition, like the chop), so the pattern changes from place to place; grazing views keep the true
  // swell, whose silhouettes the geometry draws.
  const swellDrift = ["swLarge", "1.0 - swLarge", "swGust", "1.0 - swGust", "swLarge * 0.5 + swMedium * 0.5", "1.0 - swGust * 0.5 - swMedium * 0.5", "swGust * 0.5 + swMedium * 0.5", "1.0 - swLarge * 0.5 - swMedium * 0.5"];
  const swellBend = [[2.6, 1.7], [-3.1, -2.4], [3.7, -1.3], [-2.2, 2.8], [4.1, -1.9], [-3.5, 1.5], [2.9, -2.6], [-4.4, 2.1]];
  const visualSwell = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => fromTier(swellTier(i), `
float swVm${i} = ${i === 0 ? "0.7 + 0.6" : "0.1 + 0.6"} * smoothstep(0.3, 0.7, ${swellDrift[i]});
float swVp${i} = swP${i} + (swLarge - 0.5) * ${f(swellBend[i]![0]!)} + (swGust - 0.5) * ${f(swellBend[i]![1]!)};
float swVs${i} = sin(swVp${i});
float swVc${i} = cos(swVp${i});
float swVe${i} = exp(swVs${i} - 1.0);
swVisG += swD${i} * (mix(swVc${i}, swVe${i} * swVc${i} / ${f(WATER_CREST_RANGE)}, swChopShape) * swK${i} * swF${i} * swVm${i});
swVisH += mix(swVs${i}, (swVe${i} - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swChopShape) * swF${i} * swVm${i};
swVisA += swA${i} * swA${i} * swVm${i} * swVm${i};`)).join("");
  return surfaceSource("painted") + `
vec3 swV = viewDirectionW;
float swUp = clamp(swV.y, 0.0, 1.0);
float swGraze = 1.0 - swUp;
vec3 swLumW = vec3(0.3, 0.59, 0.11);
// The scene's sun above the horizon and its sky light. Their brightness lights the water; their hue tints it.
float swSunUp = smoothstep(-0.02, 0.12, swL.y);
vec3 swKey = swSun * swSunUp;
float swAmbLum = dot(swAmb, swLumW);
float swKeyLum = dot(swKey, swLumW);
vec3 swAmbHue = swAmb / max(swAmbLum, 0.001);
vec3 swKeyHue = U.slateWaterSunColor.rgb / max(dot(U.slateWaterSunColor.rgb, swLumW), 0.001);
vec2 swSunH = swL.xz / max(length(swL.xz), 0.0001);
// Horizontal direction toward the eye.
vec2 swEyeH = swV.xz / max(length(swV.xz), 0.0001);
float swLowSun = (1.0 - smoothstep(0.02, 0.4, swL.y)) * swSunUp;
// How warm the sun's colour is (0 white, 1 orange): only a warm low sun gilds the sky and the water.
float swWarm = clamp((U.slateWaterSunColor.r - U.slateWaterSunColor.b) / max(U.slateWaterSunColor.r, 0.001) * 1.5, 0.0, 1.0);
// How clear the sky is: the sun standing out against the sky light (CPU) or simply bright; 0 overcast.
float swClear = max(U.slateWaterSky.w, smoothstep(0.6, 1.1, U.slateWaterSun.w));
float swGrey = (1.0 - swClear * swClear) * smoothstep(0.12, 0.3, swAmbLum);
vec3 swShallowC = U.slateWaterShallow.rgb;
vec3 swDeepC = U.slateWaterDeep.rgb;
// The water's own hue (Deep Color, brightness removed): reflections lean toward it so the sea keeps its identity.
vec3 swWaterHue = clamp(swDeepC / max(dot(swDeepC, swLumW), 0.001), vec3(0.0), vec3(1.6));

// Depth: the bed's depth sets the colour (refraction only bounds what shows through, so an object in deep water never
// turns the sea around it into shallows). Color Bands, when set, quantise it with crisp edges.
#if ${SAMPLES_COPY}
float swBedTone = 1.0 - exp(-swBedDepth * 2.0 / swAbsorb);
#else
float swBedTone = swTone;
#endif
float swBandCount = max(1.0, U.slateWaterLook.x);
float swBand = swBedTone * swBandCount;
float swBandAA = min(fwidth(swBand) * 0.75 + 0.015, 0.5);
float swBanded = (floor(swBand) + smoothstep(0.5 - swBandAA, 0.5 + swBandAA, fract(swBand))) / swBandCount;
swBedTone = mix(swBedTone, swBanded, step(1.5, U.slateWaterLook.x));
// Distance to the shore at rest (metres): the body's own bank and, over known terrain, the field's stored distance to
// the terrain's rest shoreline (a smooth, filtered distance field).
float swRestShore = max(0.0, min(max(0.0, swBankV), mix(${f(SHORE[1])}, mix(${f(SHORE[0])}, ${f(SHORE[1])}, swField.r), swKnown)));
// A clear turquoise lagoon hugs every shore several metres out, however steeply the bed drops: sand-tinted right at
// the shore, then turquoise, then the open water's colour.
float swLagoon = exp(-swRestShore / (4.0 + swFoamWidth * 3.0));
swBedTone = min(swBedTone, 1.0 - 0.8 * swLagoon);

// Body colour. Open water is Deep Color looking down, a little lighter and bluer toward grazing views (a longer path
// through the water), with Color Variation drifting wide areas greener; shallows scatter a deep turquoise from Shallow
// Color, darker with the copy, where the bed itself shows through the transmittance below.
float swVariation = U.slateWaterSwellInfo.z;
vec3 swOpenC = mix(swDeepC, swDeepC * vec3(0.9, 1.15, 1.25) + swShallowC * 0.03, smoothstep(0.2, 1.0, swGraze) * 0.7);
swOpenC = mix(swOpenC, mix(swDeepC, swShallowC, 0.22), smoothstep(0.35, 0.8, swDrift) * swVariation * 0.7);
swOpenC = mix(swOpenC, swDeepC * vec3(0.8, 0.85, 1.0), (1.0 - smoothstep(0.15, 0.5, swDrift)) * swVariation * 0.5);
#ifdef ${REFRACTION}
vec3 swBody = mix(swShallowC * vec3(0.1, 0.24, 0.42), swOpenC, swBedTone);
#else
vec3 swBody = mix(swShallowC * vec3(0.16, 0.5, 0.82), swOpenC, swBedTone);
#endif

// Wave form. Close up, short wind ripples shade the water as well: from Medium two crossing families (the first two
// capillary octaves), both everywhere, whose strengths drift in opposition across patches a few metres wide, and from
// High a third at a wide angle to both; their phases drift across the shared noises. (One dominant family drew even,
// parallel ridges close up, like sand ripples or ribbed fabric.) Low draws two crossing families as smoothed triangle
// waves (ALU only, no transcendentals).
float swNearSwell = 1.0 - smoothstep(0.25, 1.2, swFoot);
vec2 swRippleUv = swChop + (vec2(swFine, swMedium) - vec2(0.5)) * 0.45;
vec4 swCC0 = U.${CAPILLARY_UNIFORMS[0]};
float swCX0 = swCC0.z * dot(swCC0.xy, swRippleUv) + swCC0.w + swMedium * 2.5 - swLarge * 1.5;
// Low's triangle ripples fade sooner, before their regular creases read as stripes.${fromTier(1, `
vec2 swCapRange = vec2(0.25, 0.8);`, `
vec2 swCapRange = vec2(0.08, 0.35);`)}
float swCFd0 = (1.0 - smoothstep(swCapRange.x, swCapRange.y, swCC0.z * swFoot * 0.64)) * (0.2 + 1.2 * swMedium * swFine);${fromTier(1, `
// The two families' strengths in opposition across patches (the medium and large noises). All families fade together
// where the finer one would alias: the longer one alone would draw even rows of lines across mid-distance water.
float swRA = smoothstep(0.25, 0.75, swMedium * 0.7 + swLarge * 0.3);
vec4 swCC1 = U.${CAPILLARY_UNIFORMS[1]};
float swCFdR = 1.0 - smoothstep(swCapRange.x, swCapRange.y, swCC1.z * swFoot * 0.64);
float swCE0 = exp(sin(swCX0) - 1.0);
float swCA0 = swCFdR * (0.45 + 0.6 * swRA) * (0.6 + 0.8 * swFine);
vec2 swRipples = swCC0.xy * (swCE0 * cos(swCX0) * swCA0);
float swCX1 = swCC1.z * dot(swCC1.xy, swRippleUv) + swCC1.w - swMedium * 2.0 + swLarge * 1.8;
float swCE1 = exp(sin(swCX1) - 1.0);
float swCA1 = swCFdR * (0.45 + 0.6 * (1.0 - swRA)) * (1.4 - 0.8 * swFine);
swRipples += swCC1.xy * (swCE1 * cos(swCX1) * swCA1);${fromTier(2, `
// High: a third family, about 70 degrees from the first, between the two in wavelength, on the third capillary's clock.
vec4 swCC2 = U.${CAPILLARY_UNIFORMS[2]};
vec2 swCD2 = vec2(swCC0.x * 0.34 - swCC0.y * 0.94, swCC0.x * 0.94 + swCC0.y * 0.34);
float swCX2 = swCC0.z * 1.31 * dot(swCD2, swRippleUv) + swCC2.w + swMedium * 1.7 + swLarge * 2.3;
float swCE2 = exp(sin(swCX2) - 1.0);
float swCA2 = 0.55 * swCFdR * (0.5 + 0.7 * swMedium);
swRipples += swCD2 * (swCE2 * cos(swCX2) * swCA2);`, `
float swCE2 = 0.0;
float swCA2 = 0.0;`)}`, `
// The triangle families bend along a shared slow sine (one transcendental), so they curve like High's families instead
// of running as straight, evenly spaced lines that converge toward the horizon like a rake.
float swLowBend = sin(dot(swRippleUv, vec2(0.83, 0.55)) * swCC0.z * 0.29 + swLarge * 4.0);
float swRw = fract(swCX0 * ${f(1 / (2 * Math.PI))} + swMedium * 0.6 + swLowBend * 0.24);
float swTri = abs(swRw * 2.0 - 1.0);
// A second family across the first, the two fading in opposition across drifting patches (no regular stripes).
vec4 swCC1 = U.${CAPILLARY_UNIFORMS[1]};
float swRw1 = fract((swCC1.z * dot(swCC1.xy, swRippleUv) + swCC1.w) * ${f(1 / (2 * Math.PI))} - swMedium * 0.9 + swLarge * 0.5 - swLowBend * 0.19);
float swTri1 = abs(swRw1 * 2.0 - 1.0);
float swRA = smoothstep(0.3, 0.7, swMedium);
vec2 swRipples = swCC0.xy * (sign(swRw - 0.5) * swTri * (1.0 - swTri) * (1.4 * swRA) * swCFd0)
  + swCC1.xy * (sign(swRw1 - 0.5) * swTri1 * (1.0 - swTri1) * (1.3 - 1.3 * swRA) * (1.0 - smoothstep(0.08, 0.35, swCC1.z * swFoot * 0.64)));
// Low evaluates one chop octave, which close up reads as regular stripes: a crossing wavelet along the second octave's
// direction, its phase bent by the shared noises, breaks them up.
vec4 swOCb = U.${CHOP_UNIFORMS[1]};
float swLw = fract((swOCb.z * dot(swOCb.xy, swChop) + swOCb.w + swChopShift * ${f(CHOP_SHIFT[1])}${chopFm(1)}) * ${f(1 / (2 * Math.PI))} + swMedium * 1.3 - swLarge * 0.7 + swLowBend * 0.16);
float swLt = abs(swLw * 2.0 - 1.0);
swRipples += swOCb.xy * (sign(swLw - 0.5) * swLt * (1.0 - swLt) * 1.0 * (1.0 - smoothstep(0.06, 0.2, swOCb.z * swFoot)) * (0.4 + 0.9 * swMedium));`)}
float swCloseUp = 1.0 - smoothstep(0.01, 0.06, swFoot);${fromTier(1, `
// The families' crests together (each 0 to 1): highest only where their crests meet, so crest lights fall in short,
// scattered pieces rather than along one family's even rows.
float swRippleCrest = (swCE0 * swCA0 + swCE1 * swCA1 + swCE2 * swCA2) / max(swCA0 + swCA1 + swCA2, 0.0001);`, `
float swRippleCrest = (1.0 - swTri) * (1.0 - swTri);`)}
// Seen from above the swell's crossing components print a regular pattern: their shading drifts in strength across
// wide patches there.
float swMacro = smoothstep(0.2, 0.8, swLarge * 0.55 + swGust * 0.25 + swMedium * 0.2);
float swPatch = mix(1.0, 0.15 + 0.85 * swMacro, swUp * swUp);
float swTopDown = smoothstep(0.3, 0.85, swUp);
vec2 swVisG = vec2(0.0);
float swVisH = 0.0;
float swVisA = 0.0;${visualSwell}
swVisA = ${f(PRIMARY_RMS)} * sqrt(swVisA);
swVisG = vec2(dot(swSwellWarpM.xy, swVisG), dot(swSwellWarpM.yz, swVisG));
// Far away (where the mesh no longer draws the swell's silhouettes) the phase-bent copy shades the water too, so the
// far field never reads as one wave train's even rows running to the horizon.
float swVisMix = max(smoothstep(0.12, 0.5, swUp), 0.75 * smoothstep(0.2, 0.9, swFoot));
vec2 swSwellShadeG = mix(swGradient, swVisG, swVisMix);
// Low's single chop octave would draw regular satin ribbons: it shades less, unevenly.${fromTier(1, `
float swChopShade = 1.0 + 0.4 * swCloseUp;`, `
float swChopShade = 0.15 + 0.35 * swMedium;`)}
vec2 swShadeSlope = swSwellShadeG * ((1.0 + 0.5 * swNearSwell) * swPatch) + swDetail * (swChopGain * swChopShade) + swRipples * (U.slateWaterMotion.z * (0.7 + 0.4 * swCloseUp)) + swRipple * 2.0;
vec3 swShadeN = normalize(vec3(swBaseX - swShadeSlope.x, 1.0, swBaseZ - swShadeSlope.y));
float swNL = dot(swShadeN, swL);
float swFacing = clamp(0.5 + (swNL - swL.y) * 1.8, 0.0, 1.0);
float swShade = swFacing * swFacing * (3.0 - 2.0 * swFacing);
// The primary swell: its height (-1 trough to 1 crest) and its surface normal, the broad shape the eye reads as waves.
float swPrimN = swPrimH / max(swPrimAmp, 0.0001);
vec3 swPrimNormal = normalize(vec3(swBaseX - swPrimG.x, 1.0, swBaseZ - swPrimG.y));
// 0 in the primary swell's troughs, 1 on its crests; the shorter swell and the chop add a little.
float swSwellT = mix(0.5 + 0.5 * swPrimN + 0.25 * (swHeight - swPrimH) / max(U.slateWaterWaves.x, 0.001), 0.5 + 0.5 * swVisH / max(swVisA, 0.0001), swVisMix);
float swWaveT = clamp(swSwellT + swChopH * 0.3, 0.0, 1.0);
// Seen from above the height contrast also drifts across wide patches. Toward the horizon it eases too, unevenly across
// the gust and large noises (tens of metres, along the crests as much as across them), so far crest rows fade in and
// out in patches instead of banding the whole sea into even stripes.
float swHeightK = mix(1.0, 0.15 + 0.85 * swMacro, swTopDown)
  * mix(1.0, 0.3 + 0.7 * smoothstep(0.3, 0.7, swGust * 0.6 + swLarge * 0.4), smoothstep(0.35, 1.6, swFoot));
// The face rising toward a crest away from the eye, relative to the primary swell's own slope: the water under the crest
// is thin there and light passes through it toward the viewer.
float swRise = dot(swPrimG, -swEyeH) * swPrimLen / max(swPrimAmp, 0.0001);
// Light passes through a crest toward the eye only when the eye looks nearly along the surface: looking down onto a
// crest (close up, or from above) shows no glow.
float swThin = smoothstep(0.0, 0.6, swRise) * smoothstep(0.55, 0.85, swGraze);${fromTier(2, `
float swGlowH = clamp(0.5 + 0.5 * swPrimN + swChopH * 0.5, 0.0, 1.2);`, `
float swGlowH = clamp(0.5 + 0.5 * swPrimN + swChopH * 0.3, 0.0, 1.2);`)}
float swUnder = smoothstep(0.55, 0.85, swGlowH) * (1.0 - 0.7 * smoothstep(0.97, 1.12, swGlowH));
float swCrestFace = swUnder * swThin * mix(1.0, swHeightK, 0.8);
// Three tones by height: navy troughs, blue-teal flanks and turquoise tops (Shallow Color in part). Seen from above the
// swell's interference would print a dimple lattice, so the height contrast eases toward steep views, unevenly; over
// shallows the bed's colour dominates instead.
float swHeightT = clamp(0.5 + (swSwellT - 0.5) * swHeightK + swChopH * (0.25 + 0.5 * swCloseUp) * min(swChopShade, 1.0), 0.0, 1.0);
vec3 swTroughC = swBody * vec3(0.5, 0.56, 0.68);
vec3 swFlankC = swBody * vec3(0.92, 1.12, 1.08) * 1.25;
vec3 swTopC = mix(swBody * vec3(1.0, 1.3, 1.18), swShallowC * 0.5, 0.25 * swBedTone) * 1.35;
vec3 swBodyLit = mix(swTroughC, swFlankC, smoothstep(0.1, 0.55, swHeightT));
swBodyLit = mix(swBodyLit, swTopC, smoothstep(0.55, 0.95, swHeightT) * 0.9);
// Faces turned to the sun lean a little lighter and greener; close up the ripples shade it too.
swBodyLit = mix(swBodyLit, swBodyLit * vec3(0.9, 1.12, 1.0), swShade * 0.5);
// Close up the light falls on the ripples in two soft painted steps rather than a smooth satin gradient, gently: hard
// terraces on every ripple's lit and shaded side read as sand dunes.
float swShadeClose = clamp(0.5 + (swNL - swL.y) * 3.0, 0.0, 1.0);
swShadeClose = smoothstep(0.2, 0.45, swShadeClose) * 0.5 + smoothstep(0.55, 0.8, swShadeClose) * 0.5;
swBodyLit = mix(swBodyLit, mix(swBodyLit * vec3(0.8, 0.86, 0.93), swBodyLit * vec3(1.0, 1.2, 1.15), swShadeClose), swCloseUp * 0.45);
// The chop's sharp crests near the eye are painted ridges of lighter, greener water over darker hollows.
float swRidge = smoothstep(0.72, 0.93, swOW0) * (1.0 - smoothstep(0.15, 0.5, swOC0.z * swFoot)) * smoothstep(0.1, 0.4, swChopGain);
swBodyLit = mix(swBodyLit, swBodyLit * vec3(1.05, 1.3, 1.25), swRidge * 0.55);
// Ripple crests close up are crisp painted touches of light where the families' crests meet.
swBodyLit = mix(swBodyLit, swBodyLit * vec3(1.1, 1.55, 1.48), smoothstep(0.62, 0.85, swRippleCrest) * clamp(swCFd0 * 1.6, 0.0, 1.0) * swCloseUp * 0.7);
// Sky light (its hue in part) and the sun; a floor keeps the colours readable lit only by an environment.
vec3 swAmbTint = mix(vec3(1.0), swAmbHue, 0.45);
vec3 swKeyTint = mix(vec3(1.0), swKeyHue, 0.6);
// A low sun's light mostly glances off the surface: less of it lights the body.
vec3 swLight = swAmbTint * max(swAmbLum, 0.3) + swKeyTint * (swKeyLum * (0.15 + 0.55 * swShade) * (0.35 + 0.65 * smoothstep(0.05, 0.45, swL.y)));
vec3 swLit = swBodyLit * swLight;
// Emerald glow of light through the water: Shallow Color leaning green, a little of the sun's hue.
// A warm low sun shifts it toward green-gold (a teal glow is off-key under a sunset).
float swDuskWarm = swWarm * swLowSun;
vec3 swGlowC = swShallowC * vec3(0.55, 1.0, 0.72) * mix(vec3(1.0), swKeyHue, 0.25 + 0.5 * swDuskWarm);
float swGlow = 0.0;${ifDefined(subsurface, `
// Subsurface: sunlight through each wave body on the crest face, strongest looking toward the sun (by azimuth, and a
// lobe around the light's own direction bent by the swell), weaker from other sides with the sky's light. A sun on the
// horizon is dim and red and the water absorbs it, so a warm low sun glows less.
float swSss = U.slateWaterLook.w;
float swToSun = clamp(dot(-swEyeH, swSunH) * 0.5 + 0.5, 0.0, 1.0);
swToSun *= swToSun;
vec3 swSssDir = normalize(swL + swPrimNormal * 0.5);
float swBack = clamp(dot(swV, -swSssDir), 0.0, 1.0);
swBack *= swBack;
swBack *= swBack;
float swGlowSun = swKeyLum * smoothstep(0.02, 0.15, swL.y) * (1.0 - 0.6 * swWarm * swLowSun);
// Thin faces glow where the water is thin and the crest is near and in the foreground: the glow fades with the pixel
// footprint and the distance (a crest a few pixels thick would otherwise be a neon line across the whole view), and
// varies along each crest by the wide noises, so a long crest glows in patches instead of one unbroken band.
float swGlowNear = (1.0 - smoothstep(0.12, 0.6, swFoot)) * exp(-swEyeDist * 0.05);
float swGlowAlong = 0.1 + 0.9 * smoothstep(0.3, 0.7, swMedium * 0.5 + swLarge * 0.3 + swGust * 0.2);
swGlow = min(swCrestFace * (swGlowSun * (0.2 + 0.8 * swToSun + 1.2 * swBack) + swAmbLum * 0.25) * swSss, 1.0) * swGlowAlong * swGlowNear;
swLit += swGlowC * swGlow;`)}

// Sky: the scene's background (or fog) colour, deeper overhead and brighter at the horizon, tinted by the sky light's
// hue, under a clear sky; the sky light's own grey under an overcast one.
vec3 swOvercast = swAmbHue * swAmbLum;
vec3 swSkyTint = mix(vec3(1.0), swAmbHue, 0.5);
vec3 swZenith = mix(U.slateWaterHorizon.rgb * vec3(0.55, 0.75, 0.95) * swSkyTint, swOvercast * 0.6, swGrey);
vec3 swHorizonSky = mix((U.slateWaterHorizon.rgb * vec3(1.0, 1.1, 1.08) + vec3(0.02, 0.04, 0.06)) * swSkyTint, swOvercast * 0.75, swGrey);
#if ${SAMPLES_COPY}
// From Medium (where the view's scene copy exists; it holds the sky and opaque objects but not the water) the actual
// sky's colours replace both: read just above the horizon and near the top of the view, at fixed points across the
// screen, so the reflection is a smooth painted gradient of the real sky. (Reading the reflected direction itself
// mirrored every cloud through the waves: marbling up close and a comb of streaks along the horizon.) Taps behind
// objects drop out; with the horizon off screen the analytic sky stays.${horizonCopySource()}
vec4 swTopClip = S.viewProjection * vec4(swFwdH.x * 0.66, 0.75, swFwdH.y * 0.66, 0.0);
float swTopY = max(mix(clamp(swTopClip.y / max(swTopClip.w, 0.0001) * 0.5 + 0.5, 0.002, 0.998), 0.998, step(swTopClip.w, 0.0001)), min(swHorY + 0.04, 0.998));${skyTap("swTopT0", 0.5, "swTopY")}
vec3 swTopSum = swTopT0.rgb * ${skyHit("swTopT0")};
float swTopN = ${skyHit("swTopT0")};${fromTier(2, `${skyTap("swTopT1", 0.15, "swTopY")}${skyTap("swTopT2", 0.85, "swTopY")}
swTopSum += swTopT1.rgb * ${skyHit("swTopT1")} + swTopT2.rgb * ${skyHit("swTopT2")};
swTopN += ${skyHit("swTopT1")} + ${skyHit("swTopT2")};`)}
// Half the analytic sky stays, and the read colours keep their saturation, so a cloudy band never turns the sea grey.
vec3 swHorCopy = swHorSum / max(swHorN, 0.001);
vec3 swTopCopy = swTopSum / max(swTopN, 0.001);
swHorCopy = max(mix(vec3(dot(swHorCopy, swLumW)), swHorCopy, 1.2), vec3(0.0));
swTopCopy = max(mix(vec3(dot(swTopCopy, swLumW)), swTopCopy, 1.2), vec3(0.0));
swHorizonSky = mix(swHorizonSky, swHorCopy, swHorOn * min(swHorN, 1.0) * 0.5);
swZenith = mix(swZenith, swTopCopy, swHorOn * min(swTopN, 1.0) * 0.25);
#endif

// Reflection on the swell's own normal (each component already faded where it would alias) with a little chop close
// to the eye: faces turned toward the eye show the water's body, crests and the backs of waves mirror the sky, so each
// wave reads as a silhouette. Under an overcast sky the mirror is flatter and softer.
float swFar = smoothstep(0.12, 1.0, swFoot);
vec2 swReflSlope = (swSwellShadeG + swDetail * (swChopGain * 0.3 * (1.0 - swFar) * min(swChopShade, 1.0))) * mix(1.0, swPatch, 0.6) * (1.0 - 0.6 * swGrey);
// Close up the ripples and some more of the chop tilt it too, so near water reads glassy; the full chop would mirror
// the bright horizon in streaks that read as foam.
float swReflNear = 1.0 - smoothstep(0.03, 0.3, swFoot);
swReflSlope += (swDetail * (swChopGain * 0.3 * min(swChopShade, 1.0)) + swRipples * (U.slateWaterMotion.z * 0.8)) * swReflNear;
vec3 swReflN = normalize(vec3(swBaseX - swReflSlope.x, 1.0, swBaseZ - swReflSlope.y));
float swNdotV = clamp(dot(swReflN, swV), 0.0, 1.0);
float swFx = 1.0 - swNdotV;
float swFx2 = swFx * swFx;
float swFres = 0.02 + 0.98 * swFx2 * swFx2 * swFx;
vec3 swRefl = reflect(-swV, swReflN);
// Keep reflected rays a little above the horizon (a smooth maximum), so wave backs reflect sky, not more sea.
swRefl.y = swRefl.y + log(1.0 + exp(24.0 * (0.06 - swRefl.y))) / 24.0;
swRefl = normalize(swRefl);
// A warm low sun gilds the horizon, brightest and most golden where the reflected rays of the waves point toward its
// azimuth and a darker, partly gilded sky farther from it, so the far sea carries a bright golden path that breaks with
// the waves. (The gilding used to saturate at every azimuth: one flat, uniform gold band across the far sea.)
float swSkyAz = clamp(dot(swRefl.xz / max(length(swRefl.xz), 0.0001), swSunH), 0.0, 1.0);
swSkyAz *= swSkyAz;
float swSkyAz8 = swSkyAz * swSkyAz;
swSkyAz8 *= swSkyAz8;
float swSkyAz32 = swSkyAz8 * swSkyAz8;
swSkyAz32 *= swSkyAz32;
vec3 swGold = mix(swKeyHue, swKeyHue * swKeyHue / max(dot(swKeyHue * swKeyHue, swLumW), 0.001), 0.5);
float swGild = clamp((0.45 + 0.35 * swSkyAz8 + 0.4 * swSkyAz32) * swLowSun * 1.3, 0.0, 1.0) * swWarm;
swHorizonSky = mix(swHorizonSky, swGold * (dot(swHorizonSky, swLumW) * (0.6 + 0.4 * swSkyAz8) + swKeyLum * (0.08 + 0.6 * swSkyAz32)), swGild);
vec3 swSky = mix(swHorizonSky, swZenith, smoothstep(0.03, 0.5, swRefl.y));
// The mirrored sky leans toward the water's hue (more on Low, whose analytic sky is plainer), so the far sea is a
// deeper, bluer colour than the sky it meets and never turns lavender or milky.${fromTier(1, `
float swReflTint = 0.2;`, `
float swReflTint = 0.15;
swSky = mix(vec3(dot(swSky, swLumW)), swSky, 0.7);`)}
swSky = swSky * mix(vec3(1.0), swWaterHue, swReflTint) * (0.8 - 0.1 * swGrey);
// Reflection stays below a mirror's, lower near the eye where the body carries the waves; glowing crest faces keep
// their light.
// A warm low sun lets grazing water mirror more of its gilded sky, so a sunset sea stays warm rather than grey-taupe.
float swReflAmt = min(max(swFres, 0.05 * swCloseUp) * U.slateWaterDeep.w, mix(0.5, 0.75, smoothstep(0.05, 0.8, swFoot)) + 0.18 * swDuskWarm) * (1.0 - 0.5 * swGlow) * (1.0 - 0.3 * swGrey);

// The sun. A glossy sheen on the swell around its reflection, and a path of crisp marks: a world grid of short dashes
// (perspective draws them out across the view) lit only where the chop's facets (with the ripples close up) turn the
// sun toward the eye, so the path breaks into glints that follow the waves. Close to the eye a four times finer grid
// takes over, so marks stay small sparkles instead of growing into puddles; each grid fades to its even share before
// its marks would shrink under a pixel. A broad lobe on the swell places the halo on far water and, from Medium, star
// sparkles. The sparkles' lobe widens by its normal's variation across the pixel (\`PIXEL_SLOPE_FILTER\`, the slope's
// screen derivatives) and dims by the same factor, so chop the pixel cannot sample densely enough never sparkles.
float swSunVis = swSunUp * min(1.0, U.slateWaterSun.w) * (0.35 + 0.65 * swClear);
vec2 swLobeSlope = swGradient + swDetail * (swChopGain * 0.8);
vec3 swLobeN = normalize(vec3(swBaseX - swLobeSlope.x, 1.0, swBaseZ - swLobeSlope.y));
float swLobeA = dot(reflect(-swV, swLobeN), swL);
vec2 swLobeDx = dFdx(swLobeSlope);
vec2 swLobeDy = dFdy(swLobeSlope);
float swLobeW0 = 0.012 + 0.03 * U.slateWaterOrigin.w + 0.02 * swLowSun;
float swLobeW = swLobeW0 + 2.0 * min((dot(swLobeDx, swLobeDx) + dot(swLobeDy, swLobeDy)) * ${f(PIXEL_SLOPE_FILTER / 2)}, ${f(PIXEL_SLOPE_CAP)});
// The facets that light the marks: the swell and the chop, not the fast ripple families, whose facets turn too far
// between frames and flickered the marks on and off. A wider facet lobe, so a lit stretch of water stays lit.
vec2 swGlintSlope = swGradient + swDetail * (swChopGain * 1.3);
vec3 swGlintN = normalize(vec3(swBaseX - swGlintSlope.x, 1.0, swBaseZ - swGlintSlope.y));
float swAlign = dot(reflect(-swV, swGlintN), swL);
float swFacetW = 0.01 + 0.02 * U.slateWaterOrigin.w + 0.01 * swLowSun;
// The facets' crisp edge is antialiased by how fast the alignment changes per pixel: a facet line thinner than a pixel
// spreads over one and dims by its coverage, instead of sparkling from pixel to pixel.
float swAlignAA = fwidth(swAlign);
float swFacet = smoothstep(1.0 - swFacetW * 2.0 - swAlignAA, 1.0 - swFacetW * 0.3, swAlign) * (swFacetW * 2.0 / (swFacetW * 2.0 + swAlignAA));
float swSheenA = clamp(dot(swPrimNormal, normalize(swL + swV)), 0.0, 1.0);
float swSheen2 = swSheenA * swSheenA;
float swSheen8 = swSheen2 * swSheen2;
swSheen8 *= swSheen8;
float swSheen64 = swSheen8 * swSheen8;
swSheen64 *= swSheen64;
float swPathFar0 = smoothstep(0.15, 3.0, swFoot);
float swSheen = swSheen64 * 0.1 * swSunVis * (1.0 - 0.6 * swGrey) * (1.0 - 0.5 * swPathFar0);
// Marks and sparkles need a sun that stands out (none under an overcast or storm sky, where only the sheen and halo
// stay), and only where the sun's reflection falls on the swell's broad shape (a wide lobe on the low-frequency normal):
// close water looked down into off the sun's line never sparkles.
float swGlintVis = swSunVis * smoothstep(0.15, 0.6, swClear);
vec2 swGateSlope = swGradient + swDetail * (swChopGain * 0.3);
float swGateA = dot(reflect(-swV, normalize(vec3(swBaseX - swGateSlope.x, 1.0, swBaseZ - swGateSlope.y))), swL);
// A real sun path narrows and dims with distance (the reflection's lobe is compressed by the foreshortening, as
// Realistic's \`swFarSun\`): past a few tens of metres its gate closes to about half its width and its energy falls, so
// the far path never washes the whole sea to white.
float swPathFar = smoothstep(0.15, 3.0, swFoot);
float swSunGate = smoothstep(1.0 - swLobeW0 * 4.0 * (1.0 - 0.5 * swPathFar), 1.0 - swLobeW0 * 1.2 * (1.0 - 0.5 * swPathFar), swGateA);
// Marks (\`swMark\`): streaks drawn out across the view (perspective lengthens them further), anchored to the water's
// rest surface so they ride the waves instead of sliding over them, each lit for a fixed share of a slow cycle and
// brightening and fading smoothly over it, so none switches on or off between frames; the facets set how bright a lit
// streak is. Their grid's scale follows the pixel footprint in octaves (two neighbouring octaves crossfaded, each seeded
// by its absolute level), so a cell is always about 14 to 28 pixels deep and a streak never thins under about three
// pixels (thinner streaks shimmered as morse code) nor grows into a puddle close up; far away perspective draws them out
// into long, thin dashes. Their brightness saturates softly below white, tinted by the sun, so the path never clips
// into flickering pure-white pixels.
vec2 swDashUv = (swRest + U.slateWaterOrigin.xz - IN.vSlateWaterFlow.xy * swTime) * (1.8 * U.slateWaterMotion.y) + vec2(swMedium, swLarge) * 1.7;
vec2 swDashUx = dFdx(swDashUv);
vec2 swDashUy = dFdy(swDashUv);
vec2 swDashAcross = vec2(-swEyeH.y, swEyeH.x);
float swDashP = 0.2 + 0.6 * swFacet;
float swDashLevel = clamp(log2(max(length(swDashUx), length(swDashUy)) * 14.0), -3.0, 5.0);
float swDashL0 = floor(swDashLevel);
float swDashS0 = exp2(-swDashL0);
float swDashA = swMark(swDashUv * swDashS0, swDashUx * swDashS0, swDashUy * swDashS0, swDashAcross, vec2(0.42, 0.11), 0.5, swTime, vec2(41.0, 13.0) + vec2(7.13, 3.71) * swDashL0);
float swDashB = swMark(swDashUv * (swDashS0 * 0.5), swDashUx * (swDashS0 * 0.5), swDashUy * (swDashS0 * 0.5), swDashAcross, vec2(0.42, 0.11), 0.5, swTime, vec2(41.0, 13.0) + vec2(7.13, 3.71) * (swDashL0 + 1.0));
float swDash = mix(swDashA, swDashB, fract(swDashLevel));
// Past the coarsest octave (about a hundred metres per cell's depth, at the horizon) an even share.
swDash = mix(swDash * (0.6 + 1.6 * swFacet), swDashP * 0.2, smoothstep(4.0, 5.0, log2(max(length(swDashUx), length(swDashUy)) * 14.0)));
float swPath = (0.2 + 0.8 * swFacet) * swSunGate * swDash * 1.5 * swGlintVis * (1.0 + 0.6 * swLowSun);
swPath = 0.95 * (1.0 - exp(-swPath * 1.6)) * (1.0 - 0.45 * swPathFar);
float swHaloA = max(dot(swRefl, swL), 0.0);
float swHalo2 = swHaloA * swHaloA;
float swHalo8 = swHalo2 * swHalo2;
swHalo8 *= swHalo8;
float swHalo64 = swHalo8 * swHalo8;
swHalo64 *= swHalo64;
swHalo64 *= swHalo64;
// The soft glow lies on far water, where many facets average into it; close up the dashes carry the sun alone.
float swHalo = (swHalo8 * swHalo8 * 0.05 + swHalo64 * 0.22) * swSunVis * smoothstep(0.82, 0.97, swGraze) * (1.0 - 0.5 * swPathFar);
float swSpark = 0.0;${ifDefined(sparkles, fromTier(1, `
vec2 swSparkUv = swFlowed * (1.1 * U.slateWaterMotion.y);
vec2 swSparkId = floor(swSparkUv);
float swSparkRnd = swHash(swSparkId);
vec2 swSparkD = fract(swSparkUv) - vec2(0.5) - (vec2(swHash(swSparkId + vec2(17.0, 3.0)), swSparkRnd) - vec2(0.5)) * 0.5;
float swTwinkle = abs(fract(swTime * (0.4 + swSparkRnd * 0.8) + swSparkRnd * 7.0) * 2.0 - 1.0);
// Star: a round core and two thin arms, the arms only while a cell spans enough pixels to draw them.
float swSparkPx = swFoot * 1.1 * U.slateWaterMotion.y;
float swArms = 1.0 - smoothstep(0.02, 0.05, swSparkPx);
vec2 swSparkA = abs(swSparkD);
float swStar = max(0.0, 1.0 - length(swSparkD) * 9.0);
swStar = swStar * swStar + (max(0.0, 1.0 - swSparkA.x * 45.0) * max(0.0, 1.0 - swSparkA.y * 5.0) + max(0.0, 1.0 - swSparkA.y * 45.0) * max(0.0, 1.0 - swSparkA.x * 5.0)) * swArms * 0.8;
float swSparkOn = step(1.0 - 0.7 * U.slateWaterLook.z, swSparkRnd) * (0.3 + 0.7 * swTwinkle);
float swSparkFade = smoothstep(0.03, 0.08, swSparkPx);
float swSparkLobe = smoothstep(1.0 - swLobeW * 4.0, 1.0 - swLobeW * 0.5, swLobeA) * (swLobeW0 / swLobeW) * swGlintVis * swSunGate;
swSpark = mix(swStar * swSparkOn, 0.05 * U.slateWaterLook.z, swSparkFade) * swSparkLobe;`))}
vec3 swSpec = swKey * mix(vec3(1.0), swKeyHue, 0.55) * (swPath + swSpark * 2.2 + swSheen) + swKey * swKeyTint * swHalo;

// Shallow clarity: the water column's transmittance (Opacity caps it): what lies below shows through, Shallow Color
// fills what it absorbs. It is per channel (from Shallow Color, CPU): red goes within a metre or two, green and blue
// last several metres, so sand under shallows turns a clear, saturated turquoise. Down to the bed and back up along
// the view ray: grazing views look through far more water.
float swPathM = swDepth * (1.0 + 1.0 / max(swUp, 0.15));
vec3 swTransRgb = max(exp(-swPathM * mix(vec3(1.0), U.slateWaterAbsorb.rgb, 0.85) * vec3(1.0, 1.15, 0.8) * (1.3 / swAbsorb)), vec3(1.0 - U.slateWaterShallow.a));
// Even the thinnest water tints what lies below turquoise (red first), so shallows never read as plain sand or milk.
swTransRgb *= mix(vec3(1.0), vec3(0.45, 0.84, 0.95), smoothstep(0.0, 0.35, swDepth));
float swTrans = dot(swTransRgb, vec3(0.2, 0.45, 0.35));
// Caustics: a drifting network of light on the bed under shallow water (the iso-lines of two drifting noises at the
// point the view ray reaches the bed), faded with depth and before the lines would alias.
vec2 swBedXZ = swWorld - swV.xz / max(swUp, 0.25) * swDepth;
float swCa = swNoise(swBedXZ * 0.85 + vec2(swTime * 0.11, swTime * 0.07));
float swCb = swNoise(swBedXZ * 1.25 + vec2(swCa * 1.2 - swTime * 0.09, 0.4 - swTime * 0.05));
float swCaustic = clamp(1.0 - abs(swCa + swCb - 1.0) * 7.0, 0.0, 1.0);
swCaustic = swCaustic * swCaustic * smoothstep(0.05, 0.4, swDepth) * (1.0 - smoothstep(1.5, 5.0, swDepth)) * (1.0 - smoothstep(0.15, 0.5, swFoot)) * swSunVis;
#ifndef ${REFRACTION}
// Without the copy the bed blends in untinted: the water covers more of it, its in-scattered light standing in for
// the tinted bed, and the caustics light it from above.
swTrans *= 0.32;
#endif

// Foam densities (0-1): shore band and waves washing in, object contacts, crest caps with ribbons trailing down the
// backs of breaking waves, and drifting streaks. One lace pattern cuts all of it: it stays solid where the density is
// high and frays into strands where it thins, fading to its average coverage where it would alias. No term reads a
// screen derivative of a foam pattern.
float swFoamScale = 0.55 * U.slateWaterMotion.y;
float swNearFoam = 1.0 - smoothstep(0.4, 1.2, swFoot * 0.43);
float swEdgeWobble = (swMedium - 0.5) * 0.6 * swNearFoam + (swLarge - 0.5) * 0.5;
vec2 swWindUv = vec2(dot(swFlowed, swWindDir), dot(swFlowed, vec2(-swWindDir.y, swWindDir.x)));
float swCrestNoise = swNoise(swWindUv * vec2(0.8, 0.3) * U.slateWaterMotion.y + vec2(swMedium - 0.5, swLarge - 0.5) * 1.3);
// Shore: the band follows the waves where the depth (as if the bed shelved 1:10) is nearer, but reaches at most one and
// a half foam widths beyond the rest shoreline's band, so a flat shallow bar far from the shore stays clear.
float swDepthShore = mix(${f(SHORE[1])}, max(0.0, swTerrainDepth) * 10.0, swKnown);
float swShoreUnit = min(min(swRestShore, max(swDepthShore, swRestShore - swFoamWidth * 1.5)), ${f(SHORE[1])}) / swFoamWidth;
// The band breathes with the swash: wider as each bore runs up, narrower as it drains. Over terrain it gives way where
// the backwash has uncovered the shallows, while the swash front's soft lace runs up the beach and its furthest reach
// leaves a stranded line that drains away.
// Over terrain the band starts at the swash's edge instead of the waterline (it rides the run-up and the backwash);
// elsewhere it breathes with the swash.
float swShoreSw = mix(swShoreUnit, max(swSwashEdgeS, 0.0) / swFoamWidth, swSwashZone);
float swShoreD = (1.0 - smoothstep(0.0, mix(0.9 + 0.9 * swSwashRun, 1.5, swSwashZone), swShoreSw + swEdgeWobble * 0.5)) * (0.55 + 0.45 * (1.0 - smoothstep(0.0, 0.35, swShoreSw)));
swShoreD = max(swShoreD * swSwashCover, swSwashFoam * 0.85);
// Waves washing in: soft lace lines riding each bore toward the shore (\`swBorePhase\`), thinning as they arrive, each
// trailing fading lace. Low draws the swash front alone.
float swWashUnit = swRestShore / swFoamWidth;
float swWashB = fract(swBorePhase + swEdgeWobble * 0.04);
// Metres behind (and ahead of) the bore front.
float swWashM = swWashB * 6.283185 / max(U.slateWaterSwash.z, 0.001);
float swWashAhead = (1.0 - swWashB) * 6.283185 / max(U.slateWaterSwash.z, 0.001);
float swWash = max(max(1.0 - smoothstep(0.0, swFoamWidth * 0.55, swWashM), 1.0 - smoothstep(0.0, swFoamWidth * 0.2 + swFoot, swWashAhead)) * 0.75,
  0.25 * exp(-swWashM / (swFoamWidth * 2.5))) * min(swBoreOn * 1.6, 1.0);
// A fainter lace line halfway between bores (the backwash meeting the next bore), so the surf carries two lines.
float swWashHalfM = abs(swWashM - 3.141593 / max(U.slateWaterSwash.z, 0.001));
swWash = max(swWash, (1.0 - smoothstep(0.0, swFoamWidth * 0.4 + swFoot, swWashHalfM)) * 0.55 * min(swBoreOn * 1.6, 1.0));
swWash *= 1.0 - smoothstep(3.5, 4.5, swWashUnit);
// Surf: one broad soft band of churned water off the shore (lightens the water; lace only where dense).
float swSurfBand = exp(-swWashUnit * 0.55) * (1.0 - swShoreD);
// Contact collars: a thin solid line at the waterline, then a small lacy wreath the outgoing ripples push outward, at
// most about a metre wide whatever Contact Foam Width says (wider widths spread churned water and ripples, not foam).
// Its width swells and narrows along the waterline (a slowly drifting noise, half to one and a half times) and it
// stretches downwind into a short wake, so it never reads as a sticker's even cut line.
float swWreathW = clamp(swContactW, 0.25, 1.0);
float swWreathWide = (0.5 + swNoise(swWorld * (1.2 / swWreathW) + vec2(swTime * 0.07, swTime * -0.05))) * (1.0 + 1.6 * max(dot(swContactDir, swWindDir), 0.0));
// The wreath pulses with the swell at the hull (\`swHullPulse\`): it spreads and thickens as the water climbs, and as it
// drops a looser ring of lace clings a moment further out (\`swHullCling\`); downstream it sheds soft puffs (\`swLeePuff\`).
float swContactX = swObject / (swWreathW * swWreathWide * (0.6 + 0.8 * swHullPulse)) + swEdgeWobble * 0.3;
float swContactLine = 1.0 - smoothstep(0.0, min(0.22, 0.25 / swWreathW) + 0.02, swContactX);
float swContactD = max(swContactLine, 0.5 * exp(-swContactX * 1.7) * (0.8 + 0.2 * cos(swRipplePhase)) * (0.75 + 0.4 * swHullPulse)) * swNearContact;
swContactD = max(swContactD, (swHullCling * exp(-abs(swContactX - 1.1) * 3.5) * 0.45 + swLeePuff * exp(-swOutside / (swWreathW * 2.4)) * smoothstep(0.0, 0.2, swContactSigned) * 0.42) * swNearContact);${fromTier(1, `
// The first ripple crests carry thin wisps.
swContactD = max(swContactD, smoothstep(0.55, 0.95, cos(swRipplePhase)) * swRippleFade * 0.4 * (1.0 - smoothstep(1.5, 3.0, swObject / swWreathW)));`)}
float swContactChurn = exp(-swObject / min(swContactW, 2.5)) * swNearContact;
// Ribbons along the wind: a noise stretched along it (about 1:6), which caps, trails and streaks thin into.
float swRibbon = swNoise(swWindUv * vec2(0.2, 1.2) * U.slateWaterMotion.y + vec2(swMedium * 1.4, swLarge * 1.4 + (swCrestNoise - 0.5) * 2.2));
swRibbon = mix(swRibbon, 0.5, smoothstep(0.3, 1.0, swFoot * 1.2 * U.slateWaterMotion.y));
float swCapD = 0.0;
float swTrailD = 0.0;${ifDefined(crestFoam, `
// Caps on the primary swell's crests where the sea is steep enough to break, sharper where crests fold, broken along
// the crest by drifting breaking zones; Crest Foam sets coverage. Behind each cap a ribbon of decaying foam trails down
// the wave's back (where the height still rises along the wind). Far away they broaden and fade before they would
// shrink to specks.
float swCapFar = smoothstep(0.2, 1.2, swFoot);
float swSeaBreak = smoothstep(0.3, 0.62, swSeaState);
// Breaking zones: sparse on moderate seas, most crests on a rough one.
float swBreak = smoothstep(0.62 - 0.3 * swSeaBreak, 0.8 - 0.2 * swSeaBreak, swCrestNoise * 0.6 + swLarge * 0.4);
float swPrimT = 0.5 + 0.5 * swPrimN;
float swCapCut = 0.92 - 0.3 * U.slateWaterShape.z;${fromTier(1, `
float swCapTier = 1.0;`, `
// Low's single lace octave draws caps coarser: fewer of them.
float swCapTier = 0.8;`)}
float swCapDrive = swPrimT + swChopH * 0.3 + swFoldN * 0.12 + (swCrestNoise - 0.5) * 0.15 * swNearFoam;
swCapD = smoothstep(swCapCut - 0.05 * swCapFar, swCapCut + 0.1 + 0.15 * swCapFar, swCapDrive) * (0.35 + 0.65 * swBreak) * swSeaBreak * swRough * swCapTier
  * (0.38 + 0.2 * U.slateWaterShape.z) * (1.0 - smoothstep(1.5, 3.5, swFoot)) * (0.6 + 0.4 * smoothstep(0.3, 0.6, swRibbon));
float swBackS = dot(swPrimG, swWindDir) * swPrimLen / max(swPrimAmp, 0.0001);
float swTrailZone = smoothstep(0.0, 0.45, swBackS) * smoothstep(0.35, 0.8, swPrimT + swChopH * 0.2);
swTrailD = swTrailZone * smoothstep(0.4, 0.7, swRibbon) * (0.3 + 0.7 * swBreak) * swSeaBreak * swRough * (0.45 + 0.6 * U.slateWaterShape.z)
  * (1.0 - smoothstep(0.8, 2.2, swFoot));`)}
float swStreakD = 0.0;${ifDefined(surfaceFoam, fromTier(1, `
// Drifting streaks (Surface Foam): long ribbons along the wind, bent by the shared noises, denser on the backs of
// steep waves behind their caps and thinner over crests; they drift with the wind and the current.
vec2 swStreakUv = swWindUv * vec2(0.12, 0.6) + vec2(swMedium - 0.5, swGust - 0.5) * 1.2;
// Elongated patches that the lace frays into ribbons; they end before they would thin into hairlines far away.
float swStreakN = mix(swNoise(swStreakUv), 0.5, smoothstep(0.25, 0.7, swFoot)) * 0.8 + swGust * 0.2;
float swOpenCut = 0.85 - 0.3 * U.slateWaterSunColor.w;
swStreakD = smoothstep(swOpenCut, swOpenCut + 0.2, swStreakN) * clamp(0.45 + swTrailD + swCapD - max(swCrest, 0.0) * 0.2, 0.0, 1.0) * 0.72 * smoothstep(0.0, 0.3, U.slateWaterSunColor.w) * swCalm * (1.0 - smoothstep(0.25, 0.7, swFoot));`))}
float swDensity = max(max(clamp(max(max(swShoreD, swWash), max(swCapD, swSurfBreak)) * swFoamAmount, 0.0, 1.0), clamp(swContactD * swContactStrength, 0.0, 1.0)), clamp(max(swTrailD, swStreakD) * swFoamAmount, 0.0, 1.0));
// The lace pattern: low along curved strands (a noise's mid iso-lines), so thinning foam keeps strands and opens holes.
vec2 swFoamUv = swFlowed * swFoamScale + swWindDir * (swTime * 0.05) + vec2(swMedium, swLarge) * 0.6;${fromTier(1, `
float swLaceA = swNoise(swFoamUv * 1.6 + vec2(swFine - 0.5, swMedium - 0.5) * 0.3);
float swLaceB = swNoise(swFoamUv * 3.7 + vec2(swLaceA * 1.6, 3.1 - swTime * 0.04));
float swFoamP = swLaceA * 0.45 + swLaceB * 0.35 + abs(swLaceA * 2.0 - 1.0) * 0.2;${fromTier(2, `
// High up thinning foam also opens round holes (a jittered cell pattern bent by the lace), so it reads as bubbly lace
// rather than veins; finer lace nibbles the edges up close. Both fade before they would alias.
// Stretched along the wind and sized by the lace noise, so the holes vary and streak instead of punching even rounds
// (a Dalmatian or Swiss-cheese print).
vec2 swBubble = swWeb(vec2(dot(swFoamUv, swWindDir) * 0.4, dot(swFoamUv, vec2(-swWindDir.y, swWindDir.x))) * 2.6 + vec2(swLaceA, swLaceB) * 0.8);
float swHoleR = 0.06 + 0.32 * swLaceB;
float swHole = 1.0 - smoothstep(swHoleR, swHoleR + 0.3, swBubble.x);
swFoamP = mix(swFoamP, swHole * 0.75 + swFoamP * 0.35, 0.6 * (1.0 - smoothstep(0.25, 0.7, swFoot * swFoamScale * 2.6)));
float swLaceC = swNoise(swFoamUv * 8.3 + vec2(swLaceB * 1.3, swTime * 0.06));
swFoamP = mix(swFoamP, swFoamP * 0.8 + swLaceC * 0.2, 1.0 - smoothstep(0.2, 0.6, swFoot * swFoamScale * 8.0));`)}
float swPatFade = smoothstep(0.12, 0.45, swFoot * swFoamScale * 3.7);
float swFoamSoft = 0.06 + min(swFoot * swFoamScale * 0.8, 0.3);
// Past where the fine lace would alias a coarse octave carries the pattern, so mid-distance foam stays lace (not flat
// strips), until it too fades to its average far away.
float swLaceFar = swNoise(swFoamUv * 0.5 + vec2(swMedium - 0.5, swLarge - 0.5) * 0.6);
float swFarP = swLaceFar * 0.6 + swRibbon * 0.4;${fromTier(2, `
// High: the coarse lace opens round holes too, so caps and bands seen from afar stay lacy rather than solid.
vec2 swFarWeb = swWeb(vec2(dot(swFoamUv, swWindDir) * 0.4, dot(swFoamUv, vec2(-swWindDir.y, swWindDir.x))) * 0.75 + vec2(swLaceFar, swRibbon) * 0.7);
swFarP = max(swFarP, (1.0 - smoothstep(0.04 + 0.22 * swLaceFar, 0.3 + 0.22 * swLaceFar, swFarWeb.x)) * 0.85);`)}
swFoamP = mix(swFoamP, swFarP, swPatFade);
swFoamSoft = mix(swFoamSoft, 0.18, swPatFade);
swPatFade = smoothstep(0.25, 0.8, swFoot * swFoamScale * 0.5);`, `
// Low: one soft lace octave and the shared noises, with wide soft edges (no thin veins).
float swFoamP = swNoise(swFoamUv * 1.9 + vec2(swMedium - 0.5, swCrestNoise - 0.5) * 0.5) * 0.6 + swMedium * 0.2 + swRibbon * 0.2;
float swPatFade = smoothstep(0.3, 0.9, swFoot * 0.7 * U.slateWaterMotion.y);
float swFoamSoft = 0.14 + min(swFoot * swFoamScale * 0.8, 0.3);`)}
float swFoamLevel = swDensity * 1.2 - 0.12;
float swFoamShape = smoothstep(swFoamP - swFoamSoft, swFoamP + swFoamSoft, swFoamLevel) * smoothstep(0.06, 0.3, swDensity);
float swFoam = mix(swFoamShape, smoothstep(0.08, 0.9, swDensity) * 0.85, swPatFade);
// How deep inside the foam: thick foam is bright, its fraying edge thinner and cool.
float swFoamThick = mix(clamp((swFoamLevel - swFoamP) * 1.6, 0.0, 1.0), swDensity, swPatFade);
// Churned water around foam, around objects and in the surf band is lighter and greener: a soft translucent fringe.
float swChurn = clamp(max(max(swDensity * (1.0 - swFoam) * 0.3, swSurfBand * swFoamAmount * 0.6), swContactChurn * swContactStrength * 0.2), 0.0, 1.0);
vec3 swFoamLight = swAmbTint * max(swAmbLum * 1.1, 0.45) + swKeyTint * (swKeyLum * (0.3 + 0.5 * swShade));
swFoamLight = swFoamLight / (1.0 + dot(swFoamLight, swLumW) * 0.25) * 1.15;
vec3 swFoamTop = U.slateWaterFoam.rgb * min(swFoamLight, vec3(1.1));
vec3 swFoamUnder = swFoamTop * mix(vec3(0.66, 0.78, 0.84), vec3(0.82, 0.72, 0.7), swDuskWarm);
// Foam in the wave's shade (facing away from the sun) is cool blue-grey, lit foam bright.
vec3 swFoamC = mix(swFoamUnder, swFoamTop, smoothstep(0.0, 0.8, swFoamThick) * (0.45 + 0.55 * swShade));
swFoamC *= mix(mix(vec3(0.8, 0.88, 0.95), vec3(0.95, 0.86, 0.8), swDuskWarm), vec3(1.0), 0.4 + 0.6 * swShade);

// Composition: in-scattered body (with the glow and churn) behind the surface, the sky reflection over it, and what
// shows through. Premultiplied first, then divided by coverage for the blend; foam lies on top. Far away the body takes
// the horizon's hue at its own brightness (aerial perspective), so a sky of the complementary hue (a gold sunset over
// navy water) never mixes into grey.
swLit = mix(swLit, swLit + swGlowC * swLight * 0.6 + swFoamTop * 0.03, swChurn * 0.6);
swLit = mix(swLit, swHorizonSky * (dot(swLit, swLumW) / max(dot(swHorizonSky, swLumW), 0.001)), smoothstep(0.2, 2.0, swFoot) * 0.6);
vec3 swPremul = swLit * ((1.0 - swReflAmt) * (1.0 - swTrans)) + swSky * swReflAmt + swSpec * (1.0 - swFoam);
#ifndef ${REFRACTION}
swPremul += (swShallowC * 0.5 + vec3(0.25)) * swKey * (swCaustic * swTrans * 0.6 * (1.0 - swReflAmt));
#endif
float swCover = 1.0 - (1.0 - swReflAmt) * swTrans;
float swSpecLum = dot(swSpec, swLumW) * (1.0 - swFoam);
alpha = clamp(max(swCover, min(swSpecLum, 1.0)), 0.001, 1.0);
vec3 swEmissive = swPremul / alpha;
// Aerial perspective (the shared \`swAir\` at grazing views, and the last degrees above the horizon whatever the distance):
// far water takes the painted horizon colour (the real sky read just above the horizon from Medium up), fully opaque, and
// its foam thins, so the sea never ends in a seam against the sky.
float swPaintHaze = 1.0 - (1.0 - swAir * smoothstep(0.3, 0.85, swGraze)) * (1.0 - 0.85 * smoothstep(0.98, 0.9985, swGraze));
swEmissive = mix(swEmissive, swHorizonSky, swPaintHaze);
alpha = mix(alpha, 1.0, swPaintHaze);
swFoam *= 1.0 - 0.7 * swPaintHaze;
swEmissive = mix(swEmissive, swFoamC, swFoam);
alpha = max(alpha, swFoam);
// Backwash: uncovered shallows keep their foam and a wet film that darkens the sand under a faint sky sheen, drying
// behind the swash.
float swFilm = (1.0 - swSwashCover) * swSwashWet;
float swFilmA = max(swFoam, swFilm * 0.32);
swEmissive = mix(mix(swSky * 0.3, swFoamC, clamp(swFoam / max(swFilmA, 0.001), 0.0, 1.0)), swEmissive, swSwashCover);
alpha = mix(swFilmA, alpha, swSwashCover);
surfaceAlbedo = vec3(0.0);
${objectReflectionSource("swRefl", "U.slateWaterOrigin.w")}
#if ${REFLECTS_OBJECTS}
// Reflected objects replace the sky by its Fresnel weight, never over foam.
float swReflWeight = clamp(swObjRefl.a * swReflAmt * (1.0 - swFoam) * swSwashCover, 0.0, 1.0);
swEmissive = mix(swEmissive, swObjRefl.rgb, swReflWeight);
alpha = max(alpha, swReflWeight);
#endif${ifDefined(REFRACTION, `
// With the copy the water is opaque and adds what lies below: the refracted scene through the per-channel
// transmittance, lit by the caustics, outside the reflection and foam. It joins the output after the water's own fog
// (\`swRefracted\`, see CUSTOM_FRAGMENT_BEFORE_FOG). Uncovered shallows blend their film instead.
swRefracts *= swSwashCover * (1.0 - swPaintHaze);
vec3 swRefracted = swBackground * (1.0 + swCaustic * 0.6 * min(swKeyLum, 1.5)) * swTransRgb * ((1.0 - swReflAmt) * (1.0 - swFoam) * swRefracts);
float swRefractedWeight = (1.0 - alpha) * swRefracts;
swEmissive = swEmissive * mix(1.0, alpha, swRefracts);
alpha = mix(alpha, 1.0, swRefracts);`)}
`;
}

/**
 * Stylized Toon (`SLATE_WATER_TOON`): unlit toon water in the spirit of The Legend of Zelda: The Wind Waker.
 *
 * A vivid, flat palette from the asset in hard-edged **Color Bands** (Shallow Color near the shore, a mid tone, Deep
 * Color) and two flat wave tones (shaded faces that run along the crests, lighter tops), with white graphic line work:
 * crest lines that follow the swell and zig-zag with the chop, and close up short curled strokes whose scale steps with
 * the footprint so their density on screen stays steady. Foam is opaque white (gold at dusk): a thick shore band of
 * billowed scallops running in and out with the swash, a bold line on each bore rolling in (a breathing ring on Low), a
 * swash front and a flat wet tone where the backwash uncovers the beach, object collars pulsing with the swell at the
 * hull with one bold ring, one ring sent out with each rise and puffs shed downstream,
 * caps on the tops of folding crests, drifting patches, and small diamond flecks. The sun is one flat bright colour in
 * horizontal dashes down its reflection column (with a few large four-pointed stars from High). Far water steps lighter
 * twice, and the outermost far tone is the horizon itself (no seam); at dusk the sea deepens to indigo under a
 * rose-violet far tone that warms toward the sun, and a dim sun (overcast, storm) greys the palette toward slate. Every
 * edge is a hard step antialiased by the pixel footprint; strokes keep at least about a pixel and a half and thin out
 * by culling rather than fading. Every tier is ALU only; Low keeps the bands, wave tones, crest lines and one fixed
 * scale of strokes, flecks, the shore, contact foam, caps and the sun; Medium adds a second crest line,
 * footprint-stepped strokes, drifting patches, scalloped lobes and the backlit crest band; High adds finer foam lobes,
 * star sparkles and refraction.
 */
function toonSource(): string {
  const { crestFoam, surfaceFoam, subsurface, sparkles } = WATER_FEATURE_DEFINES;
  return surfaceSource("toon") + `
vec3 swV = viewDirectionW;
float swUp = clamp(swV.y, 0.0, 1.0);
vec3 swLuma = vec3(0.3, 0.59, 0.11);
// Light: the scene's sun and sky light set an exposure and a tint; the palette itself stays flat.
float swSunUp = smoothstep(-0.02, 0.12, swL.y);
vec3 swKey = swSun * swSunUp;
float swAmbLum = dot(swAmb, swLuma);
float swKeyLum = dot(swKey, swLuma);
vec3 swKeyHue = U.slateWaterSunColor.rgb / max(dot(U.slateWaterSunColor.rgb, swLuma), 0.001);
vec3 swMood = swAmb * 0.6 + swKey * 0.4;
vec3 swTint = mix(vec3(1.0), swMood / max(dot(swMood, swLuma), 0.001), 0.4);
float swExpo = 0.5 + 0.5 * min(sqrt((swAmbLum * 0.55 + swKeyLum * 0.45) * 0.8), 1.15);
float swGrey = clamp((0.88 - swExpo) * 1.4, 0.0, 0.45);
// No light estimate at all (no sun or sky light, the ambient at its floor: a scene lit only by an environment or by
// emissives): the palette shows as authored.
float swNoLight = (1.0 - step(0.0001, U.slateWaterSun.w)) * (1.0 - smoothstep(0.085, 0.12, swAmbLum));
swExpo = mix(swExpo, 0.92, swNoLight);
swGrey = mix(swGrey, 0.05, swNoLight) + 0.15 * (1.0 - step(0.0001, U.slateWaterSun.w)) * (1.0 - swNoLight);
// The sun's hue, saturated (a white sun stays white, a setting sun turns orange), and a gold for the dusk horizon.
vec3 swSunTone = swKeyHue * swKeyHue * swKeyHue;
swSunTone = min(swSunTone / max(dot(swSunTone, swLuma), 0.001), vec3(1.0));
vec3 swGold = swKeyHue * swKeyHue;
swGold = min(swGold / max(dot(swGold, swLuma), 0.001), vec3(1.0));
float swDusk = (1.0 - smoothstep(0.0, 0.35, swL.y)) * smoothstep(-0.1, 0.02, swL.y) * step(0.001, U.slateWaterSun.w);
// Evening: a low sun that is also warm (a low white sun keeps the day palette).
float swEve = swDusk * smoothstep(0.1, 0.6, swKeyHue.r - swKeyHue.b);
vec2 swSunH = swL.xz / max(length(swL.xz), 0.0001);
float swLowSun = (1.0 - smoothstep(0.0, 0.35, swL.y)) * swSunUp;
float swSunSeen = swSunUp * clamp(U.slateWaterSun.w, 0.0, 1.0);
// Weather: a weak or missing sun (overcast, storm) greys the palette toward slate.
float swGloom = (1.0 - smoothstep(0.45, 0.85, U.slateWaterSun.w * swSunUp)) * (1.0 - swNoLight);
vec3 swShallowC = U.slateWaterShallow.rgb;
vec3 swDeepC = U.slateWaterDeep.rgb;
vec3 swMidC = mix(swDeepC, swShallowC, 0.45);
vec2 swCross = vec2(-swWindDir.y, swWindDir.x);
// Close range (a few metres from the eye): stronger tone steps.
float swClose = 1.0 - smoothstep(0.015, 0.08, swFoot);

// Depth: hard-edged Color Bands from Shallow Color through a mid tone to Deep Color (a smooth gradient at Color Bands
// 0 or 1). The bed's depth sets them: refraction only bounds the absorption of what shows through, so an object in
// deep water never turns the sea around it into shallows.
#ifdef ${REFRACTION}
float swBedTone = 1.0 - exp(-swBedDepth * 2.0 / swAbsorb);
#else
float swBedTone = swTone;
#endif
float swBandCount = max(1.0, U.slateWaterLook.x);
// The wide noises bend the band edges into lobes, so a bed's straight contours never read as a box around an island.
// Only the edge into deep water bends (by at most about half a band), so gentle shallows keep wide, clean bands
// rather than breaking into pools, and open water (at least about two thirds of a band deeper) never shoals.
float swBandRaw = swBedTone * swBandCount;
float swBandWarp = ((swLarge - 0.5) * 0.9 + (swMedium - 0.5) * 0.3 * (1.0 - smoothstep(0.3, 1.2, swFoot))) * step(1.5, swBandCount)
  * smoothstep(swBandCount - 1.8, swBandCount - 1.3, swBandRaw);
float swBand = max(swBandRaw + swBandWarp, 0.0);
float swBandAA = min(fwidth(swBand), 0.5);
float swBanded = min((floor(swBand) + smoothstep(1.0 - swBandAA * 1.5, 1.0, fract(swBand))) / max(swBandCount - 1.0, 1.0), 1.0);
float swDepthTone = mix(swBedTone, swBanded, step(1.5, swBandCount));
// Inside the shallow bands the open sea's wave tones and dapples recede, so the lagoon reads as flat colour.
float swOpenSea = clamp(swDepthTone * 2.0 - 0.6, 0.0, 1.0);
float swDeepness = clamp(swDepthTone * 2.0 - 1.0, 0.0, 1.0);
vec3 swBody = mix(mix(swShallowC, swMidC, clamp(swDepthTone * 2.0, 0.0, 1.0)), swDeepC, swDeepness);
// Color Variation: wide, hard-edged drifts of a slightly lighter tone across deep water.
float swDriftAA = fwidth(swDrift) * 0.7 + 0.0002;
float swPatch = smoothstep(0.62 - swDriftAA, 0.62 + swDriftAA, swDrift);
swBody *= 1.0 + 0.14 * swPatch * swDeepness * U.slateWaterSwellInfo.z;

// Wave tones: the swell's slope (a little chop, exaggerated near the camera) lit relative to flat water, so even a
// high sun separates each wave's lit and shaded side; one hard step into a deeper, cooler shade. Slope across the
// waves' heading counts less, so shaded faces run along the crests instead of tiling as ovals where crossing
// components meet, and the cut drifts with the two wide noises so they gather in irregular groups.
float swNearSwell = 1.0 - smoothstep(0.25, 1.2, swFoot);
vec2 swShadeG = swGradient * (1.0 + 0.6 * swNearSwell);
swShadeG = swWindDir * dot(swShadeG, swWindDir) + swCross * (dot(swShadeG, swCross) * 0.4);
// The chop shapes the tones only near the eye: further out they follow the swell alone, in wide swaths, where chop-sized
// tone shapes would tile like a print.
float swChopTone = 1.0 - smoothstep(0.06, 0.3, swFoot);
// Seen steeply from high up, the crossing swell components' tones would print a cellular pattern: they recede, leaving
// the wide Color Variation drifts.
float swToneOn = 1.0 - 0.75 * smoothstep(0.08, 0.2, swFoot) * smoothstep(0.35, 0.7, swUp);
vec2 swShadeSlope = swShadeG + swDetail * (swChopGain * (0.9 + 0.9 * swClose) * swChopTone) + swRipple * 3.0;
vec3 swShadeN = normalize(vec3(swBaseX - swShadeSlope.x, 1.0, swBaseZ - swShadeSlope.y));
float swNL = dot(swShadeN, swL);
float swFacing = 0.5 + (swNL - swL.y) * 1.8;
float swShadeAA = min(fwidth(swFacing) * 0.7 + 0.0005, 0.3);
float swShadeCut = 0.4 + (swGust - 0.5) * 0.3 + (swLarge - 0.5) * 0.2;
float swShade = smoothstep(swShadeCut - swShadeAA, swShadeCut + swShadeAA, swFacing);
// Toward the horizon the shade step thins out in patches across the gust and large noises, so far crests band only
// here and there instead of striping the whole sea in even rows (venetian blinds).
float swFarRows = mix(1.0, 0.2 + 0.8 * smoothstep(0.3, 0.7, swGust * 0.6 + swLarge * 0.4), smoothstep(0.35, 1.6, swFoot));
swBody = mix(swBody * mix(vec3(1.0), mix(vec3(0.72, 0.75, 0.88), vec3(0.58, 0.64, 0.84), swClose), (0.4 + 0.6 * swOpenSea) * swToneOn * swFarRows), swBody, swShade);
// Wave tops step lighter (more so with Subsurface): thinner water, the third flat tone.
float swTopH = swCrest + swChopH * 1.2 * swChopTone;
float swTopAA = min(fwidth(swTopH) * 0.7 + 0.0005, 0.3);
float swTopCut = 0.45 + (swLarge - 0.5) * 0.5 + (swMedium - 0.5) * 0.3;
float swTop = smoothstep(swTopCut - swTopAA, swTopCut + swTopAA, swTopH) * swNearSwell;
float swSss = 0.0;${ifDefined(subsurface, `
swSss = min(U.slateWaterLook.w, 1.5);`)}
swBody = mix(swBody, swBody * 1.18 + swMidC * 0.08, swTop * (0.5 + 0.35 * swSss) * swToneOn);${ifDefined(subsurface, fromTier(1, `
// Backlit crest band: looking toward a sun some way up (not overhead), the slope just under each crest turned from the
// sun steps to a brighter blue, bounded by the top tone, near the camera only.
vec2 swLookH = -swV.xz / max(length(swV.xz), 0.0001);
float swBacklit = smoothstep(0.3, 0.8, dot(swLookH, swSunH)) * smoothstep(0.03, 0.15, swL.y) * (1.0 - smoothstep(0.45, 0.75, swL.y)) * swSunSeen;
float swUnder = smoothstep(swTopCut - 0.12 - swTopAA, swTopCut - 0.12 + swTopAA, swTopH) * (1.0 - swTop) * (1.0 - swShade);
swBody = mix(swBody, swBody * 1.35 + swShallowC * mix(vec3(1.0), swKeyHue, 0.3) * 0.12, swUnder * swBacklit * swNearSwell * min(swSss, 1.0));`))}
vec3 swLit = swBody * swTint * swExpo;
// Evening deepens the sea toward indigo (the sun path and horizon carry the warmth); weather greys it toward slate
// and darkens a rough sea.
swLit = mix(swLit, vec3(swLit.r * 0.5 + swLit.b * 0.14, swLit.g * 0.4, swLit.b * 0.8), swEve * 0.9);
float swDesat = clamp(max(swGrey, swGloom * 0.85), 0.0, 0.85);
swLit = mix(swLit, vec3(dot(swLit, swLuma)) * vec3(0.5, 1.05, 2.0), swDesat);
swLit *= 1.0 - 0.25 * swGloom * smoothstep(0.15, 0.5, swSeaState);
// Foam and line work: opaque white in the scene's light (never below 90%), gold-tinted at dusk, a little greyer under
// a drowned sun, and a cool white on shaded wave faces.
vec3 swFoamLit = U.slateWaterFoam.rgb * clamp(swExpo * 1.05, 0.9, 1.05) * mix(vec3(1.0), swTint, 0.25);
swFoamLit = mix(swFoamLit, swFoamLit * mix(vec3(1.0), swSunTone, 0.25), swEve);
swFoamLit = mix(swFoamLit, vec3(dot(swFoamLit, swLuma)) * vec3(0.95, 0.98, 1.02), swGloom * 0.15);
swFoamLit = mix(swFoamLit * vec3(0.82, 0.9, 1.0), swFoamLit, swShade);

// The sun's column measured on the swell alone and widened (\`swColQ\`): line work, strokes and flecks give way inside
// it by raising their cuts, so they shorten and vanish as whole shapes there instead of being perforated pixel by pixel
// by the chop's normal; a wider, weaker halo keeps a clear band around the path.
float swColQW = 0.03 + 0.09 * U.slateWaterOrigin.w;
float swColQ = clamp((dot(reflect(-swV, swSwellNormal), swL) - 1.0 + swColQW) / swColQW, 0.0, 1.0) * smoothstep(0.05, 0.4, swSunSeen);
float swColQuiet = smoothstep(0.1, 0.6, swColQ) + 0.25 * smoothstep(0.0, 0.3, swColQ);
// Crest lines: white lines along the swell's crests that zig-zag and break into dashes. The line is an isoline of the
// swell's crest height alone, bent by a noise and cut into dashes by others. Each crest of the swell's dominant component
// (its steepest, slot 0) carries its own pattern: the crest's index changes in that component's trough, where no line
// draws, and seeds the noises, so a crest keeps its dashes as it travels while the next crest's never line up with them
// into ladders. Each of a crest's isolines has its own dashes and a slow wobble of its own, so they never run as ruled
// triplets. Each keeps at least about a pixel and a half; where its natural width would be thinner, and toward the
// distance, its dashes thin out instead of fading.
float swNearFoamL = 1.0 - smoothstep(0.1, 0.5, swFoot);
// The crest's index counts whole periods of the component's world phase: the CPU reduces the phase uniform mod 2π (it
// wraps once a period as time runs) and passes how many periods it removed (\`slateWaterLight.w\`, mod
// \`CREST_COUNT_PERIOD\`), so a crest keeps its index, and its dashes, for as long as it travels. (Without the count
// every crest took the next one's pattern each time the phase wrapped, about every two seconds.)
float swCrestId = floor((swP0 + 1.570796) * 0.159155) + U.slateWaterLight.w;
swCrestId -= ${f(CREST_COUNT_PERIOD)} * floor(swCrestId / ${f(CREST_COUNT_PERIOD)});
vec2 swCrestSeed = swHash2(vec2(swCrestId, 17.0));
float swCrestAlong = dot(swFlowed, vec2(-swD0.y, swD0.x));
vec2 swCrestUv = vec2(swCrestAlong + swCrestSeed.x * 37.0, swCrestSeed.y * 13.0);
float swLineN = swNoise(swCrestUv * vec2(1.15, 1.0) + vec2(2.9, 5.3));${fromTier(1, `
float swLineWig = swNoise(swCrestUv * vec2(0.3, 1.0) + vec2(7.3, 1.1));`, `
float swLineWig = swLineN;`)}
float swLineH = swCrest + (swLineWig - 0.5) * 0.15 * swNearFoamL;
float swLineFw = max(fwidth(swLineH), 0.00001);
float swLineDash = swLineN * 0.65 + swLineWig * 0.35;
float swLineDashT = swNoise(swCrestUv * vec2(1.15, 1.0) + vec2(11.7, 2.3)) * 0.65 + swLineWig * 0.35;
// A low sea state draws one isoline only: the top one thins out as its crests flatten, the trough one goes.
float swLowSea = 1.0 - smoothstep(0.15, 0.45, swSeaState);
// Where the crest field is too steep for its isoline to keep a width (more than about 0.07 per pixel), and toward the
// distance, the cut rises. Close to the eye, where a crest (at the primary swell's phase speed) would sweep more than
// about ten pixels between frames at 30 frames per second, the lines thin out too: they would strobe across the view
// there, and the strokes riding the water carry the line work instead.
float swLinePx = sqrt(1.5613 * max(U.slateWaterWaves.y, 0.1)) * U.slateWaterWaves.z / max(swFoot * 30.0, 0.00001);
// Where the swell's slope along the dominant heading is slight (relative to the dominant component's own, k·Wave
// Height), the cut rises too: near the flat tops and bottoms of the wave groups' isolated bumps an isoline would close
// into a whole ring that pops in at full size as the bump's peak crosses its level; there its dashes shorten and vanish
// instead, and grow back as the slope steepens.
float swLineFlat = 1.0 - smoothstep(0.05, 0.16, abs(dot(swGradient, swD0)) / max(U.slateWaterWaves.x * swK0, 0.0001));
float swLineCut = 0.55 + 0.3 * smoothstep(0.05, 0.1, swLineFw) + 0.4 * smoothstep(0.06, 0.4, swFoot) + 0.6 * smoothstep(10.0, 22.0, swLinePx) + 0.8 * swColQuiet + 0.6 * swLineFlat;
// Brush strokes: each dash swells from about a third of its width at its ends to its full width (about two to four
// pixels); dashes too short to swell past half their width are dropped, so none shrinks to a speck.
float swLineTaper = clamp((swLineDash - swLineCut) * 9.0, 0.0, 1.0);
float swLineHalf = mix(1.0, 1.9, swNearFoamL) * (0.35 + 0.65 * swLineTaper);
// Isolines on each crest's flanks and near its top, and from Medium on its trough side. The one near the top closes
// round each crest, so it keeps only its longer dashes, and only where it runs along the crest (its height's gradient
// along the dominant heading): arcs, never whole rings.
float swLineLv0 = 0.18 + 0.06 * sin(swCrestAlong * 0.37 + swCrestSeed.x * 6.283);
float swLineLvT = 0.5 + 0.06 * sin(swCrestAlong * 0.29 + swCrestSeed.y * 6.283);
float swLines = (1.0 - smoothstep(swLineHalf - 0.6, swLineHalf + 0.6, abs(swLineH - swLineLv0) / swLineFw)) * smoothstep(0.25, 0.45, swLineTaper);
float swLineTopTaper = clamp((swLineDashT - swLineCut - 0.1 - 0.3 * swLowSea) * 9.0, 0.0, 1.0);
float swLineAlongCrest = smoothstep(0.35, 0.65, abs(dot(swGradient, swD0)) / max(length(swGradient), 0.000001));
swLines = max(swLines, (1.0 - smoothstep(swLineHalf * 0.75 - 0.6, swLineHalf * 0.75 + 0.6, abs(swLineH - swLineLvT) / swLineFw)) * smoothstep(0.25, 0.45, swLineTopTaper) * swLineAlongCrest);
float swLinePxD = min(abs(swLineH - swLineLv0), abs(swLineH - swLineLvT));${fromTier(1, `
float swLineLvB = -0.22 + 0.06 * sin(swCrestAlong * 0.43 + swCrestSeed.x * 3.1 + swCrestSeed.y * 2.0);
float swLineDashB = swNoise(swCrestUv * vec2(1.15, 1.0) + vec2(5.1, 19.3)) * 0.65 + swLineWig * 0.35;
float swLineTaperB = clamp((swLineDashB - swLineCut) * 9.0, 0.0, 1.0);
swLines = max(swLines, (1.0 - smoothstep(swLineHalf * 0.8 - 0.6, swLineHalf * 0.8 + 0.6, abs(swLineH - swLineLvB) / swLineFw)) * smoothstep(0.25, 0.45, swLineTaperB) * (1.0 - swLowSea));
swLinePxD = min(swLinePxD, abs(swLineH - swLineLvB));`)}
// Strokes keep clear of the isolines (about six pixels), so they never cross a crest line into X and V shapes.
float swClearOfLines = smoothstep(4.0, 8.0, swLinePxD / swLineFw);
// Close up, short curled strokes: isolines of a noise stretched along the crests, a constant width on screen. They and
// the flecks ride the water itself (its rest position, so they bob with the waves), drifting with the current and
// slowly downwind and bent by the wide static noises: a stroke keeps its shape. (They used to ride the chop's domain,
// whose drag by the chop's crests bent them into new shapes every frame.) Each lives a few seconds: a slow noise
// drifting through them raises their cut, so a stroke shortens from one end and vanishes while others grow elsewhere.
vec2 swStrokeW = swRest + U.slateWaterOrigin.xz - IN.vSlateWaterFlow.xy * swTime + swWindDir * (swTime * 0.12) + vec2(swLarge - 0.5, swGust - 0.5) * 2.4;
vec2 swSqP = vec2(dot(swStrokeW, swWindDir), dot(swStrokeW, swCross) * 0.55);
float swSqLife = 0.16 * (1.0 - smoothstep(0.3, 0.7, swNoise(swSqP * 0.45 + vec2(swTime * 0.21, swTime * -0.13))));${fromTier(1, `
// Their scale steps with the footprint in octaves, two neighbouring octaves crossing over by culling (strokes shorten
// and vanish, never fade), so their density on screen stays steady within several metres of the eye.
float swSqL = log2(max(swFoot, 0.0001) * 36.0);
float swSqL0 = clamp(floor(swSqL), -4.0, -1.0);
float swSqT = clamp(swSqL - swSqL0, 0.0, 2.0);
vec2 swSqP0 = swSqP / exp2(swSqL0);
vec2 swSqP1 = swSqP0 * 0.5;
float swSqN0 = swNoise(swSqP0);
float swSqN1 = swNoise(swSqP1);
float swSqD0 = swNoise(swSqP0 * 1.3 + vec2(3.1, 7.7));
float swSqD1 = swNoise(swSqP1 * 1.3 + vec2(3.1, 7.7));
float swSqBase = 0.54 - 0.06 * swClose;
float swSqCut0 = swSqBase + (1.0 - swSqBase) * smoothstep(0.3, 1.0, swSqT) + swSqLife + 0.6 * swColQuiet;
float swSqCut1 = 1.0 - (1.0 - swSqBase) * smoothstep(0.0, 0.7, swSqT) + 0.45 * clamp(swSqT - 1.0, 0.0, 1.0) + swSqLife + 0.6 * swColQuiet;
// Dapples: a lighter flat tone on the same noise's highs, shrinking away by octave like the strokes.
float swDapCut0 = 0.64 + 0.36 * clamp(swSqT, 0.0, 1.0);
float swDapCut1 = 1.0 - 0.36 * clamp(swSqT, 0.0, 1.0) + 0.36 * clamp(swSqT - 1.0, 0.0, 1.0);
float swDapple = max(smoothstep(swDapCut0 - fwidth(swSqN0), swDapCut0 + fwidth(swSqN0), swSqN0), smoothstep(swDapCut1 - fwidth(swSqN1), swDapCut1 + fwidth(swSqN1), swSqN1));
// Brush strokes, like the crest lines: each swells to its full width (three to five pixels close up).
float swSqHalf = mix(1.3, 2.3, swClose);
float swSqTaper0 = clamp((swSqD0 - swSqCut0) * 8.0, 0.0, 1.0);
float swSqTaper1 = clamp((swSqD1 - swSqCut1) * 8.0, 0.0, 1.0);
float swSqW0 = swSqHalf * (0.35 + 0.65 * swSqTaper0);
float swSqW1 = swSqHalf * (0.35 + 0.65 * swSqTaper1);
float swSq0 = (1.0 - smoothstep(swSqW0 - 0.6, swSqW0 + 0.6, abs(swSqN0 - 0.5) / max(fwidth(swSqN0), 0.00001))) * smoothstep(0.25, 0.45, swSqTaper0);
float swSq1 = (1.0 - smoothstep(swSqW1 - 0.6, swSqW1 + 0.6, abs(swSqN1 - 0.5) / max(fwidth(swSqN1), 0.00001))) * smoothstep(0.25, 0.45, swSqTaper1);
float swStrokes = max(swLines, max(swSq0, swSq1) * swClearOfLines);`, `
// Low: one fixed scale (about a metre) near the eye.
float swSqN0 = swNoise(swSqP);
float swSqCut0 = 0.52 + 0.4 * smoothstep(0.03, 0.1, swFoot) + swSqLife + 0.6 * swColQuiet;
float swSqTaper0 = clamp((swNoise(swSqP * 1.3 + vec2(3.1, 7.7)) - swSqCut0) * 8.0, 0.0, 1.0);
float swDapCut0 = 0.64 + 0.36 * smoothstep(0.03, 0.1, swFoot);
float swDapple = smoothstep(swDapCut0 - fwidth(swSqN0), swDapCut0 + fwidth(swSqN0), swSqN0);
float swSqHalf = mix(1.3, 2.3, swClose) * (0.35 + 0.65 * swSqTaper0);
float swSq0 = (1.0 - smoothstep(swSqHalf - 0.6, swSqHalf + 0.6, abs(swSqN0 - 0.5) / max(fwidth(swSqN0), 0.00001))) * smoothstep(0.25, 0.45, swSqTaper0);
float swStrokes = max(swLines, swSq0 * swClearOfLines);`)}
swLit = mix(swLit, swLit * 1.26 + swShallowC * (0.03 * swExpo), swDapple * (1.0 - swTop * 0.5));
float swFleck = 0.0;
// Flecks: small white ovals (rounded, so they never read as glyphs), longer across the wind, on two jittered grids riding the water with the strokes (small
// ones and tiny ones close to the eye). Each lives for part of a slow cycle, growing from a point to its full size and
// shrinking back, and drops out by its own rank (shrinking away, never switching off) before its full size would be
// under about three pixels, so distant water never speckles, and none grows into a floe close up. (Their rank cut used
// to follow their pulsing size, so they popped on and off between frames.)
vec2 swFlP = vec2(dot(swStrokeW, swWindDir), dot(swStrokeW, swCross)) * U.slateWaterMotion.y;
vec2 swFlIdA = floor(swFlP / 3.0);
float swFlRndA = swHash(swFlIdA + vec2(3.0, 11.0));
vec2 swFlDA = (fract(swFlP / 3.0) - vec2(0.5) - (swHash2(swFlIdA) - vec2(0.5)) * 0.5) * 3.0;
// Close to the eye a fleck stays small on screen (about a dozen pixels tall at most).
float swFlMaxA = min(0.22, swFoot * 6.0);
float swFlCutA = mix(1.05, 0.66 - 0.2 * swClose, smoothstep(2.5, 4.5, 1.8 * swFlMaxA / max(swFoot, 0.00001))) + 0.5 * swColQuiet;
float swFlLifeA = sin(min(fract(swFlRndA * 5.0 + swTime * (0.2 + 0.25 * fract(swFlRndA * 7.31))) * 1.3, 1.0) * 3.141593);
float swFlRA = swFlMaxA * sqrt(swFlLifeA) * smoothstep(swFlCutA, swFlCutA + 0.05, swFlRndA);
float swFlSA = length(swFlDA * vec2(2.2, 1.0)) - swFlRA;
float swFlAA = min(fwidth(swFlSA) * 0.7 + 0.0005, 0.3);
// A fleck smaller than its antialiasing width dims by its size, so it shrinks away instead of leaving a grey dot.
swFleck = (1.0 - smoothstep(-swFlAA, swFlAA, swFlSA)) * clamp(swFlRA / swFlAA, 0.0, 1.0);
vec2 swFlIdC = floor(swFlP / 0.9 + vec2(0.71, 0.23));
float swFlRndC = swHash(swFlIdC + vec2(13.0, 19.0));
vec2 swFlDC = (fract(swFlP / 0.9 + vec2(0.71, 0.23)) - vec2(0.5) - (swHash2(swFlIdC + vec2(4.0, 8.0)) - vec2(0.5)) * 0.5) * 0.9;
float swFlMaxC = min(0.07, swFoot * 5.0);
float swFlCutC = mix(1.05, 0.76, smoothstep(2.5, 4.5, 1.8 * swFlMaxC / max(swFoot, 0.00001))) + 0.5 * swColQuiet;
float swFlLifeC = sin(min(fract(swFlRndC * 3.0 + swTime * (0.3 + 0.3 * fract(swFlRndC * 5.17))) * 1.3, 1.0) * 3.141593);
float swFlRC = swFlMaxC * sqrt(swFlLifeC) * smoothstep(swFlCutC, swFlCutC + 0.05, swFlRndC);
float swFlSC = length(swFlDC * vec2(2.2, 1.0)) - swFlRC;
float swFlAAC = min(fwidth(swFlSC) * 0.7 + 0.0005, 0.1);
swFleck = max(swFleck, (1.0 - smoothstep(-swFlAAC, swFlAAC, swFlSC)) * clamp(swFlRC / swFlAAC, 0.0, 1.0));
swFleck *= swCalm;

// The sun: one bright flat colour (white by day, gold toward dusk) in horizontal dashes down its reflection column.
// The column comes from the swell's normal (a little chop), widened by that normal's variation across the pixel (its
// slope's screen derivatives, \`PIXEL_SLOPE_FILTER\`), so its edge and the dashes' thickness never jitter from pixel to
// pixel. The dashes lie on world rows across the sun's azimuth (level on screen when looking toward it), bent by the
// waves and cut by a noise along them; toward the column's core they lengthen and thicken. Only a dash's thickness
// follows the camera, continuously: rows stay 7 to 14 pixels apart by culling (as the footprint grows every other row
// thins out and vanishes, and the rows that stay never move), each row's dashes are seeded by its world index, and dash
// lengths step with the footprint by shrinking one octave's dashes away while the next octave's grow in, so no dash
// pops between frames.
vec2 swColSlope = swGradient + swDetail * (swChopGain * 1.0);
vec3 swColN = normalize(vec3(swBaseX - swColSlope.x, 1.0, swBaseZ - swColSlope.y));
float swColAlign = dot(reflect(-swV, swColN), swL);
vec2 swColDx = dFdx(swColSlope);
vec2 swColDy = dFdy(swColSlope);
float swColW = (0.007 + 0.03 * U.slateWaterOrigin.w) * (1.0 - 0.4 * swLowSun);${fromTier(1, "", `
// Low's smoother normal (fewer swell and chop terms) would spread the column into one broad blob.
swColW *= 0.7;`)}
swColW += min((dot(swColDx, swColDx) + dot(swColDy, swColDy)) * ${f(PIXEL_SLOPE_FILTER / 2)}, ${f(PIXEL_SLOPE_CAP)});
float swCol = clamp((swColAlign - 1.0 + swColW) / swColW, 0.0, 1.0) * smoothstep(0.05, 0.4, swSunSeen);
vec2 swSunSide = vec2(-swSunH.y, swSunH.x);
float swFootS = abs(dot(swFootX, swSunH)) + abs(dot(swFootY, swSunH));
float swFootT = abs(dot(swFootX, swSunSide)) + abs(dot(swFootY, swSunSide));
// Rows 0.15 m apart at level 0; level L keeps every 2^L-th, so its rows are 7 to 14 pixels apart.
float swRowLevel = max(log2(max(swFootS, 0.00001) * ${f(14 / 0.15)}), 0.0);
float swRowL = floor(swRowLevel);
float swRowPitch = 0.15 * exp2(swRowL);
float swRowPx = swRowPitch / max(swFootS, 0.00001);
// The waves bend the rows by a world distance (continuous in the footprint), so a row lies in one place at every level.
// The bend never folds a row back on itself (its change across the pixel stays well under the row coordinate's own),
// so close rows never curl into chevrons with hairline combs.
float swRowBase = dot(swWorld, swSunH);
float swRowBend = (swCrest * 0.4 + swChopH * 1.0) * max(swFootS * 10.0, 0.15);
swRowBend *= min(1.0, 0.6 / max((0.4 * length(swGradient) / max(U.slateWaterWaves.x, 0.001) + length(swDetail) * swOC0.z) * max(swFootS * 10.0, 0.15), 0.000001));
float swRowV = (swRowBase + swRowBend) / swRowPitch;
float swRowM = floor(swRowV + 0.5);
float swRowF = abs(swRowV - swRowM);
float swRowK = swRowM * exp2(swRowL);
// Every other row of this level is absent from the next one up: it thins out as the footprint grows toward it.
float swRowCull = 1.0 - step(0.25, fract(swRowM * 0.5)) * smoothstep(0.4, 1.0, swRowLevel - swRowL);
// Near the eye some rows stay empty, so the column's base reads as scattered strokes rather than an even grille.
swRowCull *= smoothstep(0.45 * swNearSwell - 0.15, 0.45 * swNearSwell, swHash(vec2(swRowK * 0.37, 3.7)));
// Dashes: two octaves of a noise along the row (dashes at least about 22 pixels long), drifting along it at a fixed
// world speed. As the footprint grows, the finer octave's dashes shrink away while the coarser one's grow in.
float swDashLevel = max(log2(max(swFootT, 0.00001) * ${f(22 / 0.35)}), 0.0);
float swDashL = floor(swDashLevel);
float swDashT = swDashLevel - swDashL;
float swDashLen = 0.35 * exp2(swDashL);
float swAlong = dot(swWorld, swSunSide) + swTime * 0.05;
float swDashN0 = swNoise(vec2(swAlong / swDashLen, swRowK * 1.37 + swDashL * 5.3));
float swDashN1 = swNoise(vec2(swAlong / (swDashLen * 2.0), swRowK * 1.37 + swDashL * 5.3 + 5.3));
float swDashCut = 0.92 + 0.14 * swNearSwell - swCol * 0.95;
float swDashMax = 0.32 - 0.12 * swNearSwell;
float swDashHalf = max(clamp((swDashN0 - swDashCut - 1.1 * smoothstep(0.35, 1.0, swDashT)) * 1.3, 0.0, swDashMax),
  clamp((swDashN1 - swDashCut - 1.1 + 1.1 * smoothstep(0.0, 0.65, swDashT)) * 1.3, 0.0, swDashMax));
// Half thickness in pixels: a share of the row spacing near the eye, of about ten pixels farther out.
float swDashHalfPx = swDashHalf * max(0.15 / max(swFootS, 0.00001), 10.0) * swRowCull;
float swRowAA = min(fwidth(swRowV) * 0.7 + 0.01, 0.2) * swRowPx;
float swPath = (1.0 - smoothstep(swDashHalfPx - swRowAA, swDashHalfPx + swRowAA, swRowF * swRowPx)) * smoothstep(0.3, 0.8, swDashHalfPx) * smoothstep(0.0, 0.05, swCol);
float swSpark = 0.0;${ifDefined(sparkles, fromTier(2, `
// Star sparkles: a few large four-pointed stars upright on screen in the column's core, on a jittered world grid; each
// cell's offset is solved into pixels through the footprint, so the stars keep their shape at any view angle.
vec2 swSparkUv = swFlowed * (0.22 * U.slateWaterMotion.y);
vec2 swSparkId = floor(swSparkUv);
float swSparkRnd = swHash(swSparkId + vec2(7.0, 3.0));
vec2 swSparkW = (fract(swSparkUv) - vec2(0.5) - (swHash2(swSparkId) - vec2(0.5)) * 0.5) / (0.22 * U.slateWaterMotion.y);
float swSparkDet = swFootX.x * swFootY.y - swFootX.y * swFootY.x;
vec2 swSparkPx = vec2(swSparkW.x * swFootY.y - swSparkW.y * swFootY.x, swFootX.x * swSparkW.y - swFootX.y * swSparkW.x) / ((step(0.0, swSparkDet) * 2.0 - 1.0) * max(abs(swSparkDet), 0.0000001));
float swSparkCellPx = 1.0 / max(0.22 * U.slateWaterMotion.y * swFoot, 0.0001);
float swSparkTw = abs(fract(swTime * (0.4 + 0.6 * swSparkRnd) + swSparkRnd * 9.0) * 2.0 - 1.0);
float swSparkR = min(10.0 + 6.0 * swSparkTw, swSparkCellPx * 0.3);
float swStarD = min(abs(swSparkPx.x) * 0.2 + abs(swSparkPx.y), abs(swSparkPx.x) + abs(swSparkPx.y) * 0.2);
swSpark = (1.0 - smoothstep(swSparkR - 0.7, swSparkR + 0.7, swStarD)) * step(1.0 - 0.45 * U.slateWaterLook.z, swSparkRnd) * smoothstep(0.3, 0.6, swCol) * smoothstep(5.0, 8.0, swSparkR);`))}
// The sun is warmer than the foam and line work (a cool off-white), so its path reads as one designed shape.
vec3 swSunC = mix(vec3(1.0, 0.94, 0.74), mix(swSunTone, vec3(1.0, 0.92, 0.6), 0.35), swEve) * clamp(0.75 + swKeyLum * 0.3, 0.85, 1.0);

// Far water steps lighter twice toward a far tone (a pale azure by day, violet at dusk), then fades into the horizon.
// The steps measure how steeply the view meets the swell's own surface (a third of its slope) rather than the flat sea, so
// wave backs turned toward the horizon step lighter first: the step edges run along the swell and travel with it.
// Where the swell is no longer resolved they soften into a gradient. (The steps used to measure the view ray alone,
// bent by world noises: hard bands fixed to the view, with lens-shaped islands sliding through them as the camera
// moved.)
vec2 swLookDir = -swV.xz / max(length(swV.xz), 0.0001);
float swSunLobe = clamp(dot(swLookDir, swSunH), 0.0, 1.0);
swSunLobe *= swSunLobe;
swSunLobe *= swSunLobe;
float swFarT = max(dot(normalize(mix(vec3(0.0, 1.0, 0.0), swSwellNormal, 0.35)), swV), 0.0);
float swFarSoft = 1.0 - smoothstep(0.3, 0.8, swResolved / max(0.0001, swSteep));
float swFarAA = fwidth(swFarT) * 0.75 + 0.00002;
// The steps stay hard (a narrow softening where the swell is unresolved, never a gradient outside the flat palette),
// and the wide noises shift their thresholds, so their edges break into islands and peninsulas rather than running as
// one even shelf or as corduroy rows of a single swell.
float swFarW1 = swFarAA + 0.008 * swFarSoft;
float swFarW2 = swFarAA + 0.005 * swFarSoft;
float swFarCut1 = 0.1 + (swLarge - 0.5) * 0.06 + (swGust - 0.5) * 0.03;
float swFarCut2 = 0.045 + (swLarge - 0.5) * 0.025 + (swMedium - 0.5) * 0.012 * (1.0 - smoothstep(0.3, 1.0, swFoot));
float swFarStep = 0.5 * (1.0 - smoothstep(swFarCut1 - swFarW1, swFarCut1 + swFarW1, swFarT)) + 0.5 * (1.0 - smoothstep(swFarCut2 - swFarW2, swFarCut2 + swFarW2, swFarT));
// Dusk: rose-violet far water, warming to the sun's gold toward its azimuth.
vec3 swFarDusk = mix(vec3(0.22, 0.05, 0.42), swGold * vec3(1.0, 0.42, 0.24), swSunLobe * 0.55);
vec3 swFarC = mix(mix(swDeepC, swShallowC, 0.3) + vec3(0.1), swFarDusk, swEve) * swTint * swExpo;
swFarC = mix(swFarC, vec3(dot(swFarC, swLuma) * 1.15) * vec3(0.78, 0.92, 1.12), swDesat);
// Toward the horizon the far tone fades gradually into a horizon tone, which only hides detail there, so no brighter
// seam runs along it: the sky's own colour just above the horizon where the view's scene copy shows it (Medium up, less
// at dusk), otherwise the far tone. (A flat strip of far tone used to lie between the far water and the sky.)
float swHaze = 1.0 - smoothstep(0.0, 0.05 + 0.02 * swEve, swUp);
swHaze *= swHaze;
// Aerial perspective in flat bands (the shared \`swAir\`, at grazing views): three hard steps of the far tone toward the
// horizon's, the last one the horizon itself, so the sea's far edge never shows as a line and the bands run along
// distance, not along the mesh. Each edge is antialiased by how fast the haze changes per pixel.
float swAirT = swAir * smoothstep(0.3, 0.85, 1.0 - swUp);
float swAirAA = fwidth(swAirT) * 0.75 + 0.002;
float swAirBand = (smoothstep(0.3 - swAirAA, 0.3 + swAirAA, swAirT) + smoothstep(0.6 - swAirAA, 0.6 + swAirAA, swAirT) + smoothstep(0.9 - swAirAA, 0.9 + swAirAA, swAirT)) / 3.0;
swHaze = max(swHaze, swAirBand);
vec3 swHazeC = swFarC;
#if ${SAMPLES_COPY}${horizonCopySource()}
swHazeC = mix(swFarC, swHorSum / max(swHorN, 0.001), swHorOn * min(swHorN, 1.0) * (0.7 - 0.45 * swEve));
#endif

// Foam: opaque white shapes antialiased by the footprint. Shore: a thick scalloped band on the waterline and a thinner
// ring breathing in and out beyond it. Objects: a lobed collar, one bold ring breathing close outside it and a thinner
// ring travelling out and breaking up. Steep folding crests: caps (Crest Foam). Medium up: drifting patches on wave
// backs (Surface Foam) and flecks.
float swFoamAmt = clamp(swFoamAmount, 0.0, 1.0);
float swNearFoam = 1.0 - smoothstep(0.4, 1.2, swFoot * 0.43);
float swLobes = (swMedium - 0.5) * 0.9 * swNearFoam + (swLarge - 0.5) * 0.6;${fromTier(2, `
swLobes += (swFine - 0.5) * 0.35 * (1.0 - smoothstep(0.1, 0.4, swFoot));`)}
// Distance to the shore (metres): the body's own bank and, over known terrain, the field's stored distance to the
// terrain's rest shoreline (a smooth, filtered distance field). The band follows the waves where the depth (as if the
// bed shelved 1:10) is nearer, but reaches at most one and a half foam widths beyond the rest shoreline's band, so a
// flat shallow bar far from the shore stays clear.
float swRestShore = max(0.0, min(max(0.0, swBankV), mix(${f(SHORE[1])}, mix(${f(SHORE[0])}, ${f(SHORE[1])}, swField.r), swKnown)));
float swDepthShore = mix(${f(SHORE[1])}, max(0.0, swTerrainDepth) * 10.0, swKnown);
float swShoreUnit = min(min(swRestShore, max(swDepthShore, swRestShore - swFoamWidth * 0.6)), ${f(SHORE[1])}) / swFoamWidth;
${fromTier(1, `
// Scallops: a noise about two foam widths across, folded at its middle value (a billow), so the band's edge runs as
// rounded lobes meeting in sharp cusps.
float swScallop = swNoise(swWorld / (swFoamWidth * 1.8) + vec2(swTime * 0.06, 0.0));`, `
float swScallop = swMedium;`)}
float swShoreLobes = (abs(swScallop * 2.0 - 1.0) - 0.3) * 1.3 * swNearFoam + (swLarge - 0.5) * 0.5;
// A body's own edge over open water (a lake's bank, no terrain shoreline near) keeps a narrower band than a beach.
float swBodyEdge = smoothstep(0.5, 3.0, swFieldShore - max(0.0, swBankV));
// The band's edge runs in and out with the swash (\`swSwashRun\`): wider as each bore runs up, narrower as it drains.
float swSurfEdge = mix(3.3, 1.3, swBodyEdge) * swFoamAmt * (0.72 + 0.45 * swSwashRun);
float swShoreX = swShoreUnit - swShoreLobes * 0.9;
float swAAU = min(fwidth(swShoreX) * 0.7 + 0.002, 0.5);
// Over terrain the band gives way where the backwash has uncovered the shallows (a hard cut, the swash's own edge), and
// the bore's front runs up the beach as a bold line that thins as it drains (\`swSwashFoam\` cut at half).
float swToonAA = min(fwidth(swSwashEdgeS) * 0.7 + 0.002, 0.3);
float swToonCover = smoothstep(-swToonAA, swToonAA, swSwashEdgeS);
float swFoam = (1.0 - smoothstep(swSurfEdge - swAAU, swSurfEdge + swAAU, swShoreX)) * swToonCover;
float swFrontAA = min(fwidth(swSwashFoam) * 0.7 + 0.01, 0.3);
swFoam = max(swFoam, smoothstep(0.5 - swFrontAA, 0.5 + swFrontAA, swSwashFoam) * step(0.01, swFoamAmt));
// The ring: from Medium a bold line on each bore (\`swBorePhase\`) rolling in toward the band, thinning (never fading)
// as it arrives and far out; Low keeps one ring breathing beyond the band. Both follow the rest shoreline (a distance
// field that grows toward open water everywhere, so they never flash across a flat bar), at least about a pixel and a
// half wide.
float swWashUnit = swRestShore / swFoamWidth - swShoreLobes * 0.6;${fromTier(1, `
// Distances in metres from the bore front (bores are tens of metres apart for long swell, so a share of a cycle
// would draw metre-wide bands up close).
float swBoreD = (min(swBorePhase, 1.0 - swBorePhase) * 6.283185 / max(U.slateWaterSwash.z, 0.001)) * (1.0 + swShoreLobes * 0.15);
float swBoreAAC = min(fwidth(swBoreD) * 0.7 + 0.002, 0.5);
// At least about a pixel and a half wide (the line thins, never fades), while its bore is strong enough.
float swBoreHalf = max(0.16 * swFoamWidth * swBoreOn, swBoreAAC * 1.1 * smoothstep(0.15, 0.35, swBoreOn)) * step(0.01, swFoamAmt);
swFoam = max(swFoam, (1.0 - smoothstep(swBoreHalf - swBoreAAC, swBoreHalf + swBoreAAC, swBoreD)) * step(0.000001, swBoreHalf) * (1.0 - smoothstep(5.0, 6.0, swWashUnit)));`, `
float swWashPhase = sin(swTime * 0.8 + swLarge * 5.0);
float swWashAA = min(fwidth(swWashUnit) * 0.7 + 0.002, 0.5);
float swWashHalf = max((0.26 + 0.06 * swWashPhase) * mix(1.0, 0.6, swBodyEdge) * swFoamAmt, swWashAA * 1.1) * step(0.01, swFoamAmt);
swFoam = max(swFoam, (1.0 - smoothstep(swWashHalf - swWashAA, swWashHalf + swWashAA, abs(swWashUnit - swSurfEdge - 1.0 - 0.3 * swWashPhase))) * (1.0 - smoothstep(5.0, 6.0, swWashUnit)));`)}
// Surf (\`swSurfBreak\`, \`swSurfGate\`): the breaking patches that advance with the swell's crests as hard shapes, and two
// thinner scalloped lines stepping seaward behind the band, each swinging in and out with the swash and the waves.
float swBrkAA = min(fwidth(swSurfBreak) * 0.7 + 0.01, 0.3);
swFoam = max(swFoam, smoothstep(0.42 - swBrkAA, 0.42 + swBrkAA, swSurfBreak) * step(0.01, swFoamAmt) * swToonCover);
float swSurfLineOn = smoothstep(0.15, 0.4, swSurfGate) * step(0.01, swFoamAmt) * (1.0 - smoothstep(7.0, 9.0, swWashUnit));
float swSurfLineAA = min(fwidth(swWashUnit) * 0.7 + 0.002, 0.5);
float swSurfLineU = swWashUnit - swSurfEdge - swShoreLobes * 0.5;
float swSurfLineHalf = max(0.15, swSurfLineAA * 1.1);
float swSurfLine1 = 1.0 - smoothstep(swSurfLineHalf - swSurfLineAA, swSurfLineHalf + swSurfLineAA, abs(swSurfLineU - 1.5 - 1.0 * swSwashRun - 0.5 * swBrkG));
float swSurfLine2 = 1.0 - smoothstep(swSurfLineHalf * 0.8 - swSurfLineAA, swSurfLineHalf * 0.8 + swSurfLineAA, abs(swSurfLineU - 3.4 - 1.6 * swSwashRun - 0.9 * swBrkG));
swFoam = max(swFoam, max(swSurfLine1, swSurfLine2 * step(0.0, swShoreLobes + 0.25)) * swSurfLineOn * swToonCover);
// Object contacts, in contact widths from the waterline: a collar whose radius swells and shrinks with a noise scaled
// to the width (so it never opens holes at the waterline) and pulses with the swell at the hull (\`swHullPulse\`: out as
// the water climbs, clinging a moment as it drops), one bold ring breathing with it close outside, a thinner ring sent
// out with each rise (\`swHullV\`; on the clock without waves) that thins and breaks up as it goes, and from Medium
// round puffs shed downstream (\`swLeePuff\`). All fade out before the contact range.
float swContactAmt = clamp(swContactStrength, 0.0, 1.0);
${fromTier(1, `
float swCLobe = swNoise(swWorld * (0.8 / swContactW) + vec2(swTime * 0.1, swTime * -0.06));`, `
float swCLobe = swMedium;`)}
float swContactX = swObject / swContactW * (1.0 + (swCLobe - 0.5) * 0.24);
// Antialiased by the pixel footprint (the waterline distance is a distance field): its screen derivatives step with the
// contact field's texels and would spike the edge into hairs.
float swCAA = min(swFoot * 0.5 / swContactW + 0.002, 0.3);
float swCollarEdge = (0.12 / swContactW + 0.3) * swContactAmt * (0.75 + 0.5 * swHullPulse);
float swCollar = 1.0 - smoothstep(swCollarEdge - swCAA, swCollarEdge + swCAA, swContactX);
float swRingAHalf = max(0.07 * swContactAmt, swCAA * 0.8);
float swRingA = 1.0 - smoothstep(swRingAHalf - swCAA, swRingAHalf + swCAA, abs(swContactX - swCollarEdge - 0.3 - 0.12 * swHullPulse - 0.03 * (swCLobe - 0.5)));
float swWavesOn = step(0.000001, U.slateWaterWaves.x);
float swRingT = mix(fract(swTime * 0.35), fract(swHullV - 0.3), swWavesOn);
float swRingRun = mix(0.9, min(6.283185 / max(U.slateWaterContactInfo.w, 0.01) / swContactW, 2.5), swWavesOn);
float swRingBHalf = 0.05 * (1.0 - swRingT) * swContactAmt;
float swRingB = (1.0 - smoothstep(swRingBHalf - swCAA, swRingBHalf + swCAA, abs(swContactX - swCollarEdge - 0.55 - swRingT * swRingRun))) * step(swRingT * 0.8, swCLobe) * step(swCAA, swRingBHalf * 1.4);
float swPuff = 0.0;${fromTier(1, `
float swPuffD = swLeePuff * exp(-swOutside / (swContactW * 2.0)) * (0.55 + 0.6 * swCLobe) * smoothstep(0.0, 0.2, swContactSigned);
swPuff = smoothstep(0.42 - swCAA, 0.42 + swCAA, swPuffD);`)}
swFoam = max(swFoam, max(swCollar, max(max(swRingA, swRingB), swPuff) * step(0.01, swContactAmt)) * swNearContact);
// Foam holes (caps and patches): round gaps opening wider where the foam thins toward its edge, as Wind Waker's foam
// patches have; they close up before they would shrink under about two pixels. Below High, one jittered world cell
// each (no neighbour search, so each circle stays inside its cell) and only some cells open one. From High, the
// nearest of a 3 × 3 neighbourhood of freely placed points (\`swWeb\`), stretched a little along the wind, with sizes
// and openings from noises: no rows or columns of holes.
float swHoleCell = 0.8 * exp2(max(0.0, ceil(log2(max(swFoot, 0.00001) * 0.5 * 12.0 / 0.8))));
vec2 swHoleUv = swFlowed / swHoleCell;${fromTier(2, `
float swHoleD = swWeb(vec2(dot(swHoleUv, swWindDir) * 0.67, dot(swHoleUv, swCross)) + vec2(17.0, 31.0)).x;
float swHoleSize = (0.1 + 0.26 * swNoise(swHoleUv * 0.6 + vec2(3.7, 1.3))) * smoothstep(0.38, 0.5, swNoise(swHoleUv * 0.9 + vec2(9.1, 4.4)));`, `
vec2 swHoleId = floor(swHoleUv);
vec2 swHoleRnd = swHash2(swHoleId + vec2(17.0, 31.0));
float swHoleD = length(fract(swHoleUv) - vec2(0.5) - (swHoleRnd - vec2(0.5)) * 0.36);
float swHoleSize = (0.12 + 0.24 * swHoleRnd.x) * step(0.45, fract(swHoleRnd.y * 7.31));`)}
float swHoleAA = min(fwidth(swHoleD) * 0.7 + 0.002, 0.08);
float swCapD = 0.0;${ifDefined(crestFoam, `
// Caps on steep, folding crests (Jacobian), broken along the crest by a noise stretched across the wind; Crest Foam
// sets coverage. Round holes open toward their edges, so they read as foam rather than floating plates. Far away the
// cut rises, so caps shrink and vanish instead of thinning to lines.
vec2 swWindUv = vec2(dot(swFlowed, swWindDir), dot(swFlowed, swCross));
float swCrestNoise = swNoise(swWindUv * vec2(0.8, 0.3) * U.slateWaterMotion.y + vec2(swMedium - 0.5, swLarge - 0.5) * 1.3);
float swCapDrive = (swFoldN * 1.35 + swCrest * 0.25 + (swCrestNoise - 0.5) * 0.7 * swNearFoam + swLobes * 0.15) * swRough;
float swCapCut = 1.55 - 1.05 * U.slateWaterShape.z + 0.25 * smoothstep(0.4, 1.6, swFoot) + 0.6 * smoothstep(2.0, 3.5, swFoot);
float swCapAA = min(fwidth(swCapDrive) * 0.7 + 0.004, 0.2);
// Holes open only where Crest Foam is plentiful; a lone cap on a moderate sea stays solid.
float swCapR = swHoleSize * (1.0 - 0.45 * clamp((swCapDrive - swCapCut) / 0.5, 0.0, 1.0)) * smoothstep(0.45, 0.8, U.slateWaterShape.z);
swCapD = smoothstep(swCapCut - swCapAA, swCapCut + swCapAA, swCapDrive) * swFoamAmt;
// Only the upper part of each wave carries a cap, so caps run along the crests instead of spreading into pancakes.
float swCapTopAA = min(fwidth(swCrest) * 0.7 + 0.003, 0.2);
swCapD *= smoothstep(0.15 - swCapTopAA, 0.15 + swCapTopAA, swCrest + (swCrestNoise - 0.5) * 0.3);
swCapD *= 1.0 - (1.0 - smoothstep(swCapR - swHoleAA, swCapR + swHoleAA, swHoleD)) * step(swHoleAA * 1.5, swCapR);
swFoam = max(swFoam, swCapD);`)}${ifDefined(surfaceFoam, fromTier(1, `
// Drifting patches (Surface Foam): streaks along the wind gathered on the backs of steep waves behind their caps, with
// holes like the caps; far away their cut rises so they vanish before their streak noise would alias.
vec2 swPatchUv = vec2(dot(swFlowed, swWindDir), dot(swFlowed, swCross)) * vec2(0.45, 0.2) + vec2(swMedium - 0.5, swGust - 0.5) * 1.4;
float swPatchNoise = swNoise(swPatchUv) * 0.7 + swGust * 0.3;
float swBackW = max(dot(swGradient, swWindDir), 0.0) / max(0.0001, swSeaState);
float swAttach = clamp(0.4 + swBackW * swRough * 1.2 + swCapD - max(swCrest, 0.0) * 0.3, 0.0, 1.0);
float swOpenCut = 1.05 - 0.5 * U.slateWaterSunColor.w * swAttach + 0.3 * smoothstep(0.35, 1.0, swFoot * 0.45);
float swPatchAA = min(fwidth(swPatchNoise) * 0.7 + 0.003, 0.1);
float swPatchR = swHoleSize * (1.0 - 0.45 * clamp((swPatchNoise - swOpenCut) / 0.12, 0.0, 1.0));
float swPatchF = smoothstep(swOpenCut - swPatchAA, swOpenCut + swPatchAA, swPatchNoise) * smoothstep(0.0, 0.3, U.slateWaterSunColor.w) * swCalm * swFoamAmt;
swFoam = max(swFoam, swPatchF * (1.0 - (1.0 - smoothstep(swPatchR - swHoleAA, swPatchR + swHoleAA, swHoleD)) * step(swHoleAA * 1.5, swPatchR)));`))}
// Strokes and flecks give way around object contacts, so those keep the eye (the sun's column raised their cuts above).
float swQuiet = (1.0 - step(swCollarEdge + 1.6, swContactX)) * step(0.01, swNearContact);
swStrokes *= 1.0 - swQuiet;
swFoam = max(swFoam, swFleck * (1.0 - swQuiet));

vec3 swColor = mix(swLit, swFoamLit * vec3(0.88, 0.94, 1.0), swStrokes);
swColor = mix(swColor, swFarC, swFarStep);
swFoam *= 1.0 - swHaze * 0.8;
swColor = mix(swColor, swFoamLit, swFoam);
float swSunShape = max(swPath, swSpark) * (1.0 - swFoam);
swColor = mix(swColor, swSunC, swSunShape);
vec3 swEmissive = mix(swColor, swHazeC, smoothstep(0.0, 1.0, swHaze));
surfaceAlbedo = vec3(0.0);
// The shallowest band lets the bed show through a little; everything else is opaque.
alpha = clamp(max(U.slateWaterShallow.a * mix(0.65, 1.0, clamp(swDepthTone * 2.0, 0.0, 1.0)), max(max(swFoam, swStrokes), max(swSunShape, swHaze))), 0.0, 1.0);
// Backwash: uncovered shallows keep their foam and one flat wet tone with a hard edge where the film is still wet
// (darker water over the sand), which shrinks back as the sand dries behind the swash.
float swFilm = (1.0 - swToonCover) * swSwashWet;
float swFilmAA = min(fwidth(swFilm) * 0.7 + 0.01, 0.2);
float swFilmA = max(swFoam, smoothstep(0.32 - swFilmAA, 0.32 + swFilmAA, swFilm) * 0.34);
swEmissive = mix(mix(swFoamLit * vec3(0.2, 0.17, 0.15), swFoamLit, clamp(swFoam / max(swFilmA, 0.001), 0.0, 1.0)), swEmissive, swToonCover);
alpha = mix(swFilmA, alpha, swToonCover);
// Fresnel for object reflections: they replace the water by it, never over foam.
float swNdotV = clamp(dot(normalize(mix(swSwellNormal, normalW, 0.5)), swV), 0.0, 1.0);
float swFx = 1.0 - swNdotV;
float swFres = 0.03 + 0.97 * swFx * swFx * swFx * swFx * swFx;
vec3 swRefl = reflect(-swV, normalize(mix(swSwellNormal, normalW, 0.5)));
${objectReflectionSource("swRefl", "U.slateWaterOrigin.w")}
#if ${REFLECTS_OBJECTS}
float swReflWeight = clamp(swObjRefl.a * swFres * U.slateWaterDeep.w * (1.0 - swFoam) * swToonCover, 0.0, 1.0);
swEmissive = mix(swEmissive, swObjRefl.rgb, swReflWeight);
alpha = max(alpha, swReflWeight);
#endif${ifDefined(REFRACTION, `
swRefracts *= swToonCover;
// Refraction-tinted shallows: what shows through takes the water's hue (a gain of at most 1) and fades toward the
// water's own colour with the refracted depth, so nothing below glows brighter than above.
vec3 swTintHue = swShallowC / max(max(swShallowC.r, max(swShallowC.g, swShallowC.b)), 0.001);
swBackground = mix(swBackground * mix(vec3(1.0), swTintHue, 0.5), swLit, clamp(swTone, 0.0, 1.0));
// The refracted scene replaces the blended background; Opacity still sets how much of it shows. It joins the output
// after the water's own fog (\`swRefracted\`, see CUSTOM_FRAGMENT_BEFORE_FOG).
float swRefractedWeight = (1.0 - alpha) * swRefracts;
vec3 swRefracted = swBackground * swRefractedWeight;
swEmissive = swEmissive * mix(1.0, alpha, swRefracts);
alpha = mix(alpha, 1.0, swRefracts);`)}
`;
}

/** Signed distance to a removal primitive (shape code in x, half extents in yzw), in its local space. */
const REMOVAL_HELPER = `
float swRemoval(mat4 inv, vec4 shape, vec3 p) {
  if (shape.x < 0.5) { return 1.0; }
  vec3 q = (inv * vec4(p, 1.0)).xyz;
  vec3 h = shape.yzw;
  if (shape.x < 1.5) {
    vec3 d = abs(q) - h;
    return length(max(d, vec3(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0);
  }
  if (shape.x < 2.5) { return length(q) - h.x; }
  if (shape.x < 3.5) {
    vec2 c = vec2(length(q.xz) - h.x, abs(q.y) - h.y);
    return min(max(c.x, c.y), 0.0) + length(max(c, vec2(0.0)));
  }
  float swStraight = max(0.0, h.y - h.x);
  return length(vec3(q.x, q.y - clamp(q.y, -swStraight, swStraight), q.z)) - h.x;
}
`;

export const WATER_REMOVAL_SLOTS = 4;

/**
 * Runs at CUSTOM_FRAGMENT_UPDATE_ALPHA: still before the depth pre-pass, so removed water leaves no
 * depth behind, but after WebGPU has copied the fragment inputs (MAIN_BEGIN would see zeros there).
 */
function cutSource(wgsl: boolean): string {
  const sample = wgsl
    ? "var swField: vec4f = textureSampleLevel(slateWaterFieldSampler, slateWaterFieldSamplerSampler, swFieldUv, 0.0);"
    : "vec4 swField = texture2D(slateWaterFieldSampler, swFieldUv);";
  const sampleContacts = wgsl
    ? "var swContactTex: vec4f = textureSampleLevel(slateWaterContactSampler, slateWaterContactSamplerSampler, swContactUv, 0.0);"
    : "vec4 swContactTex = texture2D(slateWaterContactSampler, swContactUv);";
  // Inside a branch: explicit level 0, no implicit derivatives.
  const tap = (name: string, uv: string) => wgsl
    ? `var ${name}: vec4f = textureSampleLevel(slateWaterFieldSampler, slateWaterFieldSamplerSampler, ${uv}, 0.0);`
    : `vec4 ${name} = texture2DLodEXT(slateWaterFieldSampler, ${uv}, 0.0);`;
  const removals = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `swRemoval(U.slateWaterRemoval${i}, U.slateWaterRemovalShape${i}, swPosW)`);
  const colors = (blend: boolean) => COLOR_UNIFORMS.map((name, i) =>
    `vec4 ${COLOR_LOCALS[i]} = ${blend ? `mix(U.${name}, U.${BLEND_COLOR_UNIFORMS[i]}, swBlendShare)` : `U.${name}`};`).join("\n");
  return `
// Large-world rendering makes vPositionW eye-relative; rebuild the absolute world position.
vec3 swPosW = IN.vPositionW + U.slateWaterOrigin.xyz;
// The asset's colours, mixed toward a blended neighbour's by its share (\`SLATE_WATER_BLEND\`). A blending surface keeps
// only fragments it owns (margin >= 0, in metres, with a 1.5 cm overlap, wider than the margin's interpolation error, so seams never open) inside the blended shoreline.
#ifdef ${WATER_BLEND_DEFINE}
float swBlendShare = IN.vSlateWaterBlend.w;
#ifdef ${WATER_TOON_DEFINE}
// Toon hands the colours over in three flat cels (soft-edged steps) rather than an airbrushed gradient.
float swBlendCel = swBlendShare * 3.0;
swBlendShare = (floor(swBlendCel) + smoothstep(0.4, 0.6, fract(swBlendCel))) / 3.0;
#endif
${colors(true)}
float swBlendKeep = min(IN.vSlateWater.y, IN.vSlateWaterBlend.z + 0.015);
#else
${colors(false)}
float swBlendKeep = 1.0;
#endif
vec2 swFieldUv = (swPosW.xz - U.slateWaterFieldBounds.xy) * U.slateWaterFieldBounds.zw;
${sample}
// The field hands over to the open-water defaults across its last three texels, so its bounds never draw a seam.
vec2 swFieldEdge = min(swFieldUv, vec2(1.0) - swFieldUv) / max(U.slateWaterFieldStep.xy * 3.0, vec2(0.000001));
float swFieldOn = U.slateWaterFieldInfo.x * clamp(min(swFieldEdge.x, swFieldEdge.y), 0.0, 1.0);
// Geometry displacement, not the unfiltered per-pixel normal waves, sets the waterline. Shallows read the fine
// depth channel (sized to the wave envelope), so gentle shores have no terraces; deeper water falls back to the
// full-range channel.
float swFineSpan = U.slateWaterFieldStep.z;
float swCoarseDepth = mix(U.slateWaterFieldInfo.z, U.slateWaterFieldInfo.w, swField.g);
float swFineDepth = U.slateWaterFieldInfo.y + swField.b * swFineSpan;
float swFineTop = U.slateWaterFieldInfo.y + swFineSpan;
float swTerrainDepth = mix(swFineDepth, swCoarseDepth, smoothstep(swFineTop - 0.8, swFineTop - 0.2, swFineDepth)) + IN.vSlateWater.x;
float swTerrainShore = mix(${f(SHORE[0])}, ${f(SHORE[1])}, swField.r);
// Objects: signed distances at four heights across rest +/- the wave envelope (negative inside). Blending the
// two layers around this fragment's rendered wave height puts contacts on the actual, moving waterline.
vec2 swContactUv = (swPosW.xz - U.slateWaterContactBounds.xy) * U.slateWaterContactBounds.zw;
${sampleContacts}
float swContactOn = U.slateWaterContactInfo.x * step(0.0, swContactUv.x) * step(swContactUv.x, 1.0) * step(0.0, swContactUv.y) * step(swContactUv.y, 1.0);
float swLayer = (clamp(IN.vSlateWater.x / max(0.001, U.slateWaterContactInfo.z), -1.0, 1.0) * 0.5 + 0.5) * 3.0;
vec4 swLayerW = max(vec4(0.0), vec4(1.0) - abs(vec4(0.0, 1.0, 2.0, 3.0) - vec4(swLayer)));
float swContactSigned = mix(1.0, dot(swContactTex, swLayerW) * 2.0 - 1.0, swContactOn) * U.slateWaterContactInfo.y;
vec2 swContactDerivative = vec2(dFdx(swContactSigned), dFdy(swContactSigned));
// Derivatives before discard.
vec2 swDx = dFdx(swPosW.xz);
vec2 swDy = dFdy(swPosW.xz);
float swDet = swDx.x * swDy.y - swDx.y * swDy.x;
// Outward world X/Z direction from the nearest object, from the screen derivatives of its distance.
float swSafeDet = mix(1e-12, swDet, step(1e-12, abs(swDet)));
vec2 swContactGrad = vec2(swContactDerivative.x * swDy.y - swContactDerivative.y * swDx.y, swDx.x * swContactDerivative.y - swDy.x * swContactDerivative.x) / swSafeDet;
vec2 swContactDir = swContactGrad / max(length(swContactGrad), 0.00001);
// Over known terrain with waves, convert wave-relative depth to a local world-space shoreline distance: the
// displaced depth over the terrain slope. Central differences one cell apart keep that slope continuous (a bilinear
// field's own gradient steps at every cell); they read the fine depth (2 cm steps). Where a tap is clamped beyond the
// fine range (a floor deeper than any trough reaches, or land above the highest crest) the waves cannot move the
// shoreline, so the stored rest distance stands: steep coasts keep their shoreline, and the full-range depth's 16 cm
// steps never read as slopes (over a gentle deep floor they drew contour rings of shore foam). Rest-height distance
// stays exact when waves are off. Only real terrain takes this path: cells extended past an underwater landscape edge
// (alpha ramp) have no floor slope to measure, so they keep the stored distance to real land. Open water skips the
// four taps. The terrain's slope there (\`swShoreSlope\`; 1, steep, where clamped or unmeasured) sizes the shore swash,
// and its seaward direction (\`swShoreNormal\`, zero where unmeasured) tells the bores which coasts face the swell.
float swShoreSlope = 1.0;
vec2 swShoreNormal = vec2(0.0);
if (U.slateWaterWaves.x > 0.0 && swField.a > ${f(WATER_FIELD_TERRAIN_ALPHA)}) {
  vec2 swFieldStep = U.slateWaterFieldStep.xy;
  ${tap("swTapE", "swFieldUv + vec2(swFieldStep.x, 0.0)")}
  ${tap("swTapW", "swFieldUv - vec2(swFieldStep.x, 0.0)")}
  ${tap("swTapN", "swFieldUv + vec2(0.0, swFieldStep.y)")}
  ${tap("swTapS", "swFieldUv - vec2(0.0, swFieldStep.y)")}
  vec2 swCellMetres = max(swFieldStep / U.slateWaterFieldBounds.zw, vec2(0.000001));
  vec2 swTerrainSlope = vec2(swTapE.b - swTapW.b, swTapN.b - swTapS.b) * (swFineSpan * 0.5) / swCellMetres;
  float swFineClamped = max(smoothstep(0.93, 0.99, max(max(swTapE.b, swTapW.b), max(swTapN.b, swTapS.b))),
    1.0 - smoothstep(0.01, 0.07, min(min(swTapE.b, swTapW.b), min(swTapN.b, swTapS.b))));
  swTerrainShore = mix(clamp(swTerrainDepth / max(length(swTerrainSlope), 0.001), ${f(SHORE[0])}, ${f(SHORE[1])}), swTerrainShore, swFineClamped);
  swShoreSlope = mix(length(swTerrainSlope), 1.0, swFineClamped);
  swShoreNormal = swTerrainSlope / max(length(swTerrainSlope), 0.0001) * (1.0 - swFineClamped);
}
float swCut = min(min(${removals[0]}, ${removals[1]}), min(${removals[2]}, ${removals[3]}));
// Only real terrain removes water; cells extended past a landscape's edge (alpha ramp) never do.
if (swCut < 0.0 || swBlendKeep < 0.0 || (swField.a * swFieldOn > ${f(WATER_FIELD_TERRAIN_ALPHA)} && swTerrainDepth <= 0.0)) { discard; }
`;
}

/**
 * Vertex stage of `SLATE_WATER_GPU_WAVES`, at CUSTOM_VERTEX_UPDATE_WORLDPOS: the kernel's forward evaluation
 * (`evaluateWaterVertex`) at this vertex's world rest point, unrolled over the swell uniforms. The rest grid carries
 * its mesh spacing in `slateWaterData.x` (the filter of unresolvable components) and its bank distance in `.y` (the
 * finite-body fade of the horizontal offset). Phases arrive reduced relative to the floating origin, so eye-relative
 * `worldPos` needs no large-argument trigonometry. Writes the displaced world position (the clip position, fog,
 * shadows and clip planes follow it) and leaves the height and offset for the varyings in `swvH` / `swvD`, so the
 * fragment finds its rest point and contacts see the rendered height. With `SLATE_WATER_FFT_VERTEX`, the FFT detail
 * band (`fftVertexSource`) adds its displacement before the bank fade. `slateWaterGridOffset` (xyz) is the world-space
 * translation of the rest grid since its positions were uploaded (Global Water's recentre, `waterGridOffset`): it is
 * added before the rest point is taken, so the swell, bank terms and `vPositionW` all see the translated grid.
 * GLSL-shaped: `A.` attributes, `U.` uniforms, `S.` the view matrix's owner and `O.` outputs are bound per language,
 * then `toWgsl` translates it. Other passes that draw built-in water with their own vertex shader (the shared outline
 * mask) include the same displacement through `waterOutlineVertexSource`, without the material's `vPositionW` output.
 */
function vertexWaveSource(materialOutputs: boolean): string {
  const swell = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => `
vec4 swvWD${i} = U.${SWELL_DIRECTION[i]};
vec4 swvWA${i} = U.${SWELL_AMPLITUDE[i]};
vec4 swvWG${i} = U.${SWELL_GROUP[i]};
float swvF${i} = clamp(2.0 - swvSpacing * swvWA${i}.w, 0.0, 1.0);
swvF${i} = swvF${i} * swvF${i} * (3.0 - 2.0 * swvF${i});
float swvP${i} = swvWD${i}.z * dot(swvWD${i}.xy, swvRestW) + swvWA${i}.y;
float swvS${i} = sin(swvP${i});
float swvC${i} = cos(swvP${i});
float swvG${i} = (1.0 + swvWG${i}.w * cos(dot(swvWG${i}.xy, swvRestW) + swvWG${i}.z)) * (1.0 / sqrt(1.0 + 0.5 * swvWG${i}.w * swvWG${i}.w));
swvH += mix(swvS${i}, (exp(swvS${i} - 1.0) - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swvChop) * (swvWA${i}.x * swvF${i} * swvG${i});
swvD += swvWD${i}.xy * (swvWA${i}.z * swvF${i} * swvC${i});${ifFft(`
swvShear += vec3(swvWD${i}.x * swvWD${i}.x, swvWD${i}.x * swvWD${i}.y, swvWD${i}.y * swvWD${i}.y) * (swvWA${i}.z * swvF${i} * swvWD${i}.z * swvS${i});`, 1, FFT_VERTEX)}`).join("");
  // With the band's vertex part: the warp's M = I + dW/drest for the swell's Jacobian (the band's fold limit).
  const warpGradient = ifFft(`
vec3 swvWarpG = vec3(0.0);${SWELL_WARP.map((_, t) => `
swvWarpG -= vec3(swvWW${t}.x * swvWW${t}.x, swvWW${t}.x * swvWW${t}.y, swvWW${t}.y * swvWW${t}.y) * (swvWW${t}.z * sin(swvWP${t}));`).join("")}
vec3 swvWarpM = vec3(1.0 + swvWarpG.x, swvWarpG.y, 1.0 + swvWarpG.z);`, 1, FFT_VERTEX);
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
float swvSpacing = A.slateWaterData.x;
float swvChop = U.slateWaterShape.x;
worldPos = vec4(worldPos.xyz + U.slateWaterGridOffset.xyz, worldPos.w);
vec2 swvRest = worldPos.xz;
float swvH = 0.0;
vec2 swvD = vec2(0.0);${ifFft(`
vec3 swvShear = vec3(0.0);`, 1, FFT_VERTEX)}
// The shared kernel's warp: every component is evaluated at u = rest + W(rest) (\`waterSwellWarp\`).${swellWarpSource("swv", "swvRest", false)}${warpGradient}
vec2 swvRestW = swvRest + swvWarp;
${swell}
float swvFade = U.slateWaterSwellInfo.x;
#ifdef ${WATER_BLEND_DEFINE}
swvFade = swvFade * A.slateWaterBlend.y;
#endif
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));${fftVertexSource()}
#ifdef ${WATER_BLEND_DEFINE}
swvH = swvH * A.slateWaterBlend.x;
swvD = swvD * A.slateWaterBlend.y;
#endif
swvD = swvD * swvGain;
worldPos = vec4(worldPos.xyz + vec3(swvD.x, swvH, swvD.y), worldPos.w);${materialOutputs ? "\nO.vPositionW = worldPos.xyz;" : ""}
#endif
`;
}

/**
 * Varyings at CUSTOM_VERTEX_MAIN_END, which runs after the world-position hook: GPU waves pass their own height and
 * offset, so the attribute copy must not overwrite them.
 */
const VERTEX_VARYINGS = `
#ifdef ${WATER_GPU_WAVES_DEFINE}
O.vSlateWater = vec4(swvH, A.slateWaterData.yzw);
O.vSlateWaterFlow = vec4(A.slateWaterFlow.xz, swvD);
#else
O.vSlateWater = A.slateWaterData;
O.vSlateWaterFlow = vec4(A.slateWaterFlow.xz, A.slateWaterOffset);
#endif
O.vSlateWaterBaseNormal = A.slateWaterBaseNormal;
#ifdef ${WATER_BLEND_DEFINE}
O.vSlateWaterBlend = A.slateWaterBlend;
#endif
`;

/**
 * Binds the GLSL-shaped `A.` / `U.` / `O.` prefixes for one language, and `S.` (the view matrix's owner: the scene
 * uniform buffer in a material, plain uniforms in the outline mask) to `scene`'s WGSL prefix.
 */
function bindVertexSource(code: string, wgsl: boolean, scene = "scene."): string {
  return code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bA\./g, wgsl ? "vertexInputs." : "").replace(/\bO\./g, wgsl ? "vertexOutputs." : "")
    .replace(/\bS\./g, wgsl ? scene : "");
}

/**
 * Vertex hooks for one language: the band's sampler (with GPU waves and the band's vertex part), the GPU swell and the
 * varyings.
 */
export function waterVertexSource(language: ShaderLanguage): { definitions: string; worldPosition: string; end: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const definitions = `\n#ifdef ${WATER_GPU_WAVES_DEFINE}${fftHelpers(wgsl, FFT_VERTEX)}#endif\n`;
  return wgsl
    ? { definitions, worldPosition: bindVertexSource(toWgsl(vertexWaveSource(true)), true), end: bindVertexSource(toWgsl(VERTEX_VARYINGS), true) }
    : { definitions, worldPosition: bindVertexSource(vertexWaveSource(true), false), end: bindVertexSource(VERTEX_VARYINGS, false) };
}

/**
 * Uniforms the vertex swell and the band's vertex displacement read (`WaterMaterialPlugin.bindVertexWaves` sets them
 * on another pass's effect, with `WATER_FFT_SAMPLER`).
 */
export const WATER_VERTEX_WAVE_UNIFORMS: readonly string[] = [
  "slateWaterShape", "slateWaterSwellInfo", "slateWaterGridOffset", ...SWELL_DIRECTION, ...SWELL_AMPLITUDE, ...SWELL_GROUP, ...SWELL_WARP, "slateWaterFft", ...FFT_CASCADE_UNIFORMS,
];
/** `vertexWaveDefines` per cascades the vertex samples (0-3): built once. */
const VERTEX_WAVE_DEFINES: ReadonlyArray<readonly string[]> = Array.from({ length: WATER_FFT_CASCADES_MAX + 1 }, (_, cascades) => [
  `#define ${WATER_GPU_WAVES_DEFINE}`, ...(cascades ? [`#define ${FFT_VERTEX} ${cascades}`] : []),
]);

/**
 * The GPU swell for another pass's vertex shader that computes a `worldPos` vec4 from the same world matrix and has a
 * `view` matrix uniform (the shared outline mask): declarations of its attribute, uniforms and the band's sampler,
 * and the displacement to insert after `worldPos`. Both compile only under `SLATE_WATER_GPU_WAVES` (the band under
 * `SLATE_WATER_FFT_VERTEX`), so the pass's other programs are unchanged.
 */
export function waterOutlineVertexSource(language: ShaderLanguage): { declarations: string; displacement: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const uniforms = WATER_VERTEX_WAVE_UNIFORMS.map((name) => (wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`)).join("\n");
  const attribute = wgsl ? "attribute slateWaterData: vec4f;" : "attribute vec4 slateWaterData;";
  const displacement = vertexWaveSource(false);
  return {
    declarations: `\n#ifdef ${WATER_GPU_WAVES_DEFINE}\n${attribute}\n${uniforms}${fftHelpers(wgsl, FFT_VERTEX)}#endif\n`,
    displacement: bindVertexSource(wgsl ? toWgsl(displacement) : displacement, wgsl, "uniforms."),
  };
}

/**
 * The plugin of built-in water whose vertex shader displaces this mesh (GPU waves on, rest grid present), or null:
 * passes that draw the mesh with their own vertex shader add its displacement for exactly these.
 */
export function gpuWaterWaves(material: Material | null | undefined, mesh: AbstractMesh): WaterMaterialPlugin | null {
  const plugin = material?.pluginManager?.getPlugin<WaterMaterialPlugin>("SlateWater");
  return plugin instanceof WaterMaterialPlugin && plugin.gpuWaves && mesh.isVerticesDataPresent("slateWaterData") ? plugin : null;
}

const gridOffsets = new WeakMap<AbstractMesh, Float64Array>();
const gridWorld = new Float64Array(3);

/**
 * Registers `offset` (local X, Z; read live) as the translation of `mesh`'s uploaded rest positions: Global Water
 * recentres by moving this instead of re-uploading its grid. It is per mesh, not per material, and `slateWaterGridOffset`
 * carries it to the vertex shaders of the material and of other passes (`bindVertexWaves`).
 */
export function setWaterGridOffsetSource(mesh: AbstractMesh, offset: Float64Array): void {
  gridOffsets.set(mesh, offset);
}

/**
 * The mesh's registered grid offset as a world-space vector (into a shared scratch): the linear part of its current
 * world matrix applied to (x, 0, z). Taking it at bind time keeps it right under any rotation, scale or tilt, and a
 * floating origin (which only changes the matrix's translation) never reaches it.
 */
export function waterGridOffset(mesh: AbstractMesh | null | undefined): Float64Array {
  const offset = mesh ? gridOffsets.get(mesh) : undefined;
  if (!offset || (offset[0] === 0 && offset[1] === 0)) return gridWorld.fill(0);
  const m = mesh!.getWorldMatrix().m, x = offset[0]!, z = offset[1]!;
  gridWorld[0] = x * m[0]! + z * m[8]!; gridWorld[1] = x * m[1]! + z * m[9]!; gridWorld[2] = x * m[2]! + z * m[10]!;
  return gridWorld;
}

/** Translate the restricted GLSL-shaped source above. Only the constructs it uses are supported. */
export function toWgsl(source: string): string {
  const type = (t: string) => ({ float: "f32", vec2: "vec2f", vec3: "vec3f", vec4: "vec4f", mat4: "mat4x4f" })[t] ?? t;
  return source
    .replace(/^(\s*)(float|vec2|vec3|vec4) (\w+)\(([^)]*)\) \{/gm, (_, indent: string, ret: string, name: string, args: string) =>
      `${indent}fn ${name}(${args.split(",").map((arg) => arg.trim().split(" ")).map(([t, n]) => `${n}: ${type(t!)}`).join(", ")}) -> ${type(ret)} {`)
    .replace(/^(\s*)(float|vec2|vec3|vec4) (\w+) = /gm, (_, indent: string, t: string, name: string) => `${indent}var ${name}: ${type(t)} = `)
    .replace(/\bvec([234])\(/g, "vec$1f(")
    .replace(/\bdFdx\(/g, "dpdx(").replace(/\bdFdy\(/g, "dpdy(");
}

/**
 * CUSTOM_FRAGMENT_BEFORE_FOG. Realistic colour is premultiplied by coverage: undo it for Babylon's non-premultiplied
 * blend, fog and image processing. Bright glints and reflections raise coverage instead of clipping in 8-bit targets.
 *
 * The refracted scene (`swRefracted`, its share `swRefractedWeight`; `SLATE_WATER_REFRACTION`) is light from behind
 * the surface, already fogged by its own materials. With the copy the water covers that share too, so Babylon's fog
 * below would fog the background again and add its fog colour over it: the refracted light is pre-divided by the fog
 * factor, less the fog colour at its share, so the result equals blending (the water's fog on its own light only).
 * In Scene Linear (`IMAGEPROCESSINGPOSTPROCESS`, an HDR target that never clips at 1) it stays
 * out of the coverage, so a refracted background brighter than 1 never raises coverage and dims what the shore fade
 * blends over; 8-bit display targets keep counting it (their background never exceeds 1). Stylized water is opaque
 * where it refracts and only adds it.
 */
function beforeFogSource(wgsl: boolean): string {
  const v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4", f1 = wgsl ? "f32" : "float";
  const declare = (type: string, name: string, value: string) => (wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`);
  const brightest = (c: string) => `max(${c}.r, max(${c}.g, ${c}.b))`;
  return [
    `#ifdef ${REFRACTION}`,
    declare(v3, "swRefractedOut", "swRefracted"),
    "#ifdef FOG",
    declare(f1, "swFogKeep", "max(toLinearSpace(CalcFogFactor()), 0.01)"),
    `swRefractedOut = (swRefracted - ${wgsl ? "uniforms." : ""}vFogColor * ((1.0 - swFogKeep) * swRefractedWeight)) / swFogKeep;`,
    "#endif",
    "#endif",
    `#ifdef ${WATER_STYLIZED_DEFINE}`,
    `#ifdef ${REFRACTION}`,
    `finalColor = ${v4}(finalColor.rgb + swRefractedOut, finalColor.a);`,
    "#endif",
    `#ifndef ${WATER_TOON_DEFINE}`,
    "finalColor.a *= swShoreSoft;",
    "#endif",
    "#else",
    `#if defined(${REFRACTION}) && !defined(IMAGEPROCESSINGPOSTPROCESS)`,
    declare(v3, "swCovered", "finalColor.rgb + swRefracted"),
    declare(f1, "swCover", `clamp(max(finalColor.a, ${brightest("swCovered")}), 0.02, 1.0)`),
    "#else",
    declare(f1, "swCover", `clamp(max(finalColor.a, ${brightest("finalColor")}), 0.02, 1.0)`),
    "#endif",
    `#ifdef ${REFRACTION}`,
    `finalColor = ${v4}(finalColor.rgb + swRefractedOut, finalColor.a);`,
    "#endif",
    `finalColor = ${v4}(finalColor.rgb / swCover, swCover);`,
    "#endif",
    // Open-water edges fade out (`swOpenFade`, every look).
    "finalColor.a *= swOpenFade;",
  ].join("\n");
}

/**
 * Every style and look, selected by `SLATE_WATER_STYLIZED` and, within Stylized, `SLATE_WATER_TOON` so each material
 * compiles only one (each directive on its own line).
 */
function fragmentSource(): string {
  return `\n#ifdef ${WATER_STYLIZED_DEFINE}\n#ifdef ${WATER_TOON_DEFINE}\n${toonSource()}\n#else\n${paintedSource()}\n#endif\n#else\n${realisticSource()}\n#endif\n`;
}

/** One more read of the contact field at an explicit level, legal in any control flow (Realistic's wake taps). */
const CONTACT_TAP_GLSL = "vec4 swContactAt(vec2 uv) { return texture2DLodEXT(slateWaterContactSampler, uv, 0.0); }\n";
const CONTACT_TAP_WGSL = "fn swContactAt(uv: vec2f) -> vec4f { return textureSampleLevel(slateWaterContactSampler, slateWaterContactSamplerSampler, uv, 0.0); }\n";

/**
 * The look sources read the asset's colours through the cut code's blended locals (`COLOR_LOCALS`) and its wave height
 * through the blended swell scale, so a blending surface shades as the mixed body (a plain surface folds both away).
 */
function blendColors(source: string): string {
  let out = source.replace(/\bU\.slateWaterWaves\.x\b/g, "(U.slateWaterWaves.x * swBlendH)");
  COLOR_UNIFORMS.forEach((name, i) => { out = out.replace(new RegExp(`\\bU\\.${name}\\b`, "g"), COLOR_LOCALS[i]!); });
  return out;
}

export function waterShaderSource(language: ShaderLanguage): { helpers: string; cut: string; main: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const bind = (code: string) => code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bIN\./g, wgsl ? "fragmentInputs." : "").replace(/\bS\./g, wgsl ? "scene." : "")
    // The fragment's framebuffer position (on render targets both backends store rows in the same order as uv).
    .replace(/\bSW_FRAG_COORD\b/g, wgsl ? "fragmentInputs.position" : "gl_FragCoord")
    .replace(/\bSW_TO_LINEAR\(/g, wgsl ? "toLinearSpaceVec3(" : "toLinearSpace(");
  const samplerDeclaration = wgsl
    ? "var slateWaterFieldSamplerSampler: sampler;\nvar slateWaterFieldSampler: texture_2d<f32>;\nvar slateWaterContactSamplerSampler: sampler;\nvar slateWaterContactSampler: texture_2d<f32>;\n"
    : "uniform sampler2D slateWaterFieldSampler;\nuniform sampler2D slateWaterContactSampler;\n";
  // Written by the realistic main code and read inside Babylon's reflectivity block (a separate function).
  const roughnessGlobals = wgsl
    ? "var<private> swSlopeVariance: f32 = 0.0;\nvar<private> swMatte: f32 = 0.0;\n"
    : "float swSlopeVariance = 0.0;\nfloat swMatte = 0.0;\n";
  return wgsl
    ? {
      helpers: samplerDeclaration + roughnessGlobals + toWgsl(HELPERS + REMOVAL_HELPER) + CONTACT_TAP_WGSL + objectHelpers(true) + fftHelpers(true),
      cut: bind(toWgsl(cutSource(true))), main: bind(toWgsl(blendColors(fragmentSource()))),
    }
    : {
      helpers: samplerDeclaration + roughnessGlobals + HELPERS + REMOVAL_HELPER + CONTACT_TAP_GLSL + objectHelpers(false) + fftHelpers(false),
      cut: bind(cutSource(false)), main: bind(blendColors(fragmentSource())),
    };
}

/** Object contact distances are encoded up to three contact-foam widths (1-8 m). */
export const contactRange = (water: WaterDefinition) => Math.max(1, Math.min(8, water.contactFoamWidth * 3));

const placeholders = new WeakMap<Scene, RawTexture>();
/** Field for surfaces nothing meets: far from terrain, terrain unknown. Contacts that are off ignore it. */
function placeholderField(scene: Scene): RawTexture {
  let texture = placeholders.get(scene);
  if (!texture) {
    texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 0]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    texture.name = "water-field-placeholder";
    placeholders.set(scene, texture);
    scene.onDisposeObservable.addOnce(() => { texture!.dispose(); placeholders.delete(scene); });
  }
  return texture;
}

const fftPlaceholders = new WeakMap<Scene, BaseTexture>();
/**
 * One zero texel of the FFT band's type for variants that sample the band while it is not ready (their gain is 0 then,
 * so it contributes nothing): a 2D array of one layer, which out-of-range layers clamp to. Allocated as a never-drawn
 * one-layer render target, as the band's own output is (resources start zeroed on WebGL2 and WebGPU).
 */
function placeholderFft(scene: Scene): BaseTexture {
  let texture = fftPlaceholders.get(scene);
  if (!texture) {
    const engine = scene.getEngine();
    const target = engine.createRenderTargetTexture({ width: 1, height: 1, layers: 1 }, {
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE, format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: "Water FFT placeholder",
    });
    // The wrapper holds its own reference, so the texture and the render target release independently.
    target.texture!.incrementReferences();
    const placeholder = texture = new BaseTexture(engine, target.texture);
    placeholder.name = "water-fft-placeholder";
    fftPlaceholders.set(scene, placeholder);
    scene.onDisposeObservable.addOnce(() => { placeholder.dispose(); target.dispose(); fftPlaceholders.delete(scene); });
  }
  return texture;
}

/** One colour channel in linear space, as the asset's colours upload. */
const linearChannel = (c: number) => c ** 2.2;
/** Writes one vec4 into a packed array at `o`; returns the next offset. */
const put4 = (v: Float64Array, o: number, x: number, y: number, z: number, w: number) => {
  v[o] = x; v[o + 1] = y; v[o + 2] = z; v[o + 3] = w;
  return o + 4;
};
/**
 * The per-render vec4s `WaterMaterialPlugin.frameConstants` packs, in its write order; from `FRAME_BLEND_START` on, the
 * partner colours only a blending surface binds.
 */
const FRAME_UNIFORMS: readonly string[] = [
  "slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves",
  "slateWaterSun", "slateWaterSunColor", "slateWaterSky", "slateWaterHorizon", "slateWaterSunShape", "slateWaterAbsorb", "slateWaterThrough",
  "slateWaterOrigin", "slateWaterLight",
  ...SWELL_DIRECTION.flatMap((direction, i) => [direction, SWELL_AMPLITUDE[i]!, SWELL_GROUP[i]!]), ...SWELL_WARP,
  "slateWaterSea", "slateWaterSwellInfo", "slateWaterShape", ...CHOP_UNIFORMS, ...CAPILLARY_UNIFORMS,
  "slateWaterRipple", "slateWaterChopShift", "slateWaterTerms", "slateWaterSwash", "slateWaterHaze",
  ...BLEND_COLOR_UNIFORMS,
];
const FRAME_BLEND_START = FRAME_UNIFORMS.length - BLEND_COLOR_UNIFORMS.length;
/** The numeric definition fields the packed vec4s read besides the colours and the wave set (`frameInputsChanged`). */
const FRAME_DEFINITION_FIELDS = [
  "opacity", "reflectionStrength", "foamAmount", "rippleScale", "rippleStrength", "foamWidth", "colorBands", "depthColorDistance", "sparkles",
  "subsurface", "waveHeight", "waveLength", "waveSpeed", "waveDirection", "surfaceFoam", "roughness", "colorVariation", "choppiness", "waveSpread",
  "crestFoam", "contactFoamWidth",
] as const satisfies readonly (keyof WaterDefinition)[];
/** Render, clock, origin, scale, tier, reflection source and style; the fields; three colours; the partner's six and nine. */
const FRAME_KEY_LENGTH = 10 + FRAME_DEFINITION_FIELDS.length + 9 + 3 + 9;
const REMOVAL_SHAPE_UNIFORMS = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `slateWaterRemovalShape${i}`);
const REMOVAL_UNIFORMS = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `slateWaterRemoval${i}`);

/**
 * One scene's water lighting for a frame, rewritten in place: the scene contribution before each material's environment
 * strength and low-light floor, and the analytic sky Realistic water reflects without an environment or skybox.
 */
type WaterLighting = {
  ambient: Float64Array;
  /** Toward the strongest directional light (x, y, z) and its intensity; a default direction at intensity 0 without one. */
  sun: Float64Array;
  sunColor: Float64Array;
  /**
   * Linear zenith and horizon of the analytic sky. Such a scene shows its background colour as the sky: overhead it is
   * that colour deepened and saturated a little (half the hemispheric sky light's colour where the scene has one), at
   * the horizon the background itself, or the fog colour with fog on. Both are converted to linear space as Babylon's
   * PBR fog converts its fog colour (`BindFogParameters` with `linearSpace`), so the far sea meets its own fog.
   */
  sky: Float64Array;
  horizon: Float64Array;
  /**
   * Uniform-only sun terms Realistic water would otherwise evaluate per fragment (`slateWaterSunShape`): the horizontal
   * direction toward the sun (x, z), how much a low sun warms the analytic horizon, and the share of sunlight that
   * enters the water (most of a low sun's light reflects off at grazing incidence).
   */
  sunShape: Float64Array;
  /** Sunlight through thin crests, before the water's own colour: strongest for a sun some way up, none at sunset. */
  subsurfaceLift: number;
  /** Glitter strength: how clearly the sun stands out against the sky light (slateWaterSky.w). */
  sunGlitter: number;
  /** A sky light the sun does not outshine (overcast, storm; slateWaterHorizon.w): Realistic water's body greys. */
  overcast: number;
  /**
   * What Stylized water binds in place of `horizon` and `sunGlitter`, the values its looks were tuned with: the fog
   * colour or the plain background (no sky light share), and the sun against the ambient light.
   */
  stylizedHorizon: Float64Array;
  stylizedGlitter: number;
  /** `waterHazeConstants` of the active camera's far plane (`slateWaterHaze`). */
  haze: Float64Array;
};

const toLinear = (value: number) => Math.max(0, value) ** 2.2;
const linearScratch = new Color3(), gammaScratch = new Color3();
/**
 * A Shallow Color channel's relative absorption through clear water (see `WaterMaterialPlugin.absorption`): the optical
 * depth that leaves the channel at its share of the brightest, over a small common floor. A cyan Shallow Color thus
 * absorbs red many times faster than blue and green a few times faster, as clear sea water does, so shallows over sand
 * turn turquoise and deeper water blue rather than green.
 */
const absorbCoefficient = (channel: number, top: number) => top > 0 ? 0.2 - Math.log(Math.max(channel / top, 0.02)) : 1;
/**
 * Stylized water's relative absorption (Painted's shallows): channels within 15% of the brightest absorb alike, so a
 * turquoise Shallow Color passes blue as well as green.
 */
const stylizedAbsorbCoefficient = (channel: number, top: number) => top > 0 ? 0.2 + Math.max(0, 1 - channel / top - 0.15) / 0.85 : 1;
/**
 * The gentler absorption the light through thin crests sees (`slateWaterThrough`): Beer-Lambert's −ln of the linear
 * channel plus a constant that keeps the channels' ratios mild (the fastest at most `GLOW_RATIO_CAP` times the
 * slowest), so the crest glow takes Shallow Color's hue without turning neon.
 */
const glowCoefficient = (channel: number) => 0.6 - Math.log(Math.max(channel, 1e-3));
const GLOW_RATIO_CAP = 5;

function sceneWaterLighting(scene: Scene, out: WaterLighting): void {
  let ar = 0, ag = 0, ab = 0, hr = 0, hg = 0, hb = 0, hemispheres = 0;
  let sun: DirectionalLight | null = null;
  for (const light of scene.lights) {
    if (!light.isEnabled() || light.intensity <= 0) continue;
    if (light instanceof HemisphericLight) {
      const i = light.intensity, d = light.diffuse, g = light.groundColor;
      ar += d.r * i * 0.6 + g.r * i * 0.2; ag += d.g * i * 0.6 + g.g * i * 0.2; ab += d.b * i * 0.6 + g.b * i * 0.2;
      hr += d.r * i; hg += d.g * i; hb += d.b * i; hemispheres++;
    } else if (light instanceof DirectionalLight) {
      if (!sun || light.intensity > sun.intensity) sun = light;
    }
  }
  const { sun: toSun, sunColor, ambient, sky, horizon } = out;
  if (sun) {
    const d = sun.direction, length = Math.hypot(d.x, d.y, d.z) || 1, up = Math.max(0, -d.y / length) * sun.intensity * 0.55;
    toSun[0] = -d.x / length; toSun[1] = -d.y / length; toSun[2] = -d.z / length; toSun[3] = sun.intensity;
    sunColor[0] = sun.diffuse.r; sunColor[1] = sun.diffuse.g; sunColor[2] = sun.diffuse.b;
    ar += sun.diffuse.r * up; ag += sun.diffuse.g * up; ab += sun.diffuse.b * up;
  } else {
    toSun[0] = -0.4; toSun[1] = 0.8; toSun[2] = 0.45; toSun[3] = 0;
    sunColor[0] = sunColor[1] = sunColor[2] = 1;
  }
  ambient[0] = ar; ambient[1] = ag; ambient[2] = ab;
  // Linear space as Babylon converts colours (exact sRGB where the engine uses it), so the reflected horizon matches
  // the fog the water itself fades into.
  const exact = scene.getEngine().useExactSrgbConversions, clear = scene.clearColor;
  gammaScratch.set(Math.max(0, clear.r), Math.max(0, clear.g), Math.max(0, clear.b)).toLinearSpaceToRef(linearScratch, exact);
  const cr = linearScratch.r, cg = linearScratch.g, cb = linearScratch.b;
  const luminance = Math.max(0.3 * cr + 0.59 * cg + 0.11 * cb, 1e-4);
  // A hemispheric light is the scene's sky light, a better guide to the sky drawn behind the water (a dome, a grey
  // storm) than the clear colour: the sky takes mostly its colour.
  // A sky light is brighter than the sky it stands for (it also carries bounce and fill): the reflected sky takes about
  // half of it, a little more at the horizon than overhead, so a grey storm's far sea stays as grey as its sky.
  const lit = hemispheres > 0 ? 0.92 : 0, hemi = 0.45, hemiHorizon = 0.55;
  sky[0] = (0.65 * cr + 0.35 * cr * cr / luminance) * 0.85 * (1 - lit) + hr * hemi * lit;
  sky[1] = (0.65 * cg + 0.35 * cg * cg / luminance) * 0.85 * (1 - lit) + hg * hemi * lit;
  sky[2] = (0.65 * cb + 0.35 * cb * cb / luminance) * 0.85 * (1 - lit) + hb * hemi * lit;
  const fog = scene.fogEnabled && scene.fogMode !== Scene.FOGMODE_NONE;
  if (fog) scene.fogColor.toLinearSpaceToRef(linearScratch, exact);
  // Without fog the horizon is the background, shared like the zenith with a hemispheric light's sky colour.
  horizon[0] = fog ? linearScratch.r : cr * (1 - lit) + hr * hemiHorizon * lit;
  horizon[1] = fog ? linearScratch.g : cg * (1 - lit) + hg * hemiHorizon * lit;
  horizon[2] = fog ? linearScratch.b : cb * (1 - lit) + hb * hemiHorizon * lit;
  const plain = out.stylizedHorizon;
  plain[0] = fog ? linearScratch.r : cr; plain[1] = fog ? linearScratch.g : cg; plain[2] = fog ? linearScratch.b : cb;
  const shape = out.sunShape, horizontal = Math.hypot(toSun[0]!, toSun[2]!), up = toSun[1]!;
  shape[0] = horizontal > 1e-4 ? toSun[0]! / horizontal : 0;
  shape[1] = horizontal > 1e-4 ? toSun[2]! / horizontal : 0;
  shape[2] = (1 - smoothstep(0, 0.5, up)) * smoothstep(-0.1, 0.02, up);
  shape[3] = 0.25 + 0.75 * smoothstep(0, 0.5, up);
  // A high sun lights crests from above rather than through them; a setting sun's light is dim and red, which the water
  // absorbs, so the glow is gone by the time the sun nears the horizon.
  out.subsurfaceLift = smoothstep(0.06, 0.2, up) * (1 - 0.6 * smoothstep(0.3, 0.8, up));
  // How clearly the sun stands out against the sky light (the hemispheric light where there is one, which a high sun
  // does not inflate): under an overcast or stormy sky, where the sun is no brighter than the sky, its glitter is gone
  // and Realistic water greys with the sky.
  const skyLight = hemispheres > 0 ? 0.3 * hr + 0.59 * hg + 0.11 * hb : 0.3 * ambient[0]! + 0.59 * ambient[1]! + 0.11 * ambient[2]!;
  out.sunGlitter = smoothstep(1.05, 1.5, toSun[3]! / Math.max(skyLight, 0.05));
  out.overcast = hemispheres > 0 ? 1 - out.sunGlitter : 0;
  const ambientLight = 0.3 * ambient[0]! + 0.59 * ambient[1]! + 0.11 * ambient[2]!;
  out.stylizedGlitter = smoothstep(0.8, 1.6, toSun[3]! / Math.max(ambientLight, 0.05));
  waterHazeConstants(scene.activeCamera?.maxZ ?? 0, out.haze);
}

/** Each material's ambient: the scene's, plus its environment's share and a low-light floor. Writes `waterAmbient`. */
const waterAmbient = new Float64Array(3);
function withWaterEnvironment(light: WaterLighting, environmentStrength: number, reflective: boolean): Float64Array {
  const out = waterAmbient, extra = reflective ? 0.45 * environmentStrength : 0;
  out[0] = light.ambient[0]! + 0.8 * extra; out[1] = light.ambient[1]! + 0.9 * extra; out[2] = light.ambient[2]! + extra;
  if (out[0] + out[1] + out[2] < 0.25) { out[0] = Math.max(out[0], 0.08); out[1] = Math.max(out[1], 0.08); out[2] = Math.max(out[2], 0.08); }
  return out;
}

type WaterRemovalCandidate = ReturnType<typeof sceneWaterRemovals>[number] & {
  position: Vector3;
  radius: number;
  inverse?: Matrix;
  /** `waterRemovalShapeVector` of the volume, filled at its first bind this render. */
  shape?: [number, number, number, number];
};
type WaterBindingData = {
  frame: number;
  render: number;
  lighting: WaterLighting;
  removals: WaterRemovalCandidate[];
};
const waterBindings = new WeakMap<Scene, WaterBindingData>();

const NO_REMOVALS: WaterRemovalCandidate[] = [];

/**
 * Lazy so animations and before-render updates settle before the first water draw. Rewritten in place once per
 * render; a scene without removal volumes allocates nothing.
 */
function sceneWaterBindingData(scene: Scene): WaterBindingData {
  let data = waterBindings.get(scene);
  const frame = scene.getFrameId(), render = scene.getRenderId();
  if (data?.frame === frame && data.render === render) return data;
  if (!data) {
    data = {
      frame, render, removals: NO_REMOVALS,
      lighting: {
        ambient: new Float64Array(3), sun: new Float64Array(4), sunColor: new Float64Array(3), sky: new Float64Array(3), horizon: new Float64Array(3),
        sunShape: new Float64Array(4), subsurfaceLift: 0, sunGlitter: 0, overcast: 0, stylizedHorizon: new Float64Array(3), stylizedGlitter: 0, haze: new Float64Array(4),
      },
    };
    waterBindings.set(scene, data);
    scene.onDisposeObservable.addOnce(() => waterBindings.delete(scene));
  }
  data.frame = frame; data.render = render;
  sceneWaterLighting(scene, data.lighting);
  data.removals = sceneHasWaterRemovals(scene) ? sceneWaterRemovals(scene).map((entry) => {
    entry.mesh.computeWorldMatrix(true);
    return { ...entry, position: entry.mesh.getAbsolutePosition().clone(), radius: waterRemovalWorldRadius(entry.mesh, entry.volume) };
  }) : NO_REMOVALS;
  return data;
}

const TAU = Math.PI * 2;
const wrapPhase = (phase: number) => phase - TAU * Math.floor(phase / TAU);

/**
 * The shore swash clock (`slateWaterSwash`, render only): the steepest swell slot at `SWASH_RATE` of its frequency and
 * wavenumber (ω, k) drives one swash cycle per two waves (one per wave ran up and drained in about a second for default
 * waves, a frantic flicker rather than a swash), `SWASH_SPATIAL` of that spatial phase (−β·k·d·x, as its crests travel)
 * shifts the cycle along a shore, and bores travel shoreward at ω / (κ ± β·k) on every side of an island because κ
 * (`SWASH_TRAVEL`·k, but bores at least `SWASH_BORE_SPACING` Foam Widths apart) exceeds β·k.
 */
const SWASH_RATE = 0.5;
const SWASH_SPATIAL = 0.5;
const SWASH_TRAVEL = 3;
const SWASH_BORE_SPACING = 2.5;
/** Swash cycles are counted mod this (as Toon's crests), so each wave's run-up keeps its own reach as the clock wraps. */
export const SWASH_COUNT_PERIOD = 4096;

/**
 * Writes (θ, cycles, κ, D): θ = ω·t − β·k·(d·origin) (ω and k at `SWASH_RATE` of the slot's) reduced to [0, 2π) in float64, the whole cycles removed from it
 * (mod `SWASH_COUNT_PERIOD`), the bores' shoreward wavenumber κ, and the swash's vertical excursion D (metres of water
 * the backwash uncovers at most; 0 without waves). The shader adds −β·k·(d·rest) for its rest point relative to the
 * floating origin. Allocation-free.
 */
function waterSwashConstants(
  set: WaterWaveSet, lead: number, water: WaterDefinition, scale: number, originX: number, originZ: number, time: number, out: Float64Array,
): void {
  const height = water.waveHeight * Math.abs(scale), k = SWASH_RATE * (set.k[lead] ?? 0), omega = SWASH_RATE * (set.omega[lead] ?? 0);
  if (!(k > 0) || !(height > 0)) { out.fill(0); return; }
  // The lead slot's surge (`waterWaveSurge`) delays or advances its waves, and their swash with them.
  const world = omega * time - SWASH_RATE * (waterWaveSurge(set, time)[lead] ?? 0) - SWASH_SPATIAL * k * ((set.dirX[lead] ?? 1) * originX + (set.dirZ[lead] ?? 0) * originZ);
  const reduced = wrapPhase(world), cycles = Math.round((world - reduced) / TAU);
  out[0] = reduced;
  out[1] = cycles - SWASH_COUNT_PERIOD * Math.floor(cycles / SWASH_COUNT_PERIOD);
  out[2] = Math.max(Math.min(SWASH_TRAVEL * k, TAU / (SWASH_BORE_SPACING * Math.max(water.foamWidth, 0.05))), (SWASH_SPATIAL + 0.25) * k);
  out[3] = Math.min(1.1 * height + 0.18 * Math.min(1, height / 0.1), 2.5);
}
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
/** Chop octaves then capillaries: the CPU side of `CHOP_UNIFORMS` and `CAPILLARY_UNIFORMS`. */
const ALL_OCTAVES = [...DETAIL_OCTAVES, ...CAPILLARY_OCTAVES];
/** Swell slots by descending slope (k·a), cached per wave set: Low and Medium evaluate the first few (`swellTier`). */
const slopeOrders = new WeakMap<WaterWaveSet, Uint8Array>();
function slopeOrder(set: WaterWaveSet): Uint8Array {
  let order = slopeOrders.get(set);
  if (!order) {
    const slope = (i: number) => set.k[i]! * set.amplitude[i]!;
    order = Uint8Array.from(Array.from({ length: set.count }, (_, i) => i).sort((a, b) => slope(b) - slope(a) || a - b));
    slopeOrders.set(set, order);
  }
  return order;
}
/**
 * One frame's swell constants for a wave set (`sharedSwell`): the slots by descending slope with unused slots zero,
 * the warp, the crest count and the slope sums (`sea`: Σk·a, 0, and the variance and Σk·a the tier skips).
 */
type SwellEntry = {
  set: WaterWaveSet | null; scale: number; tier: number; originX: number; originZ: number; time: number;
  swell: Float32Array; kernel: Float64Array; warp: Float64Array; sea: Float64Array;
  count: number; lead: number; crestCount: number; seaState: number;
};
/**
 * Recently computed swell constants, reused round-robin: bodies of one asset (one interned wave set) at one Wave Scale
 * and tier share an entry within a frame instead of evaluating the kernel per body and per draw. Allocation-free once
 * filled.
 */
const swellEntries: SwellEntry[] = Array.from({ length: 16 }, () => ({
  set: null, scale: NaN, tier: NaN, originX: NaN, originZ: NaN, time: NaN,
  swell: new Float32Array(WATER_WAVE_MAX_COMPONENTS * WATER_WAVE_SHADER_STRIDE), kernel: new Float64Array(WATER_WAVE_MAX_COMPONENTS * WATER_WAVE_SHADER_STRIDE),
  warp: new Float64Array(WATER_SWELL_WARP_TERMS * WATER_SWELL_WARP_STRIDE), sea: new Float64Array(4), count: 0, lead: 0, crestCount: 0, seaState: 0,
}));
let swellNext = 0;

/**
 * Swell components and the swell warp relative to the floating origin at `time` (see
 * `WaterMaterialPlugin.swellConstants`), computed once per distinct input and shared.
 */
function sharedSwell(set: WaterWaveSet, scale: number, tier: number, originX: number, originZ: number, time: number): SwellEntry {
  for (let i = 0; i < swellEntries.length; i++) {
    const e = swellEntries[i]!;
    if (e.set === set && e.scale === scale && e.tier === tier && e.originX === originX && e.originZ === originZ && e.time === time) return e;
  }
  const e = swellEntries[swellNext]!;
  swellNext = (swellNext + 1) % swellEntries.length;
  e.set = set; e.scale = scale; e.tier = tier; e.originX = originX; e.originZ = originZ; e.time = time;
  const kernel = e.kernel, out = e.swell, order = slopeOrder(set);
  const count = waterWaveShaderConstants(set, scale, originX, originZ, time, kernel);
  waterSwellWarpShaderConstants(set, originX, originZ, e.warp, time);
  // The dominant slot's whole periods between its world phase and the reduced one (`CREST_COUNT_PERIOD`).
  const lead = order[0]!, wrapped = kernel[lead * WATER_WAVE_SHADER_STRIDE + 5]!;
  const world = set.k[lead]! * (set.dirX[lead]! * originX + set.dirZ[lead]! * originZ) - set.omega[lead]! * time + waterWaveSurge(set, time)[lead]! + set.phase[lead]!;
  const periods = Math.round((world - wrapped) / TAU);
  e.crestCount = periods - CREST_COUNT_PERIOD * Math.floor(periods / CREST_COUNT_PERIOD);
  e.count = count; e.lead = lead;
  out.fill(0);
  const skipFrom = tier === WATER_SHADING_TIERS.low ? LOW_SWELL_COMPONENTS : tier === WATER_SHADING_TIERS.medium ? MEDIUM_SWELL_COMPONENTS : count;
  let steep = 0, slopeSquares = 0, droppedVariance = 0, droppedSteep = 0;
  for (let slot = 0; slot < count; slot++) {
    const from = order[slot]! * WATER_WAVE_SHADER_STRIDE, to = slot * WATER_WAVE_SHADER_STRIDE;
    for (let j = 0; j < WATER_WAVE_SHADER_STRIDE; j++) out[to + j] = kernel[from + j]!;
    const slope = Math.abs(kernel[from + 2]! * kernel[from + 4]!);
    steep += slope; slopeSquares += slope * slope;
    if (slot >= skipFrom) { droppedVariance += slope * slope; droppedSteep += slope; }
  }
  e.seaState = SEA_STATE_RMS * Math.sqrt(slopeSquares);
  e.sea[0] = steep; e.sea[1] = 0; e.sea[2] = droppedVariance; e.sea[3] = droppedSteep;
  return e;
}

/** Stylized water drawn with the Toon look (`SLATE_WATER_TOON`); Realistic ignores Stylized Look. */
const toonLook = (w: WaterDefinition) => w.style === "stylized" && w.stylizedLook === "toon";
/** Sets one define; true when its value changed. */
function setDefine(defines: MaterialDefines, name: string, value: boolean | number): boolean {
  if (defines[name] === value) return false;
  defines[name] = value;
  return true;
}

/** World-space water shading on native PBR; both backends use the same wave spectrum. */
export class WaterMaterialPlugin extends MaterialPluginBase {
  time = 0;
  /** Terrain data for this surface; null until terrain meets the water. */
  field: WaterField | null = null;
  /** Height-aware object contacts for this surface; its texture is null until an object meets the water. */
  contacts: WaterContactField | null = null;
  readonly water: WaterDefinition;
  readonly body: WaterBodyProperties;
  /** The surface this material shades, for choosing nearby removal volumes. */
  mesh: AbstractMesh | null = null;
  private bindingFrame = -1;
  private bindingRender = -1;
  private removalMesh: AbstractMesh | null = null;
  private readonly selectedRemovals: WaterRemovalCandidate[] = [];
  private readonly removalGaps = new Float64Array(WATER_REMOVAL_SLOTS + 1);
  /** The uniform buffer whose removal slots were last written empty (skipped while it stays so). */
  private removalsCleared: UniformBuffer | null = null;
  /** The swell warp's per-term constants (`waterSwellWarpShaderConstants`) relative to the floating origin. */
  private readonly warp = new Float64Array(WATER_SWELL_WARP_TERMS * WATER_SWELL_WARP_STRIDE);
  /**
   * Whole periods (mod `CREST_COUNT_PERIOD`) the reduced phase of the steepest swell slot dropped from its world phase
   * this frame (`swellConstants`): Toon counts crests with it, so a crest keeps its index as the phase wraps.
   */
  private crestCount = 0;
  /** The shore swash clock and its geometry (`waterSwashConstants`), in `slateWaterSwash`. */
  private readonly swash = new Float64Array(4);
  /** Contact ring bursts: the steepest slot's ω over the ripples' group speed (rad/m), in `slateWaterContactInfo.w`. */
  private ringDelay = 0;
  /** slateWaterSea: Σk·a, the crest-fold denominator, and the slope variance and Σk·a of the swell the compiled tier skips. */
  private readonly sea = new Float64Array(4);
  /** The sea state the look thresholds read (`SEA_STATE_RMS` · √Σ(k·a)²), in `slateWaterSwellInfo.w`. */
  private seaState = 0;
  private readonly octaves = new Float64Array(ALL_OCTAVES.length * 4);
  private _gpuWaves = false;
  /** Device-clamped quality the features below follow; compared by identity (it changes with the revision). */
  private clamp: WaterQualityDeviceClamp | null = null;
  private tier = DEFAULT_TIER;
  /** Rest height is level across the body (no river, no tilted volume): a planar reflection can mirror it. */
  private _flat = true;
  /** The surface blends with neighbours (`SLATE_WATER_BLEND`); the water mesh owns it with the per-vertex blend data. */
  private _blend = false;
  /**
   * The neighbour whose colours a blending surface mixes toward (by each vertex's partner-colour share); null keeps the
   * asset's own. Set by the water mesh with `blend`.
   */
  partner: WaterDefinition | null = null;
  /** Device-effective features this asset asks for; the copy features also need a copy for the pass drawn. */
  private refracts = false;
  private marches = false;
  private mirrors = false;
  private marchSteps = 0;
  /** The scene copy and planar reflection of the current draw (`hardBindForSubMesh`), bound by `bindForSubMesh`. */
  private boundCopy: WaterSceneCopy | null = null;
  private boundPlanar: WaterPlanarReflection | null = null;
  /** `assetDefineMask()` as last compiled: the defines `prepareDefines` derives from the asset itself. */
  private assetDefines = 0;
  /** FFT cascades this asset samples at the device-effective quality (`SLATE_WATER_FFT`); 0 without the band. */
  private fftCascades = 0;
  /** Of those, the cascades the vertex stage samples (`SLATE_WATER_FFT_VERTEX`): all or none, by `meshSpacing`. */
  private fftVertex = 0;
  /** Finest world spacing of the surface's rest grid, kept by the water mesh; +∞ until it builds one. */
  private _meshSpacing = Infinity;
  /** The band bound for the current draw: ready and matching the compiled cascades, or null (placeholder, gain 0). */
  private boundFft: WaterFftResult | null = null;
  /** Patch sizes of the layout `fftEdges` was derived from: the band's per-cascade constants change only with them. */
  private fftPatches: readonly number[] | null = null;
  /** Per cascade: the upper band edge k_hi (rad/m). */
  private readonly fftEdges = new Float64Array(WATER_FFT_CASCADES_MAX);
  /** `slateWaterFft` and the cascades' vec4s, as last computed. */
  private readonly fftValues = new Float32Array((1 + WATER_FFT_CASCADES_MAX) * 4);
  /** `frameConstants`' packed vec4s and the inputs they were computed from (`frameInputsChanged`). */
  private readonly frameValues = new Float64Array(FRAME_UNIFORMS.length * 4);
  private readonly frameKey = new Float64Array(FRAME_KEY_LENGTH).fill(NaN);
  private readonly frameScratch = new Float64Array(FRAME_KEY_LENGTH);
  private frameSet: WaterWaveSet | null = null;
  private framePartner: WaterDefinition | null = null;
  constructor(material: PBRMaterial, water: WaterDefinition, body: WaterBodyProperties) {
    super(material, "SlateWater", 180, {
      SLATE_WATER: true, [WATER_STYLIZED_DEFINE]: false, [WATER_TOON_DEFINE]: false, [WATER_GPU_WAVES_DEFINE]: false, [Q]: DEFAULT_TIER,
      ...Object.fromEntries(FEATURES.map(([, define]) => [define, false])),
      [REFRACTION]: false, [SSR]: false, [SSR_STEPS]: 0, [PLANAR]: false, [FFT]: 0, [FFT_VERTEX]: 0, [WATER_BLEND_DEFINE]: false,
    }, true, false);
    this.water = water;
    this.body = body;
    this.assetDefines = this.assetDefineMask();
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
    this.syncQuality(material.getScene());
  }
  override isCompatible(): boolean { return true; }
  override getClassName(): string { return "WaterMaterialPlugin"; }
  /** The shading tier compiled into this material (`SLATE_WATER_QUALITY`): 0 Low to 3 Ultra. */
  get shadingTier(): number { return this.tier; }
  /**
   * Follows the scene's device-clamped project Water quality. Unchanged quality costs one cached-clamp compare; a new
   * Shading Detail, or a change in the refraction and reflection features this asset runs, marks the defines dirty
   * (and resets a frozen Play material's cached readiness). Realistic Low draws unlit; this also restores that flag
   * after the editor's Unlit viewport mode, which owns it while active. Called every frame by the water update and
   * before each readiness check, ahead of define preparation.
   */
  syncQuality(scene: Scene = this._material.getScene()): void {
    const clamp = sceneWaterQualityDeviceClamp(scene);
    if (clamp !== this.clamp) {
      this.clamp = clamp;
      const tier = WATER_SHADING_TIERS[clamp.quality.shadingDetail];
      if (tier !== this.tier) {
        this.tier = tier;
        this.markDefinesDirty();
      }
      this.syncObjectFeatures();
    }
    const material = this._material as PBRMaterial;
    if (this.water.style === "stylized" || material.unlit) return;
    const unlit = this.tier === WATER_SHADING_TIERS.low;
    if (material.disableLighting === unlit) return;
    material.disableLighting = unlit;
    if (material.isFrozen) material.markDirty(true);
    // Lit again: the scene's light-slot capacity reaches this material at its next lighting sync.
    invalidateSceneLighting(scene);
  }
  /** Defines changed outside define preparation; a frozen Play material re-prepares only when marked dirty. */
  private markDefinesDirty(): void {
    this.markAllDefinesAsDirty();
    if (this._material.isFrozen) this._material.markDirty(true);
  }
  /**
   * Refraction, the screen-space march, the planar reflection and the FFT detail band this asset runs at the
   * device-effective quality: Refraction above 0 with Water Refraction on; Object Reflections under Screen Space
   * reflections or Planar's Screen Space fallback; Object Reflections at Planar on a flat body; FFT Cascades while FFT
   * Ocean Detail is on and Detail Waves is above 0, in the vertex stage too where the rest grid resolves the band's
   * first cascade. Recompiles only when one of them changes.
   */
  private syncObjectFeatures(): void {
    const clamp = this.clamp;
    if (!clamp) return;
    const q = clamp.quality, w = this.water;
    const refracts = q.refraction && w.refraction > 0;
    const marches = w.objectReflections && (q.reflections === "screenSpace" || (q.reflections === "planar" && clamp.screenSpaceFallback));
    const mirrors = w.objectReflections && q.reflections === "planar" && this._flat;
    const steps = marches ? Math.round(q.reflectionSteps) : 0;
    const fft = q.fft && w.detailWaves > 0 ? q.fftCascades : 0;
    // The vertex mesh filter passes a cascade only below half its shortest wavelength (π / k_hi); the first cascade's
    // is the longest. Evaluated only on a quality or grid change (the layout allocates).
    const vertex = fft > 0 && this._meshSpacing < Math.PI / waterFftLayout(waterWaveSet(w), q.fftSize, fft).bandEdges[1]! ? fft : 0;
    if (refracts === this.refracts && marches === this.marches && mirrors === this.mirrors && steps === this.marchSteps &&
      fft === this.fftCascades && vertex === this.fftVertex) return;
    this.refracts = refracts; this.marches = marches; this.mirrors = mirrors; this.marchSteps = steps; this.fftCascades = fft;
    this.fftVertex = vertex;
    this.markDefinesDirty();
  }
  /**
   * The asset was edited in place (`updateWaterMeshDefinition`; Style never changes there). Re-evaluates the features
   * it runs (Refraction, Object Reflections, Detail Waves) and, only when Stylized Look or a feature term crossing zero
   * changes the asset's own defines, marks them dirty once. Uniform-only fields (Wave Model, Steepness, Peak Sharpness,
   * Wave Seed, Color Variation, colours, amounts) cost nothing here: every bind reads the definition.
   */
  definitionChanged(): void {
    this.syncObjectFeatures();
    const mask = this.assetDefineMask();
    if (mask === this.assetDefines) return;
    this.assetDefines = mask;
    this.markDefinesDirty();
  }
  /**
   * The asset's own define inputs as a bit mask: each `WATER_FEATURE_DEFINES` term above zero, then the Toon look.
   */
  private assetDefineMask(): number {
    const w = this.water;
    let mask = 0;
    for (let i = 0; i < FEATURES.length; i++) if (w[FEATURES[i]![0]] > 0) mask |= 1 << i;
    if (toonLook(w)) mask |= 1 << FEATURES.length;
    return mask;
  }
  /** FFT cascades compiled into this material (`SLATE_WATER_FFT`), 0 when it never samples the band. */
  get fftDetailCascades(): number { return this.fftCascades; }
  /** FFT cascades its vertex stage samples (`SLATE_WATER_FFT_VERTEX`), 0 when the band never displaces the mesh. */
  get fftVertexCascades(): number { return this.fftVertex; }
  /**
   * The finest world spacing of the surface's rest grid: the water mesh sets it whenever it builds a grid (a quality,
   * shape, rotation or scale change), and the vertex stage samples the band only where it can resolve some of it.
   */
  get meshSpacing(): number { return this._meshSpacing; }
  set meshSpacing(value: number) {
    if (this._meshSpacing === value) return;
    this._meshSpacing = value;
    this.syncObjectFeatures();
  }
  /**
   * Whether the body's rest height is level (no river, no volume tilted out of level), as its planar reflection
   * requires; the water mesh keeps it current when the volume's rotation changes.
   */
  get flat(): boolean { return this._flat; }
  set flat(value: boolean) {
    if (this._flat === value) return;
    this._flat = value;
    this.syncObjectFeatures();
  }
  /** Whether the surface blends with neighbours (`SLATE_WATER_BLEND`): the water mesh sets it with the vertex data. */
  get blend(): boolean { return this._blend; }
  set blend(value: boolean) {
    if (this._blend === value) return;
    this._blend = value;
    this.markDefinesDirty();
  }
  /**
   * Wave Scale the swell constants carry: the body's, or 1 for a calm body that blends, so it can take a neighbour's
   * waves through its per-vertex scales (`PreparedWaterBlendBody.referenceScale`).
   */
  get waveScale(): number { return this._blend && Math.abs(this.body.waveScale) <= 1e-6 ? 1 : this.body.waveScale; }
  override isReadyForSubMesh(_defines: MaterialDefines, scene: Scene): boolean {
    this.syncQuality(scene);
    return true;
  }
  /**
   * Defines are prepared per render pass (each pass has its own draw wrapper): the copy features compile only into a
   * pass with a registered scene copy, which is registered before that pass's first readiness probe and never
   * changes for the pass, so no later dirtying is needed. The depth pre-pass draws under its own pass id
   * (`TransparentDepthPrePass`) and compiles neither: its variant returns before them, with the same vertex stage.
   */
  override prepareDefines(defines: MaterialDefines, scene: Scene): void {
    const w = this.water;
    let changed = setDefine(defines, WATER_STYLIZED_DEFINE, w.style === "stylized");
    changed = setDefine(defines, WATER_TOON_DEFINE, toonLook(w)) || changed;
    changed = setDefine(defines, WATER_GPU_WAVES_DEFINE, this._gpuWaves) || changed;
    changed = setDefine(defines, Q, this.tier) || changed;
    for (let i = 0; i < FEATURES.length; i++) {
      const [field, define] = FEATURES[i]!;
      changed = setDefine(defines, define, w[field] > 0) || changed;
    }
    const copy = (this.refracts || this.marches) && isMainWaterPass(scene, scene.getEngine().currentRenderPassId);
    changed = setDefine(defines, REFRACTION, this.refracts && copy) || changed;
    changed = setDefine(defines, SSR, this.marches && copy) || changed;
    changed = setDefine(defines, SSR_STEPS, this.marches && copy ? this.marchSteps : 0) || changed;
    changed = setDefine(defines, PLANAR, this.mirrors) || changed;
    changed = setDefine(defines, FFT, this.fftCascades) || changed;
    changed = setDefine(defines, FFT_VERTEX, this.fftVertex) || changed;
    changed = setDefine(defines, WATER_BLEND_DEFINE, this._blend) || changed;
    if (changed) defines.markAsUnprocessed();
  }
  /**
   * True when the vertex shader evaluates the swell (`SLATE_WATER_GPU_WAVES`) and the mesh keeps a static rest grid.
   * The water mesh owns this: its vertex data layout must change with it (see `setWaterGpuWaves`).
   */
  get gpuWaves(): boolean { return this._gpuWaves; }
  set gpuWaves(value: boolean) {
    if (this._gpuWaves === value) return;
    this._gpuWaves = value;
    this.markDefinesDirty();
  }
  override getAttributes(attributes: string[]): void {
    attributes.push("slateWaterData", "slateWaterFlow", "slateWaterBaseNormal", "slateWaterOffset");
    if (this._blend) attributes.push("slateWaterBlend");
  }
  override getUniforms() {
    const vectors = [
      "slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves", "slateWaterSun", "slateWaterSunColor",
      "slateWaterLight", "slateWaterShape", "slateWaterFieldBounds", "slateWaterFieldInfo", "slateWaterFieldStep", "slateWaterContactBounds", "slateWaterContactInfo",
      "slateWaterOrigin", "slateWaterGridOffset", "slateWaterSwellInfo", "slateWaterSea", "slateWaterRipple", "slateWaterTerms", "slateWaterChopShift", "slateWaterSwash", "slateWaterHaze",
      // Realistic: the analytic sky's zenith and horizon (scene background and fog colours), the per-channel
      // absorption from Shallow Color (w: Low's single coefficient), the uniform-only sun terms and the light through
      // thin crests (Subsurface).
      "slateWaterSky", "slateWaterHorizon", "slateWaterAbsorb", "slateWaterSunShape", "slateWaterThrough",
      // (1 / output width, 1 / output height, Refraction, march distance) and (planar on, display-encoded,
      // distortion, 0): per draw, from the pass's scene copy and the view's planar reflection.
      "slateWaterScreen", "slateWaterPlanar",
      // A blending surface's partner colours (\`BLEND_COLOR_UNIFORMS\`).
      ...BLEND_COLOR_UNIFORMS,
      ...SWELL_DIRECTION, ...SWELL_AMPLITUDE, ...SWELL_GROUP, ...SWELL_WARP, ...CHOP_UNIFORMS, ...CAPILLARY_UNIFORMS, ...FFT_UNIFORMS,
    ];
    const removals = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => i);
    return { ubo: [
      ...[...vectors, ...removals.map((i) => `slateWaterRemovalShape${i}`)].map((name) => ({ name, size: 4, type: "vec4" })),
      ...removals.map((i) => ({ name: `slateWaterRemoval${i}`, size: 16, type: "mat4" })),
      { name: "slateWaterPlanarMatrix", size: 16, type: "mat4" },
    ] };
  }
  // Unused names are dropped by Babylon: the copy, planar and FFT samplers bind only in variants that declare them.
  override getSamplers(samplers: string[]): void {
    samplers.push("slateWaterFieldSampler", "slateWaterContactSampler", WATER_SCENE_SAMPLER, WATER_PLANAR_SAMPLER, WATER_FFT_SAMPLER);
  }
  override bindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    buffer.setTexture("slateWaterFieldSampler", this.field?.texture ?? placeholderField(scene));
    buffer.setTexture("slateWaterContactSampler", this.contacts?.texture ?? placeholderField(scene));
    // The variant drawn in this pass declares the copy, planar and FFT samplers only with their features; a placeholder
    // (Babylon's empty texture, or an empty array for the band, sampled at gain 0) keeps a declared binding valid in a
    // frame without its source.
    const defines = subMesh?.materialDefines as MaterialDefines | null | undefined;
    if (defines?.[REFRACTION] || defines?.[SSR]) buffer.setTexture(WATER_SCENE_SAMPLER, this.boundCopy?.texture ?? EMPTY_TEXTURE);
    if (defines?.[PLANAR]) buffer.setTexture(WATER_PLANAR_SAMPLER, this.boundPlanar?.texture ?? EMPTY_TEXTURE);
    if (defines?.[FFT]) buffer.setTexture(WATER_FFT_SAMPLER, this.boundFft?.texture ?? placeholderFft(scene));
  }
  /**
   * Per draw: the pass's scene copy (its output size can change in place, so `invSize` is read every draw) and the
   * view's planar reflection, looked up only when the variant drawn samples them. The planar lookup also requests
   * the reflection for the view's next renders, so only water that draws it keeps it alive. Allocation-free.
   */
  private bindObjectFeatures(buffer: UniformBuffer, scene: Scene, subMesh: SubMesh | undefined): void {
    const defines = subMesh?.materialDefines as MaterialDefines | null | undefined;
    this.boundCopy = this.boundPlanar = null;
    const camera = scene.activeCamera;
    if (defines?.[REFRACTION] || defines?.[SSR]) {
      const copy = waterSceneCopyForPass(scene, scene.getEngine().currentRenderPassId);
      this.boundCopy = copy;
      const distance = Math.min(camera && camera.maxZ > 0 ? camera.maxZ : SSR_MAX_DISTANCE, SSR_MAX_DISTANCE);
      buffer.updateFloat4("slateWaterScreen", copy ? copy.invSize[0] : 0, copy ? copy.invSize[1] : 0, this.water.refraction, distance);
    }
    // The planar uniform also selects the march for bodies that are not the view's dominant one.
    if (defines?.[PLANAR] || defines?.[SSR]) {
      const planar = defines?.[PLANAR] ? waterPlanarReflectionForCamera(scene, camera) : null;
      const mine = planar && planar.mesh === this.mesh ? planar : null;
      this.boundPlanar = mine;
      buffer.updateFloat4("slateWaterPlanar", mine ? 1 : 0, mine?.gammaSpace ? 1 : 0, PLANAR_REACH, 0);
      if (mine) buffer.updateMatrix("slateWaterPlanarMatrix", mine.viewProjection);
    }
  }
  /**
   * Per draw of a variant that samples the FFT detail band: asks for it (`waterFftForSurface`, the band's demand), and
   * uploads its uniforms. Until the band is ready (or when it does not match the compiled cascades) the gain is 0 and
   * every cascade is faded (`FFT_FADED`), so no tap runs and the placeholder bound instead contributes nothing.
   * Allocation-free.
   */
  private bindFft(buffer: UniformBuffer, scene: Scene, subMesh: SubMesh | undefined): void {
    const cascades = (subMesh?.materialDefines as MaterialDefines | null | undefined)?.[FFT] as number | undefined;
    if (!cascades) { this.boundFft = null; return; }
    this.boundFft = this.fftState(scene, cascades);
    const v = this.fftValues;
    for (let i = 0; i < 1 + WATER_FFT_CASCADES_MAX; i++) {
      buffer.updateFloat4(i === 0 ? "slateWaterFft" : FFT_CASCADE_UNIFORMS[i - 1]!, v[i * 4]!, v[i * 4 + 1]!, v[i * 4 + 2]!, v[i * 4 + 3]!);
    }
  }
  /**
   * The FFT detail band for `cascades` and its uniforms (`fftValues`): (g, Steepness, view footprint per metre of
   * depth, constant footprint) and per cascade (1 / patch size, uv offset, upper band edge k_hi). The uv offset is
   * fract(origin / patch size) + 0.5 / N in float64, so the floating origin never reaches the shader as a large
   * coordinate. The footprint is metres per pixel of the pass's projection and target height. Returns the band only
   * when it is ready and matches `cascades`; otherwise g is 0 and every k_hi is `FFT_FADED`.
   */
  private fftState(scene: Scene, cascades: number): WaterFftResult | null {
    const result = waterFftForSurface(scene, this.water);
    const band = result?.ready && result.cascades === cascades ? result : null;
    const v = this.fftValues;
    v.fill(0);
    const projection = scene.getProjectionMatrix().m, height = scene.getEngine().getRenderHeight();
    const perPixel = 2 / Math.max(Math.abs(projection[5]!) * Math.max(1, height), 1e-6), orthographic = Math.abs(projection[11]!) < 0.5;
    v[2] = orthographic ? 0 : perPixel; v[3] = orthographic ? perPixel : 0;
    if (!band) {
      for (let c = 0; c < WATER_FFT_CASCADES_MAX; c++) v[(1 + c) * 4 + 3] = FFT_FADED;
      return null;
    }
    const size = sceneWaterQualityDeviceClamp(scene).quality.fftSize, patches = band.patchSizes, edges = this.fftEdges;
    if (patches !== this.fftPatches) {
      // Once per change of the band's layout: its edges (allocates).
      const layout = waterFftLayout(waterWaveSet(this.water), size, cascades).bandEdges;
      for (let c = 0; c < cascades; c++) edges[c] = layout[c + 1]!;
      this.fftPatches = patches;
    }
    const g = band.amplitudeGain * this.waveScale;
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    v[0] = g; v[1] = this.water.steepness;
    for (let c = 0; c < WATER_FFT_CASCADES_MAX; c++) {
      const o = (1 + c) * 4;
      if (c >= cascades) { v[o + 3] = FFT_FADED; continue; }
      // The origin in the cascade's turned frame (\`WATER_FFT_CASCADE_TURNS\`), reduced in float64.
      const patch = patches[c]!, texel = 0.5 / size, turn = WATER_FFT_CASCADE_TURNS[c]!, cos = Math.cos(turn), sin = Math.sin(turn);
      const px = (cos * origin.x + sin * origin.z) / patch, pz = (cos * origin.z - sin * origin.x) / patch;
      v[o] = 1 / patch;
      v[o + 1] = px - Math.floor(px) + texel;
      v[o + 2] = pz - Math.floor(pz) + texel;
      v[o + 3] = edges[c]!;
    }
    return band;
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    this.bindObjectFeatures(buffer, scene, subMesh);
    this.bindFft(buffer, scene, subMesh);
    // Per mesh, every draw: surfaces that share this material recentre independently, so it is not a frame constant.
    const grid = waterGridOffset(subMesh?.getRenderingMesh() ?? this.mesh);
    buffer.updateFloat4("slateWaterGridOffset", grid[0]!, grid[1]!, grid[2]!, 0);
    const data = sceneWaterBindingData(scene);
    // Packed without allocation (the swell kernel shared between bodies and draws), then uploaded.
    const values = this.frameConstants(scene, data), count = this._blend ? FRAME_UNIFORMS.length : FRAME_BLEND_START;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      buffer.updateFloat4(FRAME_UNIFORMS[i]!, values[o]!, values[o + 1]!, values[o + 2]!, values[o + 3]!);
    }
    const w = this.water;
    const field = this.field?.texture ? this.field : null;
    if (field) {
      const bounds = field.bounds, depth = field.depthRange, texel = field.texelSize;
      buffer.updateFloat4("slateWaterFieldBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
      buffer.updateFloat4("slateWaterFieldInfo", 1, field.fineDepthMin, depth[0], depth[1]);
      buffer.updateFloat4("slateWaterFieldStep", texel[0], texel[1], field.fineDepthSpan, 0);
    } else {
      buffer.updateFloat4("slateWaterFieldBounds", 0, 0, 1, 1);
      buffer.updateFloat4("slateWaterFieldInfo", 0, 0, WATER_FIELD_DEPTH_RANGE[0], WATER_FIELD_DEPTH_RANGE[1]);
      buffer.updateFloat4("slateWaterFieldStep", 1, 1, WATER_FIELD_FINE_DEPTH_SPAN, 0);
    }
    const contacts = this.contacts?.texture ? this.contacts : null;
    if (contacts) {
      const bounds = contacts.bounds;
      buffer.updateFloat4("slateWaterContactBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
      buffer.updateFloat4("slateWaterContactInfo", 1, contacts.range, contacts.amplitude, this.ringDelay);
    } else {
      buffer.updateFloat4("slateWaterContactBounds", 0, 0, 1, 1);
      buffer.updateFloat4("slateWaterContactInfo", 0, contactRange(w), 1, this.ringDelay);
    }
    // The nearest enabled removal volumes that can reach this surface.
    const mesh = this.mesh;
    if (this.bindingFrame !== data.frame || this.bindingRender !== data.render || this.removalMesh !== mesh) {
      const selected = this.selectedRemovals, gaps = this.removalGaps;
      selected.length = 0;
      if (data.removals.length > 0) {
        // The nearest few that reach the surface, by insertion into the slots (no per-render arrays).
        const center = mesh?.getBoundingInfo().boundingSphere;
        for (const entry of data.removals) {
          const gap = center ? Vector3.Distance(center.centerWorld, entry.position) - entry.radius - center.radiusWorld : 0;
          if (gap > 0) continue;
          let at = selected.length;
          while (at > 0 && gaps[at - 1]! > gap) at--;
          if (at >= WATER_REMOVAL_SLOTS) continue;
          for (let j = Math.min(selected.length, WATER_REMOVAL_SLOTS - 1); j > at; j--) { selected[j] = selected[j - 1]!; gaps[j] = gaps[j - 1]!; }
          selected[at] = entry; gaps[at] = gap;
          if (selected.length > WATER_REMOVAL_SLOTS) selected.length = WATER_REMOVAL_SLOTS;
        }
      }
      this.bindingFrame = data.frame;
      this.bindingRender = data.render;
      this.removalMesh = mesh;
    }
    // Without removals the cleared slots stay cleared in this material's buffer: nothing to rewrite per draw.
    if (this.selectedRemovals.length > 0 || this.removalsCleared !== buffer) {
      for (let i = 0; i < WATER_REMOVAL_SLOTS; i++) {
        const entry = this.selectedRemovals[i];
        if (!entry) { buffer.updateFloat4(REMOVAL_SHAPE_UNIFORMS[i]!, 0, 0, 0, 0); buffer.updateMatrix(REMOVAL_UNIFORMS[i]!, Matrix.IdentityReadOnly); continue; }
        const shape = entry.shape ??= waterRemovalShapeVector(entry.volume);
        buffer.updateFloat4(REMOVAL_SHAPE_UNIFORMS[i]!, shape[0], shape[1], shape[2], shape[3]);
        entry.inverse ??= entry.mesh.getWorldMatrix().clone().invert();
        buffer.updateMatrix(REMOVAL_UNIFORMS[i]!, entry.inverse);
      }
      this.removalsCleared = this.selectedRemovals.length > 0 ? null : buffer;
    }
  }
  /**
   * The bound vec4s in `FRAME_UNIFORMS` order (colours, lighting, swell, chop and clocks), read from the definition at
   * every bind; the swell kernel is shared between bodies and draws (`sharedSwell`). Allocation-free.
   */
  /**
   * Writes every input of `frameConstants` into `frameKey` (the render, which owns the scene lighting, the clock, the
   * origin, Wave Scale, tier, reflection source and each definition field it reads) and reports whether any changed
   * since the last call, or the wave set or partner did. Allocation-free.
   */
  private frameInputsChanged(data: WaterBindingData, origin: Vector3, scale: number, reflective: boolean, set: WaterWaveSet, partner: WaterDefinition | null): boolean {
    const s = this.frameScratch, w = this.water;
    let n = 0;
    s[n++] = data.frame; s[n++] = data.render; s[n++] = this.time; s[n++] = origin.x; s[n++] = origin.y; s[n++] = origin.z;
    s[n++] = scale; s[n++] = this.tier; s[n++] = reflective ? 1 : 0; s[n++] = w.style === "stylized" ? 1 : 0;
    for (let i = 0; i < FRAME_DEFINITION_FIELDS.length; i++) s[n++] = w[FRAME_DEFINITION_FIELDS[i]!];
    for (let c = 0; c < 3; c++) { s[n++] = w.shallowColor[c]!; s[n++] = w.deepColor[c]!; s[n++] = w.foamColor[c]!; }
    if (partner) {
      s[n++] = partner.opacity; s[n++] = partner.reflectionStrength; s[n++] = partner.foamAmount;
      for (let c = 0; c < 3; c++) { s[n++] = partner.shallowColor[c]!; s[n++] = partner.deepColor[c]!; s[n++] = partner.foamColor[c]!; }
    }
    const key = this.frameKey;
    let changed = this.frameSet !== set || this.framePartner !== partner;
    for (let i = 0; i < n; i++) if (!Object.is(key[i], s[i])) { key[i] = s[i]!; changed = true; }
    this.frameSet = set; this.framePartner = partner;
    return changed;
  }
  private frameConstants(scene: Scene, data: WaterBindingData): Float64Array {
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    const w = this.water, scale = this.waveScale, partner = this._blend ? this.partner ?? w : null;
    const material = this._material as PBRMaterial, reflective = material.reflectionTexture !== null || scene.environmentTexture !== null;
    // The depth pre-pass and colour draws (and further views) of one render bind the same values: compare every input
    // (a few dozen numbers) instead of recomputing them, so in-place asset edits still apply at the next draw.
    const set = waterWaveSet(w);
    if (!this.frameInputsChanged(data, origin, scale, reflective, set, partner)) return this.frameValues;
    const v = this.frameValues;
    let o = 0;
    const lighting = data.lighting, ambient = withWaterEnvironment(lighting, w.reflectionStrength, reflective);
    o = put4(v, o, linearChannel(w.shallowColor[0]), linearChannel(w.shallowColor[1]), linearChannel(w.shallowColor[2]), w.opacity);
    o = put4(v, o, linearChannel(w.deepColor[0]), linearChannel(w.deepColor[1]), linearChannel(w.deepColor[2]), w.reflectionStrength);
    o = put4(v, o, linearChannel(w.foamColor[0]), linearChannel(w.foamColor[1]), linearChannel(w.foamColor[2]), w.foamAmount);
    o = put4(v, o, this.time, w.rippleScale, w.rippleStrength, w.foamWidth);
    o = put4(v, o, w.colorBands, w.depthColorDistance, w.sparkles, w.subsurface);
    o = put4(v, o, w.waveHeight * scale, w.waveLength, w.waveSpeed, w.waveDirection * Math.PI / 180);
    const stylized = w.style === "stylized";
    const sun = lighting.sun, sunColor = lighting.sunColor, sky = lighting.sky, horizon = stylized ? lighting.stylizedHorizon : lighting.horizon;
    o = put4(v, o, sun[0]!, sun[1]!, sun[2]!, sun[3]!);
    o = put4(v, o, sunColor[0]!, sunColor[1]!, sunColor[2]!, w.surfaceFoam);
    o = put4(v, o, sky[0]!, sky[1]!, sky[2]!, stylized ? lighting.stylizedGlitter : lighting.sunGlitter);
    o = put4(v, o, horizon[0]!, horizon[1]!, horizon[2]!, lighting.overcast);
    const shape = lighting.sunShape;
    o = put4(v, o, shape[0]!, shape[1]!, shape[2]!, shape[3]!);
    this.absorption(v, o, lighting, w); o += 8;
    // With floating origin, shaders see positions relative to this offset (the eye); patterns must stay world-anchored.
    o = put4(v, o, origin.x, origin.y, origin.z, w.roughness);
    const swell = this.swellConstants(scene);
    o = put4(v, o, ambient[0]!, ambient[1]!, ambient[2]!, this.crestCount);
    for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
      const s = i * WATER_WAVE_SHADER_STRIDE;
      o = put4(v, o, swell[s]!, swell[s + 1]!, swell[s + 2]!, swell[s + 3]!);
      o = put4(v, o, swell[s + 4]!, swell[s + 5]!, swell[s + 6]!, swell[s + 7]!);
      o = put4(v, o, swell[s + 8]!, swell[s + 9]!, swell[s + 10]!, swell[s + 11]!);
    }
    const warp = this.warp;
    for (let t = 0; t < WATER_SWELL_WARP_TERMS; t++) {
      const s = t * WATER_SWELL_WARP_STRIDE;
      o = put4(v, o, warp[s]!, warp[s + 1]!, warp[s + 2]!, warp[s + 3]!);
    }
    const sea = this.sea;
    o = put4(v, o, sea[0]!, sea[1]!, sea[2]!, sea[3]!);
    o = put4(v, o, this.bankFade(), waterWaveQ(waterWaveSet(w), scale) > 0 ? 1 : 0, w.colorVariation, this.seaState);
    o = put4(v, o, w.choppiness, w.waveSpread, w.crestFoam, w.contactFoamWidth);
    // Uniform-only terms the shader would otherwise evaluate per fragment: chop and capillary directions, wavenumbers
    // and clock phases; the contact ripples' wavenumber and phase with the wind heading; and per-asset factors.
    const octaves = this.octaveConstants();
    for (let i = 0; i < ALL_OCTAVES.length; i++) o = put4(v, o, octaves[i * 4]!, octaves[i * 4 + 1]!, octaves[i * 4 + 2]!, octaves[i * 4 + 3]!);
    const heading = w.waveDirection * Math.PI / 180, rippleK = TAU / (0.35 + Math.max(0.05, w.contactFoamWidth) * 0.45);
    o = put4(v, o, rippleK, wrapPhase(-Math.sqrt(9.81 * rippleK) * this.time), Math.cos(heading), Math.sin(heading));
    // The chop's slow phase shift (`CHOP_SHIFT`): θ reduced in float64, so its cosine and sine stay exact however long
    // the clock runs.
    // z, w: the chop envelopes' two clocks (`CHOP_GROUP_TURNS`), reduced in float64.
    const chopOmega = Math.sqrt(9.81 * TAU * w.rippleScale / 6) * w.waveSpeed, shift = wrapPhase(CHOP_SHIFT_RATE * chopOmega * this.time);
    const clock = CHOP_GROUP_RATE * chopOmega * this.time;
    o = put4(v, o, Math.cos(shift), Math.sin(shift), wrapPhase(clock), wrapPhase(clock * Math.SQRT2));
    o = put4(v, o, smoothstep(0, 0.1, w.foamAmount) * Math.max(w.foamAmount, 0.85) * smoothstep(0, 0.05, w.contactFoamWidth),
      smoothstep(0, 0.05, w.crestFoam), 0.004 + 0.016 * smoothstep(0.05, 0.4, this.seaState), 1 + 0.9 * smoothstep(0.25, 0.6, this.seaState));
    const swash = this.swash;
    o = put4(v, o, swash[0]!, swash[1]!, swash[2]!, swash[3]!);
    const haze = lighting.haze;
    o = put4(v, o, haze[0]!, haze[1]!, haze[2]!, haze[3]!);
    if (partner) {
      // The partner's colours, through the same conversions as the asset's own (its own again without a partner).
      o = put4(v, o, linearChannel(partner.shallowColor[0]), linearChannel(partner.shallowColor[1]), linearChannel(partner.shallowColor[2]), partner.opacity);
      o = put4(v, o, linearChannel(partner.deepColor[0]), linearChannel(partner.deepColor[1]), linearChannel(partner.deepColor[2]), partner.reflectionStrength);
      o = put4(v, o, linearChannel(partner.foamColor[0]), linearChannel(partner.foamColor[1]), linearChannel(partner.foamColor[2]), partner.foamAmount);
      this.absorption(v, o, lighting, partner);
    }
    return v;
  }
  /**
   * Swell components and the swell warp relative to the floating origin at this frame's simulation time, so
   * eye-relative positions evaluate small phases; unused slots stay zero. Slots hold the components by descending
   * slope (`slopeOrder`), and `sea` receives their slope sums, with those of the slots the compiled tier's fragment
   * skips (Low from `LOW_SWELL_COMPONENTS`, Medium from `MEDIUM_SWELL_COMPONENTS`). The warp lands in `warp`.
   * The kernel part depends only on the wave set, Wave Scale, tier, clock and origin, so every body of one asset shares
   * it within a frame (`sharedSwell`). Allocation-free.
   */
  private swellConstants(scene: Scene): Float32Array {
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    const set = waterWaveSet(this.water);
    const shared = sharedSwell(set, this.waveScale, this.tier, origin.x, origin.z, this.time);
    this.warp.set(shared.warp);
    this.crestCount = shared.crestCount;
    waterSwashConstants(set, shared.lead, this.water, this.waveScale, origin.x, origin.z, this.time, this.swash);
    const rippleK = TAU / (0.35 + Math.max(0.05, this.water.contactFoamWidth) * 0.45);
    this.ringDelay = shared.count > 0 ? set.omega[shared.lead]! / (0.5 * Math.sqrt(9.81 / rippleK)) : 0;
    const sea = this.sea, steep = shared.sea[0]!;
    this.seaState = shared.seaState;
    sea[0] = steep;
    sea[1] = Math.max(0.0001, steep * (1 + this.water.choppiness * (1 / WATER_CREST_RANGE - 1)));
    sea[2] = shared.sea[2]!;
    sea[3] = shared.sea[3]!;
    return shared.swell;
  }
  /** Chop octaves and capillaries: (dir.x, dir.z, k, clock phase), the phase reduced in float64. Allocation-free. */
  private octaveConstants(): Float64Array {
    const w = this.water, out = this.octaves, base = TAU * w.rippleScale / 6, heading = w.waveDirection * Math.PI / 180;
    for (let i = 0; i < ALL_OCTAVES.length; i++) {
      const [turn, multiplier, , speed, phase] = ALL_OCTAVES[i]!, k = base * multiplier, o = i * 4;
      out[o] = Math.cos(heading + turn); out[o + 1] = Math.sin(heading + turn); out[o + 2] = k;
      out[o + 3] = wrapPhase(phase - Math.sqrt(9.81 * k) * speed * w.waveSpeed * this.time);
    }
    return out;
  }
  /**
   * Per-channel absorption for Realistic transmittance (`slateWaterAbsorb`) from Shallow Color, the colour shallows
   * take, in linear space: channels it lacks absorb fastest (`absorbCoefficient`), normalized so the slowest channel
   * absorbs over five Depth Color Distances: clear shallows keep the bed's light in the colour the water keeps. A grey
   * Shallow Color absorbs evenly. Stylized water (Painted's shallows) keeps its own `stylizedAbsorbCoefficient` (`w`
   * is spare, 0). The light through thin crests (`slateWaterThrough`, Subsurface) is
   * the sun's colour times what a crest transmits, by the gentler `glowCoefficient`. Allocation-free.
   */
  private absorption(v: Float64Array, o: number, lighting: WaterLighting, water: WaterDefinition): void {
    const tint = water.shallowColor, r = toLinear(tint[0]), g = toLinear(tint[1]), b = toLinear(tint[2]), top = Math.max(r, g, b);
    // The look's coefficients follow this material's style (a partner of the other style is coloured, not restyled).
    const k = this.water.style === "stylized" ? stylizedAbsorbCoefficient : absorbCoefficient;
    const kr = k(r, top), kg = k(g, top), kb = k(b, top), weight = Math.min(kr, kg, kb);
    const ar = kr / weight, ag = kg / weight, ab = kb / weight;
    put4(v, o, ar, ag, ab, 0);
    // Light through a crest crosses more open water than a shallow, through gentler ratios, and blue goes at least as
    // fast as green there (the plankton and dissolved matter of open water absorb blue), so crests glow teal against the
    // navy body even where clear shallows over sand read azure.
    const gr = glowCoefficient(r), gg = glowCoefficient(g), gb = Math.max(glowCoefficient(b), gg), glowWeight = Math.min(gr, gg, gb);
    const tr = Math.min(gr / glowWeight, GLOW_RATIO_CAP), tg = Math.min(gg / glowWeight, GLOW_RATIO_CAP), tb = Math.min(gb / glowWeight, GLOW_RATIO_CAP);
    const sun = lighting.sun[3]! * lighting.subsurfaceLift * 0.8, color = lighting.sunColor;
    // w: Opacity's cap on the absorption path, where the slowest channel reaches 1 − Opacity.
    const pathCap = -Math.log(Math.max(1 - water.opacity, 1e-6)) / Math.min(ar, ag, ab);
    put4(v, o + 4, color[0]! * Math.exp(-tr * 1.6) * sun, color[1]! * Math.exp(-tg * 1.6) * sun, color[2]! * Math.exp(-tb * 1.6) * sun, pathCap);
  }
  private bankFade(): number { return this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, this.waveScale); }
  /**
   * Defines another pass's program needs for `waterOutlineVertexSource` to match this material's vertex shader,
   * including the cascades of the FFT detail band its vertex stage samples. Allocation-free.
   */
  vertexWaveDefines(): readonly string[] {
    return VERTEX_WAVE_DEFINES[this.fftVertex]!;
  }
  /**
   * Sets `WATER_VERTEX_WAVE_UNIFORMS` and the band's sampler on another pass's effect for this frame, as
   * `hardBindForSubMesh` and `bindForSubMesh` do (the band's footprint follows that pass's projection and target), and
   * the drawn `mesh`'s grid offset.
   */
  bindVertexWaves(effect: Effect, scene: Scene, mesh: AbstractMesh): void {
    const grid = waterGridOffset(mesh);
    effect.setFloat4("slateWaterGridOffset", grid[0]!, grid[1]!, grid[2]!, 0);
    const swell = this.swellConstants(scene), warp = this.warp;
    for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
      const o = i * WATER_WAVE_SHADER_STRIDE;
      effect.setFloat4(SWELL_DIRECTION[i]!, swell[o]!, swell[o + 1]!, swell[o + 2]!, swell[o + 3]!);
      effect.setFloat4(SWELL_AMPLITUDE[i]!, swell[o + 4]!, swell[o + 5]!, swell[o + 6]!, swell[o + 7]!);
      effect.setFloat4(SWELL_GROUP[i]!, swell[o + 8]!, swell[o + 9]!, swell[o + 10]!, swell[o + 11]!);
    }
    for (let t = 0; t < WATER_SWELL_WARP_TERMS; t++) {
      const o = t * WATER_SWELL_WARP_STRIDE;
      effect.setFloat4(SWELL_WARP[t]!, warp[o]!, warp[o + 1]!, warp[o + 2]!, warp[o + 3]!);
    }
    effect.setFloat4("slateWaterSwellInfo", this.bankFade(), 0, 0, 0);
    effect.setFloat4("slateWaterShape", this.water.choppiness, 0, 0, 0);
    if (!this.fftVertex) return;
    const band = this.fftState(scene, this.fftCascades), v = this.fftValues;
    effect.setFloat4("slateWaterFft", v[0]!, v[1]!, v[2]!, v[3]!);
    for (let c = 0; c < WATER_FFT_CASCADES_MAX; c++) {
      const o = (1 + c) * 4;
      effect.setFloat4(FFT_CASCADE_UNIFORMS[c]!, v[o]!, v[o + 1]!, v[o + 2]!, v[o + 3]!);
    }
    effect.setTexture(WATER_FFT_SAMPLER, band?.texture ?? placeholderFft(scene));
  }
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    const wgsl = language === ShaderLanguage.WGSL;
    const v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4";
    // Babylon's shader processors are line-based: every attribute, varying and sampler needs its own line.
    const varying = (type: string, name: string) => (wgsl ? `varying ${name}: ${type};` : `varying ${type} ${name};`) + "\n";
    // vSlateWaterFlow packs the world current (x, z) and the Gerstner offset (Dx, Dz), so the fragment finds its rest point.
    const varyings = varying(v4, "vSlateWater") + varying(v4, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal")
      + `#ifdef ${WATER_BLEND_DEFINE}\n` + varying(v4, "vSlateWaterBlend") + "#endif\n";
    const blendAttribute = `#ifdef ${WATER_BLEND_DEFINE}\n${wgsl ? "attribute slateWaterBlend: vec4f;" : "attribute vec4 slateWaterBlend;"}\n#endif\n`;
    if (shaderType === "vertex") {
      const vertex = waterVertexSource(language);
      return {
        CUSTOM_VERTEX_DEFINITIONS: (wgsl
          ? "attribute slateWaterData: vec4f;\nattribute slateWaterFlow: vec3f;\nattribute slateWaterBaseNormal: vec3f;\nattribute slateWaterOffset: vec2f;\n"
          : "attribute vec4 slateWaterData;\nattribute vec3 slateWaterFlow;\nattribute vec3 slateWaterBaseNormal;\nattribute vec2 slateWaterOffset;\n") + blendAttribute + varyings + vertex.definitions,
        CUSTOM_VERTEX_UPDATE_WORLDPOS: vertex.worldPosition,
        CUSTOM_VERTEX_MAIN_END: vertex.end,
      };
    }
    if (shaderType !== "fragment") return null;
    const source = waterShaderSource(language);
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: varyings + source.helpers,
      CUSTOM_FRAGMENT_UPDATE_ALPHA: source.cut,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: source.main,
      // Realistic: filtered chop widens the GGX lobe with distance, and foam is fully rough.
      CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS:
        "metallicRoughness.g = mix(sqrt(sqrt(metallicRoughness.g * metallicRoughness.g * metallicRoughness.g * metallicRoughness.g + 2.0 * swSlopeVariance)), 1.0, swMatte);",
      // Foam and the mesh edge hide the mirror; without an environment, the analytic scene sky (`swSkyRefl`) stands in.
      // Reflected objects (screen-space or planar) replace the sky or environment where found, with the water's own
      // Fresnel and Reflection Strength.
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: [
        "finalEmissive += swEmissive;",
        `#ifndef ${WATER_STYLIZED_DEFINE}`,
        "#ifdef REFLECTION",
        // The facet's own Fresnel (`swFres`) replaces the environment BRDF's, which the lifted shading normal and the
        // filtered roughness would dim toward the horizon.
        `finalRadianceScaled = reflectionOut.environmentRadiance.rgb * (${wgsl ? "uniforms." : ""}vLightingIntensity.z * swFres);`,
        `#if ${REFLECTS_OBJECTS}`,
        `finalRadianceScaled = mix(finalRadianceScaled, swObjRefl.rgb * (swFres * ${wgsl ? "uniforms." : ""}slateWaterDeep.w), swObjRefl.a);`,
        "#endif",
        "finalRadianceScaled *= swGloss;",
        "#else",
        `#if ${REFLECTS_OBJECTS}`,
        `finalEmissive += mix(swSkyRefl, swObjRefl.rgb * ${wgsl ? "uniforms." : ""}slateWaterDeep.w, swObjRefl.a) * (swFres * swGloss);`,
        "#else",
        "finalEmissive += swSkyRefl * (swFres * swGloss);",
        "#endif",
        "#endif",
        "#ifdef SPECULARTERM",
        // The sun's lobe is dimmed close by (where facet glints carry it), log-compressed where bright, and far away
        // broken into glitter (see the sun in `realisticSource`).
        "finalSpecularScaled *= swGloss * swSunReach * swSpecKeep;",
        `finalSpecularScaled *= log(1.0 + dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) * swSpecSquash + 0.0001) / (dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) * swSpecSquash + 0.0001);`,
        `finalSpecularScaled *= mix(1.0, swSpecMod, swSpecModW * smoothstep(0.05, 0.4, dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11))));`,
        "#endif",
        "#endif",
      ].join("\n"),
      CUSTOM_FRAGMENT_BEFORE_FOG: beforeFogSource(wgsl),
    };
  }
}

export function configureWaterMaterial(material: PBRMaterial, water: WaterDefinition): void {
  // Stylized toon water is emissive only: no PBR light loop or reflection, so scene lights do not grow its shader.
  // Realistic water drops the light loop at Low Water Shading Detail (`WaterMaterialPlugin.syncQuality`).
  material.unlit = material.disableLighting = water.style === "stylized";
  // Realistic output is premultiplied (see CUSTOM_FRAGMENT_BEFORE_FOG), which raises coverage for bright light itself.
  material.useRadianceOverAlpha = false;
  material.useSpecularOverAlpha = false;
  material.albedoColor = Color3.White();
  material.metallic = 0;
  applyWaterMaterialScalars(material, water);
  material.indexOfRefraction = 1.333;
  // Realistic water widens its GGX lobe by the slope variance its filtered waves lose; Babylon's derivative-based
  // specular antialiasing would widen it again and dim the sun glitter to nothing.
  material.enableSpecularAntiAliasing = false;
  // The shader derives per-pixel transmittance from depth; blending must stay on even at full Opacity.
  material.alpha = 1;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  material.backFaceCulling = false;
  material.needDepthPrePass = true;
}

/** The PBR scalars a Water definition sets besides its Style (which needs a rebuild): Roughness and Reflection Strength. */
export function applyWaterMaterialScalars(material: PBRMaterial, water: WaterDefinition): void {
  material.roughness = water.roughness;
  material.environmentIntensity = water.reflectionStrength;
}
