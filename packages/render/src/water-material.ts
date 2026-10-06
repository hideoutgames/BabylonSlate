import {
  BaseTexture, Color3, Constants, DirectionalLight, HemisphericLight, MaterialPluginBase, Matrix, PBRMaterial, type MaterialDefines, RawTexture, ShaderLanguage,
  Texture, ThinTexture, Vector3, type AbstractEngine, type AbstractMesh, type Effect, type Material, Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import {
  WATER_CREST_MEAN, WATER_CREST_RANGE, WATER_FFT_CASCADES_MAX, WATER_JACOBIAN_FLOOR, WATER_WAVE_MAX_COMPONENTS, WATER_WAVE_SHADER_STRIDE, waterBankFadeLength,
  waterWaveComponents, waterWaveQ, waterWaveSet, waterWaveShaderConstants, type WaterBodyProperties, type WaterColor, type WaterDefinition,
  type WaterShadingDetail, type WaterWaveSet,
} from "@babylonslate/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { waterFftForSurface, type WaterFftResult } from "./water-fft";
import { waterFftLayout } from "./water-fft-spectrum";
import { invalidateSceneLighting } from "./scene-lighting";
import type { WaterContactField } from "./water-contact-field";
import { WATER_FIELD_DEPTH_RANGE, WATER_FIELD_FINE_DEPTH_SPAN, WATER_FIELD_SHORE_RANGE as SHORE, WATER_FIELD_TERRAIN_ALPHA, type WaterField } from "./water-field";
import { waterPlanarReflectionForCamera, type WaterPlanarReflection } from "./water-planar-reflection";
import type { WaterQualityDeviceClamp } from "./water-quality-device";
import { sceneWaterRemovals, waterRemovalShapeVector, waterRemovalWorldRadius } from "./water-removal-mesh";
import { WATER_SCENE_COPY_SKY_DEPTH, isMainWaterPass, waterSceneCopyForPass, type WaterSceneCopy } from "./water-scene-copy";

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

/** Compile-time style switch: each material compiles only its own style's shading. */
const WATER_STYLIZED_DEFINE = "SLATE_WATER_STYLIZED";
/** Ocean Spectrum evaluates all `WATER_WAVE_MAX_COMPONENTS` swell components; Classic compiles only its five. */
const WATER_OCEAN_DEFINE = "SLATE_WATER_OCEAN";
/**
 * Built-in water evaluates the swell in its vertex shader from the same uniforms the fragment uses: the mesh uploads a
 * static rest grid and only the clock advances. Custom Material water keeps CPU-displaced vertices.
 */
export const WATER_GPU_WAVES_DEFINE = "SLATE_WATER_GPU_WAVES";
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
/** Water thickness (metres) beyond which the refracted shift stops growing, and the largest shift (uv). */
const REFRACTION_DEPTH_CAP = 3;
const REFRACTION_SHIFT_CAP = 0.06;
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
/** Lowest tier evaluating each realistic chop octave, capillary, and Stylized chop octave. */
const CHOP_TIER = [0, 0, 1, 1, 2, 2] as const;
const CAPILLARY_TIER = [1, 2, 2, 2] as const;
const STYLIZED_CHOP_TIER = [0, 1, 2] as const;
/**
 * Radians each realistic chop octave's phase drifts across the large and the medium anti-tiling noise: its crests
 * wander instead of running straight, so crossing octaves never form a regular lattice of bumps.
 */
const CHOP_PHASE_DRIFT = [[3.1, 2.2], [-4.3, -2.5], [5.2, 1.8], [-6.1, -2.0], [7.4, 1.4], [-8.2, -1.6]] as const;
/** Frequencies (per metre) of the shared large and gust noises; the chop warp sizes its amplitude to each. */
const LARGE_NOISE = 0.07, GUST_NOISE = 0.013;
/**
 * Slope variance of wind ripples below the smallest capillary octave, per unit of chop gain squared: added to the GGX
 * roughness (within the sea-state cap) so resolved close water spreads the sun into a soft lobe for the glitter to
 * break up. Ripple Strength 0 keeps a mirror.
 */
const SUB_CAPILLARY_VARIANCE = 0.008;
/** Low evaluates only this many swell components (the largest slopes) in the fragment shader; the vertex shader keeps all. */
const LOW_SWELL_COMPONENTS = 3;
const SWELL_DIRECTION = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => `slateWaterSwellDir${i}`);
const SWELL_AMPLITUDE = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => `slateWaterSwellAmp${i}`);
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
float swCellDistance(vec2 p, vec2 c) {
  return length(p - c - vec2(0.5) - (vec2(swHash(c), swHash(c + vec2(19.0, 7.0))) - vec2(0.5)) * 0.5);
}
vec2 swCells(vec2 p) {
  vec2 b = floor(p - vec2(0.5));
  float d0 = swCellDistance(p, b);
  float d1 = swCellDistance(p, b + vec2(1.0, 0.0));
  float d2 = swCellDistance(p, b + vec2(0.0, 1.0));
  float d3 = swCellDistance(p, b + vec2(1.0, 1.0));
  float swNear = min(min(d0, d1), min(d2, d3));
  float swSecond = min(min(max(d0, d1), max(d2, d3)), max(min(d0, d1), min(d2, d3)));
  return vec2(swNear, swSecond - swNear);
}
`;

const f = (n: number) => n.toFixed(6);

type WaterShaderStyle = "realistic" | "stylized";

/** One realistic chop octave or capillary: the footprint along its own direction from High up, isotropic below. */
function footprintFade(prefix: string, i: number, k: string, dir: string): string {
  return fromTier(2, `
float ${prefix}${i} = 1.0 - smoothstep(0.4, 1.4, ${k} * (abs(dot(${dir}, swFootX)) + abs(dot(${dir}, swFootY))));`, `
float ${prefix}${i} = 1.0 - smoothstep(0.4, 1.4, ${k} * swFoot * 0.64);`);
}

/**
 * Refraction (`SLATE_WATER_REFRACTION`), right after the bottom estimate: the view ray bends by the surface tilt (in
 * view space), more through thicker water and less far away, and reads the view's scene copy there. A shifted ray
 * that lands on something in front of the water (an object above it) keeps the straight ray, so nothing above the
 * surface leaks into it. The copy's depth also bounds the bottom estimate (similar triangles along the view ray), so
 * absorption follows whatever actually lies below: the bed shows through shallows, deep water fades to its colour.
 * Orthographic views (`projection[3][3]` is 1) bend by the same view-space amount at every distance, and their view
 * rays are parallel: the bound follows the camera's forward axis instead of the ray through the eye.
 * GLSL-shaped; `SW_FRAG_COORD` and the copy helpers are bound per language.
 */
function refractionSource(): string {
  return ifDefined(REFRACTION, `
vec2 swScreenUv = SW_FRAG_COORD.xy * U.slateWaterScreen.xy;
float swWaterZ = abs((S.view * vec4(IN.vPositionW, 1.0)).z);
float swSceneZ0 = swSceneDepth(swScreenUv);
vec2 swTiltV = (S.view * vec4(-swSlope.x, 0.0, -swSlope.y, 0.0)).xy;
float swRefrDepth = min(max(swSceneZ0 - swWaterZ, 0.0), ${f(REFRACTION_DEPTH_CAP)});
float swOrtho = S.projection[3][3];
vec2 swRefrShift = swTiltV * vec2(S.projection[0][0], S.projection[1][1]) * (U.slateWaterScreen.z * ${f(REFRACTION_SHIFT)} * swRefrDepth * mix(1.0 / max(swWaterZ, 0.05), 1.0, swOrtho));
swRefrShift = swRefrShift * min(1.0, ${f(REFRACTION_SHIFT_CAP)} / max(length(swRefrShift), 0.000001));
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
 * FFT ocean detail in the fragment (`SLATE_WATER_FFT`), after the shared noises. Each cascade is sampled at this
 * fragment's rest point (the band is Lagrangian, like the swell: detail rides the waves instead of sliding over
 * them) and fades with the rest-plane pixel footprint along its longer axis, by the same curve as the swell components
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
float swFftFd${c} = 1.0 - smoothstep(0.6, 2.2, swFftC${c}.w * swFftReach);
float swFftM${c} = 0.55 + 0.9 * ${c === 0 ? "swLarge" : "swMedium"};
if (swFftFd${c} > 0.0) {
  vec2 swFftUv${c} = swRest * swFftC${c}.x + swFftC${c}.yz;
  vec4 swFftA${c} = swFftTap(swFftUv${c}, ${f(2 * c)});
  vec4 swFftB${c} = swFftTap(swFftUv${c}, ${f(2 * c + 1)});
  float swFftF${c} = swFftFd${c} * swFftM${c};
  swFftGrad += swFftB${c}.xy * swFftF${c};
  swFftJ += vec3(swFftB${c}.z, swFftA${c}.w, swFftB${c}.w) * swFftF${c};
}`;
    return c === 0 ? code : ifFft(code, c + 1);
  }).join("");
  return ifFft(`
vec4 swFft = U.slateWaterFft;
float swFftReach = max(length(swFootX), length(swFootY));
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
  vec2 swvFu${c} = swvRest * swvFc${c}.x + swvFc${c}.yz;
  vec4 swvFa${c} = swFftTap(swvFu${c}, ${f(2 * c)});
  vec4 swvFb${c} = swFftTap(swvFu${c}, ${f(2 * c + 1)});
  swvFftH += swvFa${c}.y * swvFw${c};
  swvFftD += swvFa${c}.xz * swvFw${c};
  swvFftJ += vec3(swvFb${c}.z, swvFa${c}.w, swvFb${c}.w) * swvFw${c};
}`;
    return c === 0 ? code : ifFft(code, c + 1, FFT_VERTEX);
  }).join("");
  return ifFft(`
vec4 swvFft = U.slateWaterFft;
float swvReach = max(swvSpacing, 2.0 * (swvFft.z * abs((S.view * worldPos).z) + swvFft.w));
float swvFftH = 0.0;
vec2 swvFftD = vec2(0.0);
vec3 swvFftJ = vec3(0.0);${cascades}
float swvJxx = 1.0 - swvGain * swvShear.x;
float swvJxz = -swvGain * swvShear.y;
float swvJzz = 1.0 - swvGain * swvShear.z;
float swvDetA = swvJxx * swvJzz - swvJxz * swvJxz;
vec3 swvJb = swvFftJ * (swvFft.x * swvFft.y * swvGain);
float swvDetB = (swvJxx + swvJb.x) * (swvJzz + swvJb.z) - (swvJxz + swvJb.y) * (swvJxz + swvJb.y);
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
 *   of the neighbouring texel away from the farther side (four depth loads and one texel load, only on a hit).
 * Hits fade toward the screen edge and the end of the march; one whose scene point lies under the water plane is
 * rejected (the copy holds submerged geometry). Returns linear colour and coverage.
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
  let swFade = smoothstep(0.0, 0.06, min(swEdge.x, swEdge.y)) * (1.0 - smoothstep(0.7, 1.0, swS)) * step(swOrigin.y - 0.05, swSceneY)
    * step(abs(swRayZ - swHit.a), swThickHit);
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
  float swFade = smoothstep(0.0, 0.06, min(swEdge.x, swEdge.y)) * (1.0 - smoothstep(0.7, 1.0, swS)) * step(swOrigin.y - 0.05, swSceneY)
    * step(abs(swRayZ - swHit.a), swThickHit);
  return vec4(swHit.rgb, swFade);
}`;
}

/** Swell, wind chop, contacts and depth shared by both styles; Stylized runs fewer chop octaves. */
function surfaceSource(style: WaterShaderStyle): string {
  const realistic = style === "realistic";
  // The shared kernel's components (`waterWaveShaderConstants`) at this fragment's rest point: the same swell, crest
  // profile and Gerstner offset the mesh, queries and buoyancy use. Phases arrive reduced on the CPU relative to the
  // floating origin, so no large-argument trigonometry runs here. Slots hold the components by descending slope, so
  // Low's first three are the ones that shape the light most.
  const swell = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => {
    let code = `
