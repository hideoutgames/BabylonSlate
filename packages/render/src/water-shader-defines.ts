/**
 * Built-in water's shader defines, sampler and uniform names, and the tuning constants its shader chunks embed.
 * `water-material.ts` re-exports the public names.
 */
import { ThinTexture } from "@babylonjs/core";
import {
  WATER_BLEND_COLOR_PARTNERS, WATER_FFT_CASCADES_MAX, waterFoamScale, waterFoamThreshold, waterSpectrum, type WaterDefinition, type WaterShadingDetail,
  type WaterSpectrum,
} from "@haptic/core";

/**
 * Metres over which an open-water edge (a finite body's bank over no terrain while a terrain field is bound, such as an
 * ocean's outer edge) fades out instead of drawing a shore.
 */
export const OPEN_EDGE_FADE = 6;
/** Metres over which a body's edge over water-covered terrain (short of the terrain's shoreline) fades out. */
export const OPEN_EDGE_FADE_TERRAIN = 2.5;
/** Metres of depth over which water thins to nothing at a gentle shore (`swShoreSoft`). */
export const SOFT_SHORE_DEPTH = 0.4;
/** Largest refracted screen shift (pixels of the scene copy) near the camera, and far away, over `REFRACTION_FAR` metres of view depth. */
export const REFRACTION_SHIFT_PX = [28, 3] as const;
export const REFRACTION_FAR = [6, 60] as const;
/**
 * Built-in water displaces its rest grid with the FFT spectrum in its vertex shader: the mesh uploads a static rest grid
 * and only the spectrum's textures change. Custom Material water keeps CPU-displaced vertices, unless its graph holds a
 * Water Waves node, whose block sets this define for the meshes that have a `WaterVertexWaves`.
 */
export const WATER_GPU_WAVES_DEFINE = "SLATE_WATER_GPU_WAVES";
/**
 * The surface blends with other water bodies (`evaluateWaterBlend`): the mesh carries `slateWaterBlend` per vertex
 * (swell height scale, Gerstner offset scale, ownership margin, colour share of partner 0) and `slateWaterBlendColors`
 * (colour shares of partners 1 and 2), its bank distance is the blended
 * union shoreline and its rest grid already holds the blended rest height. Compiled only into bodies with neighbours, so
 * water that blends with nothing pays nothing.
 */
export const WATER_BLEND_DEFINE = "SLATE_WATER_BLEND";
/** A Custom Material's Water Colors node mixes toward a blending mesh's colour partners (`WaterColorsBlock`). */
export const WATER_NODE_BLEND_DEFINE = "SLATE_WATER_NODE_BLEND";
/** Where a water node graph reads `slateWaterBlend`: its Water Waves node's blend scaling, or its Water Colors node's shares. */
export const WATER_BLEND_ATTRIBUTE_CONDITION = `defined(${WATER_BLEND_DEFINE}) || defined(${WATER_NODE_BLEND_DEFINE})`;
/** Colour partners a blending surface mixes toward (`WaterMaterialPlugin.partners`). */
export const BLEND_PARTNERS = WATER_BLEND_COLOR_PARTNERS;
/**
 * The colours a blending surface mixes toward, per partner (`WaterMaterialPlugin.partners`), each by its per-vertex
 * colour share: partner k's uniforms are `slateWaterBlendShallow${k}` and so on, in `COLOR_UNIFORMS` order.
 */
export const BLEND_COLOR_UNIFORMS = Array.from({ length: BLEND_PARTNERS }, (_, k) =>
  ["slateWaterBlendShallow", "slateWaterBlendDeep", "slateWaterBlendFoam", "slateWaterBlendAbsorb", "slateWaterBlendThrough"].map((name) => `${name}${k}`)).flat();
/** Per-asset colour uniforms the fragment reads through blended locals (`blendColors`), in `BLEND_COLOR_UNIFORMS` order. */
export const COLOR_UNIFORMS = ["slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterAbsorb", "slateWaterThrough"] as const;
export const COLOR_LOCALS = ["swShallowU", "swDeepU", "swFoamU", "swAbsorbU", "swThroughU"] as const;
/**
 * Numeric shading tier, 0-3, from the device-clamped project Water Shading Detail (`WATER_SHADING_TIERS`). Shader terms
 * compile per tier (`#if SLATE_WATER_QUALITY >= n`); terms a tier drops add their slope variance to the filtered
 * roughness, so lower tiers look like filtered higher tiers rather than glassier water.
 */
export const WATER_QUALITY_DEFINE = "SLATE_WATER_QUALITY";
export const WATER_SHADING_TIERS: Readonly<Record<WaterShadingDetail, number>> = { low: 0, medium: 1, high: 2, ultra: 3 };
/** Tier the constructor declares (and that unbound materials compile): High. */
export const DEFAULT_TIER = WATER_SHADING_TIERS.high;
export const Q = WATER_QUALITY_DEFINE;
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
export const { refraction: REFRACTION, screenSpace: SSR, screenSpaceSteps: SSR_STEPS, planar: PLANAR } = WATER_OBJECT_DEFINES;
/** Sampler of the view's scene copy (rgb linear colour, a linear view depth); one binding serves both features. */
export const WATER_SCENE_SAMPLER = "slateWaterSceneSampler";
/** Sampler of the view's planar reflection. */
export const WATER_PLANAR_SAMPLER = "slateWaterPlanarSampler";
/** Preprocessor tests for the copy's sampler and for an object reflection term. */
export const SAMPLES_COPY = `defined(${REFRACTION}) || defined(${SSR})`;
export const REFLECTS_OBJECTS = `defined(${SSR}) || defined(${PLANAR})`;
/** Binary refinement steps after the march's first hit. */
export const SSR_REFINE_STEPS = 4;
/** Longest reflected ray the march follows (world units), shortened to the view's far plane. */
export const SSR_MAX_DISTANCE = 500;
/**
 * Thickness (metres) an object is assumed to have behind its visible surface, base plus per metre of view depth (also
 * well above the copy's half-float depth precision): a reflected ray this far behind a surface still hits it.
 */
