import {
  BaseTexture, Color3, Constants, DirectionalLight, HemisphericLight, MaterialPluginBase, Matrix, PBRMaterial, type MaterialDefines, RawTexture, ShaderLanguage,
  Texture, ThinTexture, Vector3, type AbstractEngine, type AbstractMesh, type Effect, type Material, Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import {
  WATER_BLEND_COLOR_PARTNERS, WATER_FFT_CASCADES_MAX, WATER_FOAM_WEIGHTS, waterBankFadeLength, waterFoamScale, waterFoamThreshold, waterSpectrum, type WaterBodyProperties,
  type WaterDefinition, type WaterQuality, type WaterShadingDetail, type WaterSpectrum,
} from "@haptic/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { waterFftForSurface, type WaterFftResult } from "./water-fft";
import { WATER_FFT_CASCADE_TURNS } from "./water-fft-spectrum";
import { invalidateSceneLighting } from "./scene-lighting";
import type { WaterContactField } from "./water-contact-field";
import { WATER_FIELD_DEPTH_RANGE, WATER_FIELD_FINE_DEPTH_SPAN, WATER_FIELD_SHORE_RANGE as SHORE, WATER_FIELD_TERRAIN_ALPHA, type WaterField } from "./water-field";
import { waterPlanarReflectionForCamera, type WaterPlanarReflection } from "./water-planar-reflection";
import type { WaterQualityDeviceClamp } from "./water-quality-device";
import { sceneHasWaterRemovals, sceneWaterRemovals, waterRemovalShapeVector, waterRemovalWorldRadius } from "./water-removal-mesh";
import { WATER_SCENE_COPY_SKY_DEPTH, isMainWaterPass, waterSceneCopyForPass, type WaterSceneCopy } from "./water-scene-copy";


/**
 * Metres over which an open-water edge (a finite body's bank over no terrain while a terrain field is bound, such as an
 * ocean's outer edge) fades out instead of drawing a shore.
 */
const OPEN_EDGE_FADE = 6;
/** Metres over which a body's edge over water-covered terrain (short of the terrain's shoreline) fades out. */
const OPEN_EDGE_FADE_TERRAIN = 2.5;
/** Metres of depth over which water thins to nothing at a gentle shore (`swShoreSoft`). */
const SOFT_SHORE_DEPTH = 0.4;
/** Largest refracted screen shift (pixels of the scene copy) near the camera, and far away, over `REFRACTION_FAR` metres of view depth. */
const REFRACTION_SHIFT_PX = [28, 3] as const;
const REFRACTION_FAR = [6, 60] as const;
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
const BLEND_PARTNERS = WATER_BLEND_COLOR_PARTNERS;
/**
 * The colours a blending surface mixes toward, per partner (`WaterMaterialPlugin.partners`), each by its per-vertex
 * colour share: partner k's uniforms are `slateWaterBlendShallow${k}` and so on, in `COLOR_UNIFORMS` order.
 */
const BLEND_COLOR_UNIFORMS = Array.from({ length: BLEND_PARTNERS }, (_, k) =>
  ["slateWaterBlendShallow", "slateWaterBlendDeep", "slateWaterBlendFoam", "slateWaterBlendAbsorb", "slateWaterBlendThrough"].map((name) => `${name}${k}`)).flat();
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
const FFT = WATER_FFT_DEFINE;
/**
 * Per cascade c, (1 / patch size, uv offset x, uv offset z, 0): the uv offset is fract(R(−θ_c)·floating origin / patch
 * size) + 0.5 / N from the CPU in float64, so eye-relative rest points sample the world-anchored spectrum without large
 * coordinates.
 */
const FFT_CASCADE_UNIFORMS = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => `slateWaterFftCascade${c}`);
/**
 * Uniforms of the spectrum: `slateWaterFft` = (Wave Scale while the spectrum is ready, else 0; λ; grid size;
 * `SPECTRUM_LOD_SCALE`) and the cascades'.
 */
const FFT_UNIFORMS = ["slateWaterFft", ...FFT_CASCADE_UNIFORMS];
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