vec4 swWD${i} = U.${SWELL_DIRECTION[i]};
vec4 swWA${i} = U.${SWELL_AMPLITUDE[i]};
float swK${i} = swWD${i}.z;
vec2 swD${i} = swWD${i}.xy;
float swP${i} = swK${i} * dot(swD${i}, swRest) + swWA${i}.y;
float swA${i} = swWA${i}.x;
float swFd${i} = 1.0 - smoothstep(0.6, 2.2, swK${i} * (abs(dot(swD${i}, swFootX)) + abs(dot(swD${i}, swFootY))));
float swF${i} = swFd${i} * swA${i};
float swS${i} = sin(swP${i});
float swC${i} = cos(swP${i});
float swE${i} = exp(swS${i} - 1.0);
swHeight += mix(swS${i}, (swE${i} - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swChopShape) * swF${i};
swGradient += swD${i} * (mix(swC${i}, swE${i} * swC${i} / ${f(WATER_CREST_RANGE)}, swChopShape) * swK${i} * swF${i});
swFold += swK${i} * swF${i} * mix(swS${i}, swE${i} * (swS${i} - swC${i} * swC${i}) / ${f(WATER_CREST_RANGE)}, swChopShape);
swResolved += swK${i} * swF${i};${realistic ? `
swLost += swK${i} * swA${i} * swK${i} * swA${i} * (1.0 - swFd${i} * swFd${i});` : ""}
float swQ${i} = swWA${i}.z * swFd${i};
swOffset += swD${i} * (swQ${i} * swC${i});
swShear += vec3(swD${i}.x * swD${i}.x, swD${i}.x * swD${i}.y, swD${i}.y * swD${i}.y) * (swQ${i} * swK${i} * swS${i});`;
    if (i >= LOW_SWELL_COMPONENTS) code = fromTier(1, code);
    return i < waterWaveComponents.length ? code : ifDefined(WATER_OCEAN_DEFINE, code);
  }).join("");
  // Low: the swell components it skips still count as resolved slope (faded like its last one) and, Realistic, as
  // roughness, so they widen the sun path instead of vanishing.
  const lowSwell = fromTier(1, "", `
swResolved += U.slateWaterSea.w * swFd${LOW_SWELL_COMPONENTS - 1};${realistic ? `
swLost += U.slateWaterSea.z;` : ""}`);
  const detail = realistic
    ? DETAIL_OCTAVES.map(([, , slope], i) => fromTier(CHOP_TIER[i]!, `
vec4 swOC${i} = U.${CHOP_UNIFORMS[i]};
// The large noise drifts each octave's phase by its own amount, so crossing octaves never lock into a lattice.
float swOX${i} = swOC${i}.z * dot(swOC${i}.xy, swChop) + swOC${i}.w + swLarge * ${f(CHOP_PHASE_DRIFT[i]![0])} + swMedium * ${f(CHOP_PHASE_DRIFT[i]![1])};
float swOW${i} = exp(sin(swOX${i}) - 1.0);
float swOCs${i} = cos(swOX${i});${footprintFade("swOFd", i, `swOC${i}.z`, `swOC${i}.xy`)}
// Anti-tiling: each octave's strength drifts with the shared noises (longer octaves with the larger one), and the two
// octaves of each pair drift in opposition, so where one crossing direction dominates the other fades: no lattice.
float swOA${i} = ${f(slope)} * swOFd${i} * (0.25 + 1.5 * ${i % 2 === 0 ? "" : "(1.0 - "}smoothstep(0.3, 0.7, mix(swMedium, swLarge, ${f(1 - Math.floor(i / 2) / 2)}))${i % 2 === 0 ? "" : ")"});
swDetail += swOC${i}.xy * (swOW${i} * swOCs${i} * swOA${i});
swChopH += (swOW${i} - 0.37) * swOA${i};
swChop -= swOC${i}.xy * (swOW${i} * swOCs${i} * 0.3 / swOC${i}.z);
swLostDetail += ${f(octaveVariance(slope))} * (1.0 - swOFd${i} * swOFd${i});`, `
swLostDetail += ${f(octaveVariance(slope))};`)).join("")
    : DETAIL_OCTAVES.slice(0, STYLIZED_CHOP_TIER.length).map(([, , slope], i) => fromTier(STYLIZED_CHOP_TIER[i]!, `
vec4 swOC${i} = U.${CHOP_UNIFORMS[i]};
float swOX${i} = swOC${i}.z * dot(swOC${i}.xy, swChop) + swOC${i}.w;
float swOW${i} = exp(sin(swOX${i}) - 1.0);
float swOCs${i} = cos(swOX${i});
float swOA${i} = ${f(slope * (1 - Math.min(0.85, i * 0.14)))} * (1.0 - smoothstep(0.3, 1.1, swOC${i}.z * swFoot));
swDetail += swOC${i}.xy * (swOW${i} * swOCs${i} * swOA${i});
swChopH += (swOW${i} - 0.37) * swOA${i};
swChop -= swOC${i}.xy * (swOW${i} * swOCs${i} * 0.3 / swOC${i}.z);`)).join("");
  const capillaries = realistic ? CAPILLARY_OCTAVES.map(([, , slope], i) => fromTier(CAPILLARY_TIER[i]!, `
vec4 swCC${i} = U.${CAPILLARY_UNIFORMS[i]};
float swCX${i} = swCC${i}.z * dot(swCC${i}.xy, swRippleDomain) + swCC${i}.w;${footprintFade("swCFd", i, `swCC${i}.z`, `swCC${i}.xy`)}
swDetail += swCC${i}.xy * (exp(sin(swCX${i}) - 1.0) * cos(swCX${i}) * ${f(slope)} * swCFd${i} * swRipplePatch);
swLostDetail += ${f(octaveVariance(slope))} * (1.0 - swCFd${i} * swCFd${i});`, `
swLostDetail += ${f(octaveVariance(slope))};`)).join("") : "";
  return `
vec2 swWorld = swPosW.xz;
float swTime = U.slateWaterMotion.x;
// Filtering footprint on the rest plane under this pixel's view ray. Unlike derivatives of the displaced mesh it
// is smooth across triangles, so partly faded octaves never reveal the tessellation.
float swEyeAbove = abs(S.vEyePosition.y - IN.vPositionW.y + IN.vSlateWater.x);
vec2 swRestXZ = viewDirectionW.xz * (swEyeAbove / max(abs(viewDirectionW.y), 0.001));
vec2 swFootX = dFdx(swRestXZ);
vec2 swFootY = dFdy(swRestXZ);
float swFoot = length(swFootX) + length(swFootY);
vec2 swFlowed = swWorld - IN.vSlateWaterFlow.xy * swTime;
// Rest (Lagrangian) point of this fragment relative to the floating origin: the interpolated Gerstner offset is
// exact for the displaced triangle, since the mesh adds it to a planar rest grid.
vec2 swRest = IN.vPositionW.xz - IN.vSlateWaterFlow.zw;
float swHeight = 0.0;
vec2 swGradient = vec2(0.0);
// Crest sharpness a*k*(-P''): positive and largest on steep, sharp crests.
float swFold = 0.0;
// Sum of k*a over every component (CPU), and the resolved share this fragment evaluates.
float swSteep = U.slateWaterSea.x;
float swResolved = 0.0;${realistic ? `
float swLost = 0.0;
float swLostDetail = 0.0;` : ""}
float swChopShape = U.slateWaterShape.x;
// Unfaded Gerstner offset and sum(q*a*k*sin(p) * d d^T) (xx, xz, zz) at the rest point, filtered like the swell.
vec2 swOffset = vec2(0.0);
vec3 swShear = vec3(0.0);
${swell}${lowSwell}
vec3 swBaseNormal = normalize(IN.vSlateWaterBaseNormal);
float swBaseX = swBaseNormal.x / max(0.001, swBaseNormal.y);
float swBaseZ = swBaseNormal.z / max(0.001, swBaseNormal.y);
// Finite bodies fade the horizontal offset to zero at their banks (\`waterBankGain\`), from the interpolated bank
// distance; its rest-space gradient comes from screen derivatives and is a unit vector for a distance field.
float swFadeLength = max(U.slateWaterSwellInfo.x, 0.000001);
float swFadeOn = step(0.000001, U.slateWaterSwellInfo.x);
float swBankT = clamp(IN.vSlateWater.y / swFadeLength, 0.0, 1.0);
float swGain = mix(1.0, swBankT * swBankT * (3.0 - 2.0 * swBankT), swFadeOn);
vec2 swRestDx = dFdx(swRest);
vec2 swRestDy = dFdy(swRest);
float swBankDx = dFdx(IN.vSlateWater.y);
float swBankDy = dFdy(IN.vSlateWater.y);
vec2 swBankGrad = vec2(swBankDx * swRestDy.y - swBankDy * swRestDx.y, swRestDx.x * swBankDy - swRestDy.x * swBankDx);
vec2 swGainGrad = swBankGrad / max(length(swBankGrad), 0.000001) * (6.0 * swBankT * (1.0 - swBankT) / swFadeLength * swFadeOn);
// J = I + gain * grad(D) + D grad(gain)^T. The swell's Eulerian slope is J^-T (rest slope + grad H); det J < 1 where water gathers.
float swJxx = 1.0 - swGain * swShear.x + swOffset.x * swGainGrad.x;
float swJxz = swOffset.x * swGainGrad.y - swGain * swShear.y;
float swJzx = swOffset.y * swGainGrad.x - swGain * swShear.y;
float swJzz = 1.0 - swGain * swShear.z + swOffset.y * swGainGrad.y;
float swDetJ = swJxx * swJzz - swJxz * swJzx;
vec2 swRestSlope = swGradient - vec2(swBaseX, swBaseZ);
swGradient = vec2(swBaseX, swBaseZ) + vec2(swJzz * swRestSlope.x - swJzx * swRestSlope.y, swJxx * swRestSlope.y - swJxz * swRestSlope.x) / max(swDetJ, ${f(WATER_JACOBIAN_FLOOR / 2)});
// Shared noises: Low evaluates two and derives the rest; Medium four; High and Ultra add the contact ripple noise.
float swMedium = swNoise(swFlowed * 0.43 + vec2(swTime * 0.03, 0.0));${realistic ? `
float swLarge = swNoise(swWorld * ${f(LARGE_NOISE)});` : `
// Stylized posterises its colour drifts, where a value noise's cell grid would show as soft-edged rectangles: the
// medium noise bends the large one's domain (by up to about a third of a cell), so the drifts curve instead. The bend
// fades where the medium noise would alias, so distant drifts never speckle.
float swLarge = swNoise(swWorld * ${f(LARGE_NOISE)} + vec2(swMedium - 0.5, 0.5 - swMedium) * (0.7 * (1.0 - smoothstep(0.6, 1.6, swFoot))));`}${fromTier(1, `
float swFine = swNoise(swFlowed * 2.9 - vec2(0.0, swTime * 0.09));
// Gusts roughen or calm wide patches.
float swGust = swNoise(swWorld * ${f(GUST_NOISE)} + vec2(swTime * 0.004, 0.0));`, `
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
float swDrift = swLarge * 0.5 + swGust * 0.3 + swMedium * 0.2;${realistic ? fromTier(1, `
// Bend it at a finer scale too, so crossing octaves never settle into a regular quilt in the sun's reflection; the
// fine part fades before its noise would alias.
swChop += vec2(swMedium - 0.5, (swFine - 0.5) * (1.0 - smoothstep(0.3, 1.0, swFoot))) * 0.6;`) : ""}
vec2 swDetail = vec2(0.0);
float swChopH = 0.0;
${detail}${realistic ? fromTier(1, `
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
float swBank = min(min(max(0.0, IN.vSlateWater.y), max(0.0, swFieldShore)), ${f(SHORE[1])});
float swBodyDepth = max(0.01, IN.vSlateWater.z);
float swFoamWidth = max(0.001, U.slateWaterMotion.w);
float swCalm = smoothstep(0.0, swFoamWidth * 2.0 + 0.5, swBank);
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
float swRippleFade = exp(-swOutside / (swContactW * 1.4)) * smoothstep(-0.05, 0.08, swContactSigned) * swRippleAA * swNearContact;${fromTier(1, `
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
float swDepth = mix(swBodyDepth * (1.0 - exp(-swBank * swShelf / swBodyDepth)), max(0.0, swTerrainDepth), swKnown);${realistic ? "" : `
// The bed under this point, before refraction bounds it by whatever lies nearer.
float swBedDepth = swDepth;`}${refractionSource()}
float swAbsorb = max(0.01, U.slateWaterLook.y);
float swTone = 1.0 - exp(-swDepth * 2.0 / swAbsorb);
float swCrest = swHeight / max(0.001, U.slateWaterWaves.x);
// Crest sharpness relative to what the waves can reach (CPU denominator), gated by how steep the sea is (long gentle
// swell and small lake waves never break) and by how much of the swell is still resolved, so distant filtered swell
// never breaks in regular rows.
float swFoldN = swFold / U.slateWaterSea.y;
// Jacobian foam: on steep seas, Gerstner crests that gather water (det J below 1) break like sharp crests. Steepness
// normalizes det J to the sea, so the sea's own slope gates it: small lake waves never foam on every crest.
swFoldN = mix(swFoldN, max(swFoldN, (1.0 - swDetJ) / ${f(1 - WATER_JACOBIAN_FLOOR)} * smoothstep(0.2, 0.5, swSteep)), U.slateWaterSwellInfo.y);
float swRough = smoothstep(0.08, 0.5, swSteep) * smoothstep(0.5, 0.9, swResolved / max(0.0001, swSteep));
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
 * Realistic: lit PBR (unlit at Low, see `configureWaterMaterial`). Everything here is premultiplied by coverage;
 * `CUSTOM_FRAGMENT_BEFORE_FOG` divides by alpha so standard blending yields reflection + specular + (1 - F) *
 * (T * background + (1 - T) * in-scattered light).
 *
 * - Colour: water absorbs red first (per channel from Shallow Color, Medium up), so what shows through and the light
 *   scattered back take the water's hue with depth; the in-scattered body lightens toward Shallow Color over shallows,
 *   on crests and at grazing views, and thin crests seen toward a low sun glow (Subsurface).
 * - Sky: without an environment or skybox the reflection is an analytic sky from the scene (`slateWaterSky`): its
 *   background colour overhead, its fog colour (or background) at the horizon, warmed around a low sun's azimuth, with
 *   a sun aureole, blurred by the filtered roughness.
 * - Foam: one density field (shore swash, depth-limited surf, crest caps and their trails, wind streaks) thresholds a
 *   bubble web, so dense foam is solid and decaying foam opens round holes, thins into lace and breaks into fragments.
 * - Contacts: a churned collar at each object's waterline that stretches downstream (the current, or downwind), and
 *   from High a trailing wake read from two upstream contact-field taps.
 * - Shores: the swash band breathes with the wave phase at the moving waterline, crests break where the water is
 *   shallow for its waves, and the thinnest water darkens the bed under it (a wet band, from the water alone).
 */
function realisticSource(): string {
  const crestFoam = WATER_FEATURE_DEFINES.crestFoam, surfaceFoam = WATER_FEATURE_DEFINES.surfaceFoam;
  return surfaceSource("realistic") + `
vec3 swV = viewDirectionW;
// The chop normal before the horizon treatment: in-scatter and glitter see the actual facets.
vec3 swWaveN = normalW;
// Toward the horizon the chop flattens into the swell, so distant water keeps reflecting the horizon sky.
float swGraze = 1.0 - clamp(swV.y, 0.0, 1.0);
float swGraze4 = swGraze * swGraze * swGraze * swGraze;
normalW = normalize(mix(normalW, swSwellNormal, swGraze4 * swGraze4 * swGraze4 * 0.6));
// Detail filtered away at a distance still roughens the surface, bounded by a sea-state cap (CPU): calm water stays
// glossy, rough seas reach Cox-Munk-like roughness instead of mirroring the sky in smooth blobs. Wide wind slicks and
// rougher patches (the shared wide noises) vary it, so the far sea is neither one mirror nor one even sheen.
float swSlick = 0.6 + 0.8 * smoothstep(0.2, 0.8, swGust * 0.55 + swLarge * 0.45);
swSlopeVariance = min((swLost + swLostDetail * swChopGain * swChopGain) * swSlick, U.slateWaterTerms.z);
// Keep reflected rays above the horizon, higher for rougher water so its blurred lobe stays in the sky: below it the
// water would reflect only more water. A smooth maximum leaves no plateau of identical directions on wave backs. The
// shading normal becomes the half vector toward the lifted reflection.
vec3 swRefl = reflect(-swV, normalW);
float swReflFloor = 0.025 + sqrt(swSlopeVariance) * 1.2;
float swReflLift = swRefl.y + log(1.0 + exp(30.0 * (swReflFloor - swRefl.y))) / 30.0;
swRefl.y = mix(swRefl.y, swReflLift, step(0.0, swV.y));
normalW = normalize(swV + normalize(swRefl));
// Wind ripples below the smallest capillary octave (centimetres) tilt every facet a little, so even fully resolved close
// water spreads the sun into a soft lobe that the glitter breaks up, instead of chrome contours along the resolved
// waves. Calm water (no ripples) stays a mirror, and the sea-state cap bounds it.
swSlopeVariance = min(swSlopeVariance + ${f(SUB_CAPILLARY_VARIANCE)} * swChopGain * swChopGain, U.slateWaterTerms.z);
float swNdotV = clamp(dot(normalW, swV), 0.0, 1.0);
float swFresX = 1.0 - swNdotV;
float swFresX2 = swFresX * swFresX;
float swFres = 0.02 + 0.98 * swFresX2 * swFresX2 * swFresX;
// Beer-Lambert absorption down to the floor and back along the refracted ray (water IOR 1.333).
float swCosT = sqrt(1.0 - (1.0 - swNdotV * swNdotV) * 0.5625);
float swPath = swDepth * (1.0 + 1.0 / swCosT) / swAbsorb;${fromTier(1, `
// Per channel (from Shallow Color, CPU): red goes first, so sand under shallows turns turquoise and what shows through
// takes the water's hue with depth.
vec3 swTransmitRgb = max(exp(-swPath * U.slateWaterAbsorb.rgb), vec3(1.0 - U.slateWaterShallow.a));
float swTransmit = dot(swTransmitRgb, vec3(0.3, 0.59, 0.11));`, `
float swTransmit = max(exp(-swPath), 1.0 - U.slateWaterShallow.a);
vec3 swTransmitRgb = vec3(swTransmit);`)}${ifDefined(REFRACTION, `
// Where the copy holds no geometry behind the water (its sky depth), there is no floor in view: open water transmits
// no background (the sky colour behind it never tints the sea), and its in-scattered light fills in.
float swVoid = step(${f(WATER_SCENE_COPY_SKY_DEPTH * 0.9)}, swSceneZ);
swTransmitRgb *= 1.0 - swVoid;
swTransmit *= 1.0 - swVoid;`)}
vec3 swCol = mix(U.slateWaterShallow.rgb, U.slateWaterDeep.rgb, swTone);
// In-scattering (Atlas/Crest form): the absorption tint sets transmittance, but the scattered body has its own,
// lighter colour that shifts toward Shallow on crests, at grazing views and over shallows, so water away from the sun
// keeps colour while looking straight down into deep water shows Deep Color. Color Variation drifts it in wide
// patches. Faces turned to the eye and slopes toward the sun brighten it; sunlight through thin crests seen toward the
// sun (Subsurface) turns them bright and green.
float swFaceV = clamp(dot(swWaveN, swV), 0.0, 1.0);
// Crests lift the scatter most at grazing views, where they stand against the troughs behind them. Seen from above,
// a full lift would print the swell's interference pattern into the colour as a regular lattice, so it weakens toward
// steep views and drifts with the wide noises.
float swLiftGain = (0.3 + 0.7 * swGraze) * (0.4 + 0.75 * swLarge + 0.45 * swGust);
float swCrestLift = clamp(swCrest * 0.5 * swLiftGain + 0.5, 0.0, 1.0);
vec3 swScatterCol = mix(U.slateWaterDeep.rgb, U.slateWaterShallow.rgb, clamp(0.1 + 0.22 * swCrestLift + 0.2 * swGraze * swGraze + 0.2 * (1.0 - swTone), 0.0, 0.7));
float swPatch = smoothstep(0.3, 0.75, swDrift) * U.slateWaterSwellInfo.z;
swScatterCol = mix(swScatterCol, U.slateWaterShallow.rgb * vec3(0.85, 1.05, 0.9), swPatch * 0.35);
float swFaceLit = swFaceV * swFaceV * (0.6 + 0.4 * swCrestLift);
float swSlopeLit = max(dot(swSwellNormal, swL), 0.0);
// Sunlight entering the water weakens for a low sun (most of it reflects off at grazing incidence), so a sunset sea
// is mostly reflection.
float swSunIn = 0.25 + 0.75 * smoothstep(0.0, 0.5, swL.y);
vec3 swScatter = swScatterCol * (swAmb * (0.55 + 0.45 * swCrestLift) + swSun * ((0.35 * swFaceLit + 0.3 * swSlopeLit) * swSunIn));${ifDefined(WATER_FEATURE_DEFINES.subsurface, `
// Sunlight through thin crests and wave faces seen toward the sun, strongest for a sun some way above the horizon (a
// high sun lights crests from above rather than through them; a setting sun's light is dim and red, which water absorbs).
vec2 swLookH = -swV.xz / max(length(swV.xz), 0.0001);
vec2 swSunH = swL.xz / max(length(swL.xz), 0.0001);
float swToSun = clamp(dot(swLookH, swSunH), 0.0, 1.0);
float swBehind = swToSun * swToSun * swToSun * swToSun * (1.0 - 0.6 * smoothstep(0.3, 0.8, swL.y)) * smoothstep(-0.02, 0.2, swL.y);
float swPeak = clamp(swCrest * 0.5 + 0.5 + swChopH * 0.6, 0.0, 1.2);
float swAway = clamp(0.5 - 0.5 * dot(swL, swWaveN), 0.0, 1.0);
float swThrough = swBehind * swPeak * swPeak * swAway * swAway * (0.5 + swFaceV) * 4.0;
swScatter += U.slateWaterShallow.rgb * vec3(0.9, 1.15, 0.85) * swSun * (U.slateWaterLook.w * (swThrough + smoothstep(0.2, 0.9, swFoldN) * swRough * 0.15));`)}

// Foam: a bubble web (Voronoi cell borders, Medium up) and clumpy noise, thresholded by a foam density (Crest-style),
// so dense foam is solid, then opens round holes, thins into lace and breaks into scattered fragments as it decays.
// From High a finer web layers small bubbles into it. The slope warp is bounded, so storm slopes never shred it.
vec2 swWarp = swSlope / (1.0 + length(swSlope)) * 0.3;
vec2 swFoamUv = swFlowed * 1.1 + swWarp + vec2(swMedium - 0.5, swFine - 0.5) * 0.8;
float swFoamFade = smoothstep(0.3, 0.9, swFoot * 1.6);
float swClump = swNoise(swFoamUv * 0.5 + vec2(7.3, swTime * 0.02));${fromTier(1, `
float swBlob = swNoise(swFoamUv * 1.7 + vec2(1.9, swTime * -0.05));${fromTier(2, `
// Churn: two phases of the web crossfade, each re-seeded while it is invisible, so foam evolves in place.
float swChurnT = swTime * 0.12;
float swChurnA = fract(swChurnT);
float swChurnB = fract(swChurnT + 0.5);
vec2 swChurnDrift = vec2(0.22, -0.13);
vec2 swWebA = swCells(swFoamUv + vec2(0.37, 0.71) * (floor(swChurnT) * 7.0) + swChurnDrift * swChurnA);
vec2 swWebB = swCells(swFoamUv + vec2(0.37, 0.71) * (floor(swChurnT + 0.5) * 7.0 + 3.0) + swChurnDrift * swChurnB);
float swBorder = mix(swWebB.y, swWebA.y, 1.0 - abs(1.0 - 2.0 * swChurnA));
// Small bubbles: a web about a third the size, averaged out before it would alias.
float swBubbles = mix(1.0 - smoothstep(0.0, 0.3, swCells(swFoamUv * 2.7 + vec2(3.1, swTime * 0.07)).y), 0.45, smoothstep(0.15, 0.5, swFoot * 4.0));`, `
float swBorder = swCells(swFoamUv).y;
float swBubbles = 0.45;`)}
// The web: 1 along the cells' borders and 0 at their centres, faded to its mean before it would alias.
float swLace = mix(1.0 - smoothstep(0.02, 0.45, swBorder), 0.55, smoothstep(0.25, 0.65, swFoot * 2.2));
float swFoamTex = clamp(swLace * 0.6 + swClump * 0.22 + swBlob * 0.08 + swBubbles * 0.15 - 0.02, 0.0, 1.0);`, `
// Low evaluates one foam noise and no cell pattern. Folding it into two crossing families of narrow curved bands (triangle
// waves: no fetch, no transcendental), one bent by the medium noise and one by the chop, gives it lace: thinning foam
// opens rounded holes where both bands dip and frays into strands instead of ending at a hard edge. The bands fade
// to their mean where they would alias.
vec2 swFoamBand = vec2(swClump * 3.7 + swMedium * 1.3, swChopH * 7.0 - swClump * 2.3);
vec2 swFoamFold = abs(fract(swFoamBand) * 2.0 - vec2(1.0));
float swLace = mix(swFoamFold.x + swFoamFold.y - swFoamFold.x * swFoamFold.y, 0.75, smoothstep(0.25, 0.5, max(fwidth(swFoamBand.x), fwidth(swFoamBand.y))));
float swBlob = swClump;
float swBubbles = 0.5;
float swFoamTex = smoothstep(0.05, 0.85, swClump * 0.5 + swLace * 0.4 + 0.06);`)}
// Shores: the swash band runs up with each wave's crest and draws back with its trough (the waterline itself moves
// with the displaced surface), and where the water is shallow for its waves crests break into surf that leaves
// thinner, decaying foam behind them.
float swCrestPhase = clamp(swCrest * 0.5 + 0.5, 0.0, 1.0);
float swWash = exp(-swBank / (swFoamWidth * (0.8 + 1.6 * swCrestPhase))) * (0.55 + 0.45 * swCrestPhase);
float swRestDepth = max(swDepth - IN.vSlateWater.x, 0.02);
float swSurf = smoothstep(0.35, 0.9, U.slateWaterWaves.x / swRestDepth) * (1.0 - smoothstep(8.0, 12.0, swBank / swFoamWidth)) * smoothstep(0.0, 0.3, swBank);
float swSurfFoam = swSurf * max(smoothstep(0.0, 0.6, swCrest + swChopH * 0.6), 0.5 * smoothstep(-0.8, 0.2, swCrest));
// Whitecaps form where crests steepen (Crest Foam sets coverage) and leave foam trailing on their windward backs,
// drawn out along the wind.
vec2 swWindUv = vec2(dot(swFlowed, swWindDir), dot(swFlowed, vec2(-swWindDir.y, swWindDir.x)));
float swCap = 0.0;
float swCapCore = 0.0;
float swTrail = 0.0;${ifDefined(crestFoam, `
float swBack = max(dot(swGradient, swWindDir), 0.0) / max(0.0001, swSteep);${fromTier(2, `
// Only some crests break at a time: breaking zones drift slowly downwind.
float swBreakZone = swNoise(swWorld * 0.045 - swWindDir * (swTime * 0.12) + vec2(5.1, 2.7));`, fromTier(1, `
float swBreakZone = 1.0 - swLarge;`, `
// Low's gust is its large noise, so breaking zones come from the medium noise instead (a zone derived from the large
// noise cancelled the gust term, and every steep crest broke along its whole length).
float swBreakZone = swMedium;`))}
float swCapDrive = (swFoldN * 1.8 + swBack * 0.5 + swChopH * 0.5 + (swBreakZone - 0.5) * 0.7 + (swGust - 0.5) * 0.4) * swRough;
// Caps are densest at their cores and thin toward their edges, where the web opens them into lace; a wider, thinner
// skirt around them is the decaying foam of earlier breaks.
swCap = max(smoothstep(1.0 - U.slateWaterShape.z, 1.5 - U.slateWaterShape.z, swCapDrive) * (0.6 + 0.4 * smoothstep(0.25, 0.65, swClump)),
  smoothstep(0.7 - U.slateWaterShape.z, 1.3 - U.slateWaterShape.z, swCapDrive) * 0.4) * U.slateWaterTerms.y;
swCapCore = smoothstep(1.45 - U.slateWaterShape.z, 2.05 - U.slateWaterShape.z, swCapDrive) * U.slateWaterTerms.y;
// Cores ease in and the lace thins them, so dense caps never read as flat paint with a hard rim.
swCapCore *= swCapCore * (0.4 + 0.6 * swLace);${fromTier(1, `
// Trails: soft streaks stretched along the wind, not thin scratches.
float swTrailTex = swNoise(swWindUv * vec2(0.35, 1.1) + swWarp + vec2(swTime * 0.05, 0.0));
swTrail = smoothstep(0.75 - U.slateWaterShape.z, 1.2 - U.slateWaterShape.z, swCapDrive + swBack * swRough * 0.8) * smoothstep(0.2, 0.9, swTrailTex) * 0.6 * U.slateWaterTerms.y;`)}`)}
float swStreak = 0.0;
float swStreakTint = 0.0;${ifDefined(surfaceFoam, `
// Wind streaks: long foam lines drawn out along the wind, denser where gusts are strong. Surface Foam sets how much
// of the sea they cover as well as how thick they are.
float swStreakCut = mix(0.96, 0.7, U.slateWaterSunColor.w);
float swStreakBreak = smoothstep(0.58 - 0.28 * U.slateWaterSunColor.w, 0.85 - 0.2 * U.slateWaterSunColor.w, swClump * 0.7 + swGust * 0.3);${fromTier(1, `
vec2 swStreakUv = swWindUv * vec2(0.06, 0.8) + vec2(swLarge * 2.0, (swLarge - 0.5) * 2.5 + (swGust - 0.5) * 5.0) + swWarp * 0.6;
float swStreakRidge = 1.0 - abs(swNoise(swStreakUv) * 2.0 - 1.0);
float swStreakAA = fwidth(swStreakRidge) * 1.5 + 0.02;
swStreak = smoothstep(swStreakCut - swStreakAA, swStreakCut + swStreakAA, swStreakRidge) * swStreakBreak * (0.3 + 0.75 * U.slateWaterSunColor.w) * (0.6 + 0.6 * swGust) * swCalm;`, `
// Low has no streak noise: the streaks' average coverage, as Medium's filter to at a distance, lightly whitens the
// same gusty patches instead of drawing lines.
swStreakTint = (1.0 - swStreakCut) * swStreakBreak * (0.2 + 0.5 * U.slateWaterSunColor.w) * (0.6 + 0.6 * swGust) * swCalm * 0.6;`)}`)}
float swDensity = clamp(max(max(swWash, swCap), max(max(swTrail, swStreak), swSurfFoam)), 0.0, 1.0);
// Thinning foam softens: its holes open gradually.
float swFoamSoft = 0.06 + 0.22 * (1.0 - swDensity) + fwidth(swFoamTex);
// Even the densest foam keeps a few bubble holes.
float swFoamCut = 1.0 - 0.88 * swDensity;
// Where the pattern is too fine to resolve, foam keeps the coverage its density would give rather than turning into
// solid shapes wherever the density is high. Thin foam is also more translucent.
float swRealFoam = mix(smoothstep(swFoamCut, swFoamCut + swFoamSoft, swFoamTex), swDensity * swDensity * (3.0 - 2.0 * swDensity) * 0.8, swFoamFade) * (0.3 + 0.7 * swDensity);
// How deep inside the foam this point lies: thick foam is brighter than its fraying lace.
float swFoamThick = mix(clamp((swFoamTex - swFoamCut) * 2.5, 0.0, 1.0), swDensity, swFoamFade);
swRealFoam = max(max(swRealFoam, swCapCore), swStreakTint);
// The swash line hugs the moving waterline, wider as a wave runs up.
float swShoreLine = 1.0 - smoothstep(0.0, (0.35 * swFoamWidth + 0.1) * (0.6 + swCrestPhase), swBank);
swRealFoam = max(swRealFoam, swShoreLine * (0.6 + 0.35 * smoothstep(0.2, 0.5, mix(swFoamTex, 0.45, swFoamFade))));
// Contact foam hugs the actual waterline on objects: a dense churned band where the water meets them that breaks,
// within about half a contact width, into sparse patches; ripple crests carry a few flecks further out. The band
// stretches downstream (the current where the water flows, otherwise downwind) into a trail. Low keeps the band and
// line only.
vec2 swFlowV = IN.vSlateWaterFlow.xy;
float swFlowSpeed = length(swFlowV);
vec2 swWakeDir = mix(swWindDir, swFlowV / max(swFlowSpeed, 0.0001), smoothstep(0.05, 0.4, swFlowSpeed));
swWakeDir = swWakeDir / max(length(swWakeDir), 0.0001);
float swObjectW = swObject / (1.0 + 1.4 * max(dot(swContactDir, swWakeDir), 0.0));
float swContactLine = 1.0 - smoothstep(0.0, 0.12 * swContactW + 0.06 + fwidth(swObject), swObject + (swBlob - 0.5) * 0.06 * swContactW);
float swWake = 0.0;${fromTier(2, `
// Wake: a point downstream of an object trails its foam. Two contact-field taps upstream (at 0.4 and 0.8 of the contact
// range) find the object; the plume widens with distance at about the Kelvin angle and thins as it trails.
if (swContactOn > 0.5) {
  float swRange = U.slateWaterContactInfo.y;
  vec2 swWakeUv = swWakeDir * (swRange * 0.4) * U.slateWaterContactBounds.zw;
  float swWakeD1 = (dot(swContactAt(swContactUv - swWakeUv), swLayerW) * 2.0 - 1.0) * swRange;
  float swWakeD2 = (dot(swContactAt(swContactUv - swWakeUv * 2.0), swLayerW) * 2.0 - 1.0) * swRange;
  float swWakeW = swContactW * 0.35 + swRange * 0.1;
  swWake = max((1.0 - smoothstep(swWakeW * 0.2, swWakeW, swWakeD1)) * 0.6, (1.0 - smoothstep(swWakeW * 0.4, swWakeW * 1.7, swWakeD2)) * 0.35);
  swWake = swWake * smoothstep(0.0, 0.3, swContactSigned) * (0.2 + 0.8 * swClump);
}`)}${fromTier(1, `
float swHug = clamp(exp(-swObjectW / swContactW * 6.0) * (0.45 + 1.1 * swClump) + max(0.0, cos(swRipplePhase)) * swRippleFade * 0.1 * swClump + swWake * 0.6, 0.0, 1.0);
// Bubbly patches: the low-frequency clumps carry the bubbles, so thinning foam breaks into islands, not a net.
float swPatchTex = mix(smoothstep(0.12, 0.85, (swClump * 0.5 + swBlob * 0.5) * (0.75 + 0.25 * swBubbles) + swLace * 0.18), 0.45, swFoamFade);
float swHugSoft = 0.06 + 0.1 * (1.0 - swHug) + fwidth(swPatchTex);
// Thinner foam is sparser and more translucent.
float swRealContact = smoothstep(1.0 - swHug, 1.0 - swHug + swHugSoft, swPatchTex) * (0.3 + 0.7 * swHug);
swRealContact = max(swRealContact, swContactLine * (0.75 + 0.25 * smoothstep(0.2, 0.6, swPatchTex)));`, `
float swHug = clamp(exp(-swObjectW / swContactW * 6.0) * (0.45 + 1.1 * swClump), 0.0, 1.0);
float swRealContact = max(smoothstep(0.35, 0.75, swHug) * (0.3 + 0.7 * swHug), swContactLine * 0.85);`)}
float swFoam = clamp(max(swRealFoam * swFoamAmount * 1.35, swRealContact * swContactStrength), 0.0, 1.0);
swFoamThick = max(swFoamThick, smoothstep(0.5, 1.0, swRealContact * swContactStrength));
// Air churned under foam lightens and clouds the water around it, without a pattern.
float swAerated = max(swDensity * swFoamAmount, swHug * 0.6);
swTransmit *= 1.0 - swAerated * 0.35;
swTransmitRgb *= 1.0 - swAerated * 0.35;
swScatter += mix(swCol, U.slateWaterFoam.rgb, 0.5) * (swAmb + swSun * max(swL.y, 0.0)) * swAerated * 0.2;
// Wet bed: the thinnest water at a terrain waterline darkens what lies under it, as a film filling sand's pores does,
// so the waterline reads as a wet band rather than the shore simply ending.
float swWet = (1.0 - smoothstep(0.02, 0.2 + 0.15 * swCrestPhase, swDepth)) * swKnown * (1.0 - swFoam);

// The sun. Medium and up: Babylon's GGX lobe (widened by the filtered slope variance) carries the sun path, and a
// sparse glitter of sub-pixel facets adds sharp points where unresolved ripples would mirror the sun. Each glitter
// cell on a world grid holds one facet; it flashes with the probability that a facet tilted by the unresolved
// roughness mirrors the sun, so calm water shows none and the flashes thin out away from the sun path. From High a
// coarser grid of facets takes over where the fine one fades, so the distant sun path keeps sparkling. Low draws water
// unlit and carries one analytic sun lobe instead.
vec3 swHalf = normalize(swV + swL);
float swSunX = 1.0 - clamp(dot(swV, swHalf), 0.0, 1.0);
float swSunX2 = swSunX * swSunX;
float swSunFres = 0.02 + 0.98 * swSunX2 * swSunX2 * swSunX;${fromTier(1, `
float swNH = max(dot(swWaveN, swHalf), 0.05);
float swTan2 = (1.0 - swNH * swNH) / (swNH * swNH);${fromTier(3, `
// Ultra widens the facet spread by this pixel's own slope variation (Toksvig), so grazing glitter stays sparse.
vec2 swSlopePx = fwidth(swSlope);
float swFacetVar = ${f(0.012 - SUB_CAPILLARY_VARIANCE)} * swChopGain * swChopGain + swSlopeVariance + 0.25 * dot(swSlopePx, swSlopePx);`, `
float swFacetVar = ${f(0.012 - SUB_CAPILLARY_VARIANCE)} * swChopGain * swChopGain + swSlopeVariance;`)}
// Wind ripples below the smallest capillary octave (centimetres) always tilt facets; calm water has none.
float swFacetP = exp(-swTan2 / (2.0 * max(swFacetVar, 0.00001))) * smoothstep(0.0005, 0.003, swFacetVar);
vec2 swGlitUv = swFlowed * (5.0 * U.slateWaterMotion.y);
vec2 swGlitId = floor(swGlitUv);
float swGlitRnd = swHash(swGlitId + vec2(41.0, 13.0));
vec2 swGlitDelta = fract(swGlitUv) - vec2(0.5) - (vec2(swHash(swGlitId + vec2(3.0, 59.0)), swGlitRnd) - vec2(0.5)) * 0.6;
// The threshold drifts per cell, so facets flash on and off as the waves move.
float swGlitOn = step(fract(swGlitRnd * 37.13 + swTime * (0.6 + swGlitRnd)), swFacetP * 0.6);
float swGlitCore = max(0.0, 1.0 - length(swGlitDelta) * 2.8);
float swGlitPx = sqrt(length(swFootX) * length(swFootY)) * U.slateWaterMotion.y;
float swGlitFade = 1.0 - smoothstep(0.25, 0.9, swGlitPx * 5.0);
// A facet mirroring the sun shows the sun's own radiance: far brighter than the sky, so it saturates.
vec3 swGlint = min(swSun * (swSunFres * step(0.0, swL.y) * 40.0 * swGlitOn * swGlitCore * swGlitCore * swGlitFade), vec3(6.0));${fromTier(2, `
vec2 swGlitUv2 = swFlowed * (1.2 * U.slateWaterMotion.y) + vec2(17.3, 5.1);
vec2 swGlitId2 = floor(swGlitUv2);
float swGlitRnd2 = swHash(swGlitId2 + vec2(7.0, 91.0));
vec2 swGlitDelta2 = fract(swGlitUv2) - vec2(0.5) - (vec2(swHash(swGlitId2 + vec2(23.0, 5.0)), swGlitRnd2) - vec2(0.5)) * 0.6;
float swGlitOn2 = step(fract(swGlitRnd2 * 53.7 + swTime * (0.5 + swGlitRnd2)), swFacetP * 0.3 * (1.0 - smoothstep(0.015, 0.05, swFacetVar)));
float swGlitCore2 = max(0.0, 1.0 - length(swGlitDelta2) * 2.8);
float swGlitFade2 = (1.0 - swGlitFade) * (1.0 - smoothstep(0.25, 0.9, swGlitPx * 1.2));
swGlint += min(swSun * (swSunFres * step(0.0, swL.y) * 20.0 * swGlitOn2 * swGlitCore2 * swGlitCore2 * swGlitFade2), vec3(6.0));`)}`, `
float swLowNH = max(dot(normalW, swHalf), 0.05);
float swLowA2 = max(U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w + 2.0 * swSlopeVariance, 0.0004);
float swLowD = exp((swLowNH * swLowNH - 1.0) / (swLowNH * swLowNH * swLowA2)) / (3.14159 * swLowA2 * swLowNH * swLowNH * swLowNH * swLowNH);
// Without Smith shadowing the lobe would smear across grazing water; a cheap fade stands in for it.
vec3 swGlint = min(swSun * (swSunFres * step(0.0, swL.y) * step(0.0, dot(normalW, swL)) * swLowD / (4.0 * max(swNdotV, 0.1)) * (0.3 + 0.7 * smoothstep(0.05, 0.4, swNdotV))), vec3(6.0));`)}
${sparkled(`
float swRL = max(dot(reflect(-swV, normalW), swL), 0.0);
float swSpark = swSparkBase * 3.0 * pow(swRL, 40.0) * (1.0 - swFoam);`)}
#ifndef REFLECTION
// No environment or skybox: an analytic sky from the scene (\`slateWaterSky\`): its background colour overhead and its
// horizon colour (the fog colour with fog on) low, warmed around the sun's azimuth while the sun is low, with an
// aureole around the sun itself; rough water mirrors a blurred version. Reflection Strength scales it.
vec3 swSkyDir = normalize(swRefl);
float swSkyH = 1.0 - clamp(swSkyDir.y, 0.0, 1.0);
swSkyH = swSkyH * swSkyH * swSkyH;
vec3 swSkyRefl = mix(U.slateWaterSky.rgb, U.slateWaterHorizon.rgb, swSkyH);
vec2 swSkySun = swL.xz / max(length(swL.xz), 0.0001);
float swSkyAz = clamp(dot(swSkyDir.xz / max(length(swSkyDir.xz), 0.0001), swSkySun), 0.0, 1.0);
swSkyAz *= swSkyAz;
swSkyAz *= swSkyAz;
swSkyAz *= swSkyAz;
float swSkyLowSun = (1.0 - smoothstep(0.0, 0.5, swL.y)) * smoothstep(-0.1, 0.02, swL.y);
float swAura = max(dot(swSkyDir, swL), 0.0);
swAura *= swAura;
swAura *= swAura;
swAura *= swAura;
float swAura64 = swAura * swAura;
swAura64 *= swAura64;
swAura64 *= swAura64;
swSkyRefl += swSun * (swSkyAz * swSkyH * swSkyLowSun * 0.45 + swAura * (0.03 + 0.06 * swSkyLowSun) + swAura64 * 0.25);
swSkyRefl = mix(swSkyRefl, mix(U.slateWaterSky.rgb, U.slateWaterHorizon.rgb, 0.55) + swSun * (0.06 * swSkyLowSun), smoothstep(0.03, 0.3, sqrt(swSlopeVariance)) * 0.7);
swSkyRefl *= U.slateWaterDeep.w;
#endif

// Foam is matte and lit: PBR shades it as albedo, and its roughness and coverage remove the mirror.
float swEdgeFade = smoothstep(0.0, 0.2, swBank + 0.02);
float swGloss = (1.0 - swFoam) * swEdgeFade;
// Thicker foam is brighter; fraying lace is dimmer and lets the water's colour through.
surfaceAlbedo = mix(swScatterCol, U.slateWaterFoam.rgb, 0.65 + 0.35 * swFoamThick) * (swFoam * swEdgeFade * (0.68 + 0.32 * swFoamThick));
swMatte = swFoam;
vec3 swEmissive = swScatter * (vec3(1.0) - swTransmitRgb) * ((1.0 - swFres) * swGloss) + (swGlint + vec3(swSpark) * swSun) * swGloss;${fromTier(1, "", `
// Low is unlit: the sun and sky light the foam here, as bright as Medium's lit foam (the environment adds its own).
swEmissive += surfaceAlbedo * (swSun * max(dot(swWaveN, swL), 0.0) * 0.55 + swAmb * 0.3);`)}
alpha = (1.0 - (1.0 - swFres) * swTransmit * (1.0 - swFoam)) * swEdgeFade;
// The wet band darkens what blends under it: coverage without light.
alpha = max(alpha, swWet * 0.35 * swEdgeFade);${ifDefined(REFRACTION, `
// The refracted scene replaces the blended background: the light transmitted through the water is the copy behind
// this point, tinted by the per-channel absorption and darkened under the wet band, so coverage keeps only the shore
// fade. It stays apart from the water's own light (\`swRefracted\`, see CUSTOM_FRAGMENT_BEFORE_FOG), so it never
// raises the coverage of an HDR target or takes the water's fog twice.
float swRefractedWeight = (1.0 - swFres) * swTransmit * (1.0 - swFoam) * swEdgeFade * swRefracts;
vec3 swRefracted = swBackground * swTransmitRgb * ((1.0 - swFres) * (1.0 - swFoam) * swEdgeFade * swRefracts * (1.0 - 0.45 * swWet));
alpha = mix(alpha, swEdgeFade, swRefracts);`)}
${objectReflectionSource("normalize(swRefl)", "sqrt(sqrt(U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w + 2.0 * swSlopeVariance))")}
`;
}

/**
 * Stylized: unlit but lit-looking water in the spirit of Sea of Thieves. Saturated colour from the asset (Deep Color
 * looking down into deep water, Shallow Color over shallows), chunky swell shading in soft bands from the sun, a
 * glow through thin crests seen toward the sun (Subsurface), a soft painted sky reflection with Fresnel, chunky foam
 * blobs and a sun path of soft sparkles. Every term is ALU on Low; Medium adds the crest glow, foam blobs, drifting
 * foam patches and sparkles; High and Ultra add finer foam break-up, refraction-tinted shallows and reflections.
 */
function stylizedSource(): string {
  const { crestFoam, surfaceFoam, subsurface, sparkles } = WATER_FEATURE_DEFINES;
  return surfaceSource("stylized") + `
vec3 swV = viewDirectionW;
float swUp = clamp(swV.y, 0.0, 1.0);
float swGraze = 1.0 - swUp;
// The scene's sun above the horizon and its sky light. Their brightness lights the water and their hue only tints it,
// so dusk warms and overcast greys the water without draining the asset's colours. A floor keeps the colours readable
// in scenes lit only by an environment or by point and spot lights.
float swSunUp = smoothstep(-0.02, 0.12, swL.y);
vec3 swKey = swSun * swSunUp;
float swAmbLum = dot(swAmb, vec3(0.3, 0.59, 0.11));
float swKeyLum = dot(swKey, vec3(0.3, 0.59, 0.11));
vec3 swAmbHue = swAmb / max(swAmbLum, 0.001);
vec3 swKeyHue = U.slateWaterSunColor.rgb / max(dot(U.slateWaterSunColor.rgb, vec3(0.3, 0.59, 0.11)), 0.001);
vec3 swAmbTint = mix(vec3(1.0), swAmbHue, 0.35);
vec3 swKeyTint = mix(vec3(1.0), swKeyHue, 0.6);
vec2 swSunH = swL.xz / max(length(swL.xz), 0.0001);
vec3 swShallowC = U.slateWaterShallow.rgb;
vec3 swDeepC = U.slateWaterDeep.rgb;

// Depth from Shallow to Deep Color, in soft Color Bands. The bed's depth sets it: refraction only bounds the absorption
// of what shows through, so an object in deep water never turns the sea around it into shallows.
#ifdef ${REFRACTION}
float swBedTone = 1.0 - exp(-swBedDepth * 2.0 / swAbsorb);
#else
float swBedTone = swTone;
#endif
float swBandCount = max(1.0, U.slateWaterLook.x);
float swBand = swBedTone * swBandCount;
float swBandAA = fwidth(swBand) + 0.25;
float swBanded = (floor(swBand) + smoothstep(0.5 - swBandAA, 0.5 + swBandAA, fract(swBand))) / swBandCount;
swBedTone = mix(swBedTone, swBanded, step(1.5, U.slateWaterLook.x));
// Looking straight down, deep water shows Deep Color; toward grazing views it lightens toward a teal between the two.
vec3 swMidC = mix(swDeepC, swShallowC, 0.22);
vec3 swBody = mix(swShallowC, mix(swDeepC, swMidC, smoothstep(0.05, 0.95, swGraze)), swBedTone);
// Color Variation: wide lighter, greener drifts across deep water.
float swVariation = U.slateWaterSwellInfo.z;
float swPatch = smoothstep(0.3, 0.75, swDrift);
swBody = mix(swBody, mix(swDeepC, swShallowC, 0.45), swPatch * swBedTone * swVariation * 0.2);
swBody *= 1.0 + (swDrift - 0.5) * 0.3 * swVariation;

// Chunky swell shading: the swell's slope (exaggerated near the camera, never toward the horizon, where it would draw
// long lines), with a little chop, lit relative to flat water so even a high sun separates each wave's lit and shaded
// sides, wrapped into soft bands rather than hard toon steps. Close up the chop carries more of it.
float swNearSwell = 1.0 - smoothstep(0.25, 1.2, swFoot);
float swCloseUp = 1.0 - smoothstep(0.01, 0.06, swFoot);
// Close up, short wind ripples (the first capillary octave, a second from High) shade the water as well: shading only,
// faded by the footprint before they would alias, gathered in drifting patches, their phase drifting across the shared
// noises so they never run in straight rows. The ripples travelling out from objects shade as soft light and dark rings
// (rather than foam hairlines). Low draws the first as cusped parabolic ripples (ALU only, no transcendentals).
vec2 swRippleUv = swChop + (vec2(swFine, swMedium) - vec2(0.5)) * 0.45;
vec4 swCC0 = U.${CAPILLARY_UNIFORMS[0]};
float swCX0 = swCC0.z * dot(swCC0.xy, swRippleUv) + swCC0.w + swMedium * 2.5 - swLarge * 1.5;
float swCFd0 = (1.0 - smoothstep(0.25, 0.8, swCC0.z * swFoot * 0.64)) * (0.3 + 1.2 * swMedium);${fromTier(1, `
vec2 swRipples = swCC0.xy * (exp(sin(swCX0) - 1.0) * cos(swCX0) * swCFd0);${fromTier(2, `
vec4 swCC1 = U.${CAPILLARY_UNIFORMS[1]};
float swCX1 = swCC1.z * dot(swCC1.xy, swRippleUv) + swCC1.w - swMedium * 2.0 + swLarge * 1.8;
swRipples += swCC1.xy * (exp(sin(swCX1) - 1.0) * cos(swCX1) * 0.7 * (1.0 - smoothstep(0.25, 0.8, swCC1.z * swFoot * 0.64)) * (1.5 - 1.2 * swMedium));`)}`, `
vec2 swRipples = swCC0.xy * ((fract(swCX0 * ${f(1 / (2 * Math.PI))}) * 2.0 - 1.0) * 0.35 * swCFd0);`)}
vec2 swShadeSlope = swGradient * (1.0 + 0.8 * swNearSwell) + swDetail * (swChopGain * (0.7 + 4.0 * swCloseUp)) + swRipples * (U.slateWaterMotion.z * 1.3) + swRipple * 3.0;
vec3 swShadeN = normalize(vec3(swBaseX - swShadeSlope.x, 1.0, swBaseZ - swShadeSlope.y));
float swNL = dot(swShadeN, swL);
float swFacing = clamp(0.5 + (swNL - swL.y) * 1.7, 0.0, 1.0);
float swShadeBand = swFacing * 2.0;
float swShadeAA = fwidth(swShadeBand) + 0.3;
float swShade = mix(swFacing, (floor(swShadeBand) + smoothstep(0.5 - swShadeAA, 0.5 + swShadeAA, fract(swShadeBand))) * 0.5, 0.75);
// Close up, the shared noises dapple the light a little.
swShade = clamp(swShade + ((swFine - 0.5) * 0.25 + (swMedium - 0.5) * 0.35) * (1.0 - smoothstep(0.02, 0.12, swFoot)) * min(1.0, U.slateWaterMotion.z * 2.0), 0.0, 1.0);
// Faces turned to the sun lighten toward a sunlit turquoise, faces turned away deepen toward Deep Color: the wave forms
// read in hue as well as brightness, at any sun height and under overcast skies.
vec3 swSunlitC = mix(swBody, swShallowC * vec3(0.85, 1.05, 0.95), 0.3 * (0.4 + 0.6 * swSunUp));
swBody = mix(mix(swBody, swDeepC, 0.35), swSunlitC, swShade);
vec3 swLight = swAmbTint * max(swAmbLum * 0.6, 0.22) + swKeyTint * (swKeyLum * (0.1 + 0.65 * swShade));
vec3 swLit = swBody * swLight;
float swTop = smoothstep(0.4, 1.0, swCrest + swChopH * 0.5);${ifDefined(subsurface, `
float swSss = U.slateWaterLook.w;
vec3 swGlowC = swShallowC * vec3(0.7, 1.15, 0.95) + vec3(0.0, 0.03, 0.02);
// Wave tops are thinner, so lighter (Subsurface).
swLit *= vec3(1.0) + vec3(0.25, 0.9, 0.6) * (swTop * 0.5 * min(swSss, 1.0));${fromTier(1, `
// Crest glow: sunlight through thin crests and the faces turned from the sun, seen toward the sun. It stays within a
// few wavelengths of the camera and drifting noise breaks it up, so it never follows a whole crest to the horizon.
vec2 swLookH = -swV.xz / max(length(swV.xz), 0.0001);
float swBacklit = clamp(dot(swLookH, swSunH) * 0.6 + 0.4, 0.0, 1.0);
swBacklit = swBacklit * swBacklit * swBacklit;
${fromTier(2, `
float swGlowGain = 1.6;
float swThinChop = 0.9;`, `
float swGlowGain = 1.2;
float swThinChop = 0.5;`)}
float swThin = smoothstep(-0.2, 0.9, swCrest + swChopH * swThinChop);
float swLean = clamp(0.6 - (swNL - swL.y) * 2.0, 0.0, 1.0);
float swGlowBreak = smoothstep(0.25, 0.7, swLarge * 0.6 + swMedium * 0.4);
float swGlow = swBacklit * swThin * swLean * (1.0 - 0.6 * clamp(swL.y, 0.0, 1.0)) * swNearSwell * swGlowBreak;
swLit += swGlowC * swKeyTint * (swKeyLum * swGlow * swSss * swGlowGain);`)}`)}

// Soft painted sky reflection with Fresnel, from a smoothed normal (never a sharp mirror): a clear blue under a sun and
// the sky light's own hue when overcast, as bright as the sky light; toward a low sun the horizon warms, but only in a
// lobe around the sun's azimuth. It is capped well below a mirror, so it lifts the water rather than greying it.
vec3 swReflN = normalize(mix(swSwellNormal, normalW, 0.5));
float swNdotV = clamp(dot(swReflN, swV), 0.0, 1.0);
float swFx = 1.0 - swNdotV;
float swFres = 0.03 + 0.97 * swFx * swFx * swFx;
vec3 swRefl = reflect(-swV, swReflN);
float swClear = swSunUp * clamp(U.slateWaterSun.w, 0.0, 1.0);
float swLowSun = (1.0 - smoothstep(0.0, 0.35, swL.y)) * swSunUp;
vec3 swSkyHue = mix(mix(vec3(1.0), swAmbHue, 0.7), vec3(0.22, 0.5, 1.0), 0.85 * swClear * (1.0 - 0.5 * swLowSun));
float swSkyI = swAmbLum * 0.7 + swKeyLum * 0.1;
vec3 swZenith = swSkyHue * (swSkyI * 0.6);
vec3 swHorizon = mix(swSkyHue, vec3(1.0), 0.2) * swSkyI;
float swSunLobe = clamp(dot(swRefl.xz / max(length(swRefl.xz), 0.0001), swSunH), 0.0, 1.0);
swSunLobe *= swSunLobe;
swSunLobe *= swSunLobe;
swSunLobe *= swSunLobe;
swSunLobe *= swSunLobe;
swHorizon = mix(swHorizon, swKeyHue * (swSkyI + swKeyLum * 0.3), swSunLobe * swLowSun * swLowSun * 0.85);
float swHalo = max(dot(swRefl, swL), 0.0);
swHalo *= swHalo;
swHalo *= swHalo;
swHalo *= swHalo;
vec3 swSkyC = mix(swHorizon, swZenith, smoothstep(0.0, 0.5, max(swRefl.y, 0.0))) + swKey * (swHalo * 0.25);
// The reflection is painted in the water's own hue in part (a lift rather than a grey veil), so grazing water lightens
// toward a bright cyan instead of washing out; toward a low sun it keeps the sky's warmth.
vec3 swWaterHue = swMidC / max(dot(swMidC, vec3(0.3, 0.59, 0.11)), 0.001);
swSkyC = mix(swSkyC, min(swWaterHue, vec3(2.0)) * dot(swSkyC, vec3(0.3, 0.59, 0.11)), 0.4 * (1.0 - swSunLobe * swLowSun));
float swReflAmt = min(swFres * U.slateWaterDeep.w * 0.8, 0.3);
vec3 swColor = mix(swLit, swSkyC, swReflAmt);
// A painted horizon: the farthest water softens into the reflected horizon's colour.
swColor = mix(swColor, mix(swHorizon, swSkyC, 0.5), smoothstep(2.0, 12.0, swFoot) * 0.3);

// Foam densities (0-1): the shore band and waves washing in, object contacts, crest caps and drifting patches. One
// chunky blob pattern cuts all of it, so thinning foam breaks into soft round blobs instead of lines or specks; where
// the pattern would alias, the foam keeps its average coverage. No term reads a screen derivative of a foam pattern
// (constant per 2x2 pixel block, it would cut blocks out of the foam).
float swFoamScale = 0.65 * U.slateWaterMotion.y;
float swNearFoam = 1.0 - smoothstep(0.4, 1.2, swFoot * 0.43);
float swEdgeWobble = (swMedium - 0.5) * 0.6 * swNearFoam + (swLarge - 0.5) * 0.5;
// Crest-aligned break-up: a noise stretched across the wind (along the crests), bent by the shared noises.
vec2 swWindUv = vec2(dot(swFlowed, swWindDir), dot(swFlowed, vec2(-swWindDir.y, swWindDir.x)));
float swCrestNoise = swNoise(swWindUv * vec2(0.8, 0.3) * U.slateWaterMotion.y + vec2(swMedium - 0.5, swLarge - 0.5) * 1.3);
// Distance to the shore (metres): the body's own bank and, over known terrain, the field's stored distance to the
// terrain's rest shoreline (a smooth, filtered distance field).
float swRestShore = max(0.0, min(max(0.0, IN.vSlateWater.y), mix(${f(SHORE[1])}, mix(${f(SHORE[0])}, ${f(SHORE[1])}, swField.r), swKnown)));
// The band follows the waves where the depth (as if the bed shelved 1:10) is nearer, but reaches at most one and a
// half foam widths beyond the rest shoreline's band, so a flat shallow bar far from the shore stays clear.
float swDepthShore = mix(${f(SHORE[1])}, max(0.0, swTerrainDepth) * 10.0, swKnown);
float swShoreUnit = min(min(swRestShore, max(swDepthShore, swRestShore - swFoamWidth * 1.5)), ${f(SHORE[1])}) / swFoamWidth;
float swShoreD = 1.0 - smoothstep(0.0, 1.8, swShoreUnit + swEdgeWobble * 0.6);
// Waves washing in: bands along the rest shoreline moving toward it. A distance field grows toward open water
// everywhere, so the bands never flash across a flat bar and keep their width in metres from any view; far away they
// keep a few pixels' width.
float swWashUnit = swRestShore / swFoamWidth;
float swWashT = fract(swTime * 0.12 + swLarge * 1.7);
float swWashW = 0.8 + min(swFoot * 3.0 / swFoamWidth, 0.8);
float swWash = (1.0 - smoothstep(0.0, swWashW, abs(swWashUnit - 1.0 - (1.0 - swWashT) * 3.0 + swEdgeWobble * 0.4))) * smoothstep(0.0, 0.25, swWashT) * (1.0 - smoothstep(0.75, 1.0, swWashT)) * 0.8;${fromTier(1, `
float swWashTB = fract(swWashT + 0.5);
swWash = max(swWash, (1.0 - smoothstep(0.0, swWashW * 0.85, abs(swWashUnit - 1.0 - (1.0 - swWashTB) * 3.0 + swEdgeWobble * 0.4))) * smoothstep(0.0, 0.25, swWashTB) * (1.0 - smoothstep(0.75, 1.0, swWashTB)) * 0.65);`)}
swWash *= 1.0 - smoothstep(4.0, 5.5, swWashUnit);
// Contact collars: a solid line hugging the waterline, then a looser band that the blob pattern breaks into chunky
// pieces and the outgoing ripples push outward. It fades out before the contact range like the ripples (open water
// reads the range there, which at a wide Contact Foam Width would otherwise sit inside the collar).
float swContactX = swObject / swContactW + swEdgeWobble * 0.35;
float swContactD = max(1.0 - smoothstep(0.05, 0.4, swContactX), 0.62 * (1.0 - smoothstep(0.3, 1.25, swContactX)) * (0.75 + 0.25 * cos(swRipplePhase))) * swNearContact;${fromTier(1, `
// The ripple crests riding outward carry wide bands of foam (a good part of each wavelength, never a hairline) that the
// blob pattern breaks into chunky arcs.
swContactD = max(swContactD, smoothstep(0.25, 0.75, cos(swRipplePhase)) * swRippleFade * 0.75);`)}
float swCapD = 0.0;${ifDefined(crestFoam, `
// Caps on steep, folding crests (Jacobian), broken along the crest; Crest Foam sets coverage. Far away they soften and
// fade before they would shrink to specks.
float swCapFar = smoothstep(0.4, 1.6, swFoot);
float swCapDrive = (swFoldN * 1.35 + swCrest * 0.25 + (swCrestNoise - 0.5) * 0.6 * swNearFoam) * swRough;
float swCapCut = 1.05 - 0.55 * U.slateWaterShape.z;
swCapD = smoothstep(swCapCut - 0.15 * swCapFar, swCapCut + 0.35 + 0.5 * swCapFar, swCapDrive) * (1.0 - smoothstep(1.2, 3.5, swFoot));`)}
float swPatchD = 0.0;${ifDefined(surfaceFoam, fromTier(1, `
// Drifting patches (Surface Foam): streaks along the wind, bent by the shared noises so they never sit on a grid, that
// gather on the backs of steep waves behind their caps and thin over the crests. They drift with the wind and the
// current, so they move and dissolve.
float swBackW = max(dot(swGradient, swWindDir), 0.0) / max(0.0001, swSteep);
vec2 swPatchUv = swWindUv * vec2(0.22, 0.45) + vec2(swMedium - 0.5, swGust - 0.5) * 1.4 + vec2(swFine - 0.5, 0.0) * 0.25 * swNearFoam;
// Far away the streak noise settles to its mean before its cells (about 2 m across the wind) would alias.
float swPatchNoise = mix(swNoise(swPatchUv), 0.5, smoothstep(0.35, 1.2, swFoot * 0.45)) * 0.7 + swGust * 0.3;
float swAttach = clamp(0.55 + swBackW * swRough * 1.2 + swCapD - max(swCrest, 0.0) * 0.25, 0.0, 1.0);
float swOpenCut = 0.92 - 0.46 * U.slateWaterSunColor.w;
swPatchD = smoothstep(swOpenCut, swOpenCut + 0.18, swPatchNoise) * swAttach * 0.8 * smoothstep(0.0, 0.3, U.slateWaterSunColor.w) * swCalm;`))}
float swDensity = max(max(clamp(max(max(swShoreD, swWash), swCapD) * swFoamAmount, 0.0, 1.0), clamp(swContactD * swContactStrength, 0.0, 1.0)), clamp(swPatchD * swFoamAmount, 0.0, 1.0));${fromTier(1, `
// Soft round blobs on a jittered world grid drifting with the wind.
vec2 swFoamUv = swFlowed * swFoamScale + swWindDir * (swTime * 0.06) + vec2(swMedium, swLarge) * 0.5 + vec2(swFine - 0.5, swMedium - 0.5) * 0.15;
float swFoamPat = clamp(swCells(swFoamUv).x * 1.35, 0.0, 1.0);${fromTier(2, `
// Finer break-up: small bubbles nibble the blobs' edges, faded before they would alias.
float swFoamFine = swNoise(swFoamUv * 3.3 + vec2(swTime * 0.05, 0.0));
swFoamPat = swFoamPat * 0.8 + swFoamFine * 0.25 * (1.0 - smoothstep(0.15, 0.45, swFoot * 3.0 * swFoamScale));`)}
float swPatFade = smoothstep(0.08, 0.3, swFoot * swFoamScale);
// Edge softness from the pattern's own gradient (about 1.35 per cell) over this pixel's footprint.
float swFoamSoft = 0.07 + swFoot * swFoamScale * 0.7;`, `
// Low: no cell pattern; the crest-aligned noise and the shared noises wobble the edges into chunky lobes.
float swFoamPat = clamp(0.3 + swCrestNoise * 0.45 + swEdgeWobble * 0.5, 0.0, 1.0);
float swPatFade = smoothstep(0.25, 0.7, swFoot * 0.8 * U.slateWaterMotion.y);
float swFoamSoft = 0.07 + swFoot * 0.4 * U.slateWaterMotion.y;`)}
// Thin foam keeps chunky blobs that fade out, rather than shrinking to specks.
float swFoamShape = smoothstep(swFoamPat - swFoamSoft, swFoamPat + swFoamSoft, 0.3 + 0.75 * swDensity) * smoothstep(0.08, 0.45, swDensity);
float swFoam = mix(swFoamShape, swDensity * swDensity * (3.0 - 2.0 * swDensity), swPatFade);
vec3 swFoamLit = U.slateWaterFoam.rgb * min(swAmbTint * max(swAmbLum * 0.75, 0.25) + swKey * (0.3 + 0.35 * swShade), vec3(1.05));

// The sun: a soft, narrow streak along its reflection (narrower on Low, stronger under a low sun), with chunky soft
// sparkles that twinkle around it (Sparkles, Medium up).
vec3 swGlintN = normalize(vec3(swBaseX - swGradient.x - swDetail.x * (swChopGain * 3.0), 1.0, swBaseZ - swGradient.y - swDetail.y * (swChopGain * 3.0)));
float swAlign = dot(reflect(-swV, swGlintN), swL);
// Low's smoother glint normal (fewer swell and chop terms) would spread the path into a milky smear: it stays narrower.${fromTier(1, `
float swPathW = 0.0015 + 0.012 * U.slateWaterOrigin.w;`, `
float swPathW = 0.0008 + 0.005 * U.slateWaterOrigin.w;`)}
float swPathAA = fwidth(swAlign);
float swPath = smoothstep(1.0 - swPathW - swPathAA, 1.0 - swPathW * 0.3, swAlign) * swSunUp * min(1.0, U.slateWaterSun.w) * (1.0 + 0.8 * swLowSun);${fromTier(1, "", `
swPath *= 0.75;`)}
float swSpark = 0.0;${ifDefined(sparkles, fromTier(1, `
vec2 swSparkUv = swFlowed * (0.8 * U.slateWaterMotion.y);
vec2 swSparkId = floor(swSparkUv);
float swSparkRnd = swHash(swSparkId);
vec2 swSparkD = fract(swSparkUv) - vec2(0.5) - (vec2(swHash(swSparkId + vec2(17.0, 3.0)), swSparkRnd) - vec2(0.5)) * 0.5;
float swTwinkle = abs(fract(swTime * (0.4 + swSparkRnd * 0.8) + swSparkRnd * 7.0) * 2.0 - 1.0);
float swSparkR = 0.08 + 0.14 * swTwinkle;
float swSparkCore = max(0.0, 1.0 - length(swSparkD) / swSparkR);
float swSparkDisc = smoothstep(0.0, 0.6, swSparkCore) * step(1.0 - 0.8 * U.slateWaterLook.z, swSparkRnd);
float swSparkFade = smoothstep(0.025, 0.06, swFoot * 0.8 * U.slateWaterMotion.y);
// Sparkles live in a wider lobe around the path; far away they keep their average brightness.
float swSparkLobe = smoothstep(1.0 - swPathW * 5.0, 1.0 - swPathW * 0.5, swAlign) * swSunUp * min(1.0, U.slateWaterSun.w);
swSpark = mix(swSparkDisc, 0.12 * U.slateWaterLook.z, swSparkFade) * swSparkLobe;`))}
vec3 swEmissive = mix(swColor, swFoamLit, swFoam) + swKey * mix(vec3(1.0), swKeyHue, 0.5) * ((swPath * 0.35 + swSpark * 1.6) * (1.0 - swFoam));
surfaceAlbedo = vec3(0.0);
// Opacity holds over deep water; shallows show half of what lies below.
alpha = clamp(max(max(mix(U.slateWaterShallow.a * 0.5, U.slateWaterShallow.a, smoothstep(0.15, 0.8, swBedTone)), swReflAmt), max(swFoam, swPath * 0.35)), 0.0, 1.0);
${objectReflectionSource("swRefl", "U.slateWaterOrigin.w")}
#if ${REFLECTS_OBJECTS}
// Reflected objects replace the painted sky by its Fresnel weight, never over foam.
float swReflWeight = clamp(swObjRefl.a * swReflAmt * 1.2 * (1.0 - swFoam), 0.0, 1.0);
swEmissive = mix(swEmissive, swObjRefl.rgb, swReflWeight);
alpha = max(alpha, swReflWeight);
#endif${ifDefined(REFRACTION, `
// Refraction-tinted shallows: what shows through takes the water's hue (a gain of at most 1) and fades toward the
// water's own lit colour with the refracted depth (the absorption tone), so nothing below glows brighter than above.
vec3 swTintHue = swShallowC / max(max(swShallowC.r, max(swShallowC.g, swShallowC.b)), 0.001);
swBackground = mix(swBackground * mix(vec3(1.0), swTintHue, 0.45), swLit, clamp(swTone, 0.0, 1.0));
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
  return `
// Large-world rendering makes vPositionW eye-relative; rebuild the absolute world position.
vec3 swPosW = IN.vPositionW + U.slateWaterOrigin.xyz;
vec2 swFieldUv = (swPosW.xz - U.slateWaterFieldBounds.xy) * U.slateWaterFieldBounds.zw;
${sample}
float swFieldOn = U.slateWaterFieldInfo.x * step(0.0, swFieldUv.x) * step(swFieldUv.x, 1.0) * step(0.0, swFieldUv.y) * step(swFieldUv.y, 1.0);
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
// four taps.
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
}
float swCut = min(min(${removals[0]}, ${removals[1]}), min(${removals[2]}, ${removals[3]}));
// Only real terrain removes water; cells extended past a landscape's edge (alpha ramp) never do.
if (swCut < 0.0 || (swField.a * swFieldOn > ${f(WATER_FIELD_TERRAIN_ALPHA)} && swTerrainDepth <= 0.0)) { discard; }
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
 * band (`fftVertexSource`) adds its displacement before the bank fade.
 * GLSL-shaped: `A.` attributes, `U.` uniforms, `S.` the view matrix's owner and `O.` outputs are bound per language,
 * then `toWgsl` translates it. Other passes that draw built-in water with their own vertex shader (the shared outline
 * mask) include the same displacement through `waterOutlineVertexSource`, without the material's `vPositionW` output.
 */
function vertexWaveSource(materialOutputs: boolean): string {
  const swell = Array.from({ length: WATER_WAVE_MAX_COMPONENTS }, (_, i) => {
    const code = `
vec4 swvWD${i} = U.${SWELL_DIRECTION[i]};
vec4 swvWA${i} = U.${SWELL_AMPLITUDE[i]};
float swvF${i} = clamp(2.0 - swvSpacing * swvWA${i}.w, 0.0, 1.0);
swvF${i} = swvF${i} * swvF${i} * (3.0 - 2.0 * swvF${i});
float swvP${i} = swvWD${i}.z * dot(swvWD${i}.xy, swvRest) + swvWA${i}.y;
float swvS${i} = sin(swvP${i});
float swvC${i} = cos(swvP${i});
swvH += mix(swvS${i}, (exp(swvS${i} - 1.0) - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swvChop) * (swvWA${i}.x * swvF${i});
swvD += swvWD${i}.xy * (swvWA${i}.z * swvF${i} * swvC${i});${ifFft(`
swvShear += vec3(swvWD${i}.x * swvWD${i}.x, swvWD${i}.x * swvWD${i}.y, swvWD${i}.y * swvWD${i}.y) * (swvWA${i}.z * swvF${i} * swvWD${i}.z * swvS${i});`, 1, FFT_VERTEX)}`;
    return i < waterWaveComponents.length ? code : `\n#ifdef ${WATER_OCEAN_DEFINE}${code}\n#endif`;
  }).join("");
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
float swvSpacing = A.slateWaterData.x;
float swvChop = U.slateWaterShape.x;
vec2 swvRest = worldPos.xz;
float swvH = 0.0;
vec2 swvD = vec2(0.0);${ifFft(`
vec3 swvShear = vec3(0.0);`, 1, FFT_VERTEX)}
${swell}
float swvFade = U.slateWaterSwellInfo.x;
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));${fftVertexSource()}
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
  "slateWaterShape", "slateWaterSwellInfo", ...SWELL_DIRECTION, ...SWELL_AMPLITUDE, "slateWaterFft", ...FFT_CASCADE_UNIFORMS,
];
/** `vertexWaveDefines` per wave model (Classic, Ocean Spectrum) and cascades the vertex samples (0-3): built once. */
const VERTEX_WAVE_DEFINES: ReadonlyArray<ReadonlyArray<readonly string[]>> = [false, true].map((ocean) =>
  Array.from({ length: WATER_FFT_CASCADES_MAX + 1 }, (_, cascades) => [
    `#define ${WATER_GPU_WAVES_DEFINE}`, ...(ocean ? [`#define ${WATER_OCEAN_DEFINE}`] : []), ...(cascades ? [`#define ${FFT_VERTEX} ${cascades}`] : []),
  ]));

/**
 * The GPU swell for another pass's vertex shader that computes a `worldPos` vec4 from the same world matrix and has a
 * `view` matrix uniform (the shared outline mask): declarations of its attribute, uniforms and the band's sampler,
 * and the displacement to insert after `worldPos`. Both compile only under `SLATE_WATER_GPU_WAVES` (components 5-7
 * under `SLATE_WATER_OCEAN`, the band under `SLATE_WATER_FFT_VERTEX`), so the pass's other programs are unchanged.
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
  ].join("\n");
}

/** Both styles, selected by `SLATE_WATER_STYLIZED` so each material compiles only one (each directive on its own line). */
function fragmentSource(): string {
  return `\n#ifdef ${WATER_STYLIZED_DEFINE}\n${stylizedSource()}\n#else\n${realisticSource()}\n#endif\n`;
}

/** One more read of the contact field at an explicit level, legal in any control flow (Realistic's wake taps). */
const CONTACT_TAP_GLSL = "vec4 swContactAt(vec2 uv) { return texture2DLodEXT(slateWaterContactSampler, uv, 0.0); }\n";
const CONTACT_TAP_WGSL = "fn swContactAt(uv: vec2f) -> vec4f { return textureSampleLevel(slateWaterContactSampler, slateWaterContactSamplerSampler, uv, 0.0); }\n";

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
      cut: bind(toWgsl(cutSource(true))), main: bind(toWgsl(fragmentSource())),
    }
    : {
      helpers: samplerDeclaration + roughnessGlobals + HELPERS + REMOVAL_HELPER + CONTACT_TAP_GLSL + objectHelpers(false) + fftHelpers(false),
      cut: bind(cutSource(false)), main: bind(fragmentSource()),
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

const linear = (c: WaterColor): [number, number, number] => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];

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
   * the horizon the background itself, or the fog colour with fog on (Babylon mixes fog in linear space).
   */
  sky: Float64Array;
  horizon: Float64Array;
};

