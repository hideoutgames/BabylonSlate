import {
  BaseTexture, Color3, Constants, DirectionalLight, HemisphericLight, MaterialPluginBase, Matrix, PBRMaterial, type MaterialDefines, RawTexture, ShaderLanguage,
  Texture, ThinTexture, Vector3, type AbstractEngine, type AbstractMesh, type Effect, type Material, Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import {
  WATER_CREST_MEAN, WATER_CREST_RANGE, WATER_FFT_CASCADES_MAX, WATER_JACOBIAN_FLOOR, WATER_SWELL_WARP_STRIDE, WATER_SWELL_WARP_TERMS, WATER_WAVE_MAX_COMPONENTS,
  WATER_WAVE_SHADER_STRIDE, waterBankFadeLength, waterSpectrum, waterSwellWarpShaderConstants, waterUsesSpectrum, waterWaveQ, waterWaveSet,
  waterWaveShaderConstants, waterWaveSurge,
  type WaterBodyProperties, type WaterDefinition,
  type WaterShadingDetail, type WaterWaveSet,
} from "@haptic/core";
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
 * Sharp-crested `exp(sin - 1)` waves (Stylized adds a little domain drag) read as wind chop rather than
 * the regular interference of plain sines. All are world-space and advect with the current.
 * Toon evaluates up to three of them (`STYLIZED_CHOP_TIER`); Realistic and Painted take their waves from the FFT spectrum.
 * Their directions, wavenumbers and clock phases are uniforms (`octaveConstants`).
 */
const DETAIL_OCTAVES = [
  [0.0, 1.0, 0.22, 1.0, 0.0], [0.9, 1.61, 0.2, 0.93, 1.7], [-0.7, 2.59, 0.17, 1.07, 4.1],
  [2.1, 4.17, 0.14, 0.9, 2.3], [-1.9, 6.71, 0.11, 1.1, 5.6], [0.35, 10.8, 0.08, 0.95, 0.9],
] as const;
/**
 * A swell component fades by the phase it advances over one sample: radians per pixel footprint (the fragment, along its
 * own heading) and per vertex spacing (`swvF`, whose 4/Wave Length constant makes `spacing * w` 0.64 k · spacing). The
 * fragment's geometry terms (height, offset, resolved share) fade between `SWELL_GEOMETRY_FADE` per pixel, as the mesh
 * drops it by 1.56 to π per vertex.
 */
const SWELL_GEOMETRY_FADE = [0.6, 2.2] as const;

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
 * Toon's refraction bends by the swell and the first chop octaves only: the finer chop and the FFT band move the bed at a
 * frequency the eye reads as jelly, and stay in the shading normal alone.
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
 * static rest grid and only the clock advances. Custom Material water keeps CPU-displaced vertices, unless its graph holds
 * a Water Waves node, whose block sets this define for the meshes that have a `WaterVertexWaves`.
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
 * waterline somewhat more (within the contact range of an object in the water the reach shortens toward its distance).
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
/**
 * Spectrum water (`waterUsesSpectrum`: Realistic and Painted): the FFT spectrum is the whole sea, in the vertex and
 * fragment stages, with its persistent foam (`WATER_FOAM_SAMPLER`).
 */
export const WATER_SPECTRUM_DEFINE = "SLATE_WATER_SPECTRUM";
export const WATER_FOAM_SAMPLER = "slateWaterFoamSampler";
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
/**
 * Metres of ownership margin over which a blending surface's vertex stage eases the band's displacement out toward the
 * seam (`fftVertexSource`): neighbours' grids resolve the band differently, so at the seam neither displaces by it.
 */
const FFT_SEAM_FADE = 2;
const STYLIZED_CHOP_TIER = [0, 1, 2] as const;
/**
 * Radians each Stylized chop octave's phase (the first three) drifts across the large and the medium anti-tiling noise:
 * its crests wander instead of running straight, so crossing octaves never form a regular lattice.
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
/** `spatial` scales how fast the modulation's world phase varies across the noises. */
function chopFm(i: number, spatial = 1): string {
  const depth = `${f(CHOP_FM_DEPTH)} * (0.4 + 0.75 * swGust + 0.45 * swLarge)`;
  return ` + ${depth} * (sin(dot(U.slateWaterChopShift.zw, vec2(${f(CHOP_FM_TURNS[i]![0])}, ${f(CHOP_FM_TURNS[i]![1])})) + swGust * ${f(4 * spatial)} + ${f(0.9 + i * 1.7)})`
    + ` + sin(dot(U.slateWaterChopShift.zw, vec2(${f(CHOP_FM_SLOW_TURNS[i]![0])}, ${f(CHOP_FM_SLOW_TURNS[i]![1])})) + swLarge * ${f(6 * spatial)} + ${f(2.0 + i * 2.3)}))`;
}
/** The short-crest envelope (a factor) of the chop octave whose uniform vec4 (dir.x, dir.z, k, phase) is `octave`; `bend` is added to its phase. */
function chopCrests(octave: string, i: number, bend = ""): string {
  const turn = i % 2 ? CHOP_CREST_TURN : -CHOP_CREST_TURN, c = Math.cos(turn), s = Math.sin(turn);
  return `(0.55 + 0.9 * (0.5 - 0.5 * cos(${octave}.z * ${f(CHOP_CREST_K)} * dot(vec2(${f(c)} * ${octave}.x - ${f(s)} * ${octave}.y, ${f(s)} * ${octave}.x + ${f(c)} * ${octave}.y), swChop)${bend} + ${f(1.3 + i * 2.1)} - dot(U.slateWaterChopShift.zw, vec2(${f(CHOP_GROUP_TURNS[i]![0])}, ${f(CHOP_GROUP_TURNS[i]![1])})))))`;
}
/**
 * Toon's crest lines seed each crest of the dominant swell component by its index, counted modulo this many crests
 * (thousands of wavelengths apart, never in one view), so the count stays exact in float32 however long the clock runs.
 */
const CREST_COUNT_PERIOD = 4096;
/** Frequencies (per metre) of the shared large and gust noises; the chop warp sizes its amplitude to each. */
const LARGE_NOISE = 0.07, GUST_NOISE = 0.013;
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

/** `code` from `tier` up, `otherwise` below it; every directive on its own line. Code blocks start with a newline. */
function fromTier(tier: number, code: string, otherwise = ""): string {
  if (tier <= 0) return code;
  return `\n#if ${Q} >= ${tier}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;
}
const ifDefined = (define: string, code: string, otherwise = "") => `\n#ifdef ${define}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;

/**
 * Toon's foam holes (`swWeb`): a Worley pattern over a 3 × 3 cell neighbourhood with feature points anywhere
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
vec2 swWeb(vec2 p) {
  vec2 b = floor(p);
  vec2 f = p - b;
  float n1 = 8.0;
  float n2 = 8.0;${FOAM_WEB_CELLS}
  float s1 = sqrt(n1);
  return vec2(s1, sqrt(n2) - s1);
}
`;



/**
 * Refraction (`SLATE_WATER_REFRACTION`), right after the bottom estimate: the view ray bends by the surface tilt (in
 * view space), more through thicker water and less far away, and reads the view's scene copy there. A shifted ray
 * that lands on something in front of the water (an object above it) keeps the straight ray, so nothing above the
 * surface leaks into it, and a downsampled copy texel holding a foreground silhouette hands over to a neighbour that lies
 * behind the water. The copy's depth also bounds the bottom estimate (similar triangles along the view ray), so
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
// Beside the silhouette of something in front of the water, a downsampled copy texel holds that object (its nearest
// depth): there the copy is not what lies behind this point. The nearest neighbouring texel that does lie behind the
// water stands in for it (its colour and depth, at most one copy texel away), so silhouettes keep refracting instead of
// dropping a texel-sized block of pixels back to the blended surface. Only there: four depth loads.
vec2 swCopyTexel = swSceneTexelUv();
if (swSceneZ < swWaterZ && swCopyTexel.x > U.slateWaterScreen.x * 1.01) {
  float swBehind = ${f(WATER_SCENE_COPY_SKY_DEPTH * 2)};
  vec2 swBehindUv = swRefrUv;${[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([x, y], k) => `
  vec2 swNearUv${k} = swRefrUv + swCopyTexel * vec2(${f(x!)}, ${f(y!)});
  float swNearZ${k} = swSceneDepth(swNearUv${k});
  if (swNearZ${k} >= swWaterZ && swNearZ${k} < swBehind) { swBehind = swNearZ${k}; swBehindUv = swNearUv${k}; }`).join("")}
  if (swBehind < ${f(WATER_SCENE_COPY_SKY_DEPTH * 2)}) { swRefrUv = swBehindUv; swSceneZ = swBehind; }
}
vec3 swBackground = swSceneColor(swRefrUv);
// Where no neighbour lies behind it either, the pixel keeps the blended surface.
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
 * environment and the march do, rather than by a small fixed shift that left wavy water mirror-flat. Near an object in
 * the water (the contact field) the reach shortens toward the object's distance, so its reflection meets it at the
 * waterline, and a lookup carried past the target's edge is pulled back toward the fragment's own mirror point. Its
 * alpha is coverage and display views store it display-encoded. Without it (another body is the view's dominant one), the
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
  // Beside an object standing in the water (within the contact range), what this point mirrors is mostly that object, a
  // short way along the ray: the lookup follows the ray only about as far as the object is, so the object's reflection
  // meets it at the waterline instead of swinging with the full tilt.
  swPlanarReach = mix(min(swPlanarReach, swObject * 2.0), swPlanarReach, smoothstep(0.5, 1.0, swObject / max(U.slateWaterContactInfo.y, 0.001)));
  vec4 swPlanarClip = U.slateWaterPlanarMatrix * vec4(IN.vPositionW + swReflRay * swPlanarReach, 1.0);
  vec2 swPlanarUv = swPlanarClip.xy / max(swPlanarClip.w, 0.000001) * 0.5 + vec2(0.5);
  // The tilt can carry the lookup past the mirrored view's edge, where the clamped target would smear its border texels
  // across the water: it is pulled back along the tilt toward this fragment's own mirror point (inside the view) until
  // it lies within the target.
  vec4 swPlanarClip0 = U.slateWaterPlanarMatrix * vec4(IN.vPositionW, 1.0);
  vec2 swPlanarUv0 = clamp(swPlanarClip0.xy / max(swPlanarClip0.w, 0.000001) * 0.5 + vec2(0.5), vec2(0.0), vec2(1.0));
  vec2 swPlanarD = swPlanarUv - swPlanarUv0;
  vec2 swPlanarRoom = mix(swPlanarUv0, vec2(1.0) - swPlanarUv0, step(vec2(0.0), swPlanarD)) / max(abs(swPlanarD), vec2(0.000001));
  swPlanarUv = swPlanarUv0 + swPlanarD * clamp(min(swPlanarRoom.x, swPlanarRoom.y), 0.0, 1.0);
  vec4 swPlanarHit = swPlanarTexel(swPlanarUv);
  vec3 swPlanarColor = swPlanarHit.rgb / max(swPlanarHit.a, 0.001);
  // A point behind the mirrored camera has no projection (its uv would clamp to an edge texel): the sky stays.
  swObjRefl = vec4(mix(swPlanarColor, SW_TO_LINEAR(swPlanarColor), U.slateWaterPlanar.y), swPlanarHit.a * step(0.000001, swPlanarClip.w));
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
fn swFftTap(uv: vec2f, layer: f32) -> vec4f { return textureSampleLevel(${WATER_FFT_SAMPLER}, ${WATER_FFT_SAMPLER}Sampler, uv, i32(layer), 0.0); }
fn swFftTapLod(uv: vec2f, layer: f32, lod: f32) -> vec4f { return textureSampleLevel(${WATER_FFT_SAMPLER}, ${WATER_FFT_SAMPLER}Sampler, uv, i32(layer), lod); }` : `
uniform highp sampler2DArray ${WATER_FFT_SAMPLER};
vec4 swFftTap(vec2 uv, float layer) { return textureLod(${WATER_FFT_SAMPLER}, vec3(uv, layer), 0.0); }
vec4 swFftTapLod(vec2 uv, float layer, float lod) { return textureLod(${WATER_FFT_SAMPLER}, vec3(uv, layer), lod); }`, 1, define) + "\n";
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
float swFftReach = max(length(swFootX), length(swFootY));${fftTileWeight("swFft", "swSwellWP")}
vec2 swFftGrad = vec2(0.0);
vec3 swFftJ = vec3(0.0);${cascades}
// A blending surface scales the band's height by its swell share and its horizontal terms by its offset share, as the
// mesh scales the band's height and offset and the Gerstner offsets above use \`swBlendD\`.
swFftGrad = swFftGrad * (swFft.x * swBlendH);
swFftJ = swFftJ * (swFft.x * swFft.y * swGain * swBlendD);
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
 * fold the mesh: the combined determinant (the swell's `swvShear` plus the band's ∂D terms, at a blending surface's
 * offset scale) stays at or above `WATER_JACOBIAN_FLOOR`. Faded cascades skip their taps.
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
// The fold limit sees the offset the mesh receives: a blending surface scales it by its offset share below.
float swvFoldGain = swvGain;
#ifdef ${WATER_BLEND_DEFINE}
swvFoldGain = swvFoldGain * A.slateWaterBlend.y;
// A blend seam joins two meshes that resolve the band differently (or one compiles none of it): both ease its
// displacement out over the last \`FFT_SEAM_FADE\` metres of their ownership margin, so their edges meet at the swell's
// height and no crack opens. The fragment keeps the band's slopes in the shading there.
float swvFftSeam = smoothstep(0.0, ${f(FFT_SEAM_FADE)}, abs(A.slateWaterBlend.z));
swvFftH = swvFftH * swvFftSeam;
swvFftD = swvFftD * swvFftSeam;
swvFftJ = swvFftJ * swvFftSeam;
#endif
float swvJxx = 1.0 - swvFoldGain * (swvShear.x * swvWarpM.x + swvShear.y * swvWarpM.y);
float swvJxz = -swvFoldGain * (swvShear.x * swvWarpM.y + swvShear.y * swvWarpM.z);
float swvJzx = -swvFoldGain * (swvShear.y * swvWarpM.x + swvShear.z * swvWarpM.y);
float swvJzz = 1.0 - swvFoldGain * (swvShear.y * swvWarpM.y + swvShear.z * swvWarpM.z);
float swvDetA = swvJxx * swvJzz - swvJxz * swvJzx;
vec3 swvJb = swvFftJ * (swvFft.x * swvFft.y * swvFoldGain);
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
 * - Bisection refines the hit, taken where the depth gaps at its bracketing samples interpolate to zero (so it never
 *   depends on where the steps fell), which stands only on the surface its texel holds (within `SSR_THICKNESS`) and takes
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
  var swDA: f32 = -1.0;
  var swDB: f32 = 0.0;
  for (var swI: i32 = 1; swI <= ${steps}; swI++) {
    let swU = swEnd * f32(swI) / f32(${steps});
    let swRayZ = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swU));
    let swSceneZ = swSceneDepth(mix(swN0, swN1, swU) * 0.5 + 0.5);
    let swThick = ${base} + ${slope} * swRayZ;
    if (swRayZ > swSceneZ) {
      if (swSceneZ > swPrevZ - swThick) { swA = swPrevU; swB = swU; swDA = swPrevZ - swPrevScene; swDB = swRayZ - swSceneZ; break; }
    } else if (swRayZ > swPrevScene && swPrevZ <= swPrevScene) {
      let swProbeU = swMarchAt(swC1.w, swC0.w, clamp((swPrevScene - swD0) / max(swD1 - swD0, 0.000001), 0.0, 1.0));
      let swProbeD = swPrevScene - swSceneDepth(mix(swN0, swN1, swProbeU) * 0.5 + 0.5);
      if (abs(swProbeD) < swThick) { swA = swPrevU; swB = swProbeU; swDA = swPrevZ - swPrevScene; swDB = swProbeD; break; }
    }
    swPrevU = swU;
    swPrevZ = swRayZ;
    swPrevScene = swSceneZ;
  }
  if (swB < 0.0) { return vec4f(0.0); }
  for (var swJ: i32 = 0; swJ < ${refine}; swJ++) {
    let swM = 0.5 * (swA + swB);
    let swMidD = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swM)) - swSceneDepth(mix(swN0, swN1, swM) * 0.5 + 0.5);
    if (swMidD > 0.0) { swB = swM; swDB = swMidD; } else { swA = swM; swDA = swMidD; }
  }
  let swCross = mix(swA, swB, clamp(swDA / min(swDA - swDB, -0.000001), 0.0, 1.0));
  let swUv = mix(swN0, swN1, swCross) * 0.5 + 0.5;
  let swS = swMarchAt(swC0.w, swC1.w, swCross);
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
  // Depth gaps (ray minus scene) at A, in front of the surface, and B, behind it.
  float swDA = -1.0;
  float swDB = 0.0;
  for (int swI = 1; swI <= ${steps}; swI++) {
    float swU = swEnd * float(swI) / float(${steps});
    float swRayZ = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swU));
    float swSceneZ = swSceneDepth(mix(swN0, swN1, swU) * 0.5 + 0.5);
    float swThick = ${base} + ${slope} * swRayZ;
    if (swRayZ > swSceneZ) {
      if (swSceneZ > swPrevZ - swThick) { swA = swPrevU; swB = swU; swDA = swPrevZ - swPrevScene; swDB = swRayZ - swSceneZ; break; }
    } else if (swRayZ > swPrevScene && swPrevZ <= swPrevScene) {
      float swProbeU = swMarchAt(swC1.w, swC0.w, clamp((swPrevScene - swD0) / max(swD1 - swD0, 0.000001), 0.0, 1.0));
      float swProbeD = swPrevScene - swSceneDepth(mix(swN0, swN1, swProbeU) * 0.5 + 0.5);
      if (abs(swProbeD) < swThick) { swA = swPrevU; swB = swProbeU; swDA = swPrevZ - swPrevScene; swDB = swProbeD; break; }
    }
    swPrevU = swU;
    swPrevZ = swRayZ;
    swPrevScene = swSceneZ;
  }
  if (swB < 0.0) { return vec4(0.0); }
  for (int swJ = 0; swJ < ${refine}; swJ++) {
    float swM = 0.5 * (swA + swB);
    float swMidD = mix(swD0, swD1, swMarchAt(swC0.w, swC1.w, swM)) - swSceneDepth(mix(swN0, swN1, swM) * 0.5 + 0.5);
    if (swMidD > 0.0) { swB = swM; swDB = swMidD; } else { swA = swM; swDA = swMidD; }
  }
  // The hit is where the depth gaps at A and B interpolate to zero: on a continuous surface the ray meets it there, so
  // the thickness test below measures the copy's own texel error rather than how far the bisection's last step fell
  // from the surface (that residual follows the march's step spacing and drew sloped hills and beaches as rings).
  // Across a silhouette the gaps are large on both sides and the test still rejects the hit.
  float swCross = mix(swA, swB, clamp(swDA / min(swDA - swDB, -0.000001), 0.0, 1.0));
  vec2 swUv = mix(swN0, swN1, swCross) * 0.5 + 0.5;
  float swS = swMarchAt(swC0.w, swC1.w, swCross);
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
 * Toon's swell, wind chop, contacts and depth (the analytic waves; Realistic and Painted use `spectrumSurfaceSource`).
 */
function surfaceSource(): string {
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
float swPh${i} = swK${i} * (abs(dot(swDm${i}, swFootX)) + abs(dot(swDm${i}, swFootY)));
float swFd${i} = 1.0 - smoothstep(${f(SWELL_GEOMETRY_FADE[0])}, ${f(SWELL_GEOMETRY_FADE[1])}, swPh${i});
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
swResolved += swK${i} * swFd${i} * swA${i};${i === 0 ? `
// Toon's primary swell (its bands and crest lines follow it): the steepest slot, with from Medium the components near
// its wavelength.
swPrimH += swHv${i} * swF${i};${fromTier(1, `
swPrimAmp += swA${i} * swA${i};`)}` : fromTier(1, `
float swPw${i} = 1.0 - smoothstep(1.3, 2.2, swK${i} * swPrimLen);
swPrimH += swHv${i} * swF${i} * swPw${i};
swPrimAmp += swA${i} * swA${i} * swPw${i} * swPw${i};`)}
float swQ${i} = swWA${i}.z * swFd${i} * swBlendD;
swOffset += swD${i} * (swQ${i} * swC${i});
swShear += vec3(swD${i}.x * swD${i}.x, swD${i}.x * swD${i}.y, swD${i}.y * swD${i}.y) * (swQ${i} * swK${i} * swS${i});`)).join("");
  // Low and Medium: the swell components they skip still count as resolved slope (faded like their last one), so they
  // widen the sun path instead of vanishing (the CPU sums the skipped slots for the compiled tier).
  const skipped = (last: number) => `
swResolved += U.slateWaterSea.w * swFd${last} * swBlendH;`;
  const lowSwell = fromTier(2, "", fromTier(1, skipped(MEDIUM_SWELL_COMPONENTS - 1), skipped(LOW_SWELL_COMPONENTS - 1)));
  const detail = DETAIL_OCTAVES.slice(0, STYLIZED_CHOP_TIER.length).map(([, , slope], i) => fromTier(STYLIZED_CHOP_TIER[i]!, `
vec4 swOC${i} = U.${CHOP_UNIFORMS[i]};
// The shared noises drift each octave's phase and, in opposition between neighbours, its strength, so crossing octaves
// never lock into ribs or a dimple lattice.
float swOX${i} = swOC${i}.z * dot(swOC${i}.xy, swChop) + swOC${i}.w + swLarge * ${f(CHOP_PHASE_DRIFT[i]![0])} + swMedium * ${f(CHOP_PHASE_DRIFT[i]![1])} + swChopShift * ${f(CHOP_SHIFT[i]!)}${chopFm(i)};
float swOW${i} = exp(sin(swOX${i}) - 1.0);
float swOCs${i} = cos(swOX${i});
float swOA${i} = ${f(slope * (1 - Math.min(0.85, i * 0.14)))} * (1.0 - smoothstep(0.3, 1.1, swOC${i}.z * swFoot)) * (0.35 + 1.3 * ${i % 2 === 0 ? "" : "(1.0 - "}smoothstep(0.3, 0.7, mix(swMedium, swLarge, 0.6))${i % 2 === 0 ? "" : ")"})
  * ${chopCrests(`swOC${i}`, i)};
swDetail += swOC${i}.xy * (swOW${i} * swOCs${i} * swOA${i});
swChopH += (swOW${i} - 0.37) * swOA${i};
swChop -= swOC${i}.xy * (swOW${i} * swOCs${i} * 0.3 / swOC${i}.z);${i === REFRACTION_OCTAVES[1] - 1 ? "\nswDetailMid = swDetail;" : ""}`)).join("");
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
float swResolved = 0.0;
float swPrimLen = U.slateWaterWaves.y * 0.159155;
float swPrimH = 0.0;
float swPrimAmp = 0.0;
float swChopShape = U.slateWaterShape.x;
// Unfaded Gerstner offset and S = sum(q*a*k*sin(p) * d d^T) (xx, xz, zz) at the warped rest point, filtered like the swell.
vec2 swOffset = vec2(0.0);
vec3 swShear = vec3(0.0);
// The shared kernel's warp: every component is evaluated at u = rest + W(rest), and rest-space derivatives carry
// M = I + dW/drest (swSwellWarpM, symmetric): grad H = M grad_u H, grad D = grad_u D M.${swellWarpSource("swSwell", "swRest", true)}
vec2 swRestW = swRest + swSwellWarp;
${swell}${lowSwell}
swGradient = vec2(dot(swSwellWarpM.xy, swGradient), dot(swSwellWarpM.yz, swGradient));
// The primary swell's height scale: its components' root-sum-square, not their sum, so a crest reads as tall whether one
// component carries the swell or several share it (\`PRIMARY_RMS\` keeps a single dominant train's scale).${fromTier(1, `
swPrimAmp = ${f(PRIMARY_RMS)} * sqrt(swPrimAmp);`, `
swPrimAmp = ${f(PRIMARY_RMS)} * swA0;`)}
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
float swMedium = swNoise(swFlowedR * 0.43 + vec2(swTime * 0.03, 0.0));
// Stylized posterises its colour drifts, where a value noise's cell grid would show as soft-edged rectangles: the
// medium noise bends the large one's domain (by up to about a third of a cell), so the drifts curve instead. The bend
// fades where the medium noise would alias, so distant drifts never speckle.
float swLarge = swNoise(swWorldL * ${f(LARGE_NOISE)} + vec2(swMedium - 0.5, 0.5 - swMedium) * (0.7 * (1.0 - smoothstep(0.6, 1.6, swFoot))));${fromTier(1, `
float swFine = swNoise(swFlowed * 2.9 - vec2(0.0, swTime * 0.09));
// Gusts roughen or calm wide patches.
float swGust = swNoise(vec2(dot(swWorld, vec2(0.479426, 0.877583)), dot(swWorld, vec2(-0.877583, 0.479426))) * ${f(GUST_NOISE)} + vec2(swTime * 0.004, 0.0));`, `
float swFine = swMedium;
float swGust = swLarge;`)}${fftFragmentSource()}
// Anti-tiling (Stylized): a bounded warp bends the chop domain, so crests curve and cross differently across the sea. (A
// rotation about the world origin would compress the chop without limit far from it.) Each component's amplitude suits its
// noise's frequency, so the warp never stretches the chop much; Low's gust is its large noise, so that one shrinks.${fromTier(1, `
vec2 swChop = swFlowed + vec2(swLarge - 0.5, swGust - 0.5) * vec2(2.4, 9.0);`, `
vec2 swChop = swFlowed + vec2(swLarge - 0.5, swGust - 0.5) * vec2(2.4, ${f(9 * GUST_NOISE / LARGE_NOISE)});`)}
// Colour Variation's drifts: the two wide noises mixed, with edges bent by the medium one. Either wide noise alone shows
// its cell grid as soft-edged rectangles (the gust's cells are about 77 m); mixed with each other and the medium noise
// (six times finer than the large one) their edges curve and their cells no longer line up.
float swDrift = swLarge * 0.5 + swGust * 0.3 + swMedium * 0.2;
vec2 swDetail = vec2(0.0);
// The chop octaves refraction bends by (\`REFRACTION_OCTAVES\`): the medium-frequency part of \`swDetail\`, kept apart from the fine
// octaves, whose high-frequency wobble would make the bed under the water shimmer like jelly.
vec2 swDetailMid = vec2(0.0);
float swChopH = 0.0;
// The chop's slow phase shift (\`CHOP_SHIFT\`): a rotating mix of the two wide noises.
float swChopShift = U.slateWaterChopShift.x * (swLarge - 0.5) + U.slateWaterChopShift.y * (swGust - 0.5);
${detail}${fromTier(1, "", `
swDetailMid = swDetail;`)}
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
float swOpenEdge = U.slateWaterFieldInfo.x * (1.0 - smoothstep(0.0, 0.1, swField.a * swFieldOn));
float swOpenAny = swOpenEdge;
float swOpenW = ${f(OPEN_EDGE_FADE)};
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
float swFilmCur = 0.0;
float swFilmOld = 0.0;
float swFilmG0 = -1.0;
float swFilmG1 = -1.0;
float swFilmG2 = -1.0;
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
  // Its furthest reach leaves a stranded line that fades as the water drains (Toon leaves it out: it lay as a pale strip on
  // the sand beyond the wet film, and that film darkens the sand to mark the furthest reach instead).
  float swStrandW = swFoamWidth * 0.12 + swAAX;
  float swStrand = (1.0 - smoothstep(swStrandW * 0.4, swStrandW, abs(swShoreHere - swSwashX * (1.0 - swReach)))) * swSwashBack * exp(-swDn * 2.0) * 0.8;
  swSwashFoam = swFront * swSwashZone;
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
  // Toon cannot antialias the film's hard switches (the swash's furthest reach, this cycle's reach, the moment the backwash
  // uncovered the point) from inside this branch, which has no derivatives: it exports the two ages and the continuous
  // quantities the switches test, and blends them outside (\`swSwashWet\` below).
  swFilmCur = exp(-(swSwU - swPassC) * 1.4);
  swFilmOld = exp(-(swSwU + 1.0 - swPassP + step(1.0, swNeedP) * 3.0) * 1.4);
  swFilmG0 = swNeed * swSwashX;
  swFilmG1 = 1.0 - swNeedC;
  swFilmG2 = swSwU - swPassC;
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
float swChopGain = U.slateWaterMotion.z * (0.35 + 0.65 * swCalm + swAgitate) * (0.5 + swGust);
vec2 swSlope = swGradient + swDetail * swChopGain + swRipple;${ifFft(`
swSlope += swFftSlope;`)}
normalW = normalize(vec3(swBaseX - swSlope.x, 1.0, swBaseZ - swSlope.y));
// The swell alone, without chop: the large-scale wave shape used for lighting through crests.
vec3 swSwellNormal = normalize(vec3(swBaseX - swGradient.x, 1.0, swBaseZ - swGradient.y));

// Bottom estimate: a shelving bank with an irregular floor, capped by the component Depth.
float swShelf = 0.28 + 0.35 * swLarge;
float swDepth = mix(swBodyDepth * (1.0 - exp(-swBank * swShelf / swBodyDepth)), max(0.0, swTerrainDepth), swKnown);
// The bed under this point, before refraction bounds it by whatever lies nearer.
float swBedDepth = swDepth;${refractionSource(1)}
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

`;
}

/**
 * Spectrum water's samplers for the fragment stage (`SLATE_WATER_SPECTRUM`): the FFT ocean and its persistent foam,
 * sampled with implicit derivatives so their mips filter far water (normals and foam fade into their averages instead
 * of aliasing). Only called from the shader's top level (uniform control flow), as implicit derivatives require.
 */
function spectrumHelpers(wgsl: boolean): string {
  return ifDefined(WATER_SPECTRUM_DEFINE, wgsl ? `
var ${WATER_FOAM_SAMPLER}Sampler: sampler;
var ${WATER_FOAM_SAMPLER}: texture_2d_array<f32>;
fn swSpecTap(uv: vec2f, layer: f32) -> vec4f { return textureSample(${WATER_FFT_SAMPLER}, ${WATER_FFT_SAMPLER}Sampler, uv, i32(layer)); }
fn swFoamTap(uv: vec2f, layer: f32) -> vec4f { return textureSample(${WATER_FOAM_SAMPLER}, ${WATER_FOAM_SAMPLER}Sampler, uv, i32(layer)); }` : `
uniform highp sampler2DArray ${WATER_FOAM_SAMPLER};
vec4 swSpecTap(vec2 uv, float layer) { return texture(${WATER_FFT_SAMPLER}, vec3(uv, layer)); }
vec4 swFoamTap(vec2 uv, float layer) { return texture(${WATER_FOAM_SAMPLER}, vec3(uv, layer)); }`) + "\n";
}

/** FFT-Ocean's distance LOD: cascade c > 0 fades by `SPECTRUM_LOD_SCALE` · its patch over the eye distance. */
const SPECTRUM_LOD_SCALE = 7.13;
/** FFT-Ocean's foam: coverage per unit of turbulence below the bias. */
const SPECTRUM_FOAM_SCALE = 2.4;

/**
 * The spectrum's displacement in the vertex stage (`SLATE_WATER_SPECTRUM`): every cascade's (Dx, H, Dz) at this
 * vertex's rest point, turned back from the cascade's frame, read at the mip that matches the mesh spacing (so a
 * coarse grid takes each cascade's filtered average, never an aliased sample) and faded with eye distance by FFT-Ocean's
 * LOD (`SPECTRUM_LOD_SCALE`): small cascades stop moving far geometry the eye cannot resolve. Height scales by
 * `slateWaterFft.x` (Wave Scale while the band is ready, else 0: flat until the first dispatch), the offset also by λ
 * (`.y`); the bank fade and blending then scale them like the swell's.
 */
function spectrumVertexSource(): string {
  const cascades = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => {
    const code = `
vec4 swvSc${c} = U.${FFT_CASCADE_UNIFORMS[c]};
float swvSw${c} = ${c === 0 ? "1.0" : `clamp(swvSp.w / max(swvSc${c}.x * swvDist, 0.000001), 0.0, 1.0)`};
float swvSm${c} = max(0.0, log2(max(swvSpacing * swvSc${c}.x * swvSp.z, 1.0)));
vec4 swvSa${c} = swFftTapLod(${fftTurnIn(c, "swvRest")} * swvSc${c}.x + swvSc${c}.yz, ${f(2 * c)}, swvSm${c});
swvH += swvSa${c}.y * swvSw${c};
swvD += ${fftTurnOut(c, `swvSa${c}.xz`)} * swvSw${c};`;
    return c === 0 ? code : ifFft(code, c + 1, FFT_VERTEX);
  }).join("");
  return `
vec4 swvSp = U.slateWaterFft;
float swvDist = max(abs((S.view * worldPos).z), 0.001);${cascades}
swvH = swvH * swvSp.x;
swvD = swvD * (swvSp.x * swvSp.y);`;
}

/**
 * Spectrum water's shared fragment stage (Realistic and Painted, `SLATE_WATER_SPECTRUM`), after FFT-Ocean: every cascade
 * at this fragment's rest point (the field is Lagrangian: detail rides the waves) through its mips. The slope comes from
 * the summed derivatives through the displaced surface's Jacobian (FFT-Ocean's (∂H/∂x / (1 + λ·∂Dx/∂x), …), with the
 * cross term), small cascades fading with eye distance as in the vertex stage. Foam is FFT-Ocean's: each cascade's
 * persistent turbulence (the Jacobian, recovering slowly after a fold) summed, a faded cascade counting as calm, and
 * foam covers where the sum falls below a bias (Crest Foam) — so whitecaps form on folding crests and trail off slowly.
 * Objects meeting the water and shallow shores add their own foam; Foam Amount scales all of it. Depth, absorption,
 * refraction, the soft shoreline and open-water edges follow the other looks.
 */
function spectrumSurfaceSource(): string {
  const cascades = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => {
    const code = `
vec4 swSc${c} = U.${FFT_CASCADE_UNIFORMS[c]};
vec2 swSu${c} = ${fftTurnIn(c, "swRest")} * swSc${c}.x + swSc${c}.yz;
vec4 swSa${c} = swSpecTap(swSu${c}, ${f(2 * c)});
vec4 swSb${c} = swSpecTap(swSu${c}, ${f(2 * c + 1)});
float swSt${c} = swFoamTap(swSu${c}, ${f(c)}).r;
float swSw${c} = ${c === 0 ? "1.0" : `clamp(swSp.w / max(swSc${c}.x * swEyeDist, 0.000001), 0.0, 1.0)`};
swSpGrad += ${fftTurnOut(c, `swSb${c}.xy`)} * swSw${c};
swSpJ += ${fftTurnTensor(c, `vec3(swSb${c}.z, swSa${c}.w, swSb${c}.w)`)} * swSw${c};
// Turbulence at this body's own scale (the foam pass takes it at Wave Scale 1); a faded cascade counts as calm.
swTurb += 1.0 + (swSt${c} - 1.0) * swSw${c} * swTurbScale;
swCascades += 1.0;${c === 0 ? `
swSpLarge = swSa0.y;` : `
swSpSmall += swSa${c}.y * swSw${c};`}`;
    return c === 0 ? code : ifFft(code, c + 1);
  }).join("");
  return `
vec2 swWorld = swPosW.xz;
float swTime = U.slateWaterMotion.x;
#ifdef ${WATER_BLEND_DEFINE}
float swBlendH = IN.vSlateWaterBlend.x;
float swBlendD = IN.vSlateWaterBlend.y;
#else
float swBlendH = 1.0;
float swBlendD = 1.0;
#endif
// Filtering footprint on the rest plane under this pixel's view ray (smooth across triangles).
float swEyeAbove = abs(S.vEyePosition.y - IN.vPositionW.y + IN.vSlateWater.x);
vec2 swRestXZ = viewDirectionW.xz * (swEyeAbove / max(abs(viewDirectionW.y), 0.001));
vec2 swFootX = dFdx(swRestXZ);
vec2 swFootY = dFdy(swRestXZ);
float swFoot = length(swFootX) + length(swFootY);
// Aerial perspective (\`slateWaterHaze\`), as every look: what scene fog leaves, plus a ramp to the far plane.
float swEyeDist = length(S.vEyePosition.xyz - IN.vPositionW);
#ifdef FOG
float swAirKeep = max(toLinearSpace(CalcFogFactor()), 0.0);
#else
float swAirKeep = 1.0;
#endif
float swAirOn = 1.0 - S.projection[3][3];
float swAir = 1.0 - (1.0 - (1.0 - exp(-swEyeDist * U.slateWaterHaze.x)) * swAirKeep * swAirOn) * (1.0 - smoothstep(U.slateWaterHaze.y, U.slateWaterHaze.z, swEyeDist) * swAirOn);
vec2 swFlowed = swWorld - IN.vSlateWaterFlow.xy * swTime;
// Rest (Lagrangian) point relative to the floating origin: the interpolated offset is exact on the displaced triangle.
vec2 swRest = IN.vPositionW.xz - IN.vSlateWaterFlow.zw;
vec3 swBaseNormal = normalize(IN.vSlateWaterBaseNormal);
float swBaseX = swBaseNormal.x / max(0.001, swBaseNormal.y);
float swBaseZ = swBaseNormal.z / max(0.001, swBaseNormal.y);
// Finite bodies fade the horizontal offset to zero at their banks (\`waterBankGain\`).
float swFadeLength = max(U.slateWaterSwellInfo.x * swBlendD, 0.000001);
float swFadeOn = step(0.000001, U.slateWaterSwellInfo.x * swBlendD);
float swBankT = clamp(IN.vSlateWater.y / swFadeLength, 0.0, 1.0);
float swGain = mix(1.0, swBankT * swBankT * (3.0 - 2.0 * swBankT), swFadeOn);
// The spectrum: (Wave Scale while ready, λ, grid size, LOD scale).
vec4 swSp = U.slateWaterFft;
float swTurbScale = swSp.x * swGain * swBlendD;
vec2 swSpGrad = vec2(0.0);
vec3 swSpJ = vec3(0.0);
float swSpLarge = 0.0;
float swSpSmall = 0.0;
float swTurb = 0.0;
float swCascades = 0.0;${cascades}
swSpGrad = swSpGrad * (swSp.x * swBlendH);
swSpJ = swSpJ * (swSp.x * swSp.y * swGain * swBlendD);
float swJxx = 1.0 + swSpJ.x;
float swJxz = swSpJ.y;
float swJzz = 1.0 + swSpJ.z;
float swDetJ = swJxx * swJzz - swJxz * swJxz;
// Where the surface folds the determinant nears zero; a floor keeps those crests' normals from spiking into sparks.
vec2 swSlope = vec2(swJzz * swSpGrad.x - swJxz * swSpGrad.y, swJxx * swSpGrad.y - swJxz * swSpGrad.x) / max(swDetJ, 0.35);
normalW = normalize(vec3(swBaseX - swSlope.x, 1.0, swBaseZ - swSlope.y));
vec3 swWaveN = normalW;
// Height of the small cascades over the large one (metres): FFT-Ocean lights the crests of the small waves riding the swell.
float swSpCrest = (0.2 * swSpLarge + swSpSmall) * swSp.x * swBlendH;

// What meets the water: terrain shoreline and true depth, and objects crossing the surface.
float swFieldShore = mix(${f(SHORE[1])}, swTerrainShore, swFieldOn);
float swKnown = swField.a * swFieldOn;
float swObject = abs(swContactSigned);
// Open-water edges fade out (an ocean's outer edge, a lake drawn smaller than its basin) instead of foaming.
float swOpenEdge = U.slateWaterFieldInfo.x * (1.0 - smoothstep(0.0, 0.1, swField.a * swFieldOn));
float swOpenAny = max(swOpenEdge, swKnown * smoothstep(0.5, 2.5, swFieldShore - max(0.0, IN.vSlateWater.y)));
float swOpenW = mix(${f(OPEN_EDGE_FADE_TERRAIN)}, ${f(OPEN_EDGE_FADE)}, swOpenEdge);
float swBankV = mix(IN.vSlateWater.y, max(IN.vSlateWater.y, ${f(SHORE[1])}), swOpenAny);
float swOpenFade = mix(1.0, smoothstep(0.0, swOpenW, IN.vSlateWater.y), swOpenAny);
// Soft waterline over known terrain: the water thins out over its last few centimetres (crisp at walls and cliffs).
float swShoreSoft = mix(1.0, smoothstep(0.0, mix(${f(SOFT_SHORE_DEPTH)}, 0.06, smoothstep(0.35, 1.0, swShoreSlope)), swTerrainDepth), swKnown);
float swBank = min(min(max(0.0, swBankV), max(0.0, swFieldShore)), ${f(SHORE[1])});
float swBodyDepth = max(0.01, IN.vSlateWater.z);
// Bottom estimate: a shelving bank capped by the component Depth, or the terrain where it is known.
float swDepth = mix(swBodyDepth * (1.0 - exp(-swBank * 0.35 / swBodyDepth)), max(0.0, swTerrainDepth), swKnown);
float swEdgeFade = smoothstep(0.0, 0.2, swBank + 0.02) * swShoreSoft;
// Refraction bends by the wave slope (\`refractionSource\` reads these names).
vec2 swGradient = swSlope;
vec2 swDetailMid = vec2(0.0);
float swChopGain = 0.0;${refractionSource(0.55)}
float swAbsorb = max(0.01, U.slateWaterLook.y);

// Foam. Crests: FFT-Ocean's bias of n − 1 cascades plus Crest Foam's threshold, over the summed turbulence.
float swFoamAmount = U.slateWaterFoam.w;
float swCrestBias = swCascades - 1.0 + mix(0.55, 1.0, U.slateWaterShape.z);
float swCrestRaw = (swCrestBias - swTurb) * ${f(SPECTRUM_FOAM_SCALE)};
// Fine bubbly breakup drifting with the water, faded before it would alias.
float swFoamNoise = mix(0.5, swNoise(swFlowed * 0.9 + vec2(swTime * 0.05, 0.0)) * 0.65 + swNoise(swFlowed * 3.1 - vec2(0.0, swTime * 0.08)) * 0.35, 1.0 - smoothstep(0.15, 0.6, swFoot));
float swCrestFoam = clamp(swCrestRaw + (swFoamNoise - 0.5) * 0.25, 0.0, 1.0) * clamp(swFoamAmount * 1.6, 0.0, 1.0);
// Surface Foam: thin lingering residue where turbulence is still recovering behind the caps.
float swResidue = clamp((swCrestBias + 0.35 - swTurb) * 1.5, 0.0, 1.0) * smoothstep(0.45, 0.75, swFoamNoise) * U.slateWaterSunColor.w * 0.6;
// Contacts: a collar at every object's waterline that frays outward, and shallow shores churn white.
float swContactStrength = U.slateWaterTerms.x;
float swContactW = max(0.05, U.slateWaterShape.w);
float swCollar = (1.0 - smoothstep(0.0, swContactW, swObject)) * (0.65 + 0.35 * swFoamNoise);
swCollar = max(swCollar, (1.0 - smoothstep(swContactW, swContactW * 2.5, swObject)) * smoothstep(0.55, 0.7, swFoamNoise));
float swShoreFoam = swKnown * (1.0 - smoothstep(0.0, U.slateWaterMotion.w * 0.35 + 0.08, swTerrainDepth)) * (1.0 - swOpenAny) * (0.6 + 0.4 * swFoamNoise);
float swFoam = clamp(max(max(swCrestFoam, swResidue), max(swCollar, swShoreFoam) * swContactStrength), 0.0, 1.0);
`;
}