/** `code` from `tier` up, `otherwise` below it; every directive on its own line. Code blocks start with a newline. */
function fromTier(tier: number, code: string, otherwise = ""): string {
  if (tier <= 0) return code;
  return `\n#if ${Q} >= ${tier}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;
}
const ifDefined = (define: string, code: string, otherwise = "") => `\n#ifdef ${define}${code}${otherwise ? `\n#else${otherwise}` : ""}\n#endif`;


/**
 * Specular antialiasing: a lobe drawn on a normal that varies across the pixel widens by that variation, the per-axis
 * slope variance a Gaussian pixel filter of this variance (pixels²) sees through the slope's screen derivatives
 * (Toksvig- and Kaplanyan-style), so normal detail the pixel cannot sample densely enough never sparkles into salt.
 */
const PIXEL_SLOPE_FILTER = 0.15;
/** Caps of that variance (sun lobes widen at most this much from it). */
const PIXEL_SLOPE_CAP = 0.012;

const f = (n: number) => n.toFixed(6);

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
const SPECTRUM_FOAM_SCALE = 2.4;
/**
 * The least `crest` edge foam reads (how far the foam sum lies past the crest threshold): about where calm water lies
 * at the default Crest Foam, so shore and contact foam keep their look when Crest Foam is 0 (no threshold) or the sea is
 * glassy.
 */
const EDGE_FOAM_CALM = -0.5;
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
` + edgeFoamHelpers("sw");

/**
 * Shore and contact foam, shared by built-in water and the Water Foam node (`prefix` names the functions and the
 * caller's `<prefix>Hash` and `<prefix>Noise`), GLSL-shaped for `toWgsl`.
 *
 * `<prefix>EdgeFoamCover(p, amount, crest, foot)` is foam as the open sea draws it, only denser: `crest` is how far the
 * body's turbulence lies past its Crest Foam threshold (the whitecaps are where it is positive), and `amount` (0 none,
 * 1 all) lowers that threshold, most only at the waterline, so edge foam grows out of the whitecaps' soft streaky
 * shapes and follows the waves. Smooth noise at three scales in flowed world metres (`p`) breaks it into wisps where the
 * waves are calm, each faded where `foot` (metres per pixel) would alias it, and thin foam is partly clear. No cells,
 * so no holes or rows.
 *
 * `<prefix>ShoreFoamAmount(p, t, depth, width)` is the shore's amount: thick at the waterline, thinning to nothing where the
 * water is about 1.6 `width` deep (between 1 and 2.4 along the shore), with bands that wash in toward the shore, out of
 * step along it. `<prefix>ContactFoamAmount(p, t, dist, width)` is an object's: a tight band at its waterline, thinning
 * out within 0.35 to 1.9 `width`, varying along the object and slowly over time, so no even ring surrounds it.
 */
export function edgeFoamHelpers(prefix: string): string {
  return `
float ${prefix}EdgeFoamCover(vec2 p, float amount, float crest, float foot) {
  if (amount <= 0.0) { return 0.0; }
  float a = clamp(amount, 0.0, 1.0);
  float detail = 1.0 - smoothstep(0.15, 0.6, foot * 3.0);
  float wisp = 1.0 - smoothstep(0.15, 0.6, foot * 8.0);
  float soft = ((${prefix}Noise(p * 0.7) - 0.5) * 0.8 + (${prefix}Noise(p * 2.3 + vec2(3.7, 8.1)) - 0.5) * 0.45) * detail
    + (${prefix}Noise(p * 6.1 + vec2(9.4, 2.6)) - 0.5) * 0.3 * wisp;
  float cover = clamp((crest + soft + mix(-0.35, 0.85, a * sqrt(a))) * ${f(SPECTRUM_FOAM_SCALE)}, 0.0, 1.0);
  return cover * (0.55 + 0.45 * a) * smoothstep(0.0, 0.08, a);
}
float ${prefix}ShoreFoamAmount(vec2 p, float t, float depth, float width) {
  float s = max(depth, 0.0) / max(width * mix(0.6, 1.5, ${prefix}Noise(p * 0.2 + vec2(1.7, 9.2))), 0.001);
  float phase = fract(t * 0.08 + ${prefix}Noise(p * 0.06) * 2.0);
  float wash = (1.0 - smoothstep(0.0, 0.16, abs(s - 1.2 * (1.0 - phase)))) * sin(phase * 3.14159) * 0.55;
  float close = 1.0 - smoothstep(0.0, 1.6, s);
  return max(close * close, wash);
}
float ${prefix}ContactFoamAmount(vec2 p, float t, float dist, float width) {
  float band = 1.0 - smoothstep(0.03, 0.06 + width * 0.08, dist);
  float close = 1.0 - smoothstep(0.0, width * mix(0.35, 1.9, ${prefix}Noise(p * 0.25 + vec2(t * 0.03, 4.4))), dist);
  return max(close * close, band * 0.95);
}
`;
}



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

/** `code` only when the spectrum's cascade `cascades` is compiled in; every directive on its own line. */
const ifFft = (code: string, cascades: number) => `\n#if ${FFT} >= ${cascades}${code}\n#endif`;

/**
 * The spectrum's samplers and taps, per language, for either stage: `swFftTapLod` at an explicit level (legal in any
 * control flow and in the vertex stage), and in the fragment `swSpecTap` and `swFoamTap` with implicit derivatives
 * (mipmapped). Both stages declare the same binding (one WebGL2 texture unit, one WebGPU binding visible to both). GLSL
 * ES has no default precision for array samplers.
 */
function fftHelpers(wgsl: boolean, declare = true): string {
  const declaration = !declare ? "" : wgsl ? `
var ${WATER_FFT_SAMPLER}Sampler: sampler;
var ${WATER_FFT_SAMPLER}: texture_2d_array<f32>;` : `
uniform highp sampler2DArray ${WATER_FFT_SAMPLER};`;
  return wgsl ? `${declaration}
fn swFftTapLod(uv: vec2f, layer: f32, lod: f32) -> vec4f { return textureSampleLevel(${WATER_FFT_SAMPLER}, ${WATER_FFT_SAMPLER}Sampler, uv, i32(layer), lod); }
` : `${declaration}
vec4 swFftTapLod(vec2 uv, float layer, float lod) { return textureLod(${WATER_FFT_SAMPLER}, vec3(uv, layer), lod); }
`;
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
export function marchSource(wgsl: boolean): string {
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
 * The spectrum's samplers for the fragment stage: the FFT ocean and its persistent foam,
 * sampled with implicit derivatives so their mips filter far water (normals and foam fade into their averages instead
 * of aliasing). Only called from the shader's top level (uniform control flow), as implicit derivatives require.
 */
function spectrumHelpers(wgsl: boolean, declare = true): string {
  const declaration = !declare ? "" : wgsl ? `
var ${WATER_FOAM_SAMPLER}Sampler: sampler;
var ${WATER_FOAM_SAMPLER}: texture_2d_array<f32>;` : `
uniform highp sampler2DArray ${WATER_FOAM_SAMPLER};`;
  return wgsl ? `${declaration}
fn swSpecTap(uv: vec2f, layer: f32) -> vec4f { return textureSample(${WATER_FFT_SAMPLER}, ${WATER_FFT_SAMPLER}Sampler, uv, i32(layer)); }
fn swFoamTap(uv: vec2f, layer: f32) -> vec4f { return textureSample(${WATER_FOAM_SAMPLER}, ${WATER_FOAM_SAMPLER}Sampler, uv, i32(layer)); }
` : `${declaration}
vec4 swSpecTap(vec2 uv, float layer) { return texture(${WATER_FFT_SAMPLER}, vec3(uv, layer)); }
vec4 swFoamTap(vec2 uv, float layer) { return texture(${WATER_FOAM_SAMPLER}, vec3(uv, layer)); }
`;
}

/**
 * What shallow water lets through, declared as `out` (a vec3): the light from what lies `depth` metres below, seen at
 * `nDotV` across the surface, down and back through the water by Snell's law, per channel absorbed by `absorb`
 * (`waterAbsorption`, its path capped at `pathCap`) and evenly by turbidity, over Depth Color Distance `distance`; none
 * beyond 0.85 of it.
 */
export function transmittanceSource(depth: string, nDotV: string, distance: string, absorb: string, pathCap: string, out: string): string {
  return `
float ${out}CosT = sqrt(1.0 - (1.0 - ${nDotV} * ${nDotV}) * 0.5625);
float ${out}Path = ${depth} * (1.0 + 1.0 / ${out}CosT) / (${distance} * 5.0);
float ${out}Visible = 1.0 - smoothstep(0.35, 0.85, ${depth} / ${distance});
vec3 ${out} = exp(-min(${out}Path, ${pathCap}) * ${absorb} - vec3(${out}Path * ${f(TURBIDITY)})) * ${out}Visible;`;
}

/**
 * Per-channel absorption of `water` for `transmittanceSource` (`slateWaterAbsorb`) into `out` (r, g, b, and Opacity's
 * cap on the absorption path, where the slowest channel reaches 1 − Opacity), from Shallow Color in linear space:
 * channels it lacks absorb fastest (`absorbCoefficient`), normalized so the slowest channel absorbs over five Depth Color
 * Distances: clear shallows keep the bed's light in the colour the water keeps. A grey Shallow Color absorbs evenly.
 * Allocation-free.
 */
export function waterAbsorption(water: WaterDefinition, exact: boolean, out: Float64Array): Float64Array {
  const tint = water.shallowColor;
  gammaScratch.set(Math.max(0, tint[0]), Math.max(0, tint[1]), Math.max(0, tint[2])).toLinearSpaceToRef(linearScratch, exact);
  const r = linearScratch.r, g = linearScratch.g, b = linearScratch.b, top = Math.max(r, g, b);
  const k = absorbCoefficient;
  const kr = k(r, top), kg = k(g, top), kb = k(b, top), weight = Math.min(kr, kg, kb);
  out[0] = kr / weight; out[1] = kg / weight; out[2] = kb / weight;
  out[3] = -Math.log(Math.max(1 - water.opacity, 1e-6)) / Math.min(out[0]!, out[1]!, out[2]!);
  return out;
}

/** FFT-Ocean's far roughness: normal detail its mips average away. */
export const WATER_FAR_ROUGHNESS = 0.31;
/** FFT-Ocean's distance gloss: roughness reaches halfway to `WATER_FAR_ROUGHNESS` at 1 / this many metres. */
export const WATER_GLOSS_FALLOFF = 0.0044;

/**
 * FFT-Ocean's reflectance, declared as `out`: the environment BRDF of a facet at `roughness` seen at `nDotV` (Karis's fit
 * of the split-sum table, F0 = 0.02), so rough far water at grazing angles reflects less than a mirror would.
 */
export function fresnelSource(roughness: string, nDotV: string, out: string): string {
  return `
vec4 ${out}R = ${roughness} * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
float ${out}A = min(${out}R.x * ${out}R.x, exp2(-9.28 * ${nDotV})) * ${out}R.x + ${out}R.y;
vec2 ${out}Ab = vec2(-1.04, 1.04) * ${out}A + ${out}R.zw;
float ${out} = clamp(0.02 * ${out}Ab.x + ${out}Ab.y, 0.0, 1.0);`;
}

/**
 * How much of the sky a reflected ray keeps, declared as `out`: a ray leaving below the horizon (`rayY`, its unlifted
 * height) would meet other water, which reflects less than the sky above it. Seen from below (`viewY` < 0) it keeps all.
 */
export function reflectionKeepSource(rayY: string, viewY: string, out: string): string {
  return `
float ${out} = mix(1.0, 0.55, smoothstep(0.0, -0.2, ${rayY}) * step(0.0, ${viewY}));`;
}

/**
 * FFT-Ocean's subsurface light, declared as `out` (a float): light scattered through the crests of the small waves
 * (`crest`, their height in metres over the swell) toward a viewer (`view`, toward the eye) facing the sun (`sun`, toward
 * it) across the wave (`normal`), times Subsurface (`strength`) and the spectrum's readiness (`ready`). Only crests lit
 * from behind glow: looking down or away from the sun, the light leaves the water toward the sun instead.
 */
function subsurfaceSource(sun: string, view: string, normal: string, crest: string, strength: string, ready: string, out: string): string {
  return `
vec3 ${out}V = ${view};
float ${out}H = clamp(dot(${out}V, normalize(${normal} + ${sun})), 0.0, 1.0);
float ${out}Back = clamp(0.5 - 0.5 * dot(${out}V, ${sun}), 0.0, 1.0);
float ${out} = ${out}H * ${out}H * ${out}H * ${out}H * ${out}H * 4.5 * ${out}Back * ${out}Back * ${strength}
  * max(${crest} + 0.261, 0.0) / 4.7 * clamp(${ready}, 0.0, 1.0);`;
}

/** FFT-Ocean's distance LOD: cascade c > 0 fades by `SPECTRUM_LOD_SCALE` · its patch over the eye distance. */
const SPECTRUM_LOD_SCALE = 7.13;
/**
 * Steepest shading slope (about 56°): a sea far too tall for its Wave Length would otherwise turn every normal toward
 * the horizon and mirror only the sky. Real seas stay well below it (an RMS slope near 0.25).
 */
const SHADING_SLOPE_CAP = 1.5;
/** Eye distances, in first-cascade patches, over which whitecaps fade out before their repeat would show. */
const FOAM_FAR_PATCHES = [6, 16] as const;

/**
 * The spectrum's displacement in the vertex stage: every cascade's (Dx, H, Dz) at this vertex's rest point, turned back
 * from the cascade's frame, read at the mip that matches the mesh spacing (so a coarse grid takes each cascade's filtered
 * average, never an aliased sample) and faded with eye distance (`distance`, a GLSL expression) by FFT-Ocean's LOD
 * (`SPECTRUM_LOD_SCALE`): small cascades stop moving far geometry the eye cannot resolve. Height scales by
 * `slateWaterFft.x` (Wave Scale while the spectrum is ready, else 0: flat until the first dispatch), the offset also by
 * λ (`.y`); the bank fade and blending then scale them. `normal` (a Custom Material's Water Waves node) also sums every
 * cascade's slopes and offset gradient (layer 2c + 1, as the fragment does) into `swvG` and `swvJ` for
 * `spectrumNormalSource`.
 */
function spectrumVertexSource(distance: string, normal: boolean): string {
  const cascades = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => {
    const code = `
vec4 swvSc${c} = U.${FFT_CASCADE_UNIFORMS[c]};
float swvSw${c} = ${c === 0 ? "1.0" : `clamp(swvSp.w / max(swvSc${c}.x * swvDist, 0.000001), 0.0, 1.0)`};
float swvSm${c} = max(0.0, log2(max(swvSpacing * swvSc${c}.x * swvSp.z, 1.0)));
vec2 swvSu${c} = ${fftTurnIn(c, "swvRest")} * swvSc${c}.x + swvSc${c}.yz;
vec4 swvSa${c} = swFftTapLod(swvSu${c}, ${f(2 * c)}, swvSm${c});
swvH += swvSa${c}.y * swvSw${c};
swvD += ${fftTurnOut(c, `swvSa${c}.xz`)} * swvSw${c};${normal ? `
vec4 swvSb${c} = swFftTapLod(swvSu${c}, ${f(2 * c + 1)}, swvSm${c});
swvG += ${fftTurnOut(c, `swvSb${c}.xy`)} * swvSw${c};
swvJ += ${fftTurnTensor(c, `vec3(swvSb${c}.z, swvSa${c}.w, swvSb${c}.w)`)} * swvSw${c};` : ""}`;
    return c === 0 ? code : ifFft(code, c + 1);
  }).join("");
  return `
vec4 swvSp = U.slateWaterFft;
float swvDist = max(${distance}, 0.001);${normal ? `
vec2 swvG = vec2(0.0);
vec3 swvJ = vec3(0.0);` : ""}${cascades}
swvH = swvH * swvSp.x;
swvD = swvD * (swvSp.x * swvSp.y);`;
}

/**
 * The displaced surface's normal at the vertex (`swvNormal`, a Custom Material's Water Waves node): the summed slopes
 * through the Jacobian of the offset (FFT-Ocean's J⁻ᵀ∇H with the cross term), scaled as the displacement is (Wave Scale
 * and λ, the bank fade, a blend's height and offset shares), over the rest slope of `slateWaterBaseNormal`. Where the
 * surface folds the determinant is floored, as the built-in fragment floors it.
 */
function spectrumNormalSource(): string {
  return `
float swvHs = 1.0;
float swvDs = swvGain;
#ifdef ${WATER_BLEND_DEFINE}
swvHs = A.slateWaterBlend.x;
swvDs = swvDs * A.slateWaterBlend.y;
#endif
swvG = swvG * (swvSp.x * swvHs);
swvJ = swvJ * (swvSp.x * swvSp.y * swvDs);
float swvJxx = 1.0 + swvJ.x;
float swvJxz = swvJ.y;
float swvJzz = 1.0 + swvJ.z;
vec2 swvSlope = vec2(swvJzz * swvG.x - swvJxz * swvG.y, swvJxx * swvG.y - swvJxz * swvG.x) / max(swvJxx * swvJzz - swvJxz * swvJxz, 0.35);
swvSlope = swvSlope / max(1.0, length(swvSlope) / ${f(SHADING_SLOPE_CAP)});
vec3 swvBase = A.slateWaterBaseNormal;
vec3 swvNormal = normalize(vec3(swvBase.x / max(swvBase.y, 0.001) - swvSlope.x, 1.0, swvBase.z / max(swvBase.y, 0.001) - swvSlope.y));`;
}

/**
 * The fragment stage's waves and foam, after FFT-Ocean: every cascade
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
swFoamSum += ${f(WATER_FOAM_WEIGHTS[c]!)} * (1.0 - swSt${c}) * swSw${c} * swTurbScale;${c === 0 ? `
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
// The weighted foam sum (\`WATER_FOAM_WEIGHTS\`): how far below calm the cascades' turbulence lies, the long waves first.
float swFoamSum = 0.0;${cascades}
swSpGrad = swSpGrad * (swSp.x * swBlendH);
swSpJ = swSpJ * (swSp.x * swSp.y * swGain * swBlendD);
float swJxx = 1.0 + swSpJ.x;
float swJxz = swSpJ.y;
float swJzz = 1.0 + swSpJ.z;
float swDetJ = swJxx * swJzz - swJxz * swJxz;
// Where the surface folds the determinant nears zero; a floor keeps those crests' normals from spiking into sparks.
vec2 swSlope = vec2(swJzz * swSpGrad.x - swJxz * swSpGrad.y, swJxx * swSpGrad.y - swJxz * swSpGrad.x) / max(swDetJ, 0.35);
swSlope = swSlope / max(1.0, length(swSlope) / ${f(SHADING_SLOPE_CAP)});
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
// Past the asset's threshold (\`waterFoamThreshold\`), the sum taken at Wave Scale 1 (\`waterFoamScale\`): Crest Foam's
// share of a steep sea, none of a gentle one, and a smaller share on calmer bodies.
float swFoamAt = swFoamSum * U.slateWaterTerms.z;
float swCrestPast = swFoamAt - U.slateWaterShape.x;
float swCrestRaw = swCrestPast * ${f(SPECTRUM_FOAM_SCALE)};
// Fine bubbly breakup drifting with the water, faded before it would alias.
float swFoamNoise = mix(0.5, swNoise(swFlowed * 0.9 + vec2(swTime * 0.05, 0.0)) * 0.65 + swNoise(swFlowed * 3.1 - vec2(0.0, swTime * 0.08)) * 0.35, 1.0 - smoothstep(0.15, 0.6, swFoot));
// Many patches away the foam's repeat would show as a grid of the same caps: it fades out there (beyond a kilometre or
// two for a sea of 20 m waves, a few metres for ripples).
float swPatchFar = 1.0 - smoothstep(${f(FOAM_FAR_PATCHES[0])}, ${f(FOAM_FAR_PATCHES[1])}, swEyeDist * swSc0.x);
float swCrestFoam = clamp(swCrestRaw + (swFoamNoise - 0.5) * 0.25, 0.0, 1.0) * clamp(swFoamAmount * 1.6, 0.0, 1.0) * swPatchFar;
// Surface Foam: thin lingering residue where turbulence is still recovering behind the caps.
float swResidue = clamp((swFoamAt - U.slateWaterShape.x * 0.5) * 1.5, 0.0, 1.0) * smoothstep(0.45, 0.75, swFoamNoise) * U.slateWaterSunColor.w * 0.6 * swPatchFar;
// Edges: foam thick at every object's waterline and along shallow shores, thinning outward (\`edgeFoamHelpers\`).
float swContactStrength = U.slateWaterTerms.x;
float swContactW = max(0.05, U.slateWaterShape.w);
float swCollar = swContactFoamAmount(swFlowed, swTime, swObject, swContactW);
float swShoreFoam = swKnown * (1.0 - swOpenAny) * swShoreFoamAmount(swFlowed, swTime, swTerrainDepth, U.slateWaterMotion.w * 0.35 + 0.08);
float swEdgeFoam = swEdgeFoamCover(swFlowed, max(swCollar, swShoreFoam) * swContactStrength, max(swCrestPast, ${f(EDGE_FOAM_CALM)}), swFoot);
float swFoam = clamp(max(max(swCrestFoam, swResidue), swEdgeFoam), 0.0, 1.0);
`;
}

/**
 * Realistic spectrum water, after FFT-Ocean's material: lit PBR (unlit at Low) whose body is Deep Color emitted through
 * (1 − Fresnel) with FFT-Ocean's subsurface light (Shallow Color, Subsurface) on the crests of the small waves seen toward
 * the sun from behind, reflection of the environment (or the analytic scene sky) at the facet's own environment BRDF
 * (`fresnelSource`), less where a ray leaves below the horizon, glossy close by and rougher with distance (FFT-Ocean's
 * distance gloss, from Roughness), and white foam lit as rough albedo. Shallow
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
// Distance gloss: near water is as smooth as Roughness, far water as rough as FFT-Ocean's 0.31 (normal detail its mips
// average away), plus the shading normal's own variation across the pixel (specular antialiasing).
float swRoughNear = U.slateWaterOrigin.w;
float swRoughFar = max(swRoughNear, ${f(WATER_FAR_ROUGHNESS)});
float swRoughD = mix(swRoughFar, swRoughNear, 1.0 / (1.0 + swEyeDist * ${f(WATER_GLOSS_FALLOFF)}));
vec3 swFresN = normalW;
float swNdotV = clamp(dot(swFresN, swV), 0.0, 1.0);${fresnelSource("swRoughD", "swNdotV", "swFresBrdf")}
float swFres = mix(swFresBrdf, 1.0, swHaze);
vec2 swShadeSlope = normalW.xz / max(normalW.y, 0.1);
vec2 swShadeDx = dFdx(swShadeSlope);
vec2 swShadeDy = dFdy(swShadeSlope);
float swShadeVar = min((dot(swShadeDx, swShadeDx) + dot(swShadeDy, swShadeDy)) * ${f(PIXEL_SLOPE_FILTER / 2)}, ${f(PIXEL_SLOPE_CAP)});
swSlopeVariance = (max(swRoughD * swRoughD * swRoughD * swRoughD - swRoughNear * swRoughNear * swRoughNear * swRoughNear, 0.0) * 0.5 + swShadeVar) * (1.0 - 0.97 * swHaze);
// Reflected rays stay above the horizon (a smooth floor), so the water never mirrors more water; the shading normal
// becomes the half vector toward that ray, so the environment lookup follows it, while the Fresnel stays the facet's.
vec3 swRefl = reflect(-swV, normalW);
float swReflRawY = swRefl.y;${reflectionKeepSource("swReflRawY", "swV.y", "swReflKeepLocal")}
swReflKeep = swReflKeepLocal;
float swLiftA = 60.0 * (0.03 - swRefl.y);
swRefl.y = mix(swRefl.y, swRefl.y + (max(swLiftA, 0.0) + log(1.0 + exp(-abs(swLiftA)))) / 60.0, step(0.0, swV.y));
normalW = normalize(swV + normalize(swRefl));
// Body: Deep Color, lit by the scene (a dim scene keeps a dim sea), with FFT-Ocean's subsurface light (Shallow Color).
vec3 swLumW = vec3(0.3, 0.59, 0.11);
float swBodyLight = U.slateWaterLight.w;${subsurfaceSource("swL", "swV", "swWaveN", "swSpCrest", "U.slateWaterLook.w", "swSp.x", "swSss")}
vec3 swBody = clamp(U.slateWaterDeep.rgb + U.slateWaterShallow.rgb * swSss, vec3(0.0), vec3(1.0)) * swBodyLight;
// Shallow water: what lies below shows through per-channel absorption (Depth Color Distance; red goes first).${transmittanceSource("swDepth", "swNdotV", "swAbsorb", "U.slateWaterAbsorb.rgb", "U.slateWaterThrough.w", "swTransmitRgb")}${ifDefined(REFRACTION, `
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
// Foam is a rough white scatterer that hides the mirror, lit by the scene as FFT-Ocean's foam albedo is, with a little
// of the ambient light of its own so it stays light in shade.
float swFoamEdge = smoothstep(0.0, 0.2, swBank + 0.02);
float swGloss = (1.0 - swFoam) * swEdgeFade;
swMatte = swFoam;
float swFoamCover = swFoam * swFoamEdge;
surfaceAlbedo = U.slateWaterFoam.rgb * (swFoamCover * 0.8);
normalW = normalize(mix(normalW, swFresN, swFoam));
vec3 swFoamLight = swAmb * 0.25;
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
  const blended = (i: number) => Array.from({ length: BLEND_PARTNERS }, (_, k) =>
    ` + U.${BLEND_COLOR_UNIFORMS[k * COLOR_UNIFORMS.length + i]} * swBlendShares[${k}]`).join("");
  const colors = (blend: boolean) => COLOR_UNIFORMS.map((name, i) =>
    `vec4 ${COLOR_LOCALS[i]} = ${blend ? `U.${name} * (1.0 - swBlendShares.x - swBlendShares.y - swBlendShares.z)${blended(i)}` : `U.${name}`};`).join("\n");
  return `
// Large-world rendering makes vPositionW eye-relative; rebuild the absolute world position.
vec3 swPosW = IN.vPositionW + U.slateWaterOrigin.xyz;
// The asset's colours, mixed toward each blended neighbour's by its colour share (\`SLATE_WATER_BLEND\`). A blending surface keeps
// only fragments it owns (margin >= 0, in metres, with a 1.5 cm overlap, wider than the margin's interpolation error, so seams never open) inside the blended shoreline.
#ifdef ${WATER_BLEND_DEFINE}
vec3 swBlendShares = vec3(IN.vSlateWaterBlend.w, IN.vSlateWaterBlendColors);
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
 * Vertex stage of `SLATE_WATER_GPU_WAVES`, at CUSTOM_VERTEX_UPDATE_WORLDPOS: the spectrum's displacement
 * (`spectrumVertexSource`) at this vertex's world rest point. The rest grid carries its mesh spacing in
 * `slateWaterData.x` (the spectrum's mip) and its bank distance in `.y` (the finite-body fade of the horizontal offset).
 * Writes the displaced world position (the clip position, fog, shadows and clip planes follow it) and leaves the height
 * and offset for the varyings in `swvH` / `swvD`, so the fragment finds its rest point and contacts see the rendered
 * height. `slateWaterGridOffset` (xyz) is the world-space translation of the rest grid since its positions were uploaded
 * (Global Water's recentre, `waterGridOffset`): it is added before the rest point is taken, so the spectrum, bank terms
 * and `vPositionW` all see the translated grid. GLSL-shaped: `A.` attributes, `U.` uniforms, `S.` the view matrix's
 * owner and `O.` outputs are bound per language, then `toWgsl` translates it. Other passes that draw built-in water with
 * their own vertex shader (the shared outline mask) include the same displacement through `waterOutlineVertexSource`,
 * without the material's `vPositionW` output. `normal` (a Custom Material's Water Waves node, `waterWaveBlockSource`)
 * also leaves `swvNormal` (`spectrumNormalSource`), which the built-in fragment shader derives per pixel for itself;
 * `distance` is the eye-distance expression the spectrum's LOD reads.
 */
function vertexWaveSource(materialOutputs: boolean, normal = false, distance = "abs((S.view * worldPos).z)"): string {
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
float swvSpacing = A.slateWaterData.x;
worldPos = vec4(worldPos.xyz + U.slateWaterGridOffset.xyz, worldPos.w);
vec2 swvRest = worldPos.xz;
float swvH = 0.0;
vec2 swvD = vec2(0.0);${spectrumVertexSource(distance, normal)}
float swvFade = U.slateWaterSwellInfo.x;
#ifdef ${WATER_BLEND_DEFINE}
swvFade = swvFade * A.slateWaterBlend.y;
#endif
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));${normal ? spectrumNormalSource() : ""}
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
O.vSlateWaterBlendColors = A.slateWaterBlendColors;
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

/** Vertex hooks for one language: the spectrum's sampler (with GPU waves), the displacement and the varyings. */
export function waterVertexSource(language: ShaderLanguage): { definitions: string; worldPosition: string; end: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const definitions = `\n#ifdef ${WATER_GPU_WAVES_DEFINE}${fftHelpers(wgsl)}#endif\n`;
  return wgsl
    ? { definitions, worldPosition: bindVertexSource(toWgsl(vertexWaveSource(true)), true), end: bindVertexSource(toWgsl(VERTEX_VARYINGS), true).replace(/\bSW_CLIP_POSITION\b/g, "vertexOutputs.position") }
    : { definitions, worldPosition: bindVertexSource(vertexWaveSource(true), false), end: bindVertexSource(VERTEX_VARYINGS, false).replace(/\bSW_CLIP_POSITION\b/g, "gl_Position") };
}

/**
 * Uniforms the vertex displacement reads (`bindWaterVertexUniforms` sets them, with `WATER_FFT_SAMPLER`): the bank fade
 * (`slateWaterSwellInfo.x`), the grid offset and the spectrum's.
 */
export const WATER_VERTEX_WAVE_UNIFORMS: readonly string[] = ["slateWaterSwellInfo", "slateWaterGridOffset", ...FFT_UNIFORMS];
/** The surface's water clock in seconds (x), for a Custom Material's Water Waves node (`WaterVertexWaves.bind`). */
export const WATER_CLOCK_UNIFORM = "slateWaterClock";
/** `vertexWaveDefines` per blend state (off, on) and spectrum cascades (1-3): built once. */
const VERTEX_WAVE_DEFINES: ReadonlyArray<ReadonlyArray<readonly string[]>> = [false, true].map((blend) =>
  Array.from({ length: WATER_FFT_CASCADES_MAX + 1 }, (_, cascades) => [
    `#define ${WATER_GPU_WAVES_DEFINE}`, `#define ${FFT} ${Math.max(1, cascades)}`, ...(blend ? [`#define ${WATER_BLEND_DEFINE}`] : []),
  ]));
/** `vertexWaveAttributes` per blend state (off, on). */
const VERTEX_WAVE_ATTRIBUTES: ReadonlyArray<readonly string[]> = [["slateWaterData"], ["slateWaterData", "slateWaterBlend"]];

/**
 * The displacement for another pass's vertex shader that computes a `worldPos` vec4 from the same world matrix and has a
 * `view` matrix uniform (the shared outline mask): declarations of its attribute, uniforms and the spectrum's sampler,
 * and the displacement to insert after `worldPos`. Both compile only under `SLATE_WATER_GPU_WAVES`, so the pass's other
 * programs are unchanged.
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
    declarations: `\n${stripShaderComments(`#ifdef ${WATER_GPU_WAVES_DEFINE}\n${attribute}\n${blend}\n${uniforms}${fftHelpers(wgsl)}#endif`)}\n`,
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

/** Where a pass's vertex uniforms and the spectrum's texture go: an `Effect`, or whatever records what a pass receives. */
export interface WaterUniformSink {
  setFloat4(name: string, x: number, y: number, z: number, w: number): unknown;
  setTexture(name: string, texture: BaseTexture | null): unknown;
}

/** Floats of the spectrum's vertex uniforms (`slateWaterFft` and every cascade's vec4) written by `waterSpectrumUniforms`. */
const SPECTRUM_UNIFORM_FLOATS = (1 + WATER_FFT_CASCADES_MAX) * 4;

/**
 * The spectrum `water` draws with in `scene` (`waterFftForSurface`, which is also its demand) and its uniforms for Wave
 * Scale `scale` into `out` (`FFT_UNIFORMS` order): (Wave Scale while the spectrum is ready and matches `cascades`, else
 * 0: flat until the first dispatch; λ; grid size; `SPECTRUM_LOD_SCALE`) and per cascade (1 / patch size, uv offset): the
 * offset is the floating origin in the cascade's turned frame, fract(R(−θ)·origin / L) + 0.5 / N in float64, so the
 * floating origin never reaches the shader as a large coordinate. Returns the spectrum only when it is ready and matches
 * `cascades`. Allocation-free.
 */
function waterSpectrumUniforms(scene: Scene, water: WaterDefinition, scale: number, cascades: number, out: Float32Array): WaterFftResult | null {
  const result = waterFftForSurface(scene, water);
  const band = result?.ready && result.cascades === cascades ? result : null;
  const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
  out.fill(0);
  out[0] = band ? scale : 0; out[1] = waterSpectrum(water).choppiness; out[2] = band?.size ?? 1; out[3] = SPECTRUM_LOD_SCALE;
  if (!band) return null;
  for (let c = 0; c < band.cascades && c < WATER_FFT_CASCADES_MAX; c++) {
    const o = (1 + c) * 4, patch = band.patchSizes[c]!, turn = WATER_FFT_CASCADE_TURNS[c]!, cos = Math.cos(turn), sin = Math.sin(turn);
    const px = (cos * origin.x + sin * origin.z) / patch, pz = (cos * origin.z - sin * origin.x) / patch, texel = 0.5 / band.size;
    out[o] = 1 / patch;
    out[o + 1] = px - Math.floor(px) + texel;
    out[o + 2] = pz - Math.floor(pz) + texel;
  }
  return band;
}

/**
 * Sets `WATER_VERTEX_WAVE_UNIFORMS` and the spectrum's texture: the grid offset (world X/Z translation of the uploaded
 * rest grid), the bank fade length and the spectrum's uniforms (`waterSpectrumUniforms`), with a placeholder texture
 * until the spectrum is ready. The material plugin binds them to another pass's effect (`WaterMaterialPlugin.bindVertexWaves`)
 * and a surface without a plugin binds them to its Custom Material (`WaterVertexWaves.bind`), so both displace
 * identically.
 */
export function bindWaterVertexUniforms(
  sink: WaterUniformSink, scene: Scene, grid: ArrayLike<number>, bankFade: number, spectrum: Float32Array, band: WaterFftResult | null,
): void {
  sink.setFloat4("slateWaterGridOffset", grid[0]!, grid[1]!, grid[2]!, 0);
  sink.setFloat4("slateWaterSwellInfo", bankFade, 0, 0, 0);
  for (let i = 0; i < 1 + WATER_FFT_CASCADES_MAX; i++) {
    sink.setFloat4(FFT_UNIFORMS[i]!, spectrum[i * 4]!, spectrum[i * 4 + 1]!, spectrum[i * 4 + 2]!, spectrum[i * 4 + 3]!);
  }
  sink.setTexture(WATER_FFT_SAMPLER, band?.texture ?? placeholderFft(scene));
}

/**
 * The waves of a water surface that has no `WaterMaterialPlugin`: Custom Material water whose graph holds a Water Waves
 * node (`WaterWavesBlock`). The node's vertex stage displaces the surface's static rest grid with the same source as
 * built-in shading (`waterWaveBlockSource`) from the same uniforms (`bindWaterVertexUniforms`), here from the surface's
 * own definition, body and clock; the water mesh keeps `time` current.
 */
export class WaterVertexWaves {
  /** The surface's water clock in seconds. */
  time = 0;
  readonly water: WaterDefinition;
  readonly body: WaterBodyProperties;
  private readonly spectrum = new Float32Array(SPECTRUM_UNIFORM_FLOATS);
  constructor(water: WaterDefinition, body: WaterBodyProperties) {
    this.water = water;
    this.body = body;
  }
  /** The spectrum's cascades this surface's material compiles (`SLATE_WATER_FFT`): the device-effective FFT Cascades. */
  cascades(scene: Scene): number {
    return Math.max(1, sceneWaterQualityDeviceClamp(scene).quality.fftCascades);
  }
  /**
   * Sets the vertex uniforms, the spectrum and its foam, the clock, the eye (the active camera relative to the rest
   * positions), the foam terms and the sun for a draw of `mesh`. Allocation-free.
   */
  bind(sink: WaterUniformSink, scene: Scene, mesh: AbstractMesh): void {
    const scale = this.body.waveScale;
    const band = waterSpectrumUniforms(scene, this.water, scale, this.cascades(scene), this.spectrum);
    bindWaterVertexUniforms(sink, scene, waterGridOffset(mesh), this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, scale), this.spectrum, band);
    sink.setTexture(WATER_FOAM_SAMPLER, band?.foam ?? placeholderFft(scene));
    sink.setFloat4(WATER_CLOCK_UNIFORM, this.time, 0, 0, 0);
    const camera = scene.activeCamera, origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    const eye = camera?.globalPosition ?? Vector3.ZeroReadOnly;
    sink.setFloat4(WATER_EYE_UNIFORM, eye.x - origin.x, eye.y - origin.y, eye.z - origin.z, 0);
    const quality = sceneWaterQualityDeviceClamp(scene).quality;
    sink.setFloat4(WATER_NODE_FOAM_UNIFORM, this.water.crestFoam, this.water.foamAmount,
      waterFoamThresholdOf(this.water, scale, quality.fftSize, this.cascades(scene)), 1 / waterFoamScale(scale));
    const sun = sceneWaterNodeLighting(scene).sun;
    sink.setFloat4(WATER_NODE_SUN_UNIFORM, sun[0]!, sun[1]!, sun[2]!, this.water.subsurface);
  }
}