const toLinear = (value: number) => Math.max(0, value) ** 2.2;

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
  const clear = scene.clearColor, cr = toLinear(clear.r), cg = toLinear(clear.g), cb = toLinear(clear.b);
  const luminance = Math.max(0.3 * cr + 0.59 * cg + 0.11 * cb, 1e-4);
  // A hemispheric light is the scene's sky light: overhead the sky takes half its colour.
  const lit = hemispheres > 0 ? 0.5 : 0;
  sky[0] = (0.65 * cr + 0.35 * cr * cr / luminance) * 0.85 * (1 - lit) + hr * lit;
  sky[1] = (0.65 * cg + 0.35 * cg * cg / luminance) * 0.85 * (1 - lit) + hg * lit;
  sky[2] = (0.65 * cb + 0.35 * cb * cb / luminance) * 0.85 * (1 - lit) + hb * lit;
  const fog = scene.fogEnabled && scene.fogMode !== Scene.FOGMODE_NONE;
  horizon[0] = fog ? scene.fogColor.r : cr; horizon[1] = fog ? scene.fogColor.g : cg; horizon[2] = fog ? scene.fogColor.b : cb;
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
};
type WaterBindingData = {
  frame: number;
  render: number;
  lighting: WaterLighting;
  removals: WaterRemovalCandidate[];
};
const waterBindings = new WeakMap<Scene, WaterBindingData>();