/**
 * Realistic spectrum water, after FFT-Ocean's material: lit PBR (unlit at Low) whose body is Deep Color emitted through
 * (1 − Fresnel) with FFT-Ocean's subsurface light (Shallow Color, Subsurface) on the crests of the small waves seen toward
 * the sun, Schlick reflection of the environment (or the analytic scene sky) at the facet's own Fresnel, glossy close by
 * and rougher with distance (FFT-Ocean's distance gloss, from Roughness), and white foam lit as rough albedo. Shallow
 * water transmits what lies below through per-channel absorption (Shallow Color, Depth Color Distance), refracted with
 * the scene copy. Everything is premultiplied by coverage (see CUSTOM_FRAGMENT_BEFORE_FOG).
 */
function spectrumRealisticSource(): string {
  return spectrumSurfaceSource() + `
vec3 swV = viewDirectionW;
vec3 swL = U.slateWaterSun.xyz;
vec3 swSun = U.slateWaterSunColor.rgb * U.slateWaterSun.w;
vec3 swAmb = U.slateWaterLight.rgb;
float swGraze = 1.0 - clamp(swV.y, 0.0, 1.0);
// Toward the horizon the far sea becomes a level mirror of the horizon sky and melts into it.
float swHaze = 1.0 - (1.0 - swAir * smoothstep(0.3, 0.85, swGraze)) * (1.0 - smoothstep(0.98, 0.9985, swGraze));
normalW = normalize(mix(normalW, swBaseNormal, swHaze * swHaze));
swSharp = 1.0;
#if ${SAMPLES_COPY}
vec3 swHorC = vec3(0.0);
float swHorW = 0.0;
#endif
// FFT-Ocean's Fresnel on the facet normal.
vec3 swFresN = normalW;
float swNdotV = clamp(dot(swFresN, swV), 0.0, 1.0);
float swFx = 1.0 - swNdotV;
float swFres = mix(0.02 + 0.98 * swFx * swFx * swFx * swFx * swFx, 1.0, swHaze);
// Distance gloss: near water is as smooth as Roughness, far water as rough as FFT-Ocean's 0.31 (normal detail its mips
// average away), plus the shading normal's own variation across the pixel (specular antialiasing).
float swRoughNear = U.slateWaterOrigin.w;
float swRoughFar = max(swRoughNear, 0.31);
float swRoughD = mix(swRoughFar, swRoughNear, 1.0 / (1.0 + swEyeDist * 0.0044));
vec2 swShadeSlope = normalW.xz / max(normalW.y, 0.1);
vec2 swShadeDx = dFdx(swShadeSlope);
vec2 swShadeDy = dFdy(swShadeSlope);
float swShadeVar = min((dot(swShadeDx, swShadeDx) + dot(swShadeDy, swShadeDy)) * ${f(PIXEL_SLOPE_FILTER / 2)}, ${f(PIXEL_SLOPE_CAP)});
swSlopeVariance = (max(swRoughD * swRoughD * swRoughD * swRoughD - swRoughNear * swRoughNear * swRoughNear * swRoughNear, 0.0) * 0.5 + swShadeVar) * (1.0 - 0.97 * swHaze);
// Reflected rays stay above the horizon (a smooth floor), so the water never mirrors more water; the shading normal
// becomes the half vector toward that ray, so the environment lookup follows it, while the Fresnel stays the facet's.
vec3 swRefl = reflect(-swV, normalW);
float swReflRawY = swRefl.y;
float swLiftA = 60.0 * (0.03 - swRefl.y);
swRefl.y = mix(swRefl.y, swRefl.y + (max(swLiftA, 0.0) + log(1.0 + exp(-abs(swLiftA)))) / 60.0, step(0.0, swV.y));
normalW = normalize(swV + normalize(swRefl));
// Body: Deep Color, lit by the scene (a dim scene keeps a dim sea), with FFT-Ocean's subsurface light on the crests of
// the small waves (their height over the swell) seen toward the sun.
vec3 swLumW = vec3(0.3, 0.59, 0.11);
float swBodyLight = clamp(dot(swAmb, swLumW) * 1.4 + dot(swSun, swLumW) * max(swL.y, 0.0) * 0.35, 0.05, 1.6);
vec3 swSssH = normalize(swWaveN + swL);
float swSssV = clamp(dot(swV, swSssH), 0.0, 1.0);
float swSssBack = clamp(dot(-swV, normalize(swL + swWaveN * 0.4)), 0.0, 1.0);
float swSss = (swSssV * swSssV * swSssV * swSssV * swSssV * 30.0 + swSssBack * swSssBack * swSssBack * 6.0) * 0.15 * U.slateWaterLook.w;
float swCrestLift = max(swSpCrest / max(U.slateWaterWaves.x * 0.5, 0.05) + 0.26, 0.0) / 4.7;
vec3 swBody = mix(U.slateWaterDeep.rgb, clamp(U.slateWaterDeep.rgb + U.slateWaterShallow.rgb * (swSss * swCrestLift), vec3(0.0), vec3(1.0)), clamp(swSp.x, 0.0, 1.0)) * swBodyLight;
// Shallow water: what lies below shows through per-channel absorption (Depth Color Distance; red goes first).
float swCosT = sqrt(1.0 - (1.0 - swNdotV * swNdotV) * 0.5625);
float swPath = swDepth * (1.0 + 1.0 / swCosT) / (swAbsorb * 5.0);
float swVisible = 1.0 - smoothstep(0.35, 0.85, swDepth / swAbsorb);
vec3 swTransmitRgb = exp(-min(swPath, U.slateWaterThrough.w) * U.slateWaterAbsorb.rgb - vec3(swPath * ${f(TURBIDITY)})) * swVisible;${ifDefined(REFRACTION, `
// No geometry behind the water in the copy (its sky depth): open water transmits nothing.
swTransmitRgb *= 1.0 - step(${f(WATER_SCENE_COPY_SKY_DEPTH * 0.9)}, swSceneZ);
swRefracts = smoothstep(-0.03, 0.03 + swWaterZ * 0.004, swSceneZ - swWaterZ);`)}
float swTransmit = dot(swTransmitRgb, swLumW);
#ifndef REFLECTION
// No environment or skybox: the analytic sky of the scene (zenith to horizon, warmed around a low sun), blurred by roughness.
vec3 swSkyDir = normalize(swRefl);
float swSkyH = 1.0 - clamp(swSkyDir.y, 0.0, 1.0);
swSkyH = swSkyH * swSkyH * swSkyH;
vec3 swSkyRefl = mix(U.slateWaterSky.rgb, U.slateWaterHorizon.rgb, swSkyH);
float swSkyAz = clamp(dot(swSkyDir.xz / max(length(swSkyDir.xz), 0.0001), U.slateWaterSunShape.xy), 0.0, 1.0);
swSkyAz *= swSkyAz;
float swAura = max(dot(swSkyDir, swL), 0.0);
swAura *= swAura;
swAura *= swAura;
swAura *= swAura;
swSkyRefl += swSun * (U.slateWaterSunColor.rgb * (swSkyH * U.slateWaterSunShape.z * (0.25 + 0.35 * swSkyAz)) + vec3(swAura * 0.05));
swSkyRefl = mix(swSkyRefl, mix(U.slateWaterSky.rgb, U.slateWaterHorizon.rgb, 0.55), smoothstep(0.05, 0.35, sqrt(swSlopeVariance)) * 0.5);
swSkyRefl *= U.slateWaterDeep.w;
#endif
// Foam is a rough white scatterer that hides the mirror: a little albedo for the scene's lights, and most of its light
// from the sky and sun here, so it is never darker than the horizon it stands against (a weak sun left it grey-brown).
float swFoamEdge = smoothstep(0.0, 0.2, swBank + 0.02);
float swGloss = (1.0 - swFoam) * swEdgeFade;
swMatte = swFoam;
float swFoamCover = swFoam * swFoamEdge;
surfaceAlbedo = U.slateWaterFoam.rgb * (swFoamCover * 0.35);
normalW = normalize(mix(normalW, swFresN, swFoam));
vec3 swFoamLight = max(swAmb * 0.9 + swSun * (0.25 + 0.4 * max(dot(swWaveN, swL), 0.0)), U.slateWaterHorizon.rgb * 1.05);
vec3 swEmissive = swBody * (vec3(1.0) - swTransmitRgb) * ((1.0 - swFres) * (1.0 - swFoam) * swEdgeFade)
  + U.slateWaterFoam.rgb * swFoamLight * swFoamCover;${fromTier(1, "", `
// Low draws unlit: the sun's highlight and the foam's light come from here.
vec3 swLowH = normalize(swL + swV);
float swLowSpec = pow(max(dot(swFresN, swLowH), 0.0), 220.0) * 6.0;
swEmissive += swSun * (swLowSpec * swGloss);`)}
float swSunReach = 1.0;
float swSpecKeep = 1.0;
float swSpecSquash = 0.15;
float swSpecMod = 1.0;
float swSpecModW = 0.0;
float swWaterA = (1.0 - (1.0 - swFres) * swTransmit) * swEdgeFade;
alpha = 1.0 - (1.0 - swWaterA) * (1.0 - swFoam * swFoamEdge);${ifDefined(REFRACTION, `
// The refracted scene replaces the blended background: the copy behind this point through the absorption.
vec3 swRefracted = swBackground * swTransmitRgb * ((1.0 - swFres) * (1.0 - swFoam) * swEdgeFade * swRefracts);
float swRefractedWeight = (1.0 - swFres) * swTransmit * (1.0 - swFoam) * swEdgeFade * swRefracts;
alpha = mix(alpha, max(alpha, swEdgeFade), swRefracts);`)}
${objectReflectionSource("normalize(swRefl)", "sqrt(sqrt(U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w + 2.0 * swSlopeVariance))")}
#if ${REFLECTS_OBJECTS}
swObjRefl.a *= smoothstep(-0.01, 0.03, swReflRawY) * (1.0 - smoothstep(12.0, 48.0, length(fwidth(swReflRay)) / max(length(fwidth(swV)), 0.00001)));
#endif
`;
}