const meshWaves = new WeakMap<AbstractMesh, WaterVertexWaves>();
/** Registers (or with null removes) the waves `mesh`'s Custom Material displaces it with; the water mesh owns them. */
export function setMeshVertexWaves(mesh: AbstractMesh, waves: WaterVertexWaves | null): void {
  if (waves) meshWaves.set(mesh, waves);
  else meshWaves.delete(mesh);
}
/** The waves a Custom Material displaces `mesh` with (`setMeshVertexWaves`), or null. */
export function meshVertexWaves(mesh: AbstractMesh | null | undefined): WaterVertexWaves | null {
  return (mesh && meshWaves.get(mesh)) || null;
}

const blockWaveSources = new Map<ShaderLanguage, string>();
/**
 * The Water Waves node's vertex code for one language: `vertexWaveSource` with the normal, bound and translated like the
 * plugin's, its eye distance from `slateWaterEye` (the camera's world position relative to the rest positions). It reads
 * and writes a `worldPos` vec4 (rest point in, displaced point out) and leaves `swvH` (height), `swvD` (horizontal offset)
 * and `swvNormal`, under `SLATE_WATER_GPU_WAVES`; it reads `slateWaterData` and `slateWaterBaseNormal`, and under
 * `SLATE_WATER_BLEND` `slateWaterBlend`, as attributes. Built once.
 */