/** Lazy so animations and before-render updates settle before the first water draw. */
function sceneWaterBindingData(scene: Scene): WaterBindingData {
  const previous = waterBindings.get(scene);
  const frame = scene.getFrameId(), render = scene.getRenderId();
  if (previous?.frame === frame && previous.render === render) return previous;
  const lighting = previous?.lighting ?? {
    ambient: new Float64Array(3), sun: new Float64Array(4), sunColor: new Float64Array(3), sky: new Float64Array(3), horizon: new Float64Array(3),
  };
  sceneWaterLighting(scene, lighting);
  const data = {
    frame, render, lighting,
    removals: sceneWaterRemovals(scene).map((entry) => {
      entry.mesh.computeWorldMatrix(true);
      return { ...entry, position: entry.mesh.getAbsolutePosition().clone(), radius: waterRemovalWorldRadius(entry.mesh, entry.volume) };
    }),
  };
  waterBindings.set(scene, data);
  if (!previous) scene.onDisposeObservable.addOnce(() => waterBindings.delete(scene));
  return data;
}

const TAU = Math.PI * 2;
const wrapPhase = (phase: number) => phase - TAU * Math.floor(phase / TAU);
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
/** Chop octaves then capillaries: the CPU side of `CHOP_UNIFORMS` and `CAPILLARY_UNIFORMS`. */
const ALL_OCTAVES = [...DETAIL_OCTAVES, ...CAPILLARY_OCTAVES];
/** Swell slots by descending slope (k·a), cached per wave set: Low evaluates the first `LOW_SWELL_COMPONENTS`. */
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
  private selectedRemovals: WaterRemovalCandidate[] = [];
  private readonly swell = new Float32Array(WATER_WAVE_MAX_COMPONENTS * WATER_WAVE_SHADER_STRIDE);
  private readonly swellKernel = new Float64Array(WATER_WAVE_MAX_COMPONENTS * WATER_WAVE_SHADER_STRIDE);
  /** slateWaterSea: Σk·a, the crest-fold denominator, and the slope variance and Σk·a of the swell Low skips. */
  private readonly sea = new Float64Array(4);
  private readonly octaves = new Float64Array(ALL_OCTAVES.length * 4);
  private _gpuWaves = false;
  /** Device-clamped quality the features below follow; compared by identity (it changes with the revision). */
  private clamp: WaterQualityDeviceClamp | null = null;
  private tier = DEFAULT_TIER;
  /** Rest height is level across the body (no river, no tilted volume): a planar reflection can mirror it. */
  private _flat = true;
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
  constructor(material: PBRMaterial, water: WaterDefinition, body: WaterBodyProperties) {
    super(material, "SlateWater", 180, {
      SLATE_WATER: true, [WATER_STYLIZED_DEFINE]: false, [WATER_OCEAN_DEFINE]: false, [WATER_GPU_WAVES_DEFINE]: false, [Q]: DEFAULT_TIER,
      ...Object.fromEntries(FEATURES.map(([, define]) => [define, false])),
      [REFRACTION]: false, [SSR]: false, [SSR_STEPS]: 0, [PLANAR]: false, [FFT]: 0, [FFT_VERTEX]: 0,
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
   * it runs (Refraction, Object Reflections, Detail Waves) and, only when Wave Model or a feature term crossing zero
   * changes the asset's own defines, marks them dirty once. Uniform-only fields (Steepness, Peak Sharpness, Wave Seed,
   * Color Variation, colours, amounts) cost nothing here: every bind reads the definition.
   */
  definitionChanged(): void {
    this.syncObjectFeatures();
    const mask = this.assetDefineMask();
    if (mask === this.assetDefines) return;
    this.assetDefines = mask;
    this.markDefinesDirty();
  }
  /** The asset's own define inputs as a bit mask: Ocean Spectrum, then each `WATER_FEATURE_DEFINES` term above zero. */
  private assetDefineMask(): number {
    const w = this.water;
    let mask = waterWaveSet(w).count > waterWaveComponents.length ? 1 : 0;
    for (let i = 0; i < FEATURES.length; i++) if (w[FEATURES[i]![0]] > 0) mask |= 2 << i;
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
    changed = setDefine(defines, WATER_OCEAN_DEFINE, waterWaveSet(w).count > waterWaveComponents.length) || changed;
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
  override getAttributes(attributes: string[]): void { attributes.push("slateWaterData", "slateWaterFlow", "slateWaterBaseNormal", "slateWaterOffset"); }
  override getUniforms() {
    const vectors = [
      "slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves", "slateWaterSun", "slateWaterSunColor",
      "slateWaterLight", "slateWaterShape", "slateWaterFieldBounds", "slateWaterFieldInfo", "slateWaterFieldStep", "slateWaterContactBounds", "slateWaterContactInfo",
      "slateWaterOrigin", "slateWaterSwellInfo", "slateWaterSea", "slateWaterRipple", "slateWaterTerms",
      // Realistic: the analytic sky's zenith and horizon (scene background and fog colours) and the per-channel
      // absorption from Shallow Color.
      "slateWaterSky", "slateWaterHorizon", "slateWaterAbsorb",
      // (1 / output width, 1 / output height, Refraction, march distance) and (planar on, display-encoded,
      // distortion, 0): per draw, from the pass's scene copy and the view's planar reflection.
      "slateWaterScreen", "slateWaterPlanar",
      ...SWELL_DIRECTION, ...SWELL_AMPLITUDE, ...CHOP_UNIFORMS, ...CAPILLARY_UNIFORMS, ...FFT_UNIFORMS,
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
    const g = band.amplitudeGain * this.body.waveScale;
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    v[0] = g; v[1] = this.water.steepness;
    for (let c = 0; c < WATER_FFT_CASCADES_MAX; c++) {
      const o = (1 + c) * 4;
      if (c >= cascades) { v[o + 3] = FFT_FADED; continue; }
      const patch = patches[c]!, texel = 0.5 / size;
      v[o] = 1 / patch;
      v[o + 1] = origin.x / patch - Math.floor(origin.x / patch) + texel;
      v[o + 2] = origin.z / patch - Math.floor(origin.z / patch) + texel;
      v[o + 3] = edges[c]!;
    }
    return band;
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    this.bindObjectFeatures(buffer, scene, subMesh);
    this.bindFft(buffer, scene, subMesh);
    const w = this.water, b = this.body;
    const material = this._material as PBRMaterial;
    const data = sceneWaterBindingData(scene);
    const lighting = data.lighting, ambient = withWaterEnvironment(lighting, w.reflectionStrength, material.reflectionTexture !== null || scene.environmentTexture !== null);
    buffer.updateFloat4("slateWaterShallow", ...linear(w.shallowColor), w.opacity);
    buffer.updateFloat4("slateWaterDeep", ...linear(w.deepColor), w.reflectionStrength);
    buffer.updateFloat4("slateWaterFoam", ...linear(w.foamColor), w.foamAmount);
    buffer.updateFloat4("slateWaterMotion", this.time, w.rippleScale, w.rippleStrength, w.foamWidth);
    buffer.updateFloat4("slateWaterLook", w.colorBands, w.depthColorDistance, w.sparkles, w.subsurface);
    buffer.updateFloat4("slateWaterWaves", w.waveHeight * b.waveScale, w.waveLength, w.waveSpeed, w.waveDirection * Math.PI / 180);
    const sun = lighting.sun, sunColor = lighting.sunColor, sky = lighting.sky, horizon = lighting.horizon;
    buffer.updateFloat4("slateWaterSun", sun[0]!, sun[1]!, sun[2]!, sun[3]!);
    buffer.updateFloat4("slateWaterSunColor", sunColor[0]!, sunColor[1]!, sunColor[2]!, w.surfaceFoam);
    buffer.updateFloat4("slateWaterLight", ambient[0]!, ambient[1]!, ambient[2]!, 0);
    buffer.updateFloat4("slateWaterSky", sky[0]!, sky[1]!, sky[2]!, 0);
    buffer.updateFloat4("slateWaterHorizon", horizon[0]!, horizon[1]!, horizon[2]!, 0);
    this.absorption(buffer);
    // With floating origin, shaders see positions relative to this offset (the eye); patterns must stay world-anchored.
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    buffer.updateFloat4("slateWaterOrigin", origin.x, origin.y, origin.z, w.roughness);
    const swell = this.swellConstants(scene);
    for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
      const o = i * WATER_WAVE_SHADER_STRIDE;
      buffer.updateFloat4(SWELL_DIRECTION[i]!, swell[o]!, swell[o + 1]!, swell[o + 2]!, swell[o + 3]!);
      buffer.updateFloat4(SWELL_AMPLITUDE[i]!, swell[o + 4]!, swell[o + 5]!, swell[o + 6]!, swell[o + 7]!);
    }
    const sea = this.sea, steep = sea[0]!;
    buffer.updateFloat4("slateWaterSea", steep, sea[1]!, sea[2]!, sea[3]!);
    buffer.updateFloat4("slateWaterSwellInfo", this.bankFade(), waterWaveQ(waterWaveSet(w), b.waveScale) > 0 ? 1 : 0, w.colorVariation, 0);
    buffer.updateFloat4("slateWaterShape", w.choppiness, w.waveSpread, w.crestFoam, w.contactFoamWidth);
    // Uniform-only terms the shader would otherwise evaluate per fragment: chop and capillary directions, wavenumbers
    // and clock phases; the contact ripples' wavenumber and phase with the wind heading; and per-asset factors.
    const octaves = this.octaveConstants();
    for (let i = 0; i < ALL_OCTAVES.length; i++) {
      const o = i * 4, name = i < DETAIL_OCTAVES.length ? CHOP_UNIFORMS[i]! : CAPILLARY_UNIFORMS[i - DETAIL_OCTAVES.length]!;
      buffer.updateFloat4(name, octaves[o]!, octaves[o + 1]!, octaves[o + 2]!, octaves[o + 3]!);
    }
    const heading = w.waveDirection * Math.PI / 180, rippleK = TAU / (0.35 + Math.max(0.05, w.contactFoamWidth) * 0.45);
    buffer.updateFloat4("slateWaterRipple", rippleK, wrapPhase(-Math.sqrt(9.81 * rippleK) * this.time), Math.cos(heading), Math.sin(heading));
    buffer.updateFloat4("slateWaterTerms",
      smoothstep(0, 0.1, w.foamAmount) * Math.max(w.foamAmount, 0.85) * smoothstep(0, 0.05, w.contactFoamWidth),
      smoothstep(0, 0.05, w.crestFoam), 0.004 + 0.02 * smoothstep(0.05, 0.4, steep), 1 + 0.9 * smoothstep(0.25, 0.6, steep));
    const field = this.field?.texture ? this.field : null;
    const bounds = field?.bounds ?? [0, 0, 1, 1];
    buffer.updateFloat4("slateWaterFieldBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
    buffer.updateFloat4("slateWaterFieldInfo", field ? 1 : 0, field?.fineDepthMin ?? 0, ...(field?.depthRange ?? WATER_FIELD_DEPTH_RANGE));
    const texel = field?.texelSize ?? [1, 1];
    buffer.updateFloat4("slateWaterFieldStep", texel[0], texel[1], field?.fineDepthSpan ?? WATER_FIELD_FINE_DEPTH_SPAN, 0);
    const contacts = this.contacts?.texture ? this.contacts : null;
    const contactBounds = contacts?.bounds ?? [0, 0, 1, 1];
    buffer.updateFloat4("slateWaterContactBounds", contactBounds[0]!, contactBounds[1]!, contactBounds[2]!, contactBounds[3]!);
    buffer.updateFloat4("slateWaterContactInfo", contacts ? 1 : 0, contacts?.range ?? contactRange(w), contacts?.amplitude ?? 1, 0);
    // The nearest enabled removal volumes that can reach this surface.
    const mesh = this.mesh;
    if (this.bindingFrame !== data.frame || this.bindingRender !== data.render || this.removalMesh !== mesh) {
      const center = mesh?.getBoundingInfo().boundingSphere;
      this.selectedRemovals = data.removals
        .map((entry) => ({ entry, gap: center ? Vector3.Distance(center.centerWorld, entry.position) - entry.radius - center.radiusWorld : 0 }))
        .filter((entry) => entry.gap <= 0)
        .sort((a, b) => a.gap - b.gap)
        .slice(0, WATER_REMOVAL_SLOTS).map(({ entry }) => entry);
      this.bindingFrame = data.frame;
      this.bindingRender = data.render;
      this.removalMesh = mesh;
    }
    for (let i = 0; i < WATER_REMOVAL_SLOTS; i++) {
      const entry = this.selectedRemovals[i];
      if (!entry) { buffer.updateFloat4(`slateWaterRemovalShape${i}`, 0, 0, 0, 0); buffer.updateMatrix(`slateWaterRemoval${i}`, Matrix.IdentityReadOnly); continue; }
      buffer.updateFloat4(`slateWaterRemovalShape${i}`, ...waterRemovalShapeVector(entry.volume));
      entry.inverse ??= entry.mesh.getWorldMatrix().clone().invert();
      buffer.updateMatrix(`slateWaterRemoval${i}`, entry.inverse);
    }
  }
  /**
   * Swell components relative to the floating origin at this frame's simulation time, so eye-relative positions
   * evaluate small phases; unused slots stay zero. Slots hold the components by descending slope (`slopeOrder`), and
   * `sea` receives their slope sums. Allocation-free.
   */
  private swellConstants(scene: Scene): Float32Array {
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    const set = waterWaveSet(this.water), kernel = this.swellKernel, out = this.swell, order = slopeOrder(set);
    const count = waterWaveShaderConstants(set, this.body.waveScale, origin.x, origin.z, this.time, kernel);
    out.fill(0);
    let steep = 0, droppedVariance = 0, droppedSteep = 0;
    for (let slot = 0; slot < count; slot++) {
      const from = order[slot]! * WATER_WAVE_SHADER_STRIDE, to = slot * WATER_WAVE_SHADER_STRIDE;
      for (let j = 0; j < WATER_WAVE_SHADER_STRIDE; j++) out[to + j] = kernel[from + j]!;
      const slope = Math.abs(kernel[from + 2]! * kernel[from + 4]!);
      steep += slope;
      if (slot >= LOW_SWELL_COMPONENTS) { droppedVariance += slope * slope; droppedSteep += slope; }
    }
    const sea = this.sea;
    sea[0] = steep;
    sea[1] = Math.max(0.0001, steep * (1 + this.water.choppiness * (1 / WATER_CREST_RANGE - 1)));
    sea[2] = droppedVariance;
    sea[3] = droppedSteep;
    return out;
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
   * take: channels it lacks absorb fastest (0.3 + 0.9 · (1 - channel / brightest channel), in linear space), scaled so the slowest channel
   * absorbs over Depth Color Distance as the scalar transmittance does. A grey Shallow Color absorbs evenly. Allocation-free.
   */
  private absorption(buffer: UniformBuffer): void {
    const tint = this.water.shallowColor, r = toLinear(tint[0]), g = toLinear(tint[1]), b = toLinear(tint[2]), top = Math.max(r, g, b);
    const kr = top > 0 ? 0.3 + 0.9 * (1 - r / top) : 1, kg = top > 0 ? 0.3 + 0.9 * (1 - g / top) : 1, kb = top > 0 ? 0.3 + 0.9 * (1 - b / top) : 1;
    const weight = Math.min(kr, kg, kb);
    buffer.updateFloat4("slateWaterAbsorb", kr / weight, kg / weight, kb / weight, 0);
  }
  private bankFade(): number { return this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, this.body.waveScale); }
  /**
   * Defines another pass's program needs for `waterOutlineVertexSource` to match this material's vertex shader,
   * including the cascades of the FFT detail band its vertex stage samples. Allocation-free.
   */
  vertexWaveDefines(): readonly string[] {
    return VERTEX_WAVE_DEFINES[waterWaveSet(this.water).count > waterWaveComponents.length ? 1 : 0]![this.fftVertex]!;
  }
  /**
   * Sets `WATER_VERTEX_WAVE_UNIFORMS` and the band's sampler on another pass's effect for this frame, as
   * `hardBindForSubMesh` and `bindForSubMesh` do (the band's footprint follows that pass's projection and target).
   */
  bindVertexWaves(effect: Effect, scene: Scene): void {
    const swell = this.swellConstants(scene);
    for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
      const o = i * WATER_WAVE_SHADER_STRIDE;
      effect.setFloat4(SWELL_DIRECTION[i]!, swell[o]!, swell[o + 1]!, swell[o + 2]!, swell[o + 3]!);
      effect.setFloat4(SWELL_AMPLITUDE[i]!, swell[o + 4]!, swell[o + 5]!, swell[o + 6]!, swell[o + 7]!);
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
    const varyings = varying(v4, "vSlateWater") + varying(v4, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal");
    if (shaderType === "vertex") {
      const vertex = waterVertexSource(language);
      return {
        CUSTOM_VERTEX_DEFINITIONS: (wgsl
          ? "attribute slateWaterData: vec4f;\nattribute slateWaterFlow: vec3f;\nattribute slateWaterBaseNormal: vec3f;\nattribute slateWaterOffset: vec2f;\n"
          : "attribute vec4 slateWaterData;\nattribute vec3 slateWaterFlow;\nattribute vec3 slateWaterBaseNormal;\nattribute vec2 slateWaterOffset;\n") + varyings + vertex.definitions,
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
        "finalSpecularScaled *= swGloss;",
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