/**
 * Painted spectrum water (Stylized Painted, unlit): the same FFT-Ocean waves, normals and foam, painted in the spirit
 * of Sea of Thieves. The body runs from Deep Color in the troughs to a lighter mix toward Shallow Color on the crests,
 * lit by a soft two-step wrap of the sun over the ambient light; crests seen toward the sun glow with Shallow Color
 * (Subsurface, stronger and more saturated than Realistic's); the sky is a soft painted gradient by a gentle Fresnel; the
 * sun is a crisp glint; foam is clean opaque paint with soft broken edges. Shallows show what lies below, tinted toward
 * Shallow Color; far water takes the horizon's colour.
 */
function spectrumPaintedSource(): string {
  return spectrumSurfaceSource() + `
vec3 swV = viewDirectionW;
vec3 swL = U.slateWaterSun.xyz;
vec3 swSunC = U.slateWaterSunColor.rgb * min(U.slateWaterSun.w, 2.5);
vec3 swAmb = U.slateWaterLight.rgb;
vec3 swLumW = vec3(0.3, 0.59, 0.11);
float swGraze = 1.0 - clamp(swV.y, 0.0, 1.0);
// Far away the painted waves calm toward the base normal (no shimmer) and the colour takes the horizon's.
float swPaintFar = smoothstep(0.4, 2.5, swFoot);
vec3 swN = normalize(mix(normalW, swBaseNormal, swPaintFar * 0.6));
// Scene brightness (about 1 in daylight), so a dim scene keeps a dim sea while the palette stays the asset's own.
float swSceneK = clamp(dot(swAmb, swLumW) * 1.1 + dot(swSunC, swLumW) * max(swL.y, 0.0) * 0.45, 0.12, 1.4);
// Soft two-step wrap lighting of the wave toward the sun.
// Each step's edge is antialiased over about a pixel and a half of its own change, so bands stay crisp but never alias.
// The key light is flattened toward the horizon for the banding, so gentle slopes under a high sun still read as faces.
vec3 swKeyL = normalize(vec3(swL.x, max(swL.y, 0.0) * 0.3 + 0.05, swL.z));
float swWrap = dot(swN, swKeyL) * 0.5 + 0.5;
float swWrapAA = fwidth(swWrap) * 0.75 + 0.012;
float swBand = smoothstep(0.5 - swWrapAA, 0.5 + swWrapAA, swWrap) * 0.5 + smoothstep(0.7 - swWrapAA, 0.7 + swWrapAA, swWrap) * 0.5;
vec3 swLight = mix(vec3(1.0), U.slateWaterSunColor.rgb, 0.35) * (swSceneK * mix(0.58, 1.15, swBand));
// Troughs to crests: Deep Color in the troughs rising toward Shallow Color on the tops of the waves.
float swHeightT = clamp(0.5 + (swSpLarge + swSpSmall) * swSp.x * swBlendH / max(U.slateWaterWaves.x * 2.0, 0.05), 0.0, 1.0);
vec3 swDeepC = U.slateWaterDeep.rgb;
vec3 swShallowC = U.slateWaterShallow.rgb;
// The small waves' crests (their height over the swell) light up as well as the swell's tops, so every wave shape reads.
float swSmallT = clamp(swSpCrest / max(U.slateWaterWaves.x * 0.6, 0.05), 0.0, 1.0);
vec3 swBodyC = mix(swDeepC, mix(swDeepC, swShallowC, 0.6), clamp(smoothstep(0.35, 0.95, swHeightT) * 0.6 + smoothstep(0.05, 0.7, swSmallT) * 0.55, 0.0, 1.0));
vec3 swLit = swBodyC * swLight * 1.7;
// Subsurface glow through crests toward the sun (FFT-Ocean's term and a backlit one), on the small waves' crests:
// Painted's signature luminous teal.
vec3 swSssH = normalize(swWaveN + swL);
float swSssV = clamp(dot(swV, swSssH), 0.0, 1.0);
float swSssBack = clamp(dot(-swV, normalize(swL + swWaveN * 0.6)), 0.0, 1.0);
float swCrestLift = clamp(0.3 + swSpCrest / max(U.slateWaterWaves.x * 0.5, 0.05), 0.0, 1.6);
float swGlowAmt = (swSssV * swSssV * swSssV * 1.6 + swSssBack * swSssBack * 1.4) * swCrestLift * U.slateWaterLook.w * clamp(swSp.x, 0.0, 1.0);
swLit += swShallowC * (swSceneK * swGlowAmt * 0.55 * (1.0 - swPaintFar));
// Shallows: what lies below shows through, tinted toward Shallow Color; deep water keeps its painted body.
float swNdotV = clamp(dot(swN, swV), 0.0, 1.0);
float swPath = swDepth * 2.0 / swAbsorb;
vec3 swTransRgb = exp(-swPath * U.slateWaterAbsorb.rgb) * (1.0 - smoothstep(0.5, 1.0, swDepth / swAbsorb));${ifDefined(REFRACTION, `
swTransRgb *= 1.0 - step(${f(WATER_SCENE_COPY_SKY_DEPTH * 0.9)}, swSceneZ);
swRefracts = smoothstep(-0.03, 0.03 + swWaterZ * 0.004, swSceneZ - swWaterZ);`)}
float swTrans = dot(swTransRgb, swLumW);
swLit = mix(swLit, swShallowC * swLight * 1.5, (1.0 - smoothstep(0.0, swAbsorb * 0.6, swDepth)) * 0.55);
// Painted sky by a gentle Fresnel: the horizon colour low, a deeper sky above.
vec3 swRefl = reflect(-swV, swN);
swRefl.y = max(swRefl.y, 0.02);
float swSkyT = clamp(swRefl.y * 1.6, 0.0, 1.0);
vec3 swSky = mix(U.slateWaterHorizon.rgb, mix(U.slateWaterHorizon.rgb, U.slateWaterSky.rgb, 0.7), swSkyT);
float swFx = 1.0 - swNdotV;
// The reflection steps softly, as painted bands of sky on the faces tilted away from the eye.
float swReflRaw = 0.03 + 0.6 * swFx * swFx * swFx;
float swReflAA = fwidth(swReflRaw) * 0.75 + 0.005;
float swReflStep = 0.04 + 0.16 * smoothstep(0.1 - swReflAA, 0.1 + swReflAA, swReflRaw) + 0.25 * smoothstep(0.3 - swReflAA, 0.3 + swReflAA, swReflRaw);
float swReflAmt = clamp(mix(swReflRaw, swReflStep, 0.65) * U.slateWaterDeep.w, 0.0, 1.0);
// The sun: a crisp glint, and a soft sheen around it.
float swRL = max(dot(swRefl, swL), 0.0);
float swGlint = smoothstep(0.9975, 0.9992, swRL) * (1.0 - swPaintFar * 0.6);
float swSheen = pow(swRL, 90.0) * 0.35 + pow(swRL, 12.0) * 0.12;
vec3 swSpec = swSunC * ((swGlint * 2.2 + swSheen) * step(0.0, swL.y));
vec3 swPremul = swLit * ((1.0 - swReflAmt) * (1.0 - swTrans)) + swSky * swReflAmt + swSpec * (1.0 - swFoam);
float swCover = 1.0 - (1.0 - swReflAmt) * swTrans;
alpha = clamp(max(swCover, min(dot(swSpec, swLumW) * (1.0 - swFoam), 1.0)), 0.001, 1.0);
vec3 swEmissive = swPremul / alpha;
// Aerial perspective: far water takes the painted horizon, opaque, and its foam thins.
float swPaintHaze = 1.0 - (1.0 - swAir * smoothstep(0.3, 0.85, swGraze)) * (1.0 - smoothstep(0.98, 0.9985, swGraze));
swEmissive = mix(swEmissive, U.slateWaterHorizon.rgb, swPaintHaze);
alpha = mix(alpha, 1.0, swPaintHaze);
// Foam: clean paint with softly broken edges, lit by the sun's wrap: the caps, and thin lines along the tops of the
// crests where the turbulence starts to dip (Crest Foam), which draw the wave shapes as Painted's line work.
float swCrestSignal = ((swCrestBias + 0.28 - swTurb) * 2.5 + (swFoamNoise - 0.5) * 0.5) * smoothstep(0.5, 0.8, swHeightT + swSmallT * 0.3);
float swCrestAA = fwidth(swCrestSignal) * 0.75 + 0.02;
float swFoamGate = clamp(swFoamAmount * 1.6, 0.0, 1.0) * (1.0 - swPaintFar);
// A solid cap, and a thin ring of lace a little way outside it.
float swCrestLine = smoothstep(0.55 - swCrestAA, 0.55 + swCrestAA, swCrestSignal);
float swCrestLace = (smoothstep(0.22 - swCrestAA, 0.22 + swCrestAA, swCrestSignal) - smoothstep(0.32 - swCrestAA, 0.32 + swCrestAA, swCrestSignal)) * smoothstep(0.35, 0.6, swFoamNoise);
float swFoamPaint = max(smoothstep(0.55, 0.8, swFoam + (swFoamNoise - 0.5) * 0.3), max(swCrestLine * 0.9, swCrestLace * 0.6) * swFoamGate) * (1.0 - 0.7 * swPaintHaze);
vec3 swFoamC = U.slateWaterFoam.rgb * max(swSceneK * 1.25, dot(U.slateWaterHorizon.rgb, swLumW) * 1.2) * mix(0.82, 1.08, swBand) * mix(vec3(1.0), U.slateWaterSunColor.rgb, 0.25);
swFoamC = mix(swFoamC * vec3(0.84, 0.92, 1.0), swFoamC, 0.4 + 0.6 * swBand);
swEmissive = mix(swEmissive, swFoamC, swFoamPaint);
alpha = max(alpha, swFoamPaint) * swEdgeFade;
surfaceAlbedo = vec3(0.0);
${objectReflectionSource("swRefl", "U.slateWaterOrigin.w")}
#if ${REFLECTS_OBJECTS}
// Reflected objects replace the sky by its Fresnel weight, never over foam.
float swReflWeight = clamp(swObjRefl.a * swReflAmt * (1.0 - swFoamPaint), 0.0, 1.0);
swEmissive = mix(swEmissive, swObjRefl.rgb, swReflWeight);
alpha = max(alpha, swReflWeight);
#endif${ifDefined(REFRACTION, `
// With the copy the water is opaque and adds what lies below through the transmittance, outside reflection and foam.
swRefracts *= 1.0 - swPaintHaze;
vec3 swRefracted = swBackground * swTransRgb * ((1.0 - swReflAmt) * (1.0 - swFoamPaint) * swRefracts);
float swRefractedWeight = (1.0 - alpha) * swRefracts;
swEmissive = swEmissive * mix(1.0, alpha, swRefracts);
alpha = mix(alpha, 1.0, swRefracts);`)}
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
 * and count (taps behind objects drop out): two taps, two more from High. `swHorLocal` / `swHorHave` read three more
 * taps (five from High) around this pixel's azimuth only where `local` (a GLSL condition) holds: the looks weight them
 * in only within about a degree of the horizon, so most of the water skips those reads.
 */
function horizonCopySource(local: string): string {
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
swHorN += ${skyHit("swHorT2")} + ${skyHit("swHorT3")};`)}
vec3 swHorAvg = swHorSum / max(swHorN, 0.001);
// The sky's colour at the horizon below this pixel: a horizontal average of the row just above the horizon (taps behind
// geometry drop out), damped by the fixed-point average so the clouds' texture never streaks across columns. \`swHorHave\`
// is 0 where no tap read sky (the average is then empty too). Read only where the look uses it (\`local\`, the last
// degree or so above the horizon); elsewhere it keeps the fixed-point average, which carries no weight there.
vec3 swHorLocal = swHorAvg;
float swHorHave = min(swHorN, 1.0);
if (${local}) {
  vec2 swHorAz = -viewDirectionW.xz / max(length(viewDirectionW.xz), 0.0001);
  vec4 swHorLC = S.viewProjection * vec4(swHorAz.x, 0.004, swHorAz.y, 0.0);
  vec2 swHorUv = clamp(swHorLC.xy / max(swHorLC.w, 0.0001) * 0.5 + 0.5, vec2(0.002), vec2(0.998));
  vec4 swHorL0 = swSceneTexel(vec2(clamp(swHorUv.x - 0.035, 0.002, 0.998), swHorUv.y));
  vec4 swHorL1 = swSceneTexel(swHorUv);
  vec4 swHorL2 = swSceneTexel(vec2(clamp(swHorUv.x + 0.035, 0.002, 0.998), swHorUv.y));
  vec3 swLocSum = swHorL0.rgb * ${skyHit("swHorL0")} + swHorL1.rgb * ${skyHit("swHorL1")} + swHorL2.rgb * ${skyHit("swHorL2")};
  float swLocN = ${skyHit("swHorL0")} + ${skyHit("swHorL1")} + ${skyHit("swHorL2")};${fromTier(2, `
  vec4 swHorL3 = swSceneTexel(vec2(clamp(swHorUv.x - 0.07, 0.002, 0.998), swHorUv.y));
  vec4 swHorL4 = swSceneTexel(vec2(clamp(swHorUv.x + 0.07, 0.002, 0.998), swHorUv.y));
  swLocSum += swHorL3.rgb * ${skyHit("swHorL3")} + swHorL4.rgb * ${skyHit("swHorL4")};
  swLocN += ${skyHit("swHorL3")} + ${skyHit("swHorL4")};`)}
  float swLocK = min(swLocN, 1.0) * step(0.0001, swHorLC.w) * step(abs(swHorUv.y - 0.5), 0.49);
  swHorLocal = mix(swHorAvg, swLocSum / max(swLocN, 0.001), swLocK * mix(1.0, 0.5, min(swHorN, 1.0)));
  swHorHave = max(swHorHave, swLocK);
}`;
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
  return surfaceSource() + `
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
// The primary swell's height (-1 trough to 1 crest) and the large noise bend the band edges, so a bed's straight contours
// never read as a box around an island and the deep tone settles into the swell's troughs as smooth, rounded shapes
// running along the waves (the medium and fine noises stay out: their edges read as stains). Only the edge into deep
// water bends (by at most about three quarters of a band), so gentle shallows keep wide, clean bands rather than
// breaking into pools, and open water (at least about a band deeper) never shoals.
float swPrimN = swPrimH / max(swPrimAmp, 0.0001);${fromTier(1, `
// A noise along each crest (about fourteen metres across), in a frame that travels with the swell (the primary phase counts
// whole crests, so the pattern never jumps as the clock wraps), gates where the swell bends the edge, so the deep water's
// tongues break into rounded lobes about as long as they are wide instead of running the whole crest as fingers.
float swBandPh = swP0 * 0.159155 + U.slateWaterLight.w;
swBandPh -= ${f(CREST_COUNT_PERIOD)} * floor(swBandPh / ${f(CREST_COUNT_PERIOD)});
float swBandAlong = smoothstep(0.2, 0.8, swNoise(vec2(dot(swFlowed, vec2(-swD0.y, swD0.x)) * 0.07, swBandPh) + vec2(4.1, 8.3)));`, `
float swBandAlong = 0.5;`)}
float swBandRaw = swBedTone * swBandCount;
float swBandWarp = ((swLarge - 0.5) * 0.6 - swPrimN * (0.04 + 0.26 * swBandAlong)) * step(1.5, swBandCount)
  * smoothstep(swBandCount - 1.8, swBandCount - 1.3, swBandRaw);