export function waterWaveBlockSource(language: ShaderLanguage): string {
  let source = blockWaveSources.get(language);
  if (!source) {
    const wgsl = language === ShaderLanguage.WGSL, code = vertexWaveSource(false, true, "length(worldPos.xyz - U.slateWaterEye.xyz)");
    blockWaveSources.set(language, source = stripShaderComments(bindVertexSource(wgsl ? toWgsl(code) : code, wgsl)));
  }
  return source;
}

/** The Water Waves node's eye position uniform (`waterWaveBlockSource`): the camera relative to the rest positions. */
export const WATER_EYE_UNIFORM = "slateWaterEye";
/** The Water Waves node's foam terms: (Crest Foam, Foam Amount, the foam threshold `waterFoamThresholdOf`, 0). */
export const WATER_NODE_FOAM_UNIFORM = "slateWaterNodeFoam";
/** The Water Waves node's light: (direction toward the sun, Subsurface). */
export const WATER_NODE_SUN_UNIFORM = "slateWaterNodeWaveSun";
/**
 * Varying the Water Waves node's vertex stage hands its fragment stage: (bank gain × offset share, height share, and
 * while blending the union bank distance and ownership margin, both in metres).
 */
export const WATER_NODE_VARYING = "vSlateWaterWaves";

/**
 * The Water Waves node's vertex code that fills `WATER_NODE_VARYING` (`out`, the bound varying) from the mesh's bank
 * distance and blend data, as `vertexWaveSource` derives its bank gain and shares. GLSL-shaped with `A.` and `U.`.
 */
