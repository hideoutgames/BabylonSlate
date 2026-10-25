/**
 * GLSL-shaped source chunks of built-in water's fragment and vertex shading: helpers, refraction, object reflections
 * (screen-space march, planar), the spectrum's surface and its removal cut. `water-shader-source.ts` assembles them.
 */
import { WATER_FFT_CASCADES_MAX, WATER_FOAM_WEIGHTS } from "@haptic/core";
import { WATER_FFT_CASCADE_TURNS } from "./water-fft-spectrum";
import { WATER_FIELD_SHORE_RANGE as SHORE, WATER_FIELD_TERRAIN_ALPHA } from "./water-field";
import { WATER_SCENE_COPY_SKY_DEPTH } from "./water-scene-copy";
import {
  BLEND_COLOR_UNIFORMS, BLEND_PARTNERS, COLOR_LOCALS, COLOR_UNIFORMS, EDGE_FOAM_CALM, f, FFT, FFT_CASCADE_UNIFORMS, fromTier, ifDefined, OPEN_EDGE_FADE,
  OPEN_EDGE_FADE_TERRAIN, PIXEL_SLOPE_CAP, PIXEL_SLOPE_FILTER, PLANAR, REFLECTS_OBJECTS, REFRACTION, REFRACTION_DEPTH_CAP, REFRACTION_FAR, REFRACTION_SHIFT,
  REFRACTION_SHIFT_PX, SAMPLES_COPY, SOFT_SHORE_DEPTH, SPECTRUM_FOAM_SCALE, SSR, SSR_REFINE_STEPS, SSR_STEPS, SSR_THICKNESS, TURBIDITY, WATER_BLEND_DEFINE,
  WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER, WATER_PLANAR_SAMPLER, WATER_SCENE_SAMPLER,
} from "./water-shader-defines";

/** GLSL-shaped source that also compiles as WGSL after `toWgsl`; see `waterShaderSource`. */
export const HELPERS = `
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
export function objectHelpers(wgsl: boolean): string {
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
export const ifFft = (code: string, cascades: number) => `\n#if ${FFT} >= ${cascades}${code}\n#endif`;

/**
 * The spectrum's samplers and taps, per language, for either stage: `swFftTapLod` at an explicit level (legal in any
 * control flow and in the vertex stage), and in the fragment `swSpecTap` and `swFoamTap` with implicit derivatives
 * (mipmapped). Both stages declare the same binding (one WebGL2 texture unit, one WebGPU binding visible to both). GLSL
 * ES has no default precision for array samplers.
 */
export function fftHelpers(wgsl: boolean, declare = true): string {
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
export function fftTurnIn(c: number, v: string): string {
  const [cos, sin] = fftTurn(c);
  return c === 0 ? v : `vec2(dot(${v}, vec2(${f(cos)}, ${f(sin)})), dot(${v}, vec2(${f(-sin)}, ${f(cos)})))`;
}
/** A vector of cascade `c`'s turned frame back in world X/Z, R(θ)·v. */
export function fftTurnOut(c: number, v: string): string {
  const [cos, sin] = fftTurn(c);
  return c === 0 ? v : `vec2(dot(${v}, vec2(${f(cos)}, ${f(-sin)})), dot(${v}, vec2(${f(sin)}, ${f(cos)})))`;
}
/** A symmetric ∂D tensor (xx, xz, zz) of cascade `c`'s turned frame back in world X/Z, R(θ)·J·R(θ)ᵀ. */
export function fftTurnTensor(c: number, j: string): string {
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
export function spectrumHelpers(wgsl: boolean, declare = true): string {
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
export function subsurfaceSource(sun: string, view: string, normal: string, crest: string, strength: string, ready: string, out: string): string {
  return `
vec3 ${out}V = ${view};
float ${out}H = clamp(dot(${out}V, normalize(${normal} + ${sun})), 0.0, 1.0);
float ${out}Back = clamp(0.5 - 0.5 * dot(${out}V, ${sun}), 0.0, 1.0);
float ${out} = ${out}H * ${out}H * ${out}H * ${out}H * ${out}H * 4.5 * ${out}Back * ${out}Back * ${strength}
  * max(${crest} + 0.261, 0.0) / 4.7 * clamp(${ready}, 0.0, 1.0);`;
}

/** FFT-Ocean's distance LOD: cascade c > 0 fades by `SPECTRUM_LOD_SCALE` · its patch over the eye distance. */
export const SPECTRUM_LOD_SCALE = 7.13;
/**
 * Steepest shading slope (about 56°): a sea far too tall for its Wave Length would otherwise turn every normal toward
 * the horizon and mirror only the sky. Real seas stay well below it (an RMS slope near 0.25).
 */
export const SHADING_SLOPE_CAP = 1.5;
/** Eye distances, in first-cascade patches, over which whitecaps fade out before their repeat would show. */
export const FOAM_FAR_PATCHES = [6, 16] as const;

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
export function spectrumVertexSource(distance: string, normal: boolean): string {
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
export function spectrumNormalSource(): string {
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
export function spectrumRealisticSource(): string {
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

export const REMOVAL_HELPER = `
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
export function cutSource(wgsl: boolean): string {
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