float swBand = max(swBandRaw + swBandWarp, 0.0);
float swBandAA = min(fwidth(swBand), 0.5);
float swBandF = fract(swBand);
float swBanded = min((floor(swBand) + smoothstep(1.0 - swBandAA * 1.5, 1.0, swBandF)) / max(swBandCount - 1.0, 1.0), 1.0);${fromTier(1, `
// From Medium each band edge carries a thin, slightly lighter rim (Wind Waker's band outline), about a pixel and a half
// wide close up and culled with the footprint. Only the edge into the deepest band carries one, and not near the shore,
// where foam and surf lines dominate and a pale hairline across the shallows would read as a scratch.
float swBandPx = min(swBandF, 1.0 - swBandF) / max(fwidth(swBand), 0.00001);
float swRimHalf = 1.5 * (1.0 - smoothstep(0.3, 1.2, swFoot));
float swBandRim = (1.0 - smoothstep(swRimHalf - 0.6, swRimHalf + 0.6, swBandPx)) * smoothstep(0.3, 0.8, swRimHalf)
  * step(1.5, swBandCount) * step(max(1.0, swBandCount - 1.0), swBand) * (1.0 - step(swBandCount - 0.5, swBand))
  * smoothstep(swFoamWidth * 4.0, swFoamWidth * 8.0, swShoreRest);`)}
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
${fromTier(1, `
swLit = mix(swLit, swLit * 1.15 + swShallowC * (0.18 * swExpo), swBandRim);`)}
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
// The mid-field (past a few metres from the eye) keeps fewer strokes, about half the dapples and fewer flecks than the
// near water (Medium up).${fromTier(1, `
float swMidField = smoothstep(0.1, 0.5, swFoot);`, `
float swMidField = 0.0;`)}
// The crest's index counts whole periods of the component's world phase: the CPU reduces the phase uniform mod 2π (it
// wraps once a period as time runs) and passes how many periods it removed (\`slateWaterLight.w\`, mod
// \`CREST_COUNT_PERIOD\`), so a crest keeps its index, and its dashes, for as long as it travels. (Without the count
// every crest took the next one's pattern each time the phase wrapped, about every two seconds.)
float swCrestId = floor((swP0 + 1.570796) * 0.159155) + U.slateWaterLight.w;
swCrestId -= ${f(CREST_COUNT_PERIOD)} * floor(swCrestId / ${f(CREST_COUNT_PERIOD)});
vec2 swCrestSeed = swHash2(vec2(swCrestId, 17.0));
float swCrestAlong = dot(swFlowed, vec2(-swD0.y, swD0.x));
vec2 swCrestUv = vec2(swCrestAlong + swCrestSeed.x * 37.0, swCrestSeed.y * 13.0);
float swLineN = swNoise(swCrestUv * vec2(0.34, 1.0) + vec2(2.9, 5.3));${fromTier(1, `
float swLineWig = swNoise(swCrestUv * vec2(0.17, 1.0) + vec2(7.3, 1.1));`, `
float swLineWig = swLineN;`)}
// Each line meanders: its height is bent by the primary swell's slope across the crest (the cosine of its phase) times a
// slow noise along the crest, which slides the line sideways by up to about a tenth of a wavelength (more where the slope is
// steep, so the shift is the same in metres on every flank and dies away at the flat crest and trough), and a faster one a
// little. Without it the isolines of a single swell train run as straight, parallel speed lines.
float swLineSlope = swC0;
${fromTier(1, `
// Far out the meander (a few pixels at most there) fades, so a grazing line never breaks into aliased steps.
float swLineBend = ((swLineWig - 0.5) * 1.2 + (swLineN - 0.5) * 0.35) * (1.0 - 0.7 * smoothstep(0.08, 0.4, swFoot));`, `
float swLineBend = (swLineN - 0.5) * 0.7;`)}
float swLineH = swPrimN - swLineSlope * swLineBend;
// The flank line stands on one face of each crest (where the swell's slope across it is negative), the top and trough lines
// on the other, so a crest never draws a closed racetrack of parallel lines, which read as a ring from a grazing view.
float swLineSide = smoothstep(-0.1, 0.1, swLineSlope);
float swLineFw = max(fwidth(swLineH), 0.00001);
float swLineDash = swLineN * 0.65 + swLineWig * 0.35;
float swLineDashT = swNoise(swCrestUv * vec2(0.34, 1.0) + vec2(11.7, 2.3)) * 0.65 + swLineWig * 0.35;
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
// Beyond the near field the crest lines are also broken into short strokes along the crest, each cell of about a metre
// (its size and phase seeded by the crest, bent by the slow noise) holding a stroke of its own length at its own place or,
// for about two cells in five, none, so neighbouring lines never share a rhythm (evenly spaced, equal dashes in parallel
// rows read as road markings). Low (no budget for the breaks) simply thins its lines out sooner.${fromTier(1, `
float swLineT = swCrestAlong * (0.8 + 0.5 * swCrestSeed.y) + (swLineWig - 0.5) * 6.0 + swCrestSeed.x * 31.0;
float swLineCell = floor(swLineT);
vec2 swLineH2 = swHash2(vec2(swLineCell, swCrestId + 3.0));
float swLineLen = 0.3 + 0.45 * swLineH2.y;
float swLineStart = (1.0 - swLineLen) * fract(swLineH2.x * 7.13);
float swLineF = fract(swLineT);
float swLineIn = smoothstep(swLineStart - 0.06, swLineStart + 0.06, swLineF) * (1.0 - smoothstep(swLineStart + swLineLen - 0.06, swLineStart + swLineLen + 0.06, swLineF)) * step(0.4, swLineH2.x);
float swLineFar = 1.2 * smoothstep(0.05, 0.12, swFoot) * (1.0 - swLineIn) + 0.5 * smoothstep(0.05, 0.4, swFoot);`, `
float swLineFar = 0.9 * smoothstep(0.05, 0.4, swFoot);`)}
float swLineCut = 0.5 + 0.3 * smoothstep(0.05, 0.1, swLineFw) + swLineFar + 0.6 * smoothstep(10.0, 22.0, swLinePx) + 0.8 * swColQuiet + 0.6 * swLineFlat;
// Brush strokes: each dash swells from about a third of its width at its ends to its full width (about two to four
// pixels); dashes too short to swell past half their width are dropped, so none shrinks to a speck.
float swLineTaper = clamp((swLineDash - swLineCut) * 9.0, 0.0, 1.0);
float swLineHalf = mix(1.0, 1.9, swNearFoamL) * (0.35 + 0.65 * swLineTaper);
// Isolines on each crest's flanks and near its top, and from Medium on its trough side. The one near the top closes
// round each crest, so it keeps only its longer dashes, and only where it runs along the crest (its height's gradient
// along the dominant heading): arcs, never whole rings.
float swLineLv0 = 0.18 + 0.06 * sin(swCrestAlong * 0.37 + swCrestSeed.x * 6.283);
float swLineLvT = 0.5 + 0.06 * sin(swCrestAlong * 0.29 + swCrestSeed.y * 6.283);
float swLines = (1.0 - smoothstep(swLineHalf - 0.6, swLineHalf + 0.6, abs(swLineH - swLineLv0) / swLineFw)) * smoothstep(0.25, 0.45, swLineTaper) * (1.0 - swLineSide);
float swLineTopTaper = clamp((swLineDashT - swLineCut - 0.1 - 0.3 * swLowSea) * 9.0, 0.0, 1.0);
float swLineAlongCrest = smoothstep(0.35, 0.65, abs(dot(swGradient, swD0)) / max(length(swGradient), 0.000001));
swLines = max(swLines, (1.0 - smoothstep(swLineHalf * 0.75 - 0.6, swLineHalf * 0.75 + 0.6, abs(swLineH - swLineLvT) / swLineFw)) * smoothstep(0.25, 0.45, swLineTopTaper) * swLineAlongCrest * swLineSide);
float swLinePxD = min(abs(swLineH - swLineLv0), abs(swLineH - swLineLvT));${fromTier(1, `
float swLineLvB = -0.22 + 0.06 * sin(swCrestAlong * 0.43 + swCrestSeed.x * 3.1 + swCrestSeed.y * 2.0);
float swLineDashB = swNoise(swCrestUv * vec2(0.34, 1.0) + vec2(5.1, 19.3)) * 0.65 + swLineWig * 0.35;
float swLineTaperB = clamp((swLineDashB - swLineCut) * 9.0, 0.0, 1.0);
swLines = max(swLines, (1.0 - smoothstep(swLineHalf * 0.8 - 0.6, swLineHalf * 0.8 + 0.6, abs(swLineH - swLineLvB) / swLineFw)) * smoothstep(0.25, 0.45, swLineTaperB) * swLineSide * (1.0 - swLowSea));
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
float swSqCut0 = swSqBase + (1.0 - swSqBase) * smoothstep(0.3, 1.0, swSqT) + swSqLife + 0.6 * swColQuiet + 0.1 * swMidField;
float swSqCut1 = 1.0 - (1.0 - swSqBase) * smoothstep(0.0, 0.7, swSqT) + 0.45 * clamp(swSqT - 1.0, 0.0, 1.0) + swSqLife + 0.6 * swColQuiet + 0.1 * swMidField;
// Dapples: a lighter flat tone on the same noise's highs, shrinking away by octave like the strokes. Past a few metres
// from the eye the strokes keep fewer of their dashes and the dapples about half.
float swDapCut0 = 0.64 + 0.36 * clamp(swSqT, 0.0, 1.0) + 0.1 * swMidField;
float swDapCut1 = 1.0 - 0.36 * clamp(swSqT, 0.0, 1.0) + 0.36 * clamp(swSqT - 1.0, 0.0, 1.0) + 0.1 * swMidField;
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
float swFlCutA = mix(1.05, 0.66 - 0.2 * swClose, smoothstep(2.5, 4.5, 1.8 * swFlMaxA / max(swFoot, 0.00001))) + 0.5 * swColQuiet + 0.14 * swMidField;
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
float swFlCutC = mix(1.05, 0.76, smoothstep(2.5, 4.5, 1.8 * swFlMaxC / max(swFoot, 0.00001))) + 0.5 * swColQuiet + 0.08 * swMidField;
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
// Far out the column narrows and its dashes thin (they would merge into one white smear): the way Painted bounds its path.
float swColFar = clamp(swFoot * 0.45 - 0.13, 0.0, 1.0);
swColW *= 1.0 - 0.3 * swColFar;
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
float swDashCut = 0.92 + 0.14 * swNearSwell - swCol * 0.95 + 0.12 * swColFar;
float swDashMax = (0.32 - 0.12 * swNearSwell) * (1.0 - 0.5 * swColFar);
${fromTier(1, `
// The thickness grows as a square root of how far the noise stands above the cut, so each dash ends in a rounded tip.
float swDashHalf = swDashMax * max(sqrt(clamp((swDashN0 - swDashCut - 1.1 * smoothstep(0.35, 1.0, swDashT)) * 4.0, 0.0, 1.0)),
  sqrt(clamp((swDashN1 - swDashCut - 1.1 + 1.1 * smoothstep(0.0, 0.65, swDashT)) * 4.0, 0.0, 1.0)));`, `
float swDashHalf = max(clamp((swDashN0 - swDashCut - 1.1 * smoothstep(0.35, 1.0, swDashT)) * 1.3, 0.0, swDashMax),
  clamp((swDashN1 - swDashCut - 1.1 + 1.1 * smoothstep(0.0, 0.65, swDashT)) * 1.3, 0.0, swDashMax));`)}
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
swSpark = (1.0 - smoothstep(swSparkR - 0.7, swSparkR + 0.7, swStarD)) * step(1.0 - 0.45 * U.slateWaterLook.z, swSparkRnd) * smoothstep(0.3, 0.6, swCol) * smoothstep(5.0, 8.0, swSparkR) * smoothstep(swSurfW, swSurfW + 1.5, swShoreRest);`))}
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
// Aerial perspective in flat bands (the shared \`swAir\`, at grazing views, over deep water only so shores keep their
// tones): four hard steps (about 40, 110, 270 and 600 m for a 2 km far plane) take the whole sea a share of the way to
// the horizon's tone, the last one all of it, so the dark swell islands dissolve with distance, the sea's far edge never
// shows as a line and the bands run along distance, not along the mesh. Each edge is antialiased by how fast the haze
// changes per pixel.
float swAirD = 1.0 - swAir;
float swAirT = (1.0 - swAirD * swAirD * swAirD) * smoothstep(0.3, 0.85, 1.0 - swUp);
// The nearer steps bend with the large noise (the last one, all of the haze, does not, and the bend fades where the noise
// would alias), so a step never draws the straight, view-aligned edge of an eye-distance contour, which met a band's edge
// at a right angle in views from above.
float swAirBend = (swLarge - 0.5) * 0.3 * smoothstep(0.0, 0.06, swAirT) * (1.0 - swAirT);${fromTier(1, `
swAirBend *= 1.0 - smoothstep(0.15, 0.6, swFoot);`)}
swAirT += swAirBend;
float swAirAA = fwidth(swAirT) * 0.75 + 0.002;
float swAirBand = 0.35 * smoothstep(0.1 - swAirAA, 0.1 + swAirAA, swAirT) + 0.3 * smoothstep(0.25 - swAirAA, 0.25 + swAirAA, swAirT) + 0.25 * smoothstep(0.5 - swAirAA, 0.5 + swAirAA, swAirT) + 0.1 * smoothstep(0.8 - swAirAA, 0.8 + swAirAA, swAirT);
swAirBand *= smoothstep(0.6, 0.95, swDepthTone);
swHaze = max(swHaze, swAirBand);
vec3 swHazeC = swFarC;
#if ${SAMPLES_COPY}${horizonCopySource("swUp < 0.009")}
swHazeC = mix(mix(swFarC, swHorAvg, swHorOn * min(swHorN, 1.0) * (0.7 - 0.45 * swEve)), swHorLocal, swHorOn * swHorHave * (1.0 - smoothstep(0.0, 0.009, swUp)));
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
// Over known terrain with waves the band is the swash's own: a white band riding the water's edge (measured from the edge,
// not from the rest shoreline), about one Foam Width wide (a third less close to the eye, and never under about eight
// pixels, so it stays a line from far away), so at every moment of the cycle it is a bounded band with turquoise water
// seaward of it. (Measured from the rest shoreline it was up to four Foam Widths wide at the run-up's peak and, with the
// swash front and the surf patches beside it, ran together into one sheet over the shallows.)
float swSurfEdge = mix(mix(3.3, 1.3, swBodyEdge) * swFoamAmt * (0.72 + 0.45 * swSwashRun), min(max((0.8 + 0.25 * swSwashRun) * (1.0 - 0.3 * swClose), swFoot * 8.0 / swFoamWidth), 3.0) * swFoamAmt, swSwashZone);
float swShoreX = mix(swShoreUnit, max(swSwashEdgeS, 0.0) / swFoamWidth, swSwashZone) - swShoreLobes * mix(0.9, 0.5, swSwashZone);
float swAAU = min(fwidth(swShoreX) * 0.7 + 0.002, 0.5);
// Over terrain the band gives way where the backwash has uncovered the shallows (a hard cut, the swash's own edge). The
// swash's own foamy front (\`swSwashFoam\`) is the band itself here: it measures from the same edge.
float swToonAA = min(fwidth(swSwashEdgeS) * 0.7 + 0.002, 0.3);
float swToonCover = smoothstep(-swToonAA, swToonAA, swSwashEdgeS);
// The band is a surf zone, not a bank outline: it reaches only over water as shallow as a few Wave Heights (and about
// half a Foam Width), so a steep-banked body (a narrow river or canal, a quay) keeps a thin edge instead of foaming across
// its whole width. A gentle beach never reaches this depth inside its band.
float swBandCap = swFoamWidth * 0.4 + 2.0 * U.slateWaterWaves.x;
float swBandCapAA = fwidth(swTerrainDepth) * 0.7 + 0.002;
float swBandShallow = mix(1.0, 1.0 - smoothstep(swBandCap - swBandCapAA, swBandCap + swBandCapAA, swTerrainDepth), swKnown);
float swFoam = (1.0 - smoothstep(swSurfEdge - swAAU, swSurfEdge + swAAU, swShoreX)) * swToonCover * swBandShallow;
// The ring: from Medium a bold line on each bore (\`swBorePhase\`) rolling in toward the band, thinning (never fading)
// as it arrives and far out; Low keeps one ring breathing beyond the band. Both follow the swash's edge over known
// terrain with waves (so they step seaward from the band wherever the swash stands) and the rest shoreline elsewhere (a
// distance field that grows toward open water everywhere, so they never flash across a flat bar), at least about a pixel
// and a half wide.
float swWashUnit = mix(swRestShore / swFoamWidth, max(swSwashEdgeS, 0.0) / swFoamWidth, swSwashZone) - swShoreLobes * 0.6;${fromTier(1, `
// Distances in metres from the bore front (bores are tens of metres apart for long swell, so a share of a cycle
// would draw metre-wide bands up close).
float swBoreD = (min(swBorePhase, 1.0 - swBorePhase) * 6.283185 / max(U.slateWaterSwash.z, 0.001)) * (1.0 + swShoreLobes * 0.15);
float swBoreAAC = min(fwidth(swBoreD) * 0.7 + 0.002, 0.5);
// At least about a pixel and a half wide (the line thins, never fades), while its bore is strong enough.
float swBoreHalf = max(0.16 * swFoamWidth * swBoreOn, swBoreAAC * 1.1 * smoothstep(0.15, 0.35, swBoreOn)) * step(0.01, swFoamAmt);
// A bore whose own width would be under about a pixel is culled, not drawn as a scratchy hairline.
float swBoreWide = smoothstep(0.7, 1.4, 0.16 * swFoamWidth * swBoreOn / swBoreAAC);
swFoam = max(swFoam, (1.0 - smoothstep(swBoreHalf - swBoreAAC, swBoreHalf + swBoreAAC, swBoreD)) * step(0.000001, swBoreHalf) * swBoreWide * (1.0 - smoothstep(5.0, 6.0, swWashUnit)) * swToonCover);`, `
float swWashPhase = sin(swTime * 0.8 + swLarge * 5.0);
float swWashAA = min(fwidth(swWashUnit) * 0.7 + 0.002, 0.5);
float swWashHalf = max((0.26 + 0.06 * swWashPhase) * mix(1.0, 0.6, swBodyEdge) * swFoamAmt, swWashAA * 1.1) * step(0.01, swFoamAmt);
swFoam = max(swFoam, (1.0 - smoothstep(swWashHalf - swWashAA, swWashHalf + swWashAA, abs(swWashUnit - swSurfEdge - 1.0 - 0.3 * swWashPhase))) * (1.0 - smoothstep(5.0, 6.0, swWashUnit)));`)}
// Surf (\`swSurfBreak\`, \`swSurfGate\`): the breaking patches that advance with the swell's crests as hard shapes, and two
// thinner scalloped lines stepping seaward behind the band, each swinging in and out with the swash and the waves. Over
// known terrain with waves the lines alone draw the surf: the patches' straight crest fronts ran into the band as sheets
// and notches, so only a bank without terrain keeps them.
float swBrkAA = min(fwidth(swSurfBreak) * 0.7 + 0.01, 0.3);
swFoam = max(swFoam, smoothstep(0.42 - swBrkAA, 0.42 + swBrkAA, swSurfBreak) * step(0.01, swFoamAmt) * swToonCover * (1.0 - swSwashZone));
// The lines stand on every beach (about half of them where the surf's breaking depth would not reach), stronger where
// it does, but only over water within about six Wave Heights of depth.
float swSurfLineOn = (0.55 + 0.45 * smoothstep(0.15, 0.4, swSurfGate)) * (1.0 - step(U.slateWaterWaves.x * 6.0, swBreakDepth)) * step(0.01, swFoamAmt) * (1.0 - swOpenAny) * (1.0 - smoothstep(5.5, 7.0, swWashUnit));
float swSurfLineAA = min(fwidth(swWashUnit) * 0.7 + 0.002, 0.5);
// The lines wave smoothly (the band's cusps would kink them into hooks and detached dashes).
float swSurfLineU = swWashUnit + swShoreLobes * 0.6 - swSurfEdge - ((swScallop - 0.5) * 0.8 * swNearFoam + (swLarge - 0.5) * 0.6);
float swSurfLineHalf = max(0.12, swSurfLineAA * 1.6);
float swSurfLine1 = 1.0 - smoothstep(swSurfLineHalf - swSurfLineAA, swSurfLineHalf + swSurfLineAA, abs(swSurfLineU - 1.4 - 0.4 * swSwashRun - 0.4 * swBrkG));
float swSurfLine2 = 1.0 - smoothstep(swSurfLineHalf * 0.8 - swSurfLineAA, swSurfLineHalf * 0.8 + swSurfLineAA, abs(swSurfLineU - 3.0 - 0.8 * swSwashRun - 0.6 * swBrkG));
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
// The shallowest band stays flat colour with the shore's own line work (band, surf lines, bores): the open sea's crest
// lines and strokes begin at the next band, where they no longer cross the surf lines as stray dashes.
swStrokes *= mix(smoothstep(0.0, 0.5, swDepthTone), smoothstep(1.0 - swBandAA * 1.5, 1.0, swBand), step(1.5, swBandCount));
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
${fromTier(1, `
// The film's switches, each blended over about a pixel and a half of its own continuous quantity (metres for the furthest reach,
// cycles for the others), so the wet sand's edge is antialiased instead of a stair-stepped hard cut.
float swFilmA0 = fwidth(swFilmG0) * 1.1 + 0.002;
float swFilmA1 = fwidth(swFilmG1) * 1.1 + 0.002;
float swFilmA2 = fwidth(swFilmG2) * 1.1 + 0.002;
swSwashWet = mix(swFilmOld, swFilmCur, smoothstep(-swFilmA1, swFilmA1, swFilmG1) * smoothstep(-swFilmA2, swFilmA2, swFilmG2))
  * smoothstep(-swFilmA0, swFilmA0, swFilmG0) * swSwashZone;`)}
// The wet strip is bounded: behind the water's edge it reaches one and three fifths Foam Widths up the beach (one and a
// tenth close to the eye) and no further, so a long run-up on a gentle slope leaves a strip beside the swash, never a dark
// field close to the camera. Its outer edge is antialiased by the edge distance's own screen derivative, and the wet line
// (below) follows it.
float swFilmBackAA = fwidth(swSwashEdgeS) * 1.1 + 0.002;
float swFilmReach = swFoamWidth * (1.6 - 0.5 * swClose);
swSwashWet *= 1.0 - smoothstep(swFilmReach - swFilmBackAA, swFilmReach + swFilmBackAA, -swSwashEdgeS);
float swFilm = (1.0 - swToonCover) * swSwashWet;
float swFilmAA = min(fwidth(swFilm) * 0.7 + 0.01, 0.2);
float swFilmA = max(swFoam, smoothstep(0.32 - swFilmAA, 0.32 + swFilmAA, swFilm) * 0.4);
swEmissive = mix(mix(vec3(0.07, 0.04, 0.015) * swExpo, swFoamLit, clamp(swFoam / max(swFilmA, 0.001), 0.0, 1.0)), swEmissive, swToonCover);
alpha = mix(swFilmA, alpha, swToonCover);
${fromTier(1, `
// The wet line (Medium up): wet sand along the outermost edge of everything the water leaves on the beach, so nothing
// water-coloured lies beyond it. That edge is the outer boundary of the union of the swash's covered water and the drying
// film behind it (wet sand, below). Where the film stands, the line is the film's own outer ramp (its switches are
// blended over about a pixel and a half, so the ramp is continuous and antialiased by construction), darkest on the
// ramp's lower part and narrow (its film range is a tight window around the tone's edge, so it stays a line beside the
// wet strip); where it does not, the line stands just beyond the swash's edge.
// Both fade out in the far field (a line would outline every shoreline from above). Where the union reaches the body's own
// edge (the mesh ends at the waterline) it is drawn there instead. It is the scene behind the water darkened (a warm dark
// at partial coverage, so sand reads as wet sand, not ink); nothing refracts under it.
float swWetIn = swSwashEdgeS / clamp(fwidth(swSwashEdgeS), swFoot * 0.3, swFoot * 1.2);
float swWetHw = 2.4 * (1.0 - smoothstep(0.03, 0.2, swFoot));
float swWetFilm = smoothstep(0.1, 0.25, swFilm) * (1.0 - smoothstep(0.4, 0.55, swFilm));
float swWetSwash = smoothstep(-0.8, 0.8, -swWetIn) * (1.0 - smoothstep(swWetHw - 0.8, swWetHw + 0.8, -swWetIn)) * (1.0 - smoothstep(0.1, 0.3, swFilm));
float swWetBand = max(swWetFilm, swWetSwash);
float swWetOut = -swWetIn;
// Only real terrain draws it (or, with no terrain field bound at all, a body's own bank): a field's last texels, where its
// known share ramps down, and a body's edge over open water are no shore, and would draw a dashed line along them.
float swWetTerrain = step(${f(WATER_FIELD_TERRAIN_ALPHA)}, swKnown);
float swWetD = mix(IN.vSlateWater.y, swTerrainDepth, swWetTerrain);
float swWetEdge = (1.0 - smoothstep(swWetHw - 0.8, swWetHw + 0.8, swWetD / max(fwidth(swWetD), 0.00001))) * swToonCover
  * (1.0 - smoothstep(0.0, 2.0, swWetOut));
