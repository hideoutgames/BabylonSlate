import {
  Color3, DirectionalLight, HemisphericLight, MaterialPluginBase, Matrix, PBRMaterial, type MaterialDefines, RawTexture, ShaderLanguage, Texture, ThinTexture,
  Vector3, type AbstractEngine, type AbstractMesh, type Effect, type Material, type Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import {
  WATER_CREST_MEAN, WATER_CREST_RANGE, WATER_JACOBIAN_FLOOR, WATER_WAVE_MAX_COMPONENTS, WATER_WAVE_SHADER_STRIDE, waterBankFadeLength, waterWaveComponents,
  waterWaveQ, waterWaveSet, waterWaveShaderConstants, type WaterBodyProperties, type WaterColor, type WaterDefinition, type WaterShadingDetail,
  type WaterWaveSet,
} from "@babylonslate/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { invalidateSceneLighting } from "./scene-lighting";
import type { WaterContactField } from "./water-contact-field";
import { WATER_FIELD_DEPTH_RANGE, WATER_FIELD_FINE_DEPTH_SPAN, WATER_FIELD_SHORE_RANGE as SHORE, WATER_FIELD_TERRAIN_ALPHA, type WaterField } from "./water-field";
import { waterPlanarReflectionForCamera, type WaterPlanarReflection } from "./water-planar-reflection";
import type { WaterQualityDeviceClamp } from "./water-quality-device";
import { sceneWaterRemovals, waterRemovalShapeVector, waterRemovalWorldRadius } from "./water-removal-mesh";
import { isMainWaterPass, waterSceneCopyForPass, type WaterSceneCopy } from "./water-scene-copy";

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
 * Realistic only: capillary ripples down to about a tenth of the chop's base wavelength, in the same format. Their
 * slopes stay high like real wind ripples, so close water breaks reflections into fine glitter; they only shade
 * (no crest height or domain drag) and fade with the pixel footprint along their own direction.
 */
const CAPILLARY_OCTAVES = [
  [1.25, 17.4, 0.18, 1.0, 3.3], [-2.45, 28.1, 0.17, 0.96, 0.4], [2.75, 45.3, 0.15, 1.04, 2.2],
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
/** Bound where a copy or planar feature has no source this draw: Babylon binds its empty texture (alpha 0). */
const EMPTY_TEXTURE = new ThinTexture(null);
/** Planar reflection uv offset per unit of view-space surface tilt. */
const PLANAR_DISTORTION = 0.08;
/** Refraction: screen offset per unit of view-space tilt, per metre of water behind the surface, at Refraction 1. */
const REFRACTION_SHIFT = 1.2;
/** Water thickness (metres) beyond which the refracted shift stops growing, and the largest shift (uv). */
const REFRACTION_DEPTH_CAP = 3;
const REFRACTION_SHIFT_CAP = 0.06;
/** Lowest tier evaluating each realistic chop octave, capillary, and Stylized chop octave. */
const CHOP_TIER = [0, 0, 1, 1, 2, 2] as const;
const CAPILLARY_TIER = [1, 2, 2] as const;
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
 * GLSL-shaped; `SW_FRAG_COORD` and the copy helpers are bound per language.
 */
function refractionSource(): string {
  return ifDefined(REFRACTION, `
vec2 swScreenUv = SW_FRAG_COORD.xy * U.slateWaterScreen.xy;
float swWaterZ = abs((S.view * vec4(IN.vPositionW, 1.0)).z);
float swSceneZ0 = swSceneDepth(swScreenUv);
vec2 swTiltV = (S.view * vec4(-swSlope.x, 0.0, -swSlope.y, 0.0)).xy;
float swRefrDepth = min(max(swSceneZ0 - swWaterZ, 0.0), ${f(REFRACTION_DEPTH_CAP)});
vec2 swRefrShift = swTiltV * vec2(S.projection[0][0], S.projection[1][1]) * (U.slateWaterScreen.z * ${f(REFRACTION_SHIFT)} * swRefrDepth / max(swWaterZ, 0.05));
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
swDepth = mix(swDepth, min(swDepth, max(swSceneZ - swWaterZ, 0.0) / max(swWaterZ, 0.001) * abs(S.vEyePosition.y - IN.vPositionW.y)), swRefracts);`);
}

/**
 * Object reflections (`SLATE_WATER_SSR`, `SLATE_WATER_PLANAR`) along `ray` (a world direction): `swObjRefl` holds
 * linear colour and coverage, 0 where nothing was found (the sky or environment reflection stays). The planar
 * reflection is projected from this fragment's eye-relative position through the mirrored view-projection, at the
 * uv the planar browser proof reads back on both backends (0.5 + 0.5·clip.xy/clip.w), shifted by the surface tilt;
 * its alpha is coverage and display views store it display-encoded. Without it (another body is the view's
 * dominant one), the screen-space march runs. Sharp hits fade out as the surface gets rough.
 */
function objectReflectionSource(ray: string, roughness: string): string {
  return `
#if ${REFLECTS_OBJECTS}
vec4 swObjRefl = vec4(0.0);
vec2 swReflTilt = (S.view * vec4(-swSlope.x, 0.0, -swSlope.y, 0.0)).xy;
vec3 swReflRay = ${ray};
swReflRay = normalize(vec3(swReflRay.x, max(swReflRay.y, 0.02), swReflRay.z));${ifDefined(PLANAR, `
if (U.slateWaterPlanar.x > 0.5) {
  vec4 swPlanarClip = U.slateWaterPlanarMatrix * vec4(IN.vPositionW, 1.0);
  vec2 swPlanarUv = swPlanarClip.xy / swPlanarClip.w * 0.5 + vec2(0.5) + swReflTilt * U.slateWaterPlanar.z;
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
 * The copy's colour is filtered; its depth is read from the nearest texel (filtered depth would halo silhouettes).
 * All reads use an explicit level, so they are legal in any control flow.
 */
function objectHelpers(wgsl: boolean): string {
  const copy = wgsl ? `
var ${WATER_SCENE_SAMPLER}Sampler: sampler;
var ${WATER_SCENE_SAMPLER}: texture_2d<f32>;
fn swSceneColor(uv: vec2f) -> vec3f { return textureSampleLevel(${WATER_SCENE_SAMPLER}, ${WATER_SCENE_SAMPLER}Sampler, uv, 0.0).rgb; }
fn swSceneDepth(uv: vec2f) -> f32 {
  let swSize = vec2i(textureDimensions(${WATER_SCENE_SAMPLER}, 0));
  return textureLoad(${WATER_SCENE_SAMPLER}, clamp(vec2i(uv * vec2f(swSize)), vec2i(0), swSize - vec2i(1)), 0).a;
}` : `
uniform sampler2D ${WATER_SCENE_SAMPLER};
vec3 swSceneColor(vec2 uv) { return texture2DLodEXT(${WATER_SCENE_SAMPLER}, uv, 0.0).rgb; }
float swSceneDepth(vec2 uv) {
  ivec2 swSize = textureSize(${WATER_SCENE_SAMPLER}, 0);
  return texelFetch(${WATER_SCENE_SAMPLER}, clamp(ivec2(uv * vec2(swSize)), ivec2(0), swSize - ivec2(1)), 0).a;
}`;
  const planar = wgsl ? `
var ${WATER_PLANAR_SAMPLER}Sampler: sampler;
var ${WATER_PLANAR_SAMPLER}: texture_2d<f32>;
fn swPlanarTexel(uv: vec2f) -> vec4f { return textureSampleLevel(${WATER_PLANAR_SAMPLER}, ${WATER_PLANAR_SAMPLER}Sampler, uv, 0.0); }` : `
uniform sampler2D ${WATER_PLANAR_SAMPLER};
vec4 swPlanarTexel(vec2 uv) { return texture2DLodEXT(${WATER_PLANAR_SAMPLER}, uv, 0.0); }`;
  return `\n#if ${SAMPLES_COPY}${copy}\n#endif${ifDefined(SSR, marchSource(wgsl))}${ifDefined(PLANAR, planar)}\n`;
}

/**
 * The screen-space march (`SLATE_WATER_SSR`), per language (loops do not pass `toWgsl`). The reflected ray runs from
 * the eye-relative surface point until the march distance (`slateWaterScreen.w`), the screen edge or just short of
 * the eye; `SLATE_WATER_SSR_STEPS` samples are evenly spaced on screen along it, with depth interpolated
 * perspective-correctly (also exact for orthographic views). The first sample behind the copy's depth within a
 * thickness that grows with distance and step length is a hit, refined by bisection. Hits fade toward the screen
 * edge and the end of the march; one whose scene point lies under the water plane is rejected (the copy holds
 * submerged geometry). Returns linear colour and coverage.
 */
function marchSource(wgsl: boolean): string {
  const steps = SSR_STEPS, refine = SSR_REFINE_STEPS;
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
  let swZ1 = (scene.view * vec4f(swOrigin + swRay * swLength, 1.0)).z;
  let swForward = sign(swZ0);
  var swPrev: f32 = 0.0;
  var swPrevZ: f32 = abs(swZ0);
  var swHit: f32 = -1.0;
  for (var swI: i32 = 1; swI <= ${steps}; swI++) {
    let swU = swEnd * f32(swI) / f32(${steps});
    let swRayZ = mix(swZ0, swZ1, swMarchAt(swC0.w, swC1.w, swU)) * swForward;
    let swSceneZ = swSceneDepth(mix(swN0, swN1, swU) * 0.5 + 0.5);
    let swThick = max(0.2 + 0.02 * swRayZ, 2.0 * abs(swRayZ - swPrevZ));
    if (swRayZ > swSceneZ && swRayZ - swSceneZ < swThick) { swHit = swU; break; }
    swPrev = swU;
    swPrevZ = swRayZ;
  }
  if (swHit < 0.0) { return vec4f(0.0); }
  var swA: f32 = swPrev;
  var swB: f32 = swHit;
  for (var swJ: i32 = 0; swJ < ${refine}; swJ++) {
    let swM = 0.5 * (swA + swB);
    let swMidZ = mix(swZ0, swZ1, swMarchAt(swC0.w, swC1.w, swM)) * swForward;
    if (swMidZ > swSceneDepth(mix(swN0, swN1, swM) * 0.5 + 0.5)) { swB = swM; } else { swA = swM; }
  }
  let swUv = mix(swN0, swN1, swB) * 0.5 + 0.5;
  let swS = swMarchAt(swC0.w, swC1.w, swB);
  let swRayZ = mix(swZ0, swZ1, swS) * swForward;
  let swSceneZ = swSceneDepth(swUv);
  let swEye = scene.vEyePosition.xyz;
  let swPoint = swOrigin + swRay * (swLength * swS);
  let swSceneY = swEye.y + (swPoint.y - swEye.y) * swSceneZ / max(swRayZ, 0.000001);
  let swEdge = min(swUv, vec2f(1.0) - swUv);
  let swFade = smoothstep(0.0, 0.06, min(swEdge.x, swEdge.y)) * (1.0 - smoothstep(0.7, 1.0, swS)) * step(swOrigin.y - 0.05, swSceneY)
    * step(swRayZ - swSceneZ, max(0.2 + 0.02 * swRayZ, 0.1 * swRayZ));
  return vec4f(swSceneColor(swUv), swFade);
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
  float swZ1 = (view * vec4(swOrigin + swRay * swLength, 1.0)).z;
  float swForward = sign(swZ0);
  float swPrev = 0.0;
  float swPrevZ = abs(swZ0);
  float swHit = -1.0;
  for (int swI = 1; swI <= ${steps}; swI++) {
    float swU = swEnd * float(swI) / float(${steps});
    float swRayZ = mix(swZ0, swZ1, swMarchAt(swC0.w, swC1.w, swU)) * swForward;
    float swSceneZ = swSceneDepth(mix(swN0, swN1, swU) * 0.5 + 0.5);
    float swThick = max(0.2 + 0.02 * swRayZ, 2.0 * abs(swRayZ - swPrevZ));
    if (swRayZ > swSceneZ && swRayZ - swSceneZ < swThick) { swHit = swU; break; }
    swPrev = swU;
    swPrevZ = swRayZ;
  }
  if (swHit < 0.0) { return vec4(0.0); }
  float swA = swPrev;
  float swB = swHit;
  for (int swJ = 0; swJ < ${refine}; swJ++) {
    float swM = 0.5 * (swA + swB);
    float swMidZ = mix(swZ0, swZ1, swMarchAt(swC0.w, swC1.w, swM)) * swForward;
    if (swMidZ > swSceneDepth(mix(swN0, swN1, swM) * 0.5 + 0.5)) { swB = swM; } else { swA = swM; }
  }
  vec2 swUv = mix(swN0, swN1, swB) * 0.5 + 0.5;
  float swS = swMarchAt(swC0.w, swC1.w, swB);
  float swRayZ = mix(swZ0, swZ1, swS) * swForward;
  float swSceneZ = swSceneDepth(swUv);
  vec3 swEye = vEyePosition.xyz;
  vec3 swPoint = swOrigin + swRay * (swLength * swS);
  float swSceneY = swEye.y + (swPoint.y - swEye.y) * swSceneZ / max(swRayZ, 0.000001);
  vec2 swEdge = min(swUv, vec2(1.0) - swUv);
  float swFade = smoothstep(0.0, 0.06, min(swEdge.x, swEdge.y)) * (1.0 - smoothstep(0.7, 1.0, swS)) * step(swOrigin.y - 0.05, swSceneY)
    * step(swRayZ - swSceneZ, max(0.2 + 0.02 * swRayZ, 0.1 * swRayZ));
  return vec4(swSceneColor(swUv), swFade);
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
float swMedium = swNoise(swFlowed * 0.43 + vec2(swTime * 0.03, 0.0));
float swLarge = swNoise(swWorld * ${f(LARGE_NOISE)});${fromTier(1, `
float swFine = swNoise(swFlowed * 2.9 - vec2(0.0, swTime * 0.09));
// Gusts roughen or calm wide patches.
float swGust = swNoise(swWorld * ${f(GUST_NOISE)} + vec2(swTime * 0.004, 0.0));`, `
float swFine = swMedium;
float swGust = swLarge;`)}
// Anti-tiling: a bounded warp bends the chop domain, so crests curve and cross differently across the sea. (A rotation
// about the world origin would compress the chop without limit far from it.) Each component's amplitude suits its
// noise's frequency, so the warp never stretches the chop much; Low's gust is its large noise, so that one shrinks.${fromTier(1, `
vec2 swChop = swFlowed + vec2(swLarge - 0.5, swGust - 0.5) * vec2(2.4, 9.0);`, `
vec2 swChop = swFlowed + vec2(swLarge - 0.5, swGust - 0.5) * vec2(2.4, ${f(9 * GUST_NOISE / LARGE_NOISE)});`)}${realistic ? fromTier(1, `
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
vec2 swSlope = swGradient + swDetail * swChopGain + swRipple;
normalW = normalize(vec3(swBaseX - swSlope.x, 1.0, swBaseZ - swSlope.y));
// The swell alone, without chop: the large-scale wave shape used for lighting through crests.
vec3 swSwellNormal = normalize(vec3(swBaseX - swGradient.x, 1.0, swBaseZ - swGradient.y));

// Bottom estimate: a shelving bank with an irregular floor, capped by the component Depth.
float swShelf = 0.28 + 0.35 * swLarge;
float swDepth = mix(swBodyDepth * (1.0 - exp(-swBank * swShelf / swBodyDepth)), max(0.0, swTerrainDepth), swKnown);${refractionSource()}
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
${ifDefined(WATER_FEATURE_DEFINES.sparkles, fromTier(1, `
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
float swSparkBase = 0.0;`)}
`;
}

/**
 * Realistic: lit PBR (unlit at Low, see `configureWaterMaterial`). Everything here is premultiplied by coverage;
 * `CUSTOM_FRAGMENT_BEFORE_FOG` divides by alpha so standard blending yields reflection + specular + (1 - F) *
 * (T * background + (1 - T) * in-scattered light).
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
// glossy, rough seas reach Cox-Munk-like roughness instead of mirroring the sky in smooth blobs.
swSlopeVariance = min(swLost + swLostDetail * swChopGain * swChopGain, U.slateWaterTerms.z);
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
float swTransmit = max(exp(-swDepth * (1.0 + 1.0 / swCosT) / swAbsorb), 1.0 - U.slateWaterShallow.a);
vec3 swCol = mix(U.slateWaterShallow.rgb, U.slateWaterDeep.rgb, swTone);
// In-scattering (Atlas/Crest form): the absorption tint sets transmittance, but the scattered body has its own,
// lighter colour that shifts toward Shallow on crests and at grazing views, so water away from the sun keeps colour.
// Color Variation drifts it in wide patches. Faces turned to the eye and slopes toward the sun brighten it; sunlight
// through thin crests seen toward the sun (Subsurface) turns them bright and green.
float swFaceV = clamp(dot(swWaveN, swV), 0.0, 1.0);
// Crests lift the scatter most at grazing views, where they stand against the troughs behind them. Seen from above,
// a full lift would print the swell's interference pattern into the colour as a regular lattice, so it weakens toward
// steep views and drifts with the wide noises.
float swLiftGain = (0.3 + 0.7 * swGraze) * (0.4 + 0.75 * swLarge + 0.45 * swGust);
float swCrestLift = clamp(swCrest * 0.5 * swLiftGain + 0.5, 0.0, 1.0);
vec3 swScatterCol = mix(U.slateWaterDeep.rgb, U.slateWaterShallow.rgb, clamp(0.12 + 0.22 * swCrestLift + 0.18 * swGraze * swGraze, 0.0, 0.6));
float swPatch = smoothstep(0.3, 0.75, swLarge * 0.6 + swGust * 0.4) * U.slateWaterSwellInfo.z;
swScatterCol = mix(swScatterCol, U.slateWaterShallow.rgb * vec3(0.85, 1.05, 0.9), swPatch * 0.35);
float swFaceLit = swFaceV * swFaceV * (0.6 + 0.4 * swCrestLift);
float swSlopeLit = max(dot(swSwellNormal, swL), 0.0);
vec3 swScatter = swScatterCol * (swAmb * (0.55 + 0.45 * swCrestLift) + swSun * (0.35 * swFaceLit + 0.3 * swSlopeLit));${ifDefined(WATER_FEATURE_DEFINES.subsurface, `
float swToSun = max(dot(swL, -swV), 0.0);
float swBehind = swToSun * swToSun * swToSun * swToSun;
float swPeak = clamp(swCrest * 0.5 + 0.5 + swChopH * 0.6, 0.0, 1.2);
float swAway = clamp(0.5 - 0.5 * dot(swL, swWaveN), 0.0, 1.0);
float swThrough = swBehind * swPeak * swAway * swAway * 6.0;
swScatter += U.slateWaterShallow.rgb * vec3(0.9, 1.15, 0.85) * swSun * (U.slateWaterLook.w * (swThrough + smoothstep(0.2, 0.9, swFoldN) * swRough * 0.15));`)}

// Foam: a clumpy, bubbly pattern thresholded by a foam density (Crest-style), so dense foam is solid, then opens
// round holes and breaks into lace and scattered patches as it thins. The slope warp is bounded, so storm slopes
// never shred it.
vec2 swWarp = swSlope / (1.0 + length(swSlope)) * 0.3;
vec2 swFoamUv = swFlowed * 1.1 + swWarp + vec2(swMedium - 0.5, swFine - 0.5) * 0.8;
float swFoamFade = smoothstep(0.3, 0.9, swFoot * 1.6);
float swClump = swNoise(swFoamUv * 0.5 + vec2(7.3, swTime * 0.02));${fromTier(1, `
float swBlob = swNoise(swFoamUv * 1.7 + vec2(1.9, swTime * -0.05));${fromTier(2, `
// Churn: two phases of the hole pattern crossfade, each re-seeded while it is invisible, so foam evolves in place.
float swChurnT = swTime * 0.12;
float swChurnA = fract(swChurnT);
float swChurnB = fract(swChurnT + 0.5);
vec2 swChurnDrift = vec2(0.22, -0.13);
float swHolesA = swCells(swFoamUv + vec2(0.37, 0.71) * (floor(swChurnT) * 7.0) + swChurnDrift * swChurnA).x;
float swHolesB = swCells(swFoamUv + vec2(0.37, 0.71) * (floor(swChurnT + 0.5) * 7.0 + 3.0) + swChurnDrift * swChurnB).x;
float swHoles = mix(swHolesB, swHolesA, 1.0 - abs(1.0 - 2.0 * swChurnA));
float swBubbles = smoothstep(0.08, 0.32, swCells(swFoamUv * 2.3 + vec2(3.1, swTime * 0.07)).x);`, `
float swHoles = swCells(swFoamUv).x;
float swBubbles = 0.6;`)}
// Bubble holes, not cracks: the distance to each cell's centre opens round holes as the foam thins.
float swLace = smoothstep(0.1, 0.45, swHoles);
// Spread over 0-1 so a foam density maps evenly to coverage.
float swFoamTex = smoothstep(0.05, 0.85, swClump * 0.4 + swBlob * 0.25 + swLace * 0.22 + swBubbles * 0.13);`, `
// Low evaluates one foam noise and no cell pattern: its foam is the clumps alone, as Medium's reads at a distance.
float swBlob = swClump;
float swLace = swClump;
float swBubbles = 0.5;
float swFoamTex = smoothstep(0.05, 0.85, swClump * 0.85 + 0.08);`)}
// Shores wash in bands. Whitecaps form where crests steepen (Crest Foam sets coverage) and leave foam trailing on
// their windward backs, drawn out along the wind.
float swWashPhase = swBank / swFoamWidth - swTime * 0.45 + swMedium * 1.4;
float swWash = exp(-swBank / swFoamWidth) * (0.85 + 0.3 * sin(swWashPhase * 6.2831853));
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
// Caps keep bubbles and holes at their edges; the densest cores stay solid white.
swCap = smoothstep(1.0 - U.slateWaterShape.z, 1.5 - U.slateWaterShape.z, swCapDrive) * (0.6 + 0.4 * smoothstep(0.25, 0.65, swClump)) * U.slateWaterTerms.y;
swCapCore = smoothstep(1.45 - U.slateWaterShape.z, 2.05 - U.slateWaterShape.z, swCapDrive) * U.slateWaterTerms.y;${fromTier(1, `
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
swStreak = smoothstep(swStreakCut - swStreakAA, swStreakCut + swStreakAA, swStreakRidge) * swStreakBreak * (0.2 + 0.5 * U.slateWaterSunColor.w) * (0.6 + 0.6 * swGust) * swCalm;`, `
// Low has no streak noise: the streaks' average coverage, as Medium's filter to at a distance, lightly whitens the
// same gusty patches instead of drawing lines.
swStreakTint = (1.0 - swStreakCut) * swStreakBreak * (0.2 + 0.5 * U.slateWaterSunColor.w) * (0.6 + 0.6 * swGust) * swCalm * 0.6;`)}`)}
float swDensity = clamp(max(max(swWash, swCap), max(swTrail, swStreak)), 0.0, 1.0);
// Thinning foam softens: its holes open gradually.
float swFoamSoft = 0.1 + 0.25 * (1.0 - swDensity) + fwidth(swFoamTex);${fromTier(2, `
// Bubble grain keeps the foam from reading as flat paint; it averages out before it would alias.
float swGrain = mix(swNoise(swFoamUv * 9.0 + vec2(0.0, swTime * 0.2)), 0.5, swFoamFade);`, `
float swGrain = 0.5;`)}
// Where the pattern is too fine to resolve, foam keeps the coverage its density would give rather than turning into
// solid shapes wherever the density is high.
float swRealFoam = mix(smoothstep(1.0 - swDensity, 1.0 - swDensity + swFoamSoft, swFoamTex), swDensity * swDensity * (3.0 - 2.0 * swDensity) * 0.8, swFoamFade) * (0.3 + 0.7 * swDensity);
swRealFoam = max(max(swRealFoam, swCapCore), swStreakTint);
float swShoreLine = 1.0 - smoothstep(0.0, 0.2 * swFoamWidth + 0.05, swBank);
swRealFoam = max(swRealFoam, swShoreLine * (0.6 + 0.35 * smoothstep(0.2, 0.5, mix(swFoamTex, 0.45, swFoamFade))));
// Contact foam hugs the actual waterline on objects: a dense churned band where the water meets them that breaks,
// within about half a contact width, into sparse patches; ripple crests carry a few flecks further out. Low keeps
// the band and line only.
float swContactLine = 1.0 - smoothstep(0.0, 0.12 * swContactW + 0.06 + fwidth(swObject), swObject + (swBlob - 0.5) * 0.06 * swContactW);${fromTier(1, `
float swHug = clamp(exp(-swObject / swContactW * 6.0) * (0.45 + 1.1 * swClump) + max(0.0, cos(swRipplePhase)) * swRippleFade * 0.1 * swClump, 0.0, 1.0);
// Bubbly patches: the low-frequency clumps carry the bubbles, so thinning foam breaks into islands, not a net.
float swPatchTex = mix(smoothstep(0.12, 0.85, (swClump * 0.5 + swBlob * 0.5) * (0.75 + 0.25 * swBubbles) + swLace * 0.12), 0.45, swFoamFade);
float swHugSoft = 0.06 + 0.1 * (1.0 - swHug) + fwidth(swPatchTex);
// Thinner foam is sparser and more translucent.
float swRealContact = smoothstep(1.0 - swHug, 1.0 - swHug + swHugSoft, swPatchTex) * (0.3 + 0.7 * swHug);
swRealContact = max(swRealContact, swContactLine * (0.75 + 0.25 * smoothstep(0.2, 0.6, swPatchTex)));`, `
float swHug = clamp(exp(-swObject / swContactW * 6.0) * (0.45 + 1.1 * swClump), 0.0, 1.0);
float swRealContact = max(smoothstep(0.35, 0.75, swHug) * (0.3 + 0.7 * swHug), swContactLine * 0.85);`)}
float swFoam = clamp(max(swRealFoam * swFoamAmount * 1.35, swRealContact * swContactStrength), 0.0, 1.0);
// Air churned under foam lightens and clouds the water around it, without a pattern.
float swAerated = max(swDensity * swFoamAmount, swHug * 0.6);
swTransmit *= 1.0 - swAerated * 0.35;
swScatter += mix(swCol, U.slateWaterFoam.rgb, 0.5) * (swAmb + swSun * max(swL.y, 0.0)) * swAerated * 0.2;

// The sun. Medium and up: Babylon's GGX lobe (widened by the filtered slope variance) carries the sun path, and a
// sparse glitter of sub-pixel facets adds sharp points where unresolved ripples would mirror the sun. Each glitter
// cell on a world grid holds one facet; it flashes with the probability that a facet tilted by the unresolved
// roughness mirrors the sun, so calm water shows none and the flashes thin out away from the sun path. Low draws
// water unlit and carries one analytic sun lobe instead.
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
float swGlitFade = 1.0 - smoothstep(0.25, 0.9, sqrt(length(swFootX) * length(swFootY)) * 5.0 * U.slateWaterMotion.y);
// A facet mirroring the sun shows the sun's own radiance: far brighter than the sky, so it saturates.
vec3 swGlint = min(swSun * (swSunFres * step(0.0, swL.y) * 40.0 * swGlitOn * swGlitCore * swGlitCore * swGlitFade), vec3(6.0));`, `
float swLowNH = max(dot(normalW, swHalf), 0.05);
float swLowA2 = max(U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w + 2.0 * swSlopeVariance, 0.0004);
float swLowD = exp((swLowNH * swLowNH - 1.0) / (swLowNH * swLowNH * swLowA2)) / (3.14159 * swLowA2 * swLowNH * swLowNH * swLowNH * swLowNH);
vec3 swGlint = min(swSun * (swSunFres * step(0.0, swL.y) * step(0.0, dot(normalW, swL)) * swLowD / (4.0 * max(swNdotV, 0.1))), vec3(6.0));`)}
${sparkled(`
float swRL = max(dot(reflect(-swV, normalW), swL), 0.0);
float swSpark = swSparkBase * 3.0 * pow(swRL, 40.0) * (1.0 - swFoam);`)}

// Foam is matte and lit: PBR shades it as albedo, and its roughness and coverage remove the mirror.
float swEdgeFade = smoothstep(0.0, 0.2, swBank + 0.02);
float swGloss = (1.0 - swFoam) * swEdgeFade;
// Thicker foam is brighter; bubbles vary it slightly.
surfaceAlbedo = U.slateWaterFoam.rgb * (swFoam * swEdgeFade * (0.7 + 0.3 * swGrain));
swMatte = swFoam;
vec3 swEmissive = swScatter * ((1.0 - swFres) * (1.0 - swTransmit) * swGloss) + (swGlint + vec3(swSpark) * swSun) * swGloss;${fromTier(1, "", `
// Low is unlit: the sun and sky light the foam here.
swEmissive += surfaceAlbedo * (swSun * max(dot(swWaveN, swL), 0.0) * 0.8 + swAmb * 0.45);`)}
alpha = (1.0 - (1.0 - swFres) * swTransmit * (1.0 - swFoam)) * swEdgeFade;${ifDefined(REFRACTION, `
// The refracted scene replaces the blended background: the light transmitted through the water is the copy behind
// this point, so coverage keeps only the shore fade.
swEmissive += swBackground * ((1.0 - swFres) * swTransmit * (1.0 - swFoam) * swEdgeFade * swRefracts);
alpha = mix(alpha, swEdgeFade, swRefracts);`)}
${objectReflectionSource("normalize(swRefl)", "sqrt(sqrt(U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w * U.slateWaterOrigin.w + 2.0 * swSlopeVariance))")}
`;
}

/** Stylized: unlit toon water with flat colour bands, graphic foam lines and a crisp sun highlight. */
function stylizedSource(): string {
  return surfaceSource("stylized") + `
vec3 swV = viewDirectionW;
float swNdotV = clamp(dot(normalW, swV), 0.0, 1.0);
float swBandCount = max(1.0, U.slateWaterLook.x);
float swBand = swTone * swBandCount;
float swBandAA = fwidth(swBand) + 0.04;
float swBanded = (floor(swBand) + smoothstep(0.5 - swBandAA, 0.5 + swBandAA, fract(swBand))) / swBandCount;
swTone = mix(swTone, swBanded, step(1.5, U.slateWaterLook.x));
// Authored colours read as-is in daylight and dim with the scene's light.
vec3 swLitScale = min(vec3(0.3) + swAmb * 0.35 + swSun * (0.25 * max(swL.y, 0.0)), vec3(1.15));
vec3 swShallowLit = U.slateWaterShallow.rgb * swLitScale;
vec3 swLit = mix(U.slateWaterShallow.rgb, U.slateWaterDeep.rgb, swTone) * swLitScale;
// Two-tone swell: slopes facing the sun are a little lighter; wave tops take the shallow tint (Subsurface).
float swFacing = smoothstep(-0.02, 0.02, dot(swSwellNormal, swL) - swL.y);
swLit *= 0.92 + 0.14 * swFacing;
float swTop = smoothstep(-0.3, 1.1, swCrest + swChopH * 0.5) * clamp(U.slateWaterLook.w, 0.0, 1.0);
swLit = mix(swLit, swShallowLit * 1.1, swTop * 0.5);
// Fresnel rim toward a lighter horizon tint (Reflection Strength).
float swRim = smoothstep(0.4, 1.0, 1.0 - swNdotV) * U.slateWaterDeep.w * 0.75;
swLit = mix(swLit, swShallowLit * 1.25 + swLitScale * 0.12, clamp(swRim, 0.0, 1.0));
// Open-sea colour variation (Color Variation): lighter, greener drifts across deep water, wide lighter and darker
// areas, and a posterised band on the highest crests.
float swVariation = U.slateWaterSwellInfo.z;
float swPatch = smoothstep(0.25, 0.75, swLarge * 0.6 + swGust * 0.4);
swLit = mix(swLit, swShallowLit * 0.9 + swLit * 0.1, swPatch * swTone * swVariation * 0.6);
swLit *= 1.0 + (swGust - 0.5) * 0.4 * swVariation;
float swHeightAA = fwidth(swCrest) + 0.02;
swLit *= mix(1.0, mix(0.86, 1.1, smoothstep(0.25 - swHeightAA, 0.25 + swHeightAA, swCrest)), swVariation);${fromTier(1, `
// Caustic cell lines in the shallows.
vec2 swCausticUv = swFlowed * 0.75 * U.slateWaterMotion.y + vec2(swMedium, swFine) * 0.45 + vec2(swTime * 0.06, swTime * 0.04);
float swCausticCells = swCells(swCausticUv).y;
float swCausticAA = fwidth(swCausticCells) + 0.015;
float swCaustic = (1.0 - smoothstep(0.02, 0.02 + swCausticAA, swCausticCells)) * (1.0 - smoothstep(0.08, 0.3, swFoot * 0.75 * U.slateWaterMotion.y)) * (1.0 - swTone) * smoothstep(0.25, 0.6, swMedium);
swLit += swShallowLit * (swCaustic * 0.3);`)}

// Fine break-up for the highlight and the caps, and where it fades before it would alias: the fine noise from Medium
// up. Low has none, so it folds its two shared noises into narrow contour bands (no noise, no trigonometry).${fromTier(1, `
float swFineBreak = swFine;
float swFineFade = smoothstep(0.12, 0.3, swFoot);`, `
float swFineBreak = abs(fract(swMedium * 3.1 + swLarge * 1.3) * 2.0 - 1.0);
float swFineFade = smoothstep(0.5, 1.2, swFoot);`)}

// Toon highlight: a crisp sun reflection, sized by Roughness, on a normal with extra chop and a jittered threshold,
// so it breaks into glints and streaks instead of a disc on smooth wave faces.
${fromTier(1, `
float swGlintDetail = 1.5;
float swGlintJitter = (swFineBreak - 0.5) * 0.008;
float swGlintMask = 1.0;`, `
// Low's normals are smoother (one chop octave): a lower detail gain and a tighter threshold, and near the eye the
// folded bands also cut the highlight into curved glints and streaks.
float swGlintDetail = 2.0;
float swGlintJitter = (0.5 - swFineBreak) * 0.012 * (1.0 - swFineFade) + 0.0015;
float swGlintMask = mix(smoothstep(0.25, 0.55, swFineBreak), 1.0, swFineFade);`)}
vec3 swGlintN = normalize(normalW - vec3(swDetail.x, 0.0, swDetail.y) * swGlintDetail);
vec3 swReflected = reflect(-swV, swGlintN);
float swAlign = dot(swReflected, swL);
float swSpecThreshold = 1.0 - 0.012 * U.slateWaterOrigin.w - 0.001 + swGlintJitter;
float swSpecAA = fwidth(swAlign) + 0.0005;
float swSpec = smoothstep(swSpecThreshold - swSpecAA, swSpecThreshold + swSpecAA, swAlign) * swGlintMask * step(0.0, swL.y) * min(1.0, U.slateWaterSun.w);

// Shoreline: a crisp wobbling outline plus foam lines washing in.
float swEdgeUnit = swBank / swFoamWidth;
float swEdgeAA = fwidth(swEdgeUnit) + 0.015;
float swWobble = (swMedium - 0.5) * 0.5 + sin(swTime * 1.7 + swLarge * 18.0) * 0.08;
float swEdge = swEdgeUnit + swWobble;
float swOutline = 1.0 - smoothstep(0.7 - swEdgeAA, 0.7 + swEdgeAA, swEdge);
// Foam lines take turns washing in toward the shore, fading as they arrive; phases vary along the coast (one at Low).
float swRingAge = fract(swTime * 0.16 + swLarge * 2.3);
float swRing = (1.0 - smoothstep(0.08, 0.08 + swEdgeAA * 1.5, abs(swEdge - 0.95 - (1.0 - swRingAge) * 1.6))) * swRingAge;${fromTier(1, `
float swRingAgeB = fract(swRingAge + 0.5);
swRing = max(swRing, (1.0 - smoothstep(0.08, 0.08 + swEdgeAA * 1.5, abs(swEdge - 0.95 - (1.0 - swRingAgeB) * 1.6))) * swRingAgeB);`)}
swRing *= smoothstep(0.3, 0.42, swFine * 0.6 + swMedium * 0.4);
// Contacts: a wobbling collar at the waterline and graphic ripple rings that ride outward and break up.
float swObjectUnit = swObject / swContactW + swWobble * 0.6;
float swObjectAA = fwidth(swObjectUnit) + 0.02;
float swCollar = 1.0 - smoothstep(0.55 - swObjectAA, 0.55 + swObjectAA, swObjectUnit);
float swRingWave = cos(swRipplePhase);
float swRingAA = fwidth(swRingWave) + 0.03;
float swToonRings = smoothstep(0.72 - swRingAA, 0.72 + swRingAA, swRingWave) * smoothstep(0.25, 0.45, swRippleNoise) * swRippleFade * 1.6;
float swToonContact = clamp(max(swCollar, swToonRings), 0.0, 1.0);
float swToonCap = 0.0;${ifDefined(WATER_FEATURE_DEFINES.crestFoam, `
// White caps on the sharpest crests (Crest Foam sets coverage, not brightness): a crisp rim band with a broken core,
// so caps read as foam curling over the crest rather than solid blobs.
float swCapDrive = (swFoldN * 1.3 + swCrest * 0.2 + (swFineBreak - 0.5) * 0.3) * swRough;
float swCapThreshold = 1.1 - 0.6 * U.slateWaterShape.z;
float swCapAA = fwidth(swCapDrive) * 0.75 + 0.005;
float swCapOuter = smoothstep(swCapThreshold - swCapAA, swCapThreshold + swCapAA, swCapDrive);
float swCapInner = smoothstep(swCapThreshold + 0.1 - swCapAA, swCapThreshold + 0.1 + swCapAA, swCapDrive);
// The break pattern keeps its average coverage where it would alias, so distant caps never shimmer.
float swCapBreak = mix(smoothstep(0.36, 0.46, swFineBreak * 0.7 + swMedium * 0.3), 0.6, swFineFade);
swToonCap = swCapOuter - swCapInner + swCapInner * swCapBreak;`)}
float swSurf = 0.0;
float swSurfTint = 0.0;${ifDefined(WATER_FEATURE_DEFINES.surfaceFoam, `
// Surface foam: thin ridged lines along the drifting noise's mid contour, broken into strokes, plus small flecks;
// denser near shores and objects (Surface Foam).
float swNearEdge = clamp(min(swBank / (swFoamWidth * 3.0), swObject / (swContactW * 3.0)), 0.0, 1.0);
vec2 swSurfUv = swFlowed * 1.05 * U.slateWaterMotion.y + swSlope * 0.6 + vec2(swMedium - 0.5, swFine - 0.5) * 0.7 + vec2(swTime * 0.05, swTime * 0.03);
float swSurfNoise = swNoise(swSurfUv);
float swRidge = 1.0 - abs(swSurfNoise * 2.0 - 1.0);
float swLineCut = mix(0.985, 0.86, U.slateWaterSunColor.w) * mix(0.96, 1.0, swNearEdge);
float swRidgeAA = fwidth(swRidge) * 0.75 + 0.004;
swSurf = smoothstep(swLineCut - swRidgeAA, swLineCut + swRidgeAA, swRidge) * smoothstep(0.42, 0.58, swMedium * 0.6 + swFine * 0.4);${fromTier(1, `
float swFleckNoise = swNoise(swSurfUv * 3.1 + vec2(4.1, swTime * 0.07));
float swFleckCut = mix(0.97, 0.8, U.slateWaterSunColor.w);
float swFleckAA = fwidth(swFleckNoise) * 0.75 + 0.004;
swSurf = max(swSurf, smoothstep(swFleckCut - swFleckAA, swFleckCut + swFleckAA, swFleckNoise) * smoothstep(0.35, 0.6, swSurfNoise));`)}
// Beyond where the lines resolve, their coverage becomes a faint lighter tint instead of ending at a visible edge.
float swSurfFar = smoothstep(0.05, 0.35, swFoot * 1.05 * U.slateWaterMotion.y);
swSurf *= 1.0 - swSurfFar;
swSurfTint = swSurfFar * U.slateWaterSunColor.w * 0.12;`)}
float swFoam = clamp(max(max(max(swOutline, swRing), max(swToonCap, swSurf)) * swFoamAmount, swToonContact * swContactStrength), 0.0, 1.0);

${sparkled(`
float swSpark = swSparkBase * 2.5 * (0.3 + 1.7 * pow(max(swAlign, 0.0), 5.0)) * (1.0 - swFoam);`)}
vec3 swFoamLit = U.slateWaterFoam.rgb * clamp(swLitScale * 1.1, vec3(0.35), vec3(1.0));
vec3 swEmissive = mix(mix(swLit, swFoamLit, swSurfTint * swFoamAmount), swFoamLit, swFoam) + vec3(swSpec * 0.95 * (1.0 - swFoam) + swSpark);
surfaceAlbedo = vec3(0.0);
alpha = clamp(max(mix(U.slateWaterShallow.a * 0.55, U.slateWaterShallow.a, smoothstep(0.0, 0.5, swTone)), max(swFoam, max(swSpec, swSpark))), 0.0, 1.0);
${objectReflectionSource("reflect(-swV, normalW)", "U.slateWaterOrigin.w")}
#if ${REFLECTS_OBJECTS}
// Reflected objects join the flat colour where the rim would brighten it (Reflection Strength), never over foam.
float swReflWeight = swObjRefl.a * (0.3 + 0.7 * smoothstep(0.2, 1.0, 1.0 - swNdotV)) * U.slateWaterDeep.w * (1.0 - swFoam);
swEmissive = mix(swEmissive, swObjRefl.rgb, swReflWeight);
alpha = max(alpha, swReflWeight);
#endif${ifDefined(REFRACTION, `
// The refracted scene replaces the blended background; Opacity still sets how much of it shows.
swEmissive = mix(swEmissive, mix(swBackground, swEmissive, alpha), swRefracts);
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
// field's own gradient steps at every cell). They read the fine depth, or the full-range depth where a tap is clamped
// beyond the fine range, so steep coasts and storm waves keep their shoreline. Rest-height distance stays exact when
// waves are off. Only real terrain takes this path: cells extended past an underwater landscape edge (alpha ramp) have
// no floor slope to measure, so they keep the stored distance to real land. Open water skips the four taps.
if (U.slateWaterWaves.x > 0.0 && swField.a > ${f(WATER_FIELD_TERRAIN_ALPHA)}) {
  vec2 swFieldStep = U.slateWaterFieldStep.xy;
  ${tap("swTapE", "swFieldUv + vec2(swFieldStep.x, 0.0)")}
  ${tap("swTapW", "swFieldUv - vec2(swFieldStep.x, 0.0)")}
  ${tap("swTapN", "swFieldUv + vec2(0.0, swFieldStep.y)")}
  ${tap("swTapS", "swFieldUv - vec2(0.0, swFieldStep.y)")}
  vec2 swCellMetres = max(swFieldStep / U.slateWaterFieldBounds.zw, vec2(0.000001));
  vec2 swFineSlope = vec2(swTapE.b - swTapW.b, swTapN.b - swTapS.b) * (swFineSpan * 0.5) / swCellMetres;
  vec2 swCoarseSlope = vec2(swTapE.g - swTapW.g, swTapN.g - swTapS.g) * ((U.slateWaterFieldInfo.w - U.slateWaterFieldInfo.z) * 0.5) / swCellMetres;
  float swFineClamped = max(smoothstep(0.93, 0.99, max(max(swTapE.b, swTapW.b), max(swTapN.b, swTapS.b))),
    1.0 - smoothstep(0.01, 0.07, min(min(swTapE.b, swTapW.b), min(swTapN.b, swTapS.b))));
  vec2 swTerrainSlope = mix(swFineSlope, swCoarseSlope, swFineClamped);
  swTerrainShore = clamp(swTerrainDepth / max(length(swTerrainSlope), 0.001), ${f(SHORE[0])}, ${f(SHORE[1])});
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
 * shadows and clip planes follow it) and leaves the height and offset for the varyings in `swvH` / `swvD`.
 * GLSL-shaped: `A.` attributes, `U.` uniforms and `O.` outputs are bound per language, then `toWgsl` translates it.
 * Other passes that draw built-in water with their own vertex shader (the shared outline mask) include the same
 * displacement through `waterOutlineVertexSource`, without the material's `vPositionW` output.
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
swvD += swvWD${i}.xy * (swvWA${i}.z * swvF${i} * swvC${i});`;
    return i < waterWaveComponents.length ? code : `\n#ifdef ${WATER_OCEAN_DEFINE}${code}\n#endif`;
  }).join("");
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
float swvSpacing = A.slateWaterData.x;
float swvChop = U.slateWaterShape.x;
vec2 swvRest = worldPos.xz;
float swvH = 0.0;
vec2 swvD = vec2(0.0);
${swell}
float swvFade = U.slateWaterSwellInfo.x;
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
swvD = swvD * mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));
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