export const SSR_THICKNESS = [0.2, 0.03] as const;
/** Bound where a copy or planar feature has no source this draw: Babylon binds its empty texture (alpha 0). */
export const EMPTY_TEXTURE = new ThinTexture(null);
/**
 * How far along the reflected ray (times the eye's distance to the water point) the planar lookup follows it: content
 * that far away moves with half the ray's tilt, the sky (beyond) somewhat less than it should and objects at the
 * waterline somewhat more (within the contact range of an object in the water the reach shortens toward its distance).
 */
export const PLANAR_REACH = 1;
/** Refraction: screen offset per unit of view-space tilt, per metre of water behind the surface, at Refraction 1. */
export const REFRACTION_SHIFT = 1.2;
/** Water thickness (metres) beyond which the refracted shift stops growing. */
export const REFRACTION_DEPTH_CAP = 3;
/**
 * The FFT spectrum's cascades (`waterFftForSurface`) every stage samples (`#if SLATE_WATER_FFT >= c`): the
 * device-effective FFT Cascades, at least 1. The define follows quality only, never readiness: until the spectrum is
 * ready the shader samples a placeholder at gain 0, which leaves the surface flat, and a spectrum that becomes ready (or
 * is rebuilt) never recompiles the water.
 */
export const WATER_FFT_DEFINE = "SLATE_WATER_FFT";
/** The spectrum's 2D-array texture: one binding shared by the vertex stage (displacement) and the fragment (slopes). */
export const WATER_FFT_SAMPLER = "slateWaterFftSampler";
/** The spectrum's persistent turbulence (one layer per cascade), which the fragment's foam reads. */
export const WATER_FOAM_SAMPLER = "slateWaterFoamSampler";
export const FFT = WATER_FFT_DEFINE;
/**
 * Per cascade c, (1 / patch size, uv offset x, uv offset z, 0): the uv offset is fract(R(−θ_c)·floating origin / patch
 * size) + 0.5 / N from the CPU in float64, so eye-relative rest points sample the world-anchored spectrum without large
 * coordinates.
 */
export const FFT_CASCADE_UNIFORMS = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => `slateWaterFftCascade${c}`);
/**
 * Uniforms of the spectrum: `slateWaterFft` = (Wave Scale while the spectrum is ready, else 0; λ; grid size;
 * `SPECTRUM_LOD_SCALE`) and the cascades'.
 */
export const FFT_UNIFORMS = ["slateWaterFft", ...FFT_CASCADE_UNIFORMS];
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
export const TURBIDITY = 1.6;


/** `code` from `tier` up, `otherwise` below it; every directive on its own line. Code blocks start with a newline. */
export function fromTier(tier: number, code: string, otherwise = ""): string {
  if (tier <= 0) return code;
  return `\n#if ${Q} >= ${tier}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;
}
export const ifDefined = (define: string, code: string, otherwise = "") => `\n#ifdef ${define}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;


/**
 * Specular antialiasing: a lobe drawn on a normal that varies across the pixel widens by that variation, the per-axis
 * slope variance a Gaussian pixel filter of this variance (pixels²) sees through the slope's screen derivatives
 * (Toksvig- and Kaplanyan-style), so normal detail the pixel cannot sample densely enough never sparkles into salt.
 */
export const PIXEL_SLOPE_FILTER = 0.15;
/** Caps of that variance (sun lobes widen at most this much from it). */
export const PIXEL_SLOPE_CAP = 0.012;

export const f = (n: number) => n.toFixed(6);

const foamThresholds = new WeakMap<WaterSpectrum, { crest: number; scale: number; size: number; cascades: number; value: number }>();
/**
 * `waterFoamThreshold` of an asset on a body of `waveScale` drawn by a `fftSize`-texel, `cascades`-cascade simulation,
 * cached on its spectrum, and finite for the shaders (Crest Foam 0, no whitecaps, is a sum no sea reaches). Shaders
 * compare it to the foam sum divided by `waterFoamScale(waveScale)`.
 */
export function waterFoamThresholdOf(water: WaterDefinition, waveScale = 1, fftSize = 256, cascades = WATER_FFT_CASCADES_MAX): number {
  const spectrum = waterSpectrum(water), scale = waterFoamScale(waveScale);
  let cached = foamThresholds.get(spectrum);
  if (!cached || cached.crest !== water.crestFoam || cached.scale !== scale || cached.size !== fftSize || cached.cascades !== cascades) {
    const value = Math.min(waterFoamThreshold(spectrum, water.crestFoam, { waveScale: scale, fftSize, cascades }), 1e4);
    cached = { crest: water.crestFoam, scale, size: fftSize, cascades, value };
    foamThresholds.set(spectrum, cached);
  }
  return cached.value;
}

/** FFT-Ocean's foam: coverage per unit of turbulence below the bias. */
export const SPECTRUM_FOAM_SCALE = 2.4;
/**
 * The least `crest` edge foam reads (how far the foam sum lies past the crest threshold): about where calm water lies
 * at the default Crest Foam, so shore and contact foam keep their look when Crest Foam is 0 (no threshold) or the sea is
 * glassy.
 */
export const EDGE_FOAM_CALM = -0.5;