// A waterline is shallow: past a metre or two of depth the field's own edge rows (where its distances blend toward zero)
// would draw one.
float swWetLine = max(swWetBand, swWetEdge) * smoothstep(0.4, 1.2, swWetHw);
swWetLine *= max(swWetTerrain, 1.0 - U.slateWaterFieldInfo.x) * mix(1.0, 1.0 - smoothstep(1.0, 2.0, swTerrainDepth), swWetTerrain) * (1.0 - swOpenAny) * (1.0 - swHaze);
swEmissive = mix(swEmissive, vec3(0.07, 0.04, 0.015) * swExpo, swWetLine);
alpha = max(alpha, 0.55 * swWetLine);`, `
float swWetLine = 0.0;`)}
// Fresnel for object reflections: they replace the water by it, never over foam.
float swNdotV = clamp(dot(normalize(mix(swSwellNormal, normalW, 0.5)), swV), 0.0, 1.0);
float swFx = 1.0 - swNdotV;
float swFres = 0.03 + 0.97 * swFx * swFx * swFx * swFx * swFx;
vec3 swRefl = reflect(-swV, normalize(mix(swSwellNormal, normalW, 0.5)));
${objectReflectionSource("swRefl", "U.slateWaterOrigin.w")}
#if ${REFLECTS_OBJECTS}
float swReflWeight = clamp(swObjRefl.a * swFres * U.slateWaterDeep.w * (1.0 - swFoam) * (1.0 - swWetLine) * swToonCover, 0.0, 1.0);
swEmissive = mix(swEmissive, swObjRefl.rgb, swReflWeight);
alpha = max(alpha, swReflWeight);
#endif${ifDefined(REFRACTION, `
swRefracts *= swToonCover * (1.0 - swWetLine);
// Refraction-tinted shallows: what shows through takes the water's hue (a gain of at most 1) and fades toward the
// water's own colour with the refracted depth, so nothing below glows brighter than above.
vec3 swTintHue = swShallowC / max(max(swShallowC.r, max(swShallowC.g, swShallowC.b)), 0.001);
// As Realistic: where the copy holds no geometry behind the water (its sky depth) there is no bed, and the water's own
// colour shows instead of the sky.
float swVoid = step(${f(WATER_SCENE_COPY_SKY_DEPTH * 0.9)}, swSceneZ);
swBackground = mix(swBackground * mix(vec3(1.0), swTintHue, 0.5), swLit, max(clamp(swTone, 0.0, 1.0), swVoid));
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
 *
 * Computes the contact derivatives and whether this fragment is removed (`swRemoved`: a removal volume, a blend partner's
 * share, or land above the water), then discards at once only in the depth pre-pass (`DEPTHPREPASS`, set by Babylon from the
 * colour-write state: nothing after it reads a derivative and removed water must write no depth). The colour pass
 * discards in `beforeFogSource`, after every look's derivatives (foam, normals, footprints, line work) were taken with the
 * whole 2x2 quad running: a derivative taken after a neighbour's discard is undefined on some GPUs.
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
// Toon hands the colours over in flat cels (the share rounded to quarters: a two-body owner's share is at most 0.5, so
// three flat tones, and a fourth only where several bodies meet) with crisp edges, each antialiased over about a pixel by
// the share's screen derivative, not an airbrushed gradient. The share, not the ownership margin, places the steps: both
// bodies mix by complementary shares, while each fits its own approximate margin, so margin steps would not meet.
float swBlendCel = swBlendShare * 4.0;
float swBlendAA = max(fwidth(swBlendCel) * 0.75, 0.0002);
swBlendShare = (smoothstep(0.5 - swBlendAA, 0.5 + swBlendAA, swBlendCel) + smoothstep(1.5 - swBlendAA, 1.5 + swBlendAA, swBlendCel) + smoothstep(2.5 - swBlendAA, 2.5 + swBlendAA, swBlendCel)) * 0.25;
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
// Derivatives before any discard.
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
${wgsl ? "var swRemoved: bool" : "bool swRemoved"} = swCut < 0.0 || swBlendKeep < 0.0 || (swField.a * swFieldOn > ${f(WATER_FIELD_TERRAIN_ALPHA)} && swTerrainDepth <= 0.0);
#ifdef DEPTHPREPASS
if (swRemoved) { discard; }
#endif
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
 *
 * `gradient` (a Custom Material's Water Waves node, `waterWaveBlockSource`) also leaves `swvNormal`, the Eulerian surface
 * normal at the displaced point, which the built-in fragment shader derives for itself: it accumulates what
 * `evaluateWaterWaves` does (∇₀H and S = Σ q·a·k·sin p·d ⊗ d, with the warp's M) and takes `waterEulerianGradient`
 * against the rest slope of `slateWaterBaseNormal`. Like the kernel it divides by a Jacobian that holds the bank fade's
 * gain but not that gain's own slope, so inside a finite body's fade band the normal is a touch off the CPU mesh's. The
 * band's vertex part is not part of it.
 */
function vertexWaveSource(materialOutputs: boolean, gradient = false): string {
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
swvD += swvWD${i}.xy * (swvWA${i}.z * swvF${i} * swvC${i});${gradient ? swellGradientSource(i) : ifFft(`
swvShear += vec3(swvWD${i}.x * swvWD${i}.x, swvWD${i}.x * swvWD${i}.y, swvWD${i}.y * swvWD${i}.y) * (swvWA${i}.z * swvF${i} * swvWD${i}.z * swvS${i});`, 1, FFT_VERTEX)}`).join("");
  // With the band's vertex part: the warp's M = I + dW/drest for the swell's Jacobian (the band's fold limit).
  const warpGradient = gradient ? "" : ifFft(`
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
vec2 swvD = vec2(0.0);${gradient ? "" : `
#ifdef ${WATER_SPECTRUM_DEFINE}${spectrumVertexSource()}
#else`}${gradient ? `
vec2 swvHg = vec2(0.0);
vec3 swvJ = vec3(0.0);` : ifFft(`
vec3 swvShear = vec3(0.0);`, 1, FFT_VERTEX)}
// The shared kernel's warp: every component is evaluated at u = rest + W(rest) (\`waterSwellWarp\`).${swellWarpSource("swv", "swvRest", gradient)}${warpGradient}
vec2 swvRestW = swvRest + swvWarp;
${swell}${gradient ? "" : `
#endif`}
float swvFade = U.slateWaterSwellInfo.x;
#ifdef ${WATER_BLEND_DEFINE}
swvFade = swvFade * A.slateWaterBlend.y;
#endif
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));${gradient ? "" : `
#ifndef ${WATER_SPECTRUM_DEFINE}${fftVertexSource()}
#endif`}
#ifdef ${WATER_BLEND_DEFINE}
swvH = swvH * A.slateWaterBlend.x;
swvD = swvD * A.slateWaterBlend.y;
#endif
swvD = swvD * swvGain;
worldPos = vec4(worldPos.xyz + vec3(swvD.x, swvH, swvD.y), worldPos.w);${materialOutputs ? "\nO.vPositionW = worldPos.xyz;" : ""}${gradient ? swellNormalSource() : ""}
#endif
`;
}

/**
 * Component `i`'s share of the swell's gradient terms (`vertexWaveSource` with `gradient`), as `evaluateWaterWaves`
 * accumulates them: `swvHg` is ∇ᵤH before the warp's M (a·(g·k·d·slope − gs·∇group), gs the wave group's own slope times
 * the wave value) and `swvJ` the offset's shear S = Σ d·k·sin p·(dx², dx·dz, dz²) with d = q·a, which is zero without
 * Gerstner waves because the uniform's q·a is.
 */
function swellGradientSource(i: number): string {
  return `
float swvV${i} = mix(swvS${i}, (exp(swvS${i} - 1.0) - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swvChop);
float swvL${i} = mix(swvC${i}, exp(swvS${i} - 1.0) * swvC${i} / ${f(WATER_CREST_RANGE)}, swvChop);
float swvQ${i} = swvWG${i}.w * (1.0 / sqrt(1.0 + 0.5 * swvWG${i}.w * swvWG${i}.w)) * sin(dot(swvWG${i}.xy, swvRestW) + swvWG${i}.z) * swvV${i};
swvHg += swvWD${i}.xy * (swvWA${i}.x * swvF${i} * swvG${i} * swvWD${i}.z * swvL${i}) - swvWG${i}.xy * (swvWA${i}.x * swvF${i} * swvQ${i});
swvJ += vec3(swvWD${i}.x * swvWD${i}.x, swvWD${i}.x * swvWD${i}.y, swvWD${i}.y * swvWD${i}.y) * (swvWA${i}.z * swvF${i} * swvWD${i}.z * swvS${i});`;
}

/**
 * The end of `vertexWaveSource` with `gradient`: the blend's height scale and offset scale (times the bank gain) scale
 * the gradient and the shear as they scale H and D, the warp turns ∇ᵤH into ∇₀H, the rest slope of
 * `slateWaterBaseNormal` joins it, and `waterEulerianGradient` (J = I − gain·S·M) makes it the slope of the displaced
 * surface, from which the world normal follows.
 */
function swellNormalSource(): string {
  return `
float swvHs = 1.0;
float swvDs = swvGain;
#ifdef ${WATER_BLEND_DEFINE}
swvHs = A.slateWaterBlend.x;
swvDs = swvDs * A.slateWaterBlend.y;
#endif
vec2 swvHw = vec2(swvWarpM.x * swvHg.x + swvWarpM.y * swvHg.y, swvWarpM.y * swvHg.x + swvWarpM.z * swvHg.y) * swvHs;
vec3 swvBase = A.slateWaterBaseNormal;
vec2 swvSlope = swvHw - swvBase.xz / max(swvBase.y, 0.000001);
float swvJa = 1.0 - swvDs * (swvJ.x * swvWarpM.x + swvJ.y * swvWarpM.y);
float swvJb = -swvDs * (swvJ.x * swvWarpM.y + swvJ.y * swvWarpM.z);
float swvJc = -swvDs * (swvJ.y * swvWarpM.x + swvJ.z * swvWarpM.y);
float swvJd = 1.0 - swvDs * (swvJ.y * swvWarpM.y + swvJ.z * swvWarpM.z);
float swvJi = 1.0 / max(swvJa * swvJd - swvJb * swvJc, 0.000001);
vec2 swvEuler = vec2(swvJd * swvSlope.x - swvJc * swvSlope.y, swvJa * swvSlope.y - swvJb * swvSlope.x) * swvJi;
vec3 swvNormal = normalize(vec3(-swvEuler.x, 1.0, -swvEuler.y));`;
}

/**
 * Blending surfaces on the GPU path cull vertices this many of their own grid spacings, plus `BLEND_CULL_MARGIN` metres,
 * inside water they never draw (`VERTEX_VARYINGS`). A triangle's other vertices are at most √2 spacings away, and both
 * the ownership margin and the bank distance change by about a metre per metre (the margin's fit is approximate, hence
 * the slack), so they lie in that water too.
 */
const BLEND_CULL_CELLS = 2;
const BLEND_CULL_MARGIN = 1;

/**
 * Varyings at CUSTOM_VERTEX_MAIN_END, which runs after the world-position hook: GPU waves pass their own height and
 * offset, so the attribute copy must not overwrite them. `SW_CLIP_POSITION` is the clip position, bound per language.
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
#ifdef ${WATER_GPU_WAVES_DEFINE}
// Water this blending surface never draws (a neighbour's share, or past the blended shoreline) is discarded fragment by
// fragment, but only after the whole look has run on it, and where it overlaps the neighbour's surface the depth test
// cannot reject it. A vertex deeper in it than \`BLEND_CULL_CELLS\` of its own spacing plus \`BLEND_CULL_MARGIN\` metres
// belongs only to triangles all of whose vertices lie in it too (by the same attribute: both fields are distances), so
// every fragment of those triangles would discard: its clip depth moves past the far side of the clip volume (x, y and w
// unchanged, so the triangles it starts clip to within their own outline) and they rasterize nothing, in the depth
// pre-pass and the colour pass alike.
if (min(A.slateWaterData.y, A.slateWaterBlend.z) < -(${f(BLEND_CULL_CELLS)} * A.slateWaterData.x + ${f(BLEND_CULL_MARGIN)})) {
  SW_CLIP_POSITION.z = 2.0 * SW_CLIP_POSITION.w;
}
#endif
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
    ? { definitions, worldPosition: bindVertexSource(toWgsl(vertexWaveSource(true)), true), end: bindVertexSource(toWgsl(VERTEX_VARYINGS), true).replace(/\bSW_CLIP_POSITION\b/g, "vertexOutputs.position") }
    : { definitions, worldPosition: bindVertexSource(vertexWaveSource(true), false), end: bindVertexSource(VERTEX_VARYINGS, false).replace(/\bSW_CLIP_POSITION\b/g, "gl_Position") };
}

/**
 * Uniforms the vertex swell reads (`bindWaterSwellUniforms` sets them): the choppiness, the bank fade, the grid offset, and
 * every component's and the warp's constants.
 */
export const WATER_SWELL_UNIFORMS: readonly string[] = [
  "slateWaterShape", "slateWaterSwellInfo", "slateWaterGridOffset", ...SWELL_DIRECTION, ...SWELL_AMPLITUDE, ...SWELL_GROUP, ...SWELL_WARP,
];
/**
 * Uniforms the vertex swell and the band's vertex displacement read (`WaterMaterialPlugin.bindVertexWaves` sets them
 * on another pass's effect, with `WATER_FFT_SAMPLER`).
 */
export const WATER_VERTEX_WAVE_UNIFORMS: readonly string[] = [...WATER_SWELL_UNIFORMS, "slateWaterFft", ...FFT_CASCADE_UNIFORMS];
/** The surface's water clock in seconds (x), for a Custom Material's Water Waves node (`WaterVertexWaves.bind`). */
export const WATER_CLOCK_UNIFORM = "slateWaterClock";
/** `vertexWaveDefines` per blend state (off, on), spectrum water (off, on) and cascades the vertex samples (0-3): built once. */
const VERTEX_WAVE_DEFINES: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly string[]>>> = [false, true].map((blend) => [false, true].map((spectrum) =>
  Array.from({ length: WATER_FFT_CASCADES_MAX + 1 }, (_, cascades) => [
    `#define ${WATER_GPU_WAVES_DEFINE}`, ...(cascades ? [`#define ${FFT_VERTEX} ${cascades}`] : []), ...(blend ? [`#define ${WATER_BLEND_DEFINE}`] : []),
    ...(spectrum ? [`#define ${WATER_SPECTRUM_DEFINE}`] : []),
  ])));