function nodeVaryingSource(out: string): string {
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
{
float swvFade = U.slateWaterSwellInfo.x;
float swvHs = 1.0;
float swvDs = 1.0;
#ifdef ${WATER_BLEND_DEFINE}
swvFade = swvFade * A.slateWaterBlend.y;
swvHs = A.slateWaterBlend.x;
swvDs = A.slateWaterBlend.y;
#endif
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));
float swvKeepBank = 1.0;
float swvKeepMargin = 1.0;
#ifdef ${WATER_BLEND_DEFINE}
swvKeepBank = A.slateWaterData.y;
swvKeepMargin = A.slateWaterBlend.z;
#endif
${out} = vec4(swvGain * swvDs, swvHs, swvKeepBank, swvKeepMargin);
}
#endif
`;
}

/**
 * The Water Waves node's fragment code: the spectrum at this pixel's rest point (`rest`, the interpolated undisplaced
 * world position plus the grid offset), every cascade through its mips as built-in water samples it
 * (`spectrumSurfaceSource`): it discards what a blending surface does not own, then gives the displaced surface's
 * normal over the mesh's base normal (`base`), the height, and
 * FFT-Ocean's crest foam from the persistent turbulence with the asset's Crest Foam and Foam Amount, and the subsurface
 * light built-in water draws (`subsurfaceSource`). Writes `swnNormal`, `swnHeight`, `swnFoam`, `swnSubsurface` and
 * `swnEdgeTurbulence` (the turbulence past the crest threshold, which edge foam reads: `edgeFoamHelpers`).
 * GLSL-shaped with `U.`; `varying` is the bound `WATER_NODE_VARYING`.
 */
function nodeFragmentSource(rest: string, base: string, varying: string): string {
  const cascades = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => {
    const code = `
vec4 swnSc${c} = U.${FFT_CASCADE_UNIFORMS[c]};
vec2 swnSu${c} = ${fftTurnIn(c, "swnRest")} * swnSc${c}.x + swnSc${c}.yz;
vec4 swnSa${c} = swSpecTap(swnSu${c}, ${f(2 * c)});
vec4 swnSb${c} = swSpecTap(swnSu${c}, ${f(2 * c + 1)});
float swnSt${c} = swFoamTap(swnSu${c}, ${f(c)}).r;
float swnSw${c} = ${c === 0 ? "1.0" : `clamp(swnSp.w / max(swnSc${c}.x * swnDist, 0.000001), 0.0, 1.0)`};
swnGrad += ${fftTurnOut(c, `swnSb${c}.xy`)} * swnSw${c};
swnJ += ${fftTurnTensor(c, `vec3(swnSb${c}.z, swnSa${c}.w, swnSb${c}.w)`)} * swnSw${c};
swnH += swnSa${c}.y * swnSw${c};${c === 0 ? `
swnLarge = swnSa0.y;` : `
swnSmall += swnSa${c}.y * swnSw${c};`}
swnFoamSum += ${f(WATER_FOAM_WEIGHTS[c]!)} * (1.0 - swnSt${c}) * swnSw${c} * swnTurbScale;`;
    return c === 0 ? code : ifFft(code, c + 1);
  }).join("");
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
{
vec3 swnRestW = ${rest}.xyz + U.slateWaterGridOffset.xyz;
vec2 swnRest = swnRestW.xz;
float swnDist = max(length(swnRestW - U.${WATER_EYE_UNIFORM}.xyz), 0.001);
vec4 swnSp = U.slateWaterFft;
vec4 swnShares = ${varying};
// A blending surface draws only the water it owns inside the blended shoreline, as built-in water does (\`cutSource\`).
if (min(swnShares.z, swnShares.w + 0.015) < 0.0) { discard; }
float swnTurbScale = swnSp.x * swnShares.x;
vec2 swnGrad = vec2(0.0);
vec3 swnJ = vec3(0.0);
float swnH = 0.0;
float swnLarge = 0.0;
float swnSmall = 0.0;
float swnFoamSum = 0.0;${cascades}
swnGrad = swnGrad * (swnSp.x * swnShares.y);
swnJ = swnJ * (swnSp.x * swnSp.y * swnShares.x);
float swnJxx = 1.0 + swnJ.x;
float swnJxz = swnJ.y;
float swnJzz = 1.0 + swnJ.z;
vec2 swnSlope = vec2(swnJzz * swnGrad.x - swnJxz * swnGrad.y, swnJxx * swnGrad.y - swnJxz * swnGrad.x) / max(swnJxx * swnJzz - swnJxz * swnJxz, 0.35);
swnSlope = swnSlope / max(1.0, length(swnSlope) / ${f(SHADING_SLOPE_CAP)});
vec3 swnBase = ${base};
swnNormal = normalize(vec3(swnBase.x / max(swnBase.y, 0.001) - swnSlope.x, 1.0, swnBase.z / max(swnBase.y, 0.001) - swnSlope.y));
swnHeight = swnH * swnSp.x * swnShares.y;
vec4 swnTerms = U.${WATER_NODE_FOAM_UNIFORM};
float swnCrestPast = swnFoamSum * swnTerms.w - swnTerms.z;
float swnPatchFar = 1.0 - smoothstep(${f(FOAM_FAR_PATCHES[0])}, ${f(FOAM_FAR_PATCHES[1])}, swnDist * swnSc0.x);
swnFoam = clamp(swnCrestPast * ${f(SPECTRUM_FOAM_SCALE)}, 0.0, 1.0) * clamp(swnTerms.y * 1.6, 0.0, 1.0) * step(0.000001, swnTerms.x) * swnPatchFar;
${subsurfaceSource(`U.${WATER_NODE_SUN_UNIFORM}.xyz`, `normalize(U.${WATER_EYE_UNIFORM}.xyz - swnRestW - vec3(0.0, swnHeight, 0.0))`, "swnNormal",
    "(0.2 * swnLarge + swnSmall) * swnSp.x * swnShares.y", `U.${WATER_NODE_SUN_UNIFORM}.w`, "swnSp.x", "swnSss")}
swnSubsurface = swnSss;
swnEdgeTurbulence = max(swnCrestPast, ${f(EDGE_FOAM_CALM)});
}
#endif
`;
}

/** Binds the GLSL-shaped `U.` and `IN.` prefixes of fragment code for one language. */
const bindFragmentSource = (code: string, wgsl: boolean) => code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bIN\./g, wgsl ? "fragmentInputs." : "");