/** Binds the GLSL-shaped `A.` / `U.` / `O.` prefixes for one language. */
function bindVertexSource(code: string, wgsl: boolean): string {
  return code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bA\./g, wgsl ? "vertexInputs." : "").replace(/\bO\./g, wgsl ? "vertexOutputs." : "");
}

/** Vertex hooks for one language: the GPU swell and the varyings. */
export function waterVertexSource(language: ShaderLanguage): { worldPosition: string; end: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  return wgsl
    ? { worldPosition: bindVertexSource(toWgsl(vertexWaveSource(true)), true), end: bindVertexSource(toWgsl(VERTEX_VARYINGS), true) }
    : { worldPosition: bindVertexSource(vertexWaveSource(true), false), end: bindVertexSource(VERTEX_VARYINGS, false) };
}

/** Uniforms the vertex swell reads (`WaterMaterialPlugin.bindVertexWaves` sets them on another pass's effect). */
export const WATER_VERTEX_WAVE_UNIFORMS: readonly string[] = ["slateWaterShape", "slateWaterSwellInfo", ...SWELL_DIRECTION, ...SWELL_AMPLITUDE];
const CLASSIC_VERTEX_WAVE_DEFINES: readonly string[] = [`#define ${WATER_GPU_WAVES_DEFINE}`];
const OCEAN_VERTEX_WAVE_DEFINES: readonly string[] = [`#define ${WATER_GPU_WAVES_DEFINE}`, `#define ${WATER_OCEAN_DEFINE}`];