/** `vertexWaveAttributes` per blend state (off, on). */
const VERTEX_WAVE_ATTRIBUTES: ReadonlyArray<readonly string[]> = [["slateWaterData"], ["slateWaterData", "slateWaterBlend"]];

/**
 * The GPU swell for another pass's vertex shader that computes a `worldPos` vec4 from the same world matrix and has a
 * `view` matrix uniform (the shared outline mask): declarations of its attribute, uniforms and the band's sampler,
 * and the displacement to insert after `worldPos`. Both compile only under `SLATE_WATER_GPU_WAVES` (the band under
 * `SLATE_WATER_FFT_VERTEX`), so the pass's other programs are unchanged.
 */
export function waterOutlineVertexSource(language: ShaderLanguage): { declarations: string; displacement: string } {
  const key = language === ShaderLanguage.WGSL ? "wgsl" : "glsl";
  let source = outlineVertexSources.get(key);
  if (!source) outlineVertexSources.set(key, source = buildOutlineVertexSource(language));
  return source;
}
const outlineVertexSources = new Map<string, { declarations: string; displacement: string }>();
function buildOutlineVertexSource(language: ShaderLanguage): { declarations: string; displacement: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const uniforms = WATER_VERTEX_WAVE_UNIFORMS.map((name) => (wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`)).join("\n");
  const attribute = wgsl ? "attribute slateWaterData: vec4f;" : "attribute vec4 slateWaterData;";
  const blend = `#ifdef ${WATER_BLEND_DEFINE}\n${wgsl ? "attribute slateWaterBlend: vec4f;" : "attribute vec4 slateWaterBlend;"}\n#endif`;
  const displacement = vertexWaveSource(false);
  return {
    declarations: `\n${stripShaderComments(`#ifdef ${WATER_GPU_WAVES_DEFINE}\n${attribute}\n${blend}\n${uniforms}${fftHelpers(wgsl, FFT_VERTEX)}#endif`)}\n`,
    displacement: `\n${stripShaderComments(bindVertexSource(wgsl ? toWgsl(displacement) : displacement, wgsl, "uniforms."))}\n`,
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

/** Where a pass's float4 uniforms go: an `Effect`, or whatever records the vectors a pass would receive. */
export interface WaterUniformSink {
  setFloat4(name: string, x: number, y: number, z: number, w: number): unknown;
}

/**
 * Sets `WATER_SWELL_UNIFORMS`: the grid offset (world X/Z translation of the uploaded rest grid), each component's constants
 * (`swell`: three vec4s a slot) and the warp's (`warp`), the bank fade length and the choppiness. The material plugin binds
 * them to another pass's effect (`WaterMaterialPlugin.bindVertexWaves`) and a surface without a plugin binds them to its
 * Custom Material (`WaterVertexWaves.bind`), so both displace identically.
 */
export function bindWaterSwellUniforms(
  sink: WaterUniformSink, grid: ArrayLike<number>, swell: Float32Array, warp: Float64Array, bankFade: number, choppiness: number,
): void {
  sink.setFloat4("slateWaterGridOffset", grid[0]!, grid[1]!, grid[2]!, 0);
  for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
    const o = i * WATER_WAVE_SHADER_STRIDE;
    sink.setFloat4(SWELL_DIRECTION[i]!, swell[o]!, swell[o + 1]!, swell[o + 2]!, swell[o + 3]!);
    sink.setFloat4(SWELL_AMPLITUDE[i]!, swell[o + 4]!, swell[o + 5]!, swell[o + 6]!, swell[o + 7]!);
    sink.setFloat4(SWELL_GROUP[i]!, swell[o + 8]!, swell[o + 9]!, swell[o + 10]!, swell[o + 11]!);
  }
  for (let t = 0; t < WATER_SWELL_WARP_TERMS; t++) {
    const o = t * WATER_SWELL_WARP_STRIDE;
    sink.setFloat4(SWELL_WARP[t]!, warp[o]!, warp[o + 1]!, warp[o + 2]!, warp[o + 3]!);
  }
  sink.setFloat4("slateWaterSwellInfo", bankFade, 0, 0, 0);
  sink.setFloat4("slateWaterShape", choppiness, 0, 0, 0);
}

/**
 * The swell of a water surface that has no `WaterMaterialPlugin`: Custom Material water whose graph holds a Water Waves
 * node (`WaterWavesBlock`). The node's vertex stage displaces the surface's static rest grid with the same source as
 * built-in shading (`waterWaveBlockSource`) from the same uniforms (`bindWaterSwellUniforms`), here from the surface's
 * own definition, body and clock; the water mesh keeps `time` current. The FFT detail band is not part of it, as it is
 * not part of the CPU path this replaces.
 */
export class WaterVertexWaves {
  /** The surface's water clock in seconds. */
  time = 0;
  readonly water: WaterDefinition;
  readonly body: WaterBodyProperties;
  constructor(water: WaterDefinition, body: WaterBodyProperties) {
    this.water = water;
    this.body = body;
  }
  /** Sets the swell uniforms and the clock for a draw of `mesh`. Allocation-free. */
  bind(sink: WaterUniformSink, scene: Scene, mesh: AbstractMesh): void {
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly, scale = this.body.waveScale;
    const shared = sharedSwell(waterWaveSet(this.water), scale, DEFAULT_TIER, origin.x, origin.z, this.time);
    bindWaterSwellUniforms(sink, waterGridOffset(mesh), shared.swell, shared.warp, this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, scale), this.water.choppiness);
    sink.setFloat4(WATER_CLOCK_UNIFORM, this.time, 0, 0, 0);
  }
}

const meshWaves = new WeakMap<AbstractMesh, WaterVertexWaves>();
/** Registers (or with null removes) the swell `mesh`'s Custom Material displaces it with; the water mesh owns it. */
export function setMeshVertexWaves(mesh: AbstractMesh, waves: WaterVertexWaves | null): void {
  if (waves) meshWaves.set(mesh, waves);
  else meshWaves.delete(mesh);
}
/** The swell a Custom Material displaces `mesh` with (`setMeshVertexWaves`), or null. */
export function meshVertexWaves(mesh: AbstractMesh | null | undefined): WaterVertexWaves | null {
  return (mesh && meshWaves.get(mesh)) || null;
}

const blockWaveSources = new Map<ShaderLanguage, string>();
/**
 * The Water Waves node's vertex code for one language: `vertexWaveSource` with the gradient, bound and translated like the
 * plugin's. It reads and writes a `worldPos` vec4 (rest point in, displaced point out) and leaves `swvH` (height),
 * `swvD` (horizontal offset) and `swvNormal`, under `SLATE_WATER_GPU_WAVES`; it reads `slateWaterData` and
 * `slateWaterBaseNormal`, and under `SLATE_WATER_BLEND` `slateWaterBlend`, as attributes. Built once.
 */
export function waterWaveBlockSource(language: ShaderLanguage): string {
  let source = blockWaveSources.get(language);
  if (!source) {
    const wgsl = language === ShaderLanguage.WGSL, code = vertexWaveSource(false, true);
    blockWaveSources.set(language, source = stripShaderComments(bindVertexSource(wgsl ? toWgsl(code) : code, wgsl)));
  }
  return source;
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
 * CUSTOM_FRAGMENT_BEFORE_FOG. The colour pass first discards removed water (`swRemoved`, see `cutSource`): the look's
 * derivatives ran with every fragment of the quad alive, and nothing from here on takes one.
 *
 * Realistic colour is premultiplied by coverage: undo it for Babylon's non-premultiplied blend, fog and image
 * processing. In an 8-bit display target, light brighter than the coverage raises it instead of clipping, and the raised
 * coverage hides that much more of the background behind the blend. With the refracted copy (`swBehindCopy`: the copy at this
 * pixel, the background the blend would show) the share it hides is added back as refracted light, and the coverage
 * solves for that too (per channel, (light − copy · a) / (1 − copy)): glints, foam and bright reflections over shallows
 * add to the bed seen through them instead of replacing it with a darker ring. Without the copy the raise stays as it is
 * (the least coverage that keeps the light from clipping). In Scene Linear (`IMAGEPROCESSINGPOSTPROCESS`, a half-float
 * target that never clips at 1) coverage is the water's own and nothing is raised.
 *
 * The refracted scene (`swRefracted`; `SLATE_WATER_REFRACTION`) is light from behind the surface, already fogged by its
 * own materials. Its share `swRefractedWeight` is the coverage the water's own light leaves it (the output's coverage
 * less the water's blend coverage), whatever tint, caustics or foam `swRefracted` carries. With the copy the water
 * covers that share too, so Babylon's fog below would fog the background again and add its fog colour over it: the
 * refracted light is pre-divided by the fog factor, less the fog colour at its share, so the result equals blending
 * (the water's fog on its own light only). The factor is the weight Babylon's PBR fog mixes with
 * (`toLinearSpace(CalcFogFactor())` under `PBR`, which water materials are).
 * Stylized water is opaque where it refracts and only adds it.
 */
function beforeFogSource(wgsl: boolean): string {
  const v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4", f1 = wgsl ? "f32" : "float";
  const declare = (type: string, name: string, value: string) => (wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`);
  const brightest = (c: string) => `max(${c}.r, max(${c}.g, ${c}.b))`;
  return [
    // Removed water leaves the colour pass here, after every derivative of the look (the depth pre-pass left in `cutSource`).
    "#ifndef DEPTHPREPASS",
    "if (swRemoved) { discard; }",
    "#endif",
    // Realistic coverage, before the refracted light takes its fog: the raise below can add to it.
    `#ifndef ${WATER_STYLIZED_DEFINE}`,
    "#ifdef IMAGEPROCESSINGPOSTPROCESS",
    declare(f1, "swCover", "clamp(finalColor.a, 0.02, 1.0)"),
    `#elif defined(${REFRACTION})`,
    declare(v3, "swBehindCopy", "swSceneColor(swScreenUv)"),
    declare(v3, "swNeed", `(finalColor.rgb + swRefracted - swBehindCopy * finalColor.a) / max(${v3}(1.0) - swBehindCopy, ${v3}(0.001))`),
    declare(f1, "swCover", `clamp(max(finalColor.a, ${brightest("swNeed")}), 0.02, 1.0)`),
    declare(f1, "swRaised", "max(swCover - finalColor.a, 0.0)"),
    "swRefracted += swBehindCopy * swRaised;",
    "swRefractedWeight += swRaised;",
    "#else",
    declare(f1, "swCover", `clamp(max(finalColor.a, ${brightest("finalColor")}), 0.02, 1.0)`),
    "#endif",
    "#endif",
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
    `#ifdef ${REFRACTION}`,
    `finalColor = ${v4}(finalColor.rgb + swRefractedOut, finalColor.a);`,
    "#endif",
    `finalColor = ${v4}(finalColor.rgb / swCover, swCover);`,
    `#if ${SAMPLES_COPY}`,
    `finalColor = ${v4}(mix(finalColor.rgb, swHorC, swHorW), mix(finalColor.a, 1.0, swHorW));`,
    "#endif",
    "#endif",
    // Open-water edges fade out (`swOpenFade`, every look).
    "finalColor.a *= swOpenFade;",
  ].join("\n");
}

/** The three looks: Realistic, and Stylized's Painted and Toon (`SLATE_WATER_STYLIZED`, within it `SLATE_WATER_TOON`). */
export type WaterLook = "realistic" | "painted" | "toon";
const LOOK_SOURCES: Readonly<Record<WaterLook, () => string>> = { realistic: spectrumRealisticSource, painted: spectrumPaintedSource, toon: toonSource };

/** The look a compile's defines select: the one `fragmentSource`'s directives would keep. */
function lookOfDefines(defines: readonly string[]): WaterLook {
  const defined = (name: string) => defines.some((line) => line === `#define ${name}` || line.startsWith(`#define ${name} `));
  return !defined(WATER_STYLIZED_DEFINE) ? "realistic" : defined(WATER_TOON_DEFINE) ? "toon" : "painted";
}

/**
 * The look's shading, or with no look every look, selected by `SLATE_WATER_STYLIZED` and, within Stylized,
 * `SLATE_WATER_TOON` so each material compiles only one (each directive on its own line). A compile knows its defines
 * (`WaterMaterialPlugin.getCustomCode`), so it asks for its look alone; the look sources never test the look defines.
 */
function fragmentSource(look: WaterLook | null): string {
  if (look) return `\n${LOOK_SOURCES[look]()}\n`;
  return `\n#ifdef ${WATER_STYLIZED_DEFINE}\n#ifdef ${WATER_TOON_DEFINE}\n${toonSource()}\n#else\n${spectrumPaintedSource()}\n#endif\n#else\n${spectrumRealisticSource()}\n#endif\n`;
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

export function waterShaderSource(language: ShaderLanguage, look: WaterLook | null = null): { helpers: string; cut: string; main: string } {
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
    ? "var<private> swSlopeVariance: f32 = 0.0;\nvar<private> swMatte: f32 = 0.0;\nvar<private> swSharp: f32 = 1.0;\n"
    : "float swSlopeVariance = 0.0;\nfloat swMatte = 0.0;\nfloat swSharp = 1.0;\n";
  return wgsl
    ? {
      helpers: samplerDeclaration + roughnessGlobals + toWgsl(HELPERS + REMOVAL_HELPER) + CONTACT_TAP_WGSL + objectHelpers(true) + fftHelpers(true) + spectrumHelpers(true),
      cut: bind(toWgsl(cutSource(true))), main: bind(toWgsl(blendColors(fragmentSource(look)))),
    }
    : {
      helpers: samplerDeclaration + roughnessGlobals + HELPERS + REMOVAL_HELPER + CONTACT_TAP_GLSL + objectHelpers(false) + fftHelpers(false) + spectrumHelpers(false),
      cut: bind(cutSource(false)), main: bind(blendColors(fragmentSource(look))),
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

/** Writes one vec4 into a packed array at `o`; returns the next offset. */
const put4 = (v: Float64Array, o: number, x: number, y: number, z: number, w: number) => {
  v[o] = x; v[o + 1] = y; v[o + 2] = z; v[o + 3] = w;
  return o + 4;
};
/**
 * Writes an asset colour, in linear space as Babylon converts colours (exact sRGB where the engine uses it, like the
 * clear and fog colours in `sceneWaterLighting`), and `w` into a packed array at `o`; returns the next offset.
 */
const putLinear = (v: Float64Array, o: number, color: readonly number[], w: number, exact: boolean) => {
  gammaScratch.set(color[0]!, color[1]!, color[2]!).toLinearSpaceToRef(linearScratch, exact);
  return put4(v, o, linearScratch.r, linearScratch.g, linearScratch.b, w);
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
  "slateWaterSea", "slateWaterSwellInfo", "slateWaterShape", ...CHOP_UNIFORMS,
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
  // the fog the water itself fades into. Light colours above are linear already: Babylon's PBR lights shade with them
  // unconverted.
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
/** The chop octaves: the CPU side of `CHOP_UNIFORMS`. */
const ALL_OCTAVES = DETAIL_OCTAVES;
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
  // Spectrum water has no analytic slots: no lead and no crest count.
  const lead = order[0] ?? 0;
  if (count > 0) {
    const wrapped = kernel[lead * WATER_WAVE_SHADER_STRIDE + 5]!;
    const world = set.k[lead]! * (set.dirX[lead]! * originX + set.dirZ[lead]! * originZ) - set.omega[lead]! * time + waterWaveSurge(set, time)[lead]! + set.phase[lead]!;
    const periods = Math.round((world - wrapped) / TAU);
    e.crestCount = periods - CREST_COUNT_PERIOD * Math.floor(periods / CREST_COUNT_PERIOD);
  } else e.crestCount = 0;
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

/** A water variant a render pass asked Babylon to compile: what the compile log (`recordWaterVariant`) holds. */
export interface WaterVariantRequest {
  at: number;
  mesh: string;
  /** `engine.currentRenderPassId` when the variant was requested, and whether that is a scene-copy (main water) pass. */
  pass: number;
  mainPass: boolean;
  look: "realistic" | "painted" | "toon";
  refraction: boolean;
  ssr: boolean;
  planar: boolean;
  fft: boolean;
  blend: boolean;
  /** The shadow defines in the variant, as the pass's shadow toggles left them. */
  shadows: string[];
  depthPrePass: boolean;
  prePass: boolean;
  /** The calling frames, innermost first. */
  caller: string;
}

/** Harnesses and tests opt in with `globalThis.__slateWaterCompileLog = []`; without it nothing is recorded. */
const WATER_COMPILE_LOG = "__slateWaterCompileLog";

/** Appends one request to the compile log when one is installed. Called when a pass's defines change, i.e. per variant. */
function recordWaterVariant(defines: MaterialDefines, water: WaterDefinition, mesh: AbstractMesh | null, scene: Scene): void {
  const log = (globalThis as unknown as Record<string, WaterVariantRequest[] | undefined>)[WATER_COMPILE_LOG];
  if (!log) return;
  const pass = scene.getEngine().currentRenderPassId;
  const on = (name: string) => Boolean(defines[name]);
  log.push({
    at: performance.now(), mesh: mesh?.name ?? "", pass, mainPass: isMainWaterPass(scene, pass),
    look: water.style !== "stylized" ? "realistic" : toonLook(water) ? "toon" : "painted",
    refraction: on(REFRACTION), ssr: on(SSR), planar: on(PLANAR), fft: on(FFT), blend: on(WATER_BLEND_DEFINE),
    shadows: Object.keys(defines).filter((name) => name.startsWith("SHADOW") && defines[name]),
    depthPrePass: on("DEPTHPREPASS"), prePass: on("PREPASS"),
    caller: String(new Error().stack ?? "").split("\n").slice(2, 12).map((frame) => frame.trim().replace(/^at /, "")).join(" < "),
  });
}

type VertexPoint = "CUSTOM_VERTEX_DEFINITIONS" | "CUSTOM_VERTEX_UPDATE_WORLDPOS" | "CUSTOM_VERTEX_MAIN_END";
const FRAGMENT_POINTS = [
  "CUSTOM_FRAGMENT_DEFINITIONS", "CUSTOM_FRAGMENT_UPDATE_ALPHA", "CUSTOM_FRAGMENT_BEFORE_LIGHTS", "CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS",
  "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION", "CUSTOM_FRAGMENT_BEFORE_FOG",
] as const;
/**
 * The code a stage injects into the PBR shader, by injection point. `look` (fragment only) keeps that look's shading
 * alone; null keeps every look under its defines.
 */
function waterInjection(stage: "vertex" | "fragment", language: ShaderLanguage, look: WaterLook | null): Record<string, string> {
  const wgsl = language === ShaderLanguage.WGSL;
  const v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4";
  // Babylon's shader processors are line-based: every attribute, varying and sampler needs its own line.
  const varying = (type: string, name: string) => (wgsl ? `varying ${name}: ${type};` : `varying ${type} ${name};`) + "\n";
  // vSlateWaterFlow packs the world current (x, z) and the Gerstner offset (Dx, Dz), so the fragment finds its rest point.
  const varyings = varying(v4, "vSlateWater") + varying(v4, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal")
    + `#ifdef ${WATER_BLEND_DEFINE}\n` + varying(v4, "vSlateWaterBlend") + "#endif\n";
  const blendAttribute = `#ifdef ${WATER_BLEND_DEFINE}\n${wgsl ? "attribute slateWaterBlend: vec4f;" : "attribute vec4 slateWaterBlend;"}\n#endif\n`;
  if (stage === "vertex") {
    const vertex = waterVertexSource(language);
    return {
      CUSTOM_VERTEX_DEFINITIONS: (wgsl
        ? "attribute slateWaterData: vec4f;\nattribute slateWaterFlow: vec3f;\nattribute slateWaterBaseNormal: vec3f;\nattribute slateWaterOffset: vec2f;\n"
        : "attribute vec4 slateWaterData;\nattribute vec3 slateWaterFlow;\nattribute vec3 slateWaterBaseNormal;\nattribute vec2 slateWaterOffset;\n") + blendAttribute + varyings + vertex.definitions,
      CUSTOM_VERTEX_UPDATE_WORLDPOS: vertex.worldPosition,
      CUSTOM_VERTEX_MAIN_END: vertex.end,
    } satisfies Record<VertexPoint, string>;
  }
  const source = waterShaderSource(language, look);
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: varyings + source.helpers,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: source.cut,
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: source.main,
    // Realistic: filtered chop widens the GGX lobe with distance, and foam is fully rough.
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS:
      "metallicRoughness.g = mix(sqrt(sqrt(metallicRoughness.g * metallicRoughness.g * metallicRoughness.g * metallicRoughness.g * swSharp + 2.0 * swSlopeVariance)), 1.0, swMatte);",
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
      // The glitter's weight rises smoothly with the lobe's luminance (a threshold on it drew an outline around every contour of the slope).
      `finalSpecularScaled *= mix(1.0, swSpecMod, swSpecModW * 0.6 * dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) / (dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) + 0.15));`,
      "#endif",
      "#endif",
    ].join("\n"),
    CUSTOM_FRAGMENT_BEFORE_FOG: beforeFogSource(wgsl),
  } satisfies Record<(typeof FRAGMENT_POINTS)[number], string>;
}

/**
 * Removes `//` comments and blank lines from generated shader code. The source has no string literals, block comments
 * or line continuations, so the first `//` of a line always starts a comment; directives keep their own lines.
 */
export function stripShaderComments(source: string): string {
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    const comment = line.indexOf("//");
    const code = (comment < 0 ? line : line.slice(0, comment)).trimEnd();
    if (code) lines.push(code);
  }
  return lines.join("\n");
}

const injections = new Map<string, Readonly<Record<string, string>>>();
/**
 * `waterInjection`'s points with comments stripped, built once per stage, language and look. Every look is for Babylon
 * collecting the point names when the plugin is added (no compile yet), so it builds on the first read of a value.
 */
function injectionFor(stage: "vertex" | "fragment", language: ShaderLanguage, look: WaterLook | null): Readonly<Record<string, string>> {
  const key = `${stage}:${language === ShaderLanguage.WGSL ? "wgsl" : "glsl"}:${look ?? "all"}`;
  let injection = injections.get(key);
  if (!injection) {
    const build = () => Object.fromEntries(Object.entries(waterInjection(stage, language, look)).map(([point, code]) => [point, stripShaderComments(code)]));
    injection = stage === "fragment" && !look ? lazyInjection(FRAGMENT_POINTS, build) : Object.freeze(build());
    injections.set(key, injection);
  }
  return injection;
}
function lazyInjection(points: readonly string[], build: () => Record<string, string>): Readonly<Record<string, string>> {
  let built: Record<string, string> | undefined;
  return Object.defineProperties({}, Object.fromEntries(points.map((point) => [point, { enumerable: true, get: () => (built ??= build())[point] }])));
}

/** The look a definition draws: Realistic, or Stylized's Painted or Toon. */
const waterLook = (w: WaterDefinition): WaterLook => (w.style !== "stylized" ? "realistic" : w.stylizedLook === "toon" ? "toon" : "painted");
const resolvesUltra = new Map<string, boolean>();
/**
 * Whether a look's code (either stage) tests the shading tier for anything but `>= 0` to `>= 2`, i.e. tells Ultra from
 * High. Painted and Toon have no Ultra term; any other test, or a use of the define outside `#if`, counts as one.
 */
function lookResolvesUltra(look: WaterLook, language: ShaderLanguage): boolean {
  const key = `${language === ShaderLanguage.WGSL ? "wgsl" : "glsl"}:${look}`;
  let resolves = resolvesUltra.get(key);
  if (resolves === undefined) {
    const code = [injectionFor("vertex", language, null), injectionFor("fragment", language, look)].flatMap((injection) => Object.values(injection));
    resolves = code.some((text) => [...text.matchAll(new RegExp(`${WATER_QUALITY_DEFINE}(.*)`, "g"))].some((use) => !/^ >= [012]\s*$/.test(use[1]!)));
    resolvesUltra.set(key, resolves);
  }
  return resolves;
}

/** Defines of the effect whose shader code Babylon is assembling at this moment (synchronously, see below), else null. */
let compileDefines: readonly string[] | null = null;
type ProcessShaderCode = (shaderType: string, code: string, defines?: string[]) => string;
/** The part of Babylon's `MaterialPluginManager` that makes the callback an effect assembles its code with (`protected` there). */
interface CodeInjectingManager { _injectCustomCode(eventData: unknown, existingCallback?: ProcessShaderCode): ProcessShaderCode }
const trackedManagers = new WeakSet<object>();
/**
 * Makes the defines of the effect being compiled visible to `getCustomCode` while it runs. Babylon's effect calls the
 * manager's callback with the defines that make up its cache key (`engine.createEffect` keys by name and defines) but
 * the manager drops them before `getCustomCode(shaderType, language)`. Reading the look from the plugin's own state
 * instead could disagree with the key: the effect assembles its code asynchronously, and a Stylized Look edit in place
 * changes the state meanwhile. Wrapped once per manager, as `eventData.customCode` is created per effect.
 */
function trackCompileDefines(material: Material): void {
  const manager = material.pluginManager as unknown as CodeInjectingManager | null;
  if (!manager || trackedManagers.has(manager)) return;
  trackedManagers.add(manager);
  const injectCustomCode = manager._injectCustomCode;
  manager._injectCustomCode = function (this: CodeInjectingManager, eventData, existingCallback) {
    const process = injectCustomCode.call(this, eventData, existingCallback);
    return (shaderType, code, defines) => {
      const outer = compileDefines;
      compileDefines = defines ?? null;
      try { return process(shaderType, code, defines); } finally { compileDefines = outer; }
    };
  };
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
      [WATER_SPECTRUM_DEFINE]: false,
    }, true, false);
    this.water = water;
    this.body = body;
    trackCompileDefines(material);
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
  /**
   * The tier `SLATE_WATER_QUALITY` compiles: the shading tier, but Ultra compiles as High for a look with no Ultra term
   * (Painted and Toon: `lookResolvesUltra`), so both tiers share one effect and the shader is the same either way.
   */
  private compiledTier(): number {
    const look = waterLook(this.water);
    return this.tier > WATER_SHADING_TIERS.high && look !== "realistic" && !lookResolvesUltra(look, this._material.shaderLanguage) ? WATER_SHADING_TIERS.high : this.tier;
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
    // Spectrum water is the FFT at every quality, in both stages (its vertex taps pick mips by the mesh spacing).
    const spectrum = waterUsesSpectrum(w);
    const fft = spectrum || (q.fft && w.detailWaves > 0) ? q.fftCascades : 0;
    // The vertex mesh filter passes a cascade only below half its shortest wavelength (π / k_hi); the first cascade's
    // is the longest. Evaluated only on a quality or grid change (the layout allocates).
    const vertex = spectrum ? fft : fft > 0 && this._meshSpacing < Math.PI / waterFftLayout(waterWaveSet(w), q.fftSize, fft).bandEdges[1]! ? fft : 0;
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
    changed = setDefine(defines, Q, this.compiledTier()) || changed;
    for (let i = 0; i < FEATURES.length; i++) {
      const [field, define] = FEATURES[i]!;
      changed = setDefine(defines, define, w[field] > 0) || changed;
    }
    const copy = (this.refracts || this.marches) && isMainWaterPass(scene, scene.getEngine().currentRenderPassId);
    changed = setDefine(defines, REFRACTION, this.refracts && copy) || changed;
    changed = setDefine(defines, SSR, this.marches && copy) || changed;
    changed = setDefine(defines, SSR_STEPS, this.marches && copy ? this.marchSteps : 0) || changed;
    // Every pass at Planar quality compiles it, Render Target Capture passes included: their planar lookup is null
    // (mirrors are per scene view), so the per-draw uniform selects the march or sky fallback. Gating it per pass would
    // need a registry of planar-drawing pass ids, as the scene copy has.
    changed = setDefine(defines, PLANAR, this.mirrors) || changed;
    changed = setDefine(defines, FFT, this.fftCascades) || changed;
    changed = setDefine(defines, FFT_VERTEX, this.fftVertex) || changed;
    changed = setDefine(defines, WATER_BLEND_DEFINE, this._blend) || changed;
    changed = setDefine(defines, WATER_SPECTRUM_DEFINE, waterUsesSpectrum(w)) || changed;
    if (changed) {
      defines.markAsUnprocessed();
      recordWaterVariant(defines, w, this.mesh, scene);
    }
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
      ...SWELL_DIRECTION, ...SWELL_AMPLITUDE, ...SWELL_GROUP, ...SWELL_WARP, ...CHOP_UNIFORMS, ...FFT_UNIFORMS,
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
    samplers.push("slateWaterFieldSampler", "slateWaterContactSampler", WATER_SCENE_SAMPLER, WATER_PLANAR_SAMPLER, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER);
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
    // Spectrum water's foam: the placeholder's zero turbulence is neutralized by the zero gain bound with it.
    if (defines?.[WATER_SPECTRUM_DEFINE]) buffer.setTexture(WATER_FOAM_SAMPLER, this.boundFft?.foam ?? placeholderFft(scene));
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
    if (waterUsesSpectrum(this.water)) return this.spectrumState(scene, band);
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
  /**
   * Spectrum water's uniforms (`fftValues`): (Wave Scale while the band is ready, else 0: flat until the first dispatch;
   * λ; grid size; `SPECTRUM_LOD_SCALE`) and per cascade (1 / patch size, uv offset): the offset is the floating origin in
   * the cascade's turned frame, fract(R(−θ)·origin / L) + 0.5 / N in float64.
   */
  private spectrumState(scene: Scene, band: WaterFftResult | null): WaterFftResult | null {
    const v = this.fftValues, origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    v[0] = band ? this.waveScale : 0; v[1] = waterSpectrum(this.water).choppiness; v[2] = band?.size ?? 1; v[3] = SPECTRUM_LOD_SCALE;
    if (!band) return null;
    for (let c = 0; c < band.cascades && c < WATER_FFT_CASCADES_MAX; c++) {
      const o = (1 + c) * 4, patch = band.patchSizes[c]!, turn = WATER_FFT_CASCADE_TURNS[c]!, cos = Math.cos(turn), sin = Math.sin(turn);
      const px = (cos * origin.x + sin * origin.z) / patch, pz = (cos * origin.z - sin * origin.x) / patch, texel = 0.5 / band.size;
      v[o] = 1 / patch;
      v[o + 1] = px - Math.floor(px) + texel;
      v[o + 2] = pz - Math.floor(pz) + texel;
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
    const exact = scene.getEngine().useExactSrgbConversions;
    o = putLinear(v, o, w.shallowColor, w.opacity, exact);
    o = putLinear(v, o, w.deepColor, w.reflectionStrength, exact);
    o = putLinear(v, o, w.foamColor, w.foamAmount, exact);
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
    this.absorption(v, o, lighting, w, exact); o += 8;
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
      o = putLinear(v, o, partner.shallowColor, partner.opacity, exact);
      o = putLinear(v, o, partner.deepColor, partner.reflectionStrength, exact);
      o = putLinear(v, o, partner.foamColor, partner.foamAmount, exact);
      this.absorption(v, o, lighting, partner, exact);
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
  /** Toon's chop octaves: (dir.x, dir.z, k, clock phase), the phase reduced in float64. Allocation-free. */
  private octaveConstants(): Float64Array {
    const w = this.water, out = this.octaves, base = TAU * w.rippleScale / 6, heading = w.waveDirection * Math.PI / 180;
    for (let i = 0; i < ALL_OCTAVES.length; i++) {
      const [offset, multiplier, , speed, phase] = ALL_OCTAVES[i]!, k = base * multiplier, o = i * 4;
      out[o] = Math.cos(heading + offset); out[o + 1] = Math.sin(heading + offset); out[o + 2] = k;
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
  private absorption(v: Float64Array, o: number, lighting: WaterLighting, water: WaterDefinition, exact: boolean): void {
    const tint = water.shallowColor;
    gammaScratch.set(Math.max(0, tint[0]), Math.max(0, tint[1]), Math.max(0, tint[2])).toLinearSpaceToRef(linearScratch, exact);
    const r = linearScratch.r, g = linearScratch.g, b = linearScratch.b, top = Math.max(r, g, b);
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
   * including the cascades of the FFT detail band its vertex stage samples and the blend scaling. Allocation-free.
   */
  vertexWaveDefines(): readonly string[] {
    return VERTEX_WAVE_DEFINES[this._blend ? 1 : 0]![waterUsesSpectrum(this.water) ? 1 : 0]![this.fftVertex]!;
  }
  /** Mesh attributes `waterOutlineVertexSource` reads under `vertexWaveDefines`. Allocation-free. */
  vertexWaveAttributes(): readonly string[] {
    return VERTEX_WAVE_ATTRIBUTES[this._blend ? 1 : 0]!;
  }
  /**
   * Sets `WATER_VERTEX_WAVE_UNIFORMS` and the band's sampler on another pass's effect for this frame, as
   * `hardBindForSubMesh` and `bindForSubMesh` do (the band's footprint follows that pass's projection and target), and
   * the drawn `mesh`'s grid offset.
   */
  bindVertexWaves(effect: Effect, scene: Scene, mesh: AbstractMesh): void {
    bindWaterSwellUniforms(effect, waterGridOffset(mesh), this.swellConstants(scene), this.warp, this.bankFade(), this.water.choppiness);
    if (!this.fftVertex) return;
    const band = this.fftState(scene, this.fftCascades), v = this.fftValues;
    effect.setFloat4("slateWaterFft", v[0]!, v[1]!, v[2]!, v[3]!);
    for (let c = 0; c < WATER_FFT_CASCADES_MAX; c++) {
      const o = (1 + c) * 4;
      effect.setFloat4(FFT_CASCADE_UNIFORMS[c]!, v[o]!, v[o + 1]!, v[o + 2]!, v[o + 3]!);
    }
    effect.setTexture(WATER_FFT_SAMPLER, band?.texture ?? placeholderFft(scene));
  }
  /**
   * Injected code is a pure function of (stage, language, look), so it is built and stripped once per key
   * (`injectionFor`). Babylon calls this at every effect compile, once per injection point. The look comes from the
   * defines of the effect being assembled (`trackCompileDefines`), the same defines its cache key is made of, so two
   * effects of different looks never share code; outside a compile (Babylon collecting the injection points when the
   * plugin is added) it keeps every look.
   */
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== "vertex" && shaderType !== "fragment") return null;
    return injectionFor(shaderType, language, shaderType === "fragment" && compileDefines ? lookOfDefines(compileDefines) : null);
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