/** The Water Waves node's per-stage sources for one language (`WaterWavesBlock`), built once each. */
export interface WaterWaveNodeSources {
  /** Taps of each stage, under `SLATE_WATER_GPU_WAVES` (the block declares the samplers). */
  vertexHelpers: string;
  fragmentHelpers: string;
  /** The vertex code that fills the node's varying, given its bound name. */
  varying(out: string): string;
  /** The fragment code, given the rest position, base normal and varying expressions (already bound). */
  fragment(rest: string, base: string, varying: string): string;
}
const nodeSources = new Map<ShaderLanguage, WaterWaveNodeSources>();
export function waterWaveNodeSources(language: ShaderLanguage): WaterWaveNodeSources {
  let sources = nodeSources.get(language);
  if (!sources) {
    const wgsl = language === ShaderLanguage.WGSL;
    const guard = (code: string) => `#ifdef ${WATER_GPU_WAVES_DEFINE}\n${code}\n#endif\n`;
    const vertexBind = (code: string) => stripShaderComments(bindVertexSource(wgsl ? toWgsl(code) : code, wgsl));
    const fragmentBind = (code: string) => stripShaderComments(bindFragmentSource(wgsl ? toWgsl(code) : code, wgsl));
    sources = {
      // The block declares the samplers itself, once per stage.
      vertexHelpers: guard(fftHelpers(wgsl, false)),
      fragmentHelpers: guard(fftHelpers(wgsl, false) + spectrumHelpers(wgsl, false)),
      varying: (out) => vertexBind(nodeVaryingSource(out)),
      fragment: (rest, base, varying) => fragmentBind(nodeFragmentSource(rest, base, varying)),
    };
    nodeSources.set(language, sources);
  }
  return sources;
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
    `#ifdef ${REFRACTION}`,
    declare(v3, "swRefractedOut", "swRefracted"),
    "#ifdef FOG",
    declare(f1, "swFogKeep", "max(toLinearSpace(CalcFogFactor()), 0.01)"),
    `swRefractedOut = (swRefracted - ${wgsl ? "uniforms." : ""}vFogColor * ((1.0 - swFogKeep) * swRefractedWeight)) / swFogKeep;`,
    "#endif",
    "#endif",
    `#ifdef ${REFRACTION}`,
    `finalColor = ${v4}(finalColor.rgb + swRefractedOut, finalColor.a);`,
    "#endif",
    `finalColor = ${v4}(finalColor.rgb / swCover, swCover);`,
    `#if ${SAMPLES_COPY}`,
    `finalColor = ${v4}(mix(finalColor.rgb, swHorC, swHorW), mix(finalColor.a, 1.0, swHorW));`,
    "#endif",
    // Open-water edges fade out (`swOpenFade`).
    "finalColor.a *= swOpenFade;",
  ].join("\n");
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
    ? "var<private> swSlopeVariance: f32 = 0.0;\nvar<private> swMatte: f32 = 0.0;\nvar<private> swSharp: f32 = 1.0;\nvar<private> swReflKeep: f32 = 1.0;\n"
    : "float swSlopeVariance = 0.0;\nfloat swMatte = 0.0;\nfloat swSharp = 1.0;\nfloat swReflKeep = 1.0;\n";
  return wgsl
    ? {
      helpers: samplerDeclaration + roughnessGlobals + toWgsl(HELPERS + REMOVAL_HELPER) + CONTACT_TAP_WGSL + objectHelpers(true) + fftHelpers(true) + spectrumHelpers(true),
      cut: bind(toWgsl(cutSource(true))), main: bind(toWgsl(blendColors(spectrumRealisticSource()))),
    }
    : {
      helpers: samplerDeclaration + roughnessGlobals + HELPERS + REMOVAL_HELPER + CONTACT_TAP_GLSL + objectHelpers(false) + fftHelpers(false) + spectrumHelpers(false),
      cut: bind(cutSource(false)), main: bind(blendColors(spectrumRealisticSource())),
    };
}

/** Object contact distances are encoded up to three contact-foam widths (1-8 m). */
export const contactRange = (water: WaterDefinition) => Math.max(1, Math.min(8, water.contactFoamWidth * 3));

const placeholders = new WeakMap<Scene, RawTexture>();
/** Field for surfaces nothing meets: far from terrain, terrain unknown. Contacts that are off ignore it. */
export function placeholderField(scene: Scene): RawTexture {
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
 * partners' colours only a blending surface binds.
 */
const FRAME_UNIFORMS: readonly string[] = [
  "slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves",
  "slateWaterSun", "slateWaterSunColor", "slateWaterSky", "slateWaterHorizon", "slateWaterSunShape", "slateWaterAbsorb", "slateWaterThrough",
  "slateWaterOrigin", "slateWaterLight", "slateWaterSwellInfo", "slateWaterShape", "slateWaterTerms", "slateWaterHaze",
  ...BLEND_COLOR_UNIFORMS,
];
const FRAME_BLEND_START = FRAME_UNIFORMS.length - BLEND_COLOR_UNIFORMS.length;
const NO_BLEND_PARTNERS: readonly (WaterDefinition | null)[] = Object.freeze([null, null, null]);
/** The numeric definition fields the packed vec4s read besides the colours (`frameInputsChanged`). */
const FRAME_DEFINITION_FIELDS = [
  "opacity", "reflectionStrength", "foamAmount", "foamWidth", "depthColorDistance",
  "subsurface", "waveHeight", "waveLength", "waveSpeed", "waveDirection", "surfaceFoam", "roughness", "colorVariation", "waveSpread",
  "crestFoam", "contactFoamWidth",
] as const satisfies readonly (keyof WaterDefinition)[];
/**
 * Render, clock, origin, scale, tier, reflection source, bank fade and the simulation's size and cascades; the fields;
 * three colours; each partner's three and nine.
 */
const FRAME_KEY_LENGTH = 12 + FRAME_DEFINITION_FIELDS.length + 9 + BLEND_PARTNERS * (3 + 9);
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
  /** `waterHazeConstants` of the active camera's far plane (`slateWaterHaze`). */
  haze: Float64Array;
};

const linearScratch = new Color3(), gammaScratch = new Color3(), absorbScratch = new Float64Array(4);
/**
 * A Shallow Color channel's relative absorption through clear water (see `WaterMaterialPlugin.absorption`): the optical
 * depth that leaves the channel at its share of the brightest, over a small common floor. A cyan Shallow Color thus
 * absorbs red many times faster than blue and green a few times faster, as clear sea water does, so shallows over sand
 * turn turquoise and deeper water blue rather than green.
 */
const absorbCoefficient = (channel: number, top: number) => top > 0 ? 0.2 - Math.log(Math.max(channel / top, 0.02)) : 1;
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
  waterHazeConstants(scene.activeCamera?.maxZ ?? 0, out.haze);
}

/** Each material's ambient: the scene's, plus its environment's share and a low-light floor. Writes `waterAmbient`. */
const waterAmbient = new Float64Array(3);
/**
 * How strongly the scene lights a water body's own colour (Deep Color and its subsurface light), from the ambient light
 * the water sees (`withWaterEnvironment`) and the sun: a dim scene keeps a dim sea. 0.05 to 1.6.
 */
function waterBodyLight(ambient: ArrayLike<number>, light: Pick<WaterLighting, "sun" | "sunColor">): number {
  const luminance = (r: number, g: number, b: number) => r * 0.3 + g * 0.59 + b * 0.11;
  const sun = light.sun, color = light.sunColor;
  const lit = luminance(ambient[0]!, ambient[1]!, ambient[2]!) * 1.4 + luminance(color[0]!, color[1]!, color[2]!) * sun[3]! * Math.max(sun[1]!, 0) * 0.35;
  return Math.min(1.6, Math.max(0.05, lit));
}

/**
 * `waterBodyLight` of `water` in `scene` this frame, as built-in water lights its colour (`slateWaterLight.w`), for a
 * Custom Material's Water Colors node. `reflective`: the water reflects an environment or skybox cube.
 */
export function sceneWaterBodyLight(scene: Scene, water: WaterDefinition, reflective: boolean): number {
  const lighting = sceneWaterBindingData(scene).lighting;
  return waterBodyLight(withWaterEnvironment(lighting, water.reflectionStrength, reflective), lighting);
}

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
/**
 * The scene's water lighting this render (`sceneWaterLighting`): the sun, ambient and the analytic sky and horizon the
 * water nodes reflect without an environment. Shared with built-in water; read-only.
 */
export function sceneWaterNodeLighting(scene: Scene): Readonly<Pick<WaterLighting, "sun" | "sunColor" | "sky" | "horizon" | "sunShape">> {
  return sceneWaterBindingData(scene).lighting;
}