/**
 * The GPU swell for another pass's vertex shader that computes a `worldPos` vec4 from the same world matrix (the
 * shared outline mask): declarations of its attribute and uniforms, and the displacement to insert after `worldPos`.
 * Both compile only under `SLATE_WATER_GPU_WAVES` (and components 5-7 under `SLATE_WATER_OCEAN`), so the pass's other
 * programs are unchanged.
 */
export function waterOutlineVertexSource(language: ShaderLanguage): { declarations: string; displacement: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const uniforms = WATER_VERTEX_WAVE_UNIFORMS.map((name) => (wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`)).join("\n");
  const attribute = wgsl ? "attribute slateWaterData: vec4f;" : "attribute vec4 slateWaterData;";
  const displacement = vertexWaveSource(false);
  return {
    declarations: `\n#ifdef ${WATER_GPU_WAVES_DEFINE}\n${attribute}\n${uniforms}\n#endif\n`,
    displacement: bindVertexSource(wgsl ? toWgsl(displacement) : displacement, wgsl),
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

/** Both styles, selected by `SLATE_WATER_STYLIZED` so each material compiles only one (each directive on its own line). */
function fragmentSource(): string {
  return `\n#ifdef ${WATER_STYLIZED_DEFINE}\n${stylizedSource()}\n#else\n${realisticSource()}\n#endif\n`;
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
    ? { helpers: samplerDeclaration + roughnessGlobals + toWgsl(HELPERS + REMOVAL_HELPER) + objectHelpers(true), cut: bind(toWgsl(cutSource(true))), main: bind(toWgsl(fragmentSource())) }
    : { helpers: samplerDeclaration + roughnessGlobals + HELPERS + REMOVAL_HELPER + objectHelpers(false), cut: bind(cutSource(false)), main: bind(fragmentSource()) };
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

const linear = (c: WaterColor): [number, number, number] => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];

/** Scene contribution before each material's environment strength and low-light floor. */
function sceneWaterLighting(scene: Scene) {
  const ambient = new Color3(0, 0, 0);
  let sun: DirectionalLight | null = null;
  for (const light of scene.lights) {
    if (!light.isEnabled() || light.intensity <= 0) continue;
    if (light instanceof HemisphericLight) {
      ambient.addInPlace(light.diffuse.scale(light.intensity * 0.6)).addInPlace(light.groundColor.scale(light.intensity * 0.2));
    } else if (light instanceof DirectionalLight) {
      if (!sun || light.intensity > sun.intensity) sun = light;
    }
  }
  const direction = sun ? sun.direction.normalizeToNew().scale(-1) : null;
  if (sun && direction) ambient.addInPlace(sun.diffuse.scale(sun.intensity * Math.max(0, direction.y) * 0.55));
  return {
    ambient: [ambient.r, ambient.g, ambient.b] as const,
    sun: direction ? [direction.x, direction.y, direction.z, sun!.intensity] as const : [-0.4, 0.8, 0.45, 0] as const,
    sunColor: sun ? [sun.diffuse.r, sun.diffuse.g, sun.diffuse.b] as const : [1, 1, 1] as const,
  };
}

function withWaterEnvironment(light: ReturnType<typeof sceneWaterLighting>, environmentStrength: number, reflective: boolean) {
  const ambient = Color3.FromArray(light.ambient);
  if (reflective) ambient.addInPlace(new Color3(0.8, 0.9, 1).scale(0.45 * environmentStrength));
  if (ambient.r + ambient.g + ambient.b < 0.25) ambient.set(Math.max(ambient.r, 0.08), Math.max(ambient.g, 0.08), Math.max(ambient.b, 0.08));
  return { ...light, ambient: [ambient.r, ambient.g, ambient.b] as const };
}

type WaterRemovalCandidate = ReturnType<typeof sceneWaterRemovals>[number] & {
  position: Vector3;
  radius: number;
  inverse?: Matrix;
};
type WaterBindingData = {
  frame: number;
  render: number;
  lighting: ReturnType<typeof sceneWaterLighting>;
  removals: WaterRemovalCandidate[];
};
const waterBindings = new WeakMap<Scene, WaterBindingData>();

/** Lazy so animations and before-render updates settle before the first water draw. */
function sceneWaterBindingData(scene: Scene): WaterBindingData {
  const previous = waterBindings.get(scene);
  const frame = scene.getFrameId(), render = scene.getRenderId();
  if (previous?.frame === frame && previous.render === render) return previous;
  const data = {
    frame, render, lighting: sceneWaterLighting(scene),
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
  constructor(material: PBRMaterial, water: WaterDefinition, body: WaterBodyProperties) {
    super(material, "SlateWater", 180, {
      SLATE_WATER: true, [WATER_STYLIZED_DEFINE]: false, [WATER_OCEAN_DEFINE]: false, [WATER_GPU_WAVES_DEFINE]: false, [Q]: DEFAULT_TIER,
      ...Object.fromEntries(FEATURES.map(([, define]) => [define, false])),
      [REFRACTION]: false, [SSR]: false, [SSR_STEPS]: 0, [PLANAR]: false,
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
   * Refraction, the screen-space march and the planar reflection this asset runs at the device-effective quality:
   * Refraction above 0 with Water Refraction on; Object Reflections under Screen Space reflections or Planar's Screen
   * Space fallback; Object Reflections at Planar on a flat body. Recompiles only when one of them changes.
   */
  private syncObjectFeatures(): void {
    const clamp = this.clamp;
    if (!clamp) return;
    const q = clamp.quality, w = this.water;
    const refracts = q.refraction && w.refraction > 0;
    const marches = w.objectReflections && (q.reflections === "screenSpace" || (q.reflections === "planar" && clamp.screenSpaceFallback));
    const mirrors = w.objectReflections && q.reflections === "planar" && this._flat;
    const steps = marches ? Math.round(q.reflectionSteps) : 0;
    if (refracts === this.refracts && marches === this.marches && mirrors === this.mirrors && steps === this.marchSteps) return;
    this.refracts = refracts; this.marches = marches; this.mirrors = mirrors; this.marchSteps = steps;
    this.markDefinesDirty();
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
   * changes for the pass, so no later dirtying is needed.
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
      // (1 / output width, 1 / output height, Refraction, march distance) and (planar on, display-encoded,
      // distortion, 0): per draw, from the pass's scene copy and the view's planar reflection.
      "slateWaterScreen", "slateWaterPlanar",
      ...SWELL_DIRECTION, ...SWELL_AMPLITUDE, ...CHOP_UNIFORMS, ...CAPILLARY_UNIFORMS,
    ];
    const removals = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => i);
    return { ubo: [
      ...[...vectors, ...removals.map((i) => `slateWaterRemovalShape${i}`)].map((name) => ({ name, size: 4, type: "vec4" })),
      ...removals.map((i) => ({ name: `slateWaterRemoval${i}`, size: 16, type: "mat4" })),
      { name: "slateWaterPlanarMatrix", size: 16, type: "mat4" },
    ] };
  }
  // Unused names are dropped by Babylon: the copy and planar samplers bind only in variants that declare them.
  override getSamplers(samplers: string[]): void { samplers.push("slateWaterFieldSampler", "slateWaterContactSampler", WATER_SCENE_SAMPLER, WATER_PLANAR_SAMPLER); }
  override bindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    buffer.setTexture("slateWaterFieldSampler", this.field?.texture ?? placeholderField(scene));
    buffer.setTexture("slateWaterContactSampler", this.contacts?.texture ?? placeholderField(scene));
    // The variant drawn in this pass declares the copy and planar samplers only with their features; a placeholder
    // (Babylon's empty texture) keeps a declared binding valid in a frame without its source.
    const defines = subMesh?.materialDefines as MaterialDefines | null | undefined;
    if (defines?.[REFRACTION] || defines?.[SSR]) buffer.setTexture(WATER_SCENE_SAMPLER, this.boundCopy?.texture ?? EMPTY_TEXTURE);
    if (defines?.[PLANAR]) buffer.setTexture(WATER_PLANAR_SAMPLER, this.boundPlanar?.texture ?? EMPTY_TEXTURE);
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
      buffer.updateFloat4("slateWaterPlanar", mine ? 1 : 0, mine?.gammaSpace ? 1 : 0, PLANAR_DISTORTION, 0);
      if (mine) buffer.updateMatrix("slateWaterPlanarMatrix", mine.viewProjection);
    }
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    this.bindObjectFeatures(buffer, scene, subMesh);
    const w = this.water, b = this.body;
    const material = this._material as PBRMaterial;
    const data = sceneWaterBindingData(scene);
    const light = withWaterEnvironment(data.lighting, w.reflectionStrength, material.reflectionTexture !== null || scene.environmentTexture !== null);
    buffer.updateFloat4("slateWaterShallow", ...linear(w.shallowColor), w.opacity);
    buffer.updateFloat4("slateWaterDeep", ...linear(w.deepColor), w.reflectionStrength);
    buffer.updateFloat4("slateWaterFoam", ...linear(w.foamColor), w.foamAmount);
    buffer.updateFloat4("slateWaterMotion", this.time, w.rippleScale, w.rippleStrength, w.foamWidth);
    buffer.updateFloat4("slateWaterLook", w.colorBands, w.depthColorDistance, w.sparkles, w.subsurface);
    buffer.updateFloat4("slateWaterWaves", w.waveHeight * b.waveScale, w.waveLength, w.waveSpeed, w.waveDirection * Math.PI / 180);
    buffer.updateFloat4("slateWaterSun", ...light.sun);
    buffer.updateFloat4("slateWaterSunColor", ...light.sunColor, w.surfaceFoam);
    buffer.updateFloat4("slateWaterLight", ...light.ambient, 0);
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
  private bankFade(): number { return this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, this.body.waveScale); }
  /** Defines another pass's program needs for `waterOutlineVertexSource` to match this material's vertex shader. */
  vertexWaveDefines(): readonly string[] {
    return waterWaveSet(this.water).count > waterWaveComponents.length ? OCEAN_VERTEX_WAVE_DEFINES : CLASSIC_VERTEX_WAVE_DEFINES;
  }
  /** Sets `WATER_VERTEX_WAVE_UNIFORMS` on another pass's effect for this frame, as `hardBindForSubMesh` does. */
  bindVertexWaves(effect: Effect, scene: Scene): void {
    const swell = this.swellConstants(scene);
    for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
      const o = i * WATER_WAVE_SHADER_STRIDE;
      effect.setFloat4(SWELL_DIRECTION[i]!, swell[o]!, swell[o + 1]!, swell[o + 2]!, swell[o + 3]!);
      effect.setFloat4(SWELL_AMPLITUDE[i]!, swell[o + 4]!, swell[o + 5]!, swell[o + 6]!, swell[o + 7]!);
    }
    effect.setFloat4("slateWaterSwellInfo", this.bankFade(), 0, 0, 0);
    effect.setFloat4("slateWaterShape", this.water.choppiness, 0, 0, 0);
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
          : "attribute vec4 slateWaterData;\nattribute vec3 slateWaterFlow;\nattribute vec3 slateWaterBaseNormal;\nattribute vec2 slateWaterOffset;\n") + varyings,
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
      // Foam and the mesh edge hide the mirror; without an environment, the scene light estimate stands in for the sky.
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
        `finalEmissive += mix(swAmb * 0.35, swObjRefl.rgb * ${wgsl ? "uniforms." : ""}slateWaterDeep.w, swObjRefl.a) * (swFres * swGloss);`,
        "#else",
        "finalEmissive += swAmb * (swFres * swGloss * 0.35);",
        "#endif",
        "#endif",
        "#ifdef SPECULARTERM",
        "finalSpecularScaled *= swGloss;",
        "#endif",
        "#endif",
      ].join("\n"),
      // Realistic colour is premultiplied by coverage: undo it for Babylon's non-premultiplied blend, fog and image
      // processing. Bright glints and reflections raise coverage instead of clipping in 8-bit targets.
      CUSTOM_FRAGMENT_BEFORE_FOG: [
        `#ifndef ${WATER_STYLIZED_DEFINE}`,
        `${wgsl ? "var swCover: f32 =" : "float swCover ="} clamp(max(finalColor.a, max(finalColor.r, max(finalColor.g, finalColor.b))), 0.02, 1.0);`,
        `finalColor = ${wgsl ? "vec4f" : "vec4"}(finalColor.rgb / swCover, swCover);`,
        "#endif",
      ].join("\n"),
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
  material.roughness = water.roughness;
  material.indexOfRefraction = 1.333;
  material.environmentIntensity = water.reflectionStrength;
  // Realistic water widens its GGX lobe by the slope variance its filtered waves lose; Babylon's derivative-based
  // specular antialiasing would widen it again and dim the sun glitter to nothing.
  material.enableSpecularAntiAliasing = false;
  // The shader derives per-pixel transmittance from depth; blending must stay on even at full Opacity.
  material.alpha = 1;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  material.backFaceCulling = false;
  material.needDepthPrePass = true;
}