function sceneWaterBindingData(scene: Scene): WaterBindingData {
  let data = waterBindings.get(scene);
  const frame = scene.getFrameId(), render = scene.getRenderId();
  if (data?.frame === frame && data.render === render) return data;
  if (!data) {
    data = {
      frame, render, removals: NO_REMOVALS,
      lighting: {
        ambient: new Float64Array(3), sun: new Float64Array(4), sunColor: new Float64Array(3), sky: new Float64Array(3), horizon: new Float64Array(3),
        sunShape: new Float64Array(4), subsurfaceLift: 0, sunGlitter: 0, overcast: 0, haze: new Float64Array(4),
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

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
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
function recordWaterVariant(defines: MaterialDefines, mesh: AbstractMesh | null, scene: Scene): void {
  const log = (globalThis as unknown as Record<string, WaterVariantRequest[] | undefined>)[WATER_COMPILE_LOG];
  if (!log) return;
  const pass = scene.getEngine().currentRenderPassId;
  const on = (name: string) => Boolean(defines[name]);
  log.push({
    at: performance.now(), mesh: mesh?.name ?? "", pass, mainPass: isMainWaterPass(scene, pass),
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
/** The code a stage injects into the PBR shader, by injection point. */
function waterInjection(stage: "vertex" | "fragment", language: ShaderLanguage): Record<string, string> {
  const wgsl = language === ShaderLanguage.WGSL;
  const v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4";
  // Babylon's shader processors are line-based: every attribute, varying and sampler needs its own line.
  const varying = (type: string, name: string) => (wgsl ? `varying ${name}: ${type};` : `varying ${type} ${name};`) + "\n";
  // vSlateWaterFlow packs the world current (x, z) and the Gerstner offset (Dx, Dz), so the fragment finds its rest point.
  const varyings = varying(v4, "vSlateWater") + varying(v4, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal")
    + `#ifdef ${WATER_BLEND_DEFINE}\n` + varying(v4, "vSlateWaterBlend") + varying(wgsl ? "vec2f" : "vec2", "vSlateWaterBlendColors") + "#endif\n";
  const blendAttribute = `#ifdef ${WATER_BLEND_DEFINE}\n${wgsl ? "attribute slateWaterBlend: vec4f;" : "attribute vec4 slateWaterBlend;"}\n`
    + `${wgsl ? "attribute slateWaterBlendColors: vec2f;" : "attribute vec2 slateWaterBlendColors;"}\n#endif\n`;
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
  const source = waterShaderSource(language);
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
      "#ifdef REFLECTION",
      // The facet's own reflectance (`swFres`, the environment BRDF of the facet normal) replaces Babylon's, which the
      // lifted shading normal would dim toward the horizon; rays leaving below the horizon keep less (`swReflKeep`).
      `finalRadianceScaled = reflectionOut.environmentRadiance.rgb * (${wgsl ? "uniforms." : ""}vLightingIntensity.z * swFres * swReflKeep);`,
      `#if ${REFLECTS_OBJECTS}`,
      `finalRadianceScaled = mix(finalRadianceScaled, swObjRefl.rgb * (swFres * ${wgsl ? "uniforms." : ""}slateWaterDeep.w), swObjRefl.a);`,
      "#endif",
      "finalRadianceScaled *= swGloss;",
      "#else",
      `#if ${REFLECTS_OBJECTS}`,
      `finalEmissive += mix(swSkyRefl * swReflKeep, swObjRefl.rgb * ${wgsl ? "uniforms." : ""}slateWaterDeep.w, swObjRefl.a) * (swFres * swGloss);`,
      "#else",
      "finalEmissive += swSkyRefl * (swFres * swGloss * swReflKeep);",
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
 * `waterInjection`'s points with comments stripped, built once per stage and language. Babylon collects the fragment's
 * point names when the plugin is added (no compile yet), so the fragment builds on the first read of a value.
 */
function injectionFor(stage: "vertex" | "fragment", language: ShaderLanguage): Readonly<Record<string, string>> {
  const key = `${stage}:${language === ShaderLanguage.WGSL ? "wgsl" : "glsl"}`;
  let injection = injections.get(key);
  if (!injection) {
    const build = () => Object.fromEntries(Object.entries(waterInjection(stage, language)).map(([point, code]) => [point, stripShaderComments(code)]));
    injection = stage === "fragment" ? lazyInjection(FRAGMENT_POINTS, build) : Object.freeze(build());
    injections.set(key, injection);
  }
  return injection;
}
function lazyInjection(points: readonly string[], build: () => Record<string, string>): Readonly<Record<string, string>> {
  let built: Record<string, string> | undefined;
  return Object.defineProperties({}, Object.fromEntries(points.map((point) => [point, { enumerable: true, get: () => (built ??= build())[point] }])));
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
  private _gpuWaves = false;
  /** Device-clamped quality the features below follow; compared by identity (it changes with the revision). */
  private clamp: WaterQualityDeviceClamp | null = null;
  private tier = DEFAULT_TIER;
  /** Rest height is level across the body (no river, no tilted volume): a planar reflection can mirror it. */
  private _flat = true;
  /** The surface blends with neighbours (`SLATE_WATER_BLEND`); the water mesh owns it with the per-vertex blend data. */
  private _blend = false;
  /**
   * The neighbours whose colours a blending surface mixes toward, by slot (each by its per-vertex colour share); null
   * keeps the asset's own. Set by the water mesh with `blend`.
   */
  partners: readonly (WaterDefinition | null)[] = NO_BLEND_PARTNERS;
  /** Device-effective features this asset asks for; the copy features also need a copy for the pass drawn. */
  private refracts = false;
  private marches = false;
  private mirrors = false;
  private marchSteps = 0;
  /** The scene copy and planar reflection of the current draw (`hardBindForSubMesh`), bound by `bindForSubMesh`. */
  private boundCopy: WaterSceneCopy | null = null;
  private boundPlanar: WaterPlanarReflection | null = null;
  /** The spectrum's cascades at the device-effective quality (`SLATE_WATER_FFT`). */
  private fftCascades = 1;
  /** The spectrum bound for the current draw: ready and matching the compiled cascades, or null (placeholder, gain 0). */
  private boundFft: WaterFftResult | null = null;
  /** `slateWaterFft` and the cascades' vec4s, as last computed (`waterSpectrumUniforms`). */
  private readonly fftValues = new Float32Array(SPECTRUM_UNIFORM_FLOATS);
  /** `frameConstants`' packed vec4s and the inputs they were computed from (`frameInputsChanged`). */
  private readonly frameValues = new Float64Array(FRAME_UNIFORMS.length * 4);
  private readonly frameKey = new Float64Array(FRAME_KEY_LENGTH).fill(NaN);
  private readonly frameScratch = new Float64Array(FRAME_KEY_LENGTH);
  private readonly framePartners: (WaterDefinition | null)[] = [null, null, null];
  constructor(material: PBRMaterial, water: WaterDefinition, body: WaterBodyProperties) {
    super(material, "SlateWater", 180, {
      SLATE_WATER: true, [WATER_GPU_WAVES_DEFINE]: false, [Q]: DEFAULT_TIER,
      [REFRACTION]: false, [SSR]: false, [SSR_STEPS]: 0, [PLANAR]: false, [FFT]: 1, [WATER_BLEND_DEFINE]: false,
    }, true, false);
    this.water = water;
    this.body = body;
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
   * Shading Detail, or a change in the refraction, reflection and spectrum features this asset runs, marks the defines
   * dirty (and resets a frozen Play material's cached readiness). Realistic Low draws unlit; this also restores that flag
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
    if (material.unlit) return;
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
   * Refraction, the screen-space march, the planar reflection and the spectrum's cascades this asset runs at the
   * device-effective quality: Refraction above 0 with Water Refraction on; Object Reflections under Screen Space
   * reflections or Planar's Screen Space fallback; Object Reflections at Planar on a flat body; FFT Cascades. Recompiles
   * only when one of them changes.
   */
  private syncObjectFeatures(): void {
    const clamp = this.clamp;
    if (!clamp) return;
    const q = clamp.quality, w = this.water;
    const refracts = q.refraction && w.refraction > 0;
    const marches = w.objectReflections && (q.reflections === "screenSpace" || (q.reflections === "planar" && clamp.screenSpaceFallback));
    const mirrors = w.objectReflections && q.reflections === "planar" && this._flat;
    const steps = marches ? Math.round(q.reflectionSteps) : 0;
    const fft = Math.max(1, q.fftCascades);
    if (refracts === this.refracts && marches === this.marches && mirrors === this.mirrors && steps === this.marchSteps && fft === this.fftCascades) return;
    this.refracts = refracts; this.marches = marches; this.mirrors = mirrors; this.marchSteps = steps; this.fftCascades = fft;
    this.markDefinesDirty();
  }
  /**
   * The asset was edited in place (`updateWaterMeshDefinition`; Style never changes there). Re-evaluates the features
   * it runs (Refraction, Object Reflections). Uniform-only fields (waves, colours, amounts) cost nothing here: every bind
   * reads the definition.
   */
  definitionChanged(): void {
    this.syncObjectFeatures();
  }
  /** The spectrum's cascades compiled into this material (`SLATE_WATER_FFT`). */
  get spectrumCascades(): number { return this.fftCascades; }
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
   * Wave Scale the spectrum's uniforms carry: the body's, or 1 for a calm body that blends, so it can take a neighbour's
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
    let changed = setDefine(defines, WATER_GPU_WAVES_DEFINE, this._gpuWaves);
    changed = setDefine(defines, Q, this.tier) || changed;
    const copy = (this.refracts || this.marches) && isMainWaterPass(scene, scene.getEngine().currentRenderPassId);
    changed = setDefine(defines, REFRACTION, this.refracts && copy) || changed;
    changed = setDefine(defines, SSR, this.marches && copy) || changed;
    changed = setDefine(defines, SSR_STEPS, this.marches && copy ? this.marchSteps : 0) || changed;
    // Every pass at Planar quality compiles it, Render Target Capture passes included: their planar lookup is null
    // (mirrors are per scene view), so the per-draw uniform selects the march or sky fallback. Gating it per pass would
    // need a registry of planar-drawing pass ids, as the scene copy has.
    changed = setDefine(defines, PLANAR, this.mirrors) || changed;
    changed = setDefine(defines, FFT, this.fftCascades) || changed;
    changed = setDefine(defines, WATER_BLEND_DEFINE, this._blend) || changed;
    if (changed) {
      defines.markAsUnprocessed();
      recordWaterVariant(defines, this.mesh, scene);
    }
  }
  /**
   * True when the vertex shader displaces the mesh (`SLATE_WATER_GPU_WAVES`) and the mesh keeps a static rest grid.
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
    if (this._blend) attributes.push("slateWaterBlend", "slateWaterBlendColors");
  }
  override getUniforms() {
    const vectors = [
      "slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves", "slateWaterSun", "slateWaterSunColor",
      "slateWaterLight", "slateWaterShape", "slateWaterFieldBounds", "slateWaterFieldInfo", "slateWaterFieldStep", "slateWaterContactBounds", "slateWaterContactInfo",
      "slateWaterOrigin", "slateWaterGridOffset", "slateWaterSwellInfo", "slateWaterTerms", "slateWaterHaze",
      // Realistic: the analytic sky's zenith and horizon (scene background and fog colours), the per-channel
      // absorption from Shallow Color (w: Low's single coefficient), the uniform-only sun terms and the light through
      // thin crests (Subsurface).
      "slateWaterSky", "slateWaterHorizon", "slateWaterAbsorb", "slateWaterSunShape", "slateWaterThrough",
      // (1 / output width, 1 / output height, Refraction, march distance) and (planar on, display-encoded,
      // distortion, 0): per draw, from the pass's scene copy and the view's planar reflection.
      "slateWaterScreen", "slateWaterPlanar",
      // A blending surface's partners' colours (\`BLEND_COLOR_UNIFORMS\`).
      ...BLEND_COLOR_UNIFORMS, ...FFT_UNIFORMS,
    ];
    const removals = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => i);
    return { ubo: [
      ...[...vectors, ...removals.map((i) => `slateWaterRemovalShape${i}`)].map((name) => ({ name, size: 4, type: "vec4" })),
      ...removals.map((i) => ({ name: `slateWaterRemoval${i}`, size: 16, type: "mat4" })),
      { name: "slateWaterPlanarMatrix", size: 16, type: "mat4" },
    ] };
  }
  // Unused names are dropped by Babylon: the copy and planar samplers bind only in variants that declare them.
  override getSamplers(samplers: string[]): void {
    samplers.push("slateWaterFieldSampler", "slateWaterContactSampler", WATER_SCENE_SAMPLER, WATER_PLANAR_SAMPLER, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER);
  }
  override bindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    buffer.setTexture("slateWaterFieldSampler", this.field?.texture ?? placeholderField(scene));
    buffer.setTexture("slateWaterContactSampler", this.contacts?.texture ?? placeholderField(scene));
    // The variant drawn in this pass declares the copy and planar samplers only with their features; a placeholder
    // (Babylon's empty texture, or an empty array for the spectrum, sampled at gain 0) keeps a declared binding valid in a
    // frame without its source.
    const defines = subMesh?.materialDefines as MaterialDefines | null | undefined;
    if (defines?.[REFRACTION] || defines?.[SSR]) buffer.setTexture(WATER_SCENE_SAMPLER, this.boundCopy?.texture ?? EMPTY_TEXTURE);
    if (defines?.[PLANAR]) buffer.setTexture(WATER_PLANAR_SAMPLER, this.boundPlanar?.texture ?? EMPTY_TEXTURE);
    buffer.setTexture(WATER_FFT_SAMPLER, this.boundFft?.texture ?? placeholderFft(scene));
    // The foam: the placeholder's zero turbulence is neutralized by the zero gain bound with it.
    buffer.setTexture(WATER_FOAM_SAMPLER, this.boundFft?.foam ?? placeholderFft(scene));
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
   * Per draw: asks for the spectrum (`waterSpectrumUniforms`, which is also its demand) and uploads its uniforms. Until
   * it is ready (or when it does not match the compiled cascades) the gain is 0, so the placeholder bound instead leaves
   * the surface flat. Allocation-free.
   */
  private bindFft(buffer: UniformBuffer, scene: Scene): void {
    this.boundFft = waterSpectrumUniforms(scene, this.water, this.waveScale, this.fftCascades, this.fftValues);
    const v = this.fftValues;
    for (let i = 0; i < 1 + WATER_FFT_CASCADES_MAX; i++) buffer.updateFloat4(FFT_UNIFORMS[i]!, v[i * 4]!, v[i * 4 + 1]!, v[i * 4 + 2]!, v[i * 4 + 3]!);
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    this.bindObjectFeatures(buffer, scene, subMesh);
    this.bindFft(buffer, scene);
    // Per mesh, every draw: surfaces that share this material recentre independently, so it is not a frame constant.
    const grid = waterGridOffset(subMesh?.getRenderingMesh() ?? this.mesh);
    buffer.updateFloat4("slateWaterGridOffset", grid[0]!, grid[1]!, grid[2]!, 0);
    const data = sceneWaterBindingData(scene);
    // Packed without allocation, then uploaded.
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
      buffer.updateFloat4("slateWaterContactInfo", 1, contacts.range, contacts.amplitude, 0);
    } else {
      buffer.updateFloat4("slateWaterContactBounds", 0, 0, 1, 1);
      buffer.updateFloat4("slateWaterContactInfo", 0, contactRange(w), 1, 0);
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
   * Writes every input of `frameConstants` into `frameKey` (the render, which owns the scene lighting, the clock, the
   * origin, Wave Scale, tier, reflection source and each definition field it reads) and reports whether any changed
   * since the last call, or a partner did. Allocation-free.
   */
  private frameInputsChanged(data: WaterBindingData, origin: Vector3, scale: number, reflective: boolean, bankFade: number, blend: boolean, quality: Readonly<WaterQuality>): boolean {
    const s = this.frameScratch, w = this.water;
    let n = 0;
    s[n++] = data.frame; s[n++] = data.render; s[n++] = this.time; s[n++] = origin.x; s[n++] = origin.y; s[n++] = origin.z;
    s[n++] = scale; s[n++] = this.tier; s[n++] = reflective ? 1 : 0; s[n++] = bankFade;
    s[n++] = quality.fftSize; s[n++] = quality.fftCascades;
    for (let i = 0; i < FRAME_DEFINITION_FIELDS.length; i++) s[n++] = w[FRAME_DEFINITION_FIELDS[i]!];
    for (let c = 0; c < 3; c++) { s[n++] = w.shallowColor[c]!; s[n++] = w.deepColor[c]!; s[n++] = w.foamColor[c]!; }
    let changed = false;
    for (let k = 0; k < BLEND_PARTNERS; k++) {
      const partner = blend ? this.partners[k] ?? w : null;
      if (this.framePartners[k] !== partner) { this.framePartners[k] = partner; changed = true; }
      if (!partner) continue;
      s[n++] = partner.opacity; s[n++] = partner.reflectionStrength; s[n++] = partner.foamAmount;
      for (let c = 0; c < 3; c++) { s[n++] = partner.shallowColor[c]!; s[n++] = partner.deepColor[c]!; s[n++] = partner.foamColor[c]!; }
    }
    const key = this.frameKey;
    for (let i = 0; i < n; i++) if (!Object.is(key[i], s[i])) { key[i] = s[i]!; changed = true; }
    return changed;
  }
  /** The bound vec4s in `FRAME_UNIFORMS` order (colours, lighting and the asset's terms), read from the definition at every bind. */
  private frameConstants(scene: Scene, data: WaterBindingData): Float64Array {
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    const w = this.water, scale = this.waveScale, blend = this._blend;
    const material = this._material as PBRMaterial, reflective = material.reflectionTexture !== null || scene.environmentTexture !== null;
    const bankFade = this.bankFade();
    // The depth pre-pass and colour draws (and further views) of one render bind the same values: compare every input
    // (a few dozen numbers) instead of recomputing them, so in-place asset edits still apply at the next draw.
    const quality = sceneWaterQualityDeviceClamp(scene).quality;
    if (!this.frameInputsChanged(data, origin, scale, reflective, bankFade, blend, quality)) return this.frameValues;
    const v = this.frameValues;
    let o = 0;
    const lighting = data.lighting, ambient = withWaterEnvironment(lighting, w.reflectionStrength, reflective);
    const exact = scene.getEngine().useExactSrgbConversions;
    o = putLinear(v, o, w.shallowColor, w.opacity, exact);
    o = putLinear(v, o, w.deepColor, w.reflectionStrength, exact);
    o = putLinear(v, o, w.foamColor, w.foamAmount, exact);
    o = put4(v, o, this.time, 0, 0, w.foamWidth);
    o = put4(v, o, 0, w.depthColorDistance, 0, w.subsurface);
    o = put4(v, o, w.waveHeight * scale, w.waveLength, w.waveSpeed, w.waveDirection * Math.PI / 180);
    const sun = lighting.sun, sunColor = lighting.sunColor, sky = lighting.sky, horizon = lighting.horizon;
    o = put4(v, o, sun[0]!, sun[1]!, sun[2]!, sun[3]!);
    o = put4(v, o, sunColor[0]!, sunColor[1]!, sunColor[2]!, w.surfaceFoam);
    o = put4(v, o, sky[0]!, sky[1]!, sky[2]!, lighting.sunGlitter);
    o = put4(v, o, horizon[0]!, horizon[1]!, horizon[2]!, lighting.overcast);
    const shape = lighting.sunShape;
    o = put4(v, o, shape[0]!, shape[1]!, shape[2]!, shape[3]!);
    this.absorption(v, o, lighting, w, exact); o += 8;
    // With floating origin, shaders see positions relative to this offset (the eye); patterns must stay world-anchored.
    o = put4(v, o, origin.x, origin.y, origin.z, w.roughness);
    o = put4(v, o, ambient[0]!, ambient[1]!, ambient[2]!, waterBodyLight(ambient, lighting));
    o = put4(v, o, bankFade, 0, w.colorVariation, 0);
    o = put4(v, o, waterFoamThresholdOf(w, scale, quality.fftSize, Math.max(1, quality.fftCascades)), w.waveSpread, w.crestFoam, w.contactFoamWidth);
    o = put4(v, o, smoothstep(0, 0.1, w.foamAmount) * Math.max(w.foamAmount, 0.85) * smoothstep(0, 0.05, w.contactFoamWidth), smoothstep(0, 0.05, w.crestFoam), 1 / waterFoamScale(scale), 0);
    const haze = lighting.haze;
    o = put4(v, o, haze[0]!, haze[1]!, haze[2]!, haze[3]!);
    for (let k = 0; blend && k < BLEND_PARTNERS; k++) {
      // Each partner's colours, through the same conversions as the asset's own (its own again in an empty slot).
      const partner = this.partners[k] ?? w;
      o = putLinear(v, o, partner.shallowColor, partner.opacity, exact);
      o = putLinear(v, o, partner.deepColor, partner.reflectionStrength, exact);
      o = putLinear(v, o, partner.foamColor, partner.foamAmount, exact);
      this.absorption(v, o, lighting, partner, exact); o += 8;
    }
    return v;
  }
  /**
   * Per-channel absorption for Realistic transmittance (`slateWaterAbsorb`, `waterAbsorption`; `w` is spare, 0), and
   * the light through thin crests (`slateWaterThrough`, Subsurface): the sun's colour times what a crest transmits, by
   * the gentler `glowCoefficient`, with Opacity's cap on the absorption path in `w`. Allocation-free.
   */
  private absorption(v: Float64Array, o: number, lighting: WaterLighting, water: WaterDefinition, exact: boolean): void {
    const absorb = waterAbsorption(water, exact, absorbScratch), pathCap = absorb[3]!;
    put4(v, o, absorb[0]!, absorb[1]!, absorb[2]!, 0);
    gammaScratch.set(Math.max(0, water.shallowColor[0]), Math.max(0, water.shallowColor[1]), Math.max(0, water.shallowColor[2])).toLinearSpaceToRef(linearScratch, exact);
    const r = linearScratch.r, g = linearScratch.g, b = linearScratch.b;
    // Light through a crest crosses more open water than a shallow, through gentler ratios, and blue goes at least as
    // fast as green there (the plankton and dissolved matter of open water absorb blue), so crests glow teal against the
    // navy body even where clear shallows over sand read azure.
    const gr = glowCoefficient(r), gg = glowCoefficient(g), gb = Math.max(glowCoefficient(b), gg), glowWeight = Math.min(gr, gg, gb);
    const tr = Math.min(gr / glowWeight, GLOW_RATIO_CAP), tg = Math.min(gg / glowWeight, GLOW_RATIO_CAP), tb = Math.min(gb / glowWeight, GLOW_RATIO_CAP);
    const sun = lighting.sun[3]! * lighting.subsurfaceLift * 0.8, color = lighting.sunColor;
    put4(v, o + 4, color[0]! * Math.exp(-tr * 1.6) * sun, color[1]! * Math.exp(-tg * 1.6) * sun, color[2]! * Math.exp(-tb * 1.6) * sun, pathCap);
  }
  private bankFade(): number { return this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, this.waveScale); }
  /**
   * Defines another pass's program needs for `waterOutlineVertexSource` to match this material's vertex shader: the
   * spectrum's cascades and the blend scaling. Allocation-free.
   */
  vertexWaveDefines(): readonly string[] {
    return VERTEX_WAVE_DEFINES[this._blend ? 1 : 0]![this.fftCascades]!;
  }
  /** Mesh attributes `waterOutlineVertexSource` reads under `vertexWaveDefines`. Allocation-free. */
  vertexWaveAttributes(): readonly string[] {
    return VERTEX_WAVE_ATTRIBUTES[this._blend ? 1 : 0]!;
  }
  /**
   * Sets `WATER_VERTEX_WAVE_UNIFORMS` and the spectrum's sampler on another pass's effect for this frame, as
   * `hardBindForSubMesh` and `bindForSubMesh` do, and the drawn `mesh`'s grid offset.
   */
  bindVertexWaves(effect: Effect, scene: Scene, mesh: AbstractMesh): void {
    const band = waterSpectrumUniforms(scene, this.water, this.waveScale, this.fftCascades, this.fftValues);
    bindWaterVertexUniforms(effect, scene, waterGridOffset(mesh), this.bankFade(), this.fftValues, band);
  }
  /**
   * Injected code is a pure function of (stage, language), so it is built and stripped once per key (`injectionFor`).
   * Babylon calls this at every effect compile, once per injection point.
   */
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== "vertex" && shaderType !== "fragment") return null;
    return injectionFor(shaderType, language);
  }
}

export function configureWaterMaterial(material: PBRMaterial, water: WaterDefinition): void {
  // Water drops the light loop at Low Water Shading Detail (`WaterMaterialPlugin.syncQuality`).
  material.unlit = material.disableLighting = false;
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
