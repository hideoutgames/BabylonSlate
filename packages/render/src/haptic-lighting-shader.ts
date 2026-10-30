import { HAPTIC_LIGHT_MAXIMUM, HAPTIC_SHADOW_VIEW_VEC4S } from "./haptic-lights";

/**
 * The lighting function of `HapticLightingBlock`, in GLSL and WGSL twins that change together: a metallic-roughness
 * surface lit by the `HapticLights` block
 * and the Scene's environment cube. GGX distribution, height-correlated Smith visibility and Schlick Fresnel for
 * specular, Lambert for diffuse, linearly transformed cosines for rect area lights (with the standard LTC Fresnel,
 * as Babylon's OpenPBR material uses), the split-sum environment BRDF table with multi-scatter energy compensation, and
 * irradiance from the cube's spherical harmonics. Point and spot lights fall off with the inverse square of their
 * distance, windowed to reach zero at their range. Under `HAPTIC_CEL` the same lights and falloffs feed CEL's ramp
 * instead (`cel-shader.ts`).
 */

/** Pre-scaled spherical harmonics of the environment's irradiance (Babylon's PBR evaluation), one uniform each. */
export const HAPTIC_IRRADIANCE_KEYS = ["l00", "l1_1", "l10", "l11", "l2_2", "l2_1", "l20", "l21", "l22"] as const;
export const HAPTIC_IRRADIANCE_UNIFORMS = HAPTIC_IRRADIANCE_KEYS.map((key) => `hapticIrradiance_${key}`);
/** The shadow atlas's compare sampler, which the block's shadows read (`shadowAtlasTexture`). */
export const HAPTIC_SHADOW_ATLAS = "hapticShadowAtlas";
/**
 * WebGL2: the shadow atlas read plainly, beside its compare sampler, for Contact Hardening's blocker search: the same
 * depth texture on another unit with a sampler object without compare (`plainDepthSampler`). WGSL loads the depth from
 * the compare binding's texture instead.
 */
export const HAPTIC_SHADOW_ATLAS_DEPTH = "hapticShadowAtlasDepth";

/** Babylon's Poisson discs for PCSS (its `PoissonSamplers32` and `PoissonSamplers64`), as x, y pairs. */
const POISSON_32 = [
  0.06407013, 0.05409927, 0.7366577, 0.5789394, -0.6270542, -0.5320278, -0.4096107, 0.8411095,
  0.6849564, -0.4990818, -0.874181, -0.04579735, 0.9989998, 0.0009880066, -0.004920578, -0.9151649,
  0.1805763, 0.9747483, -0.2138451, 0.2635818, 0.109845, 0.3884785, 0.06876755, -0.3581074,
  0.374073, -0.7661266, 0.3079132, -0.1216763, -0.3794335, -0.8271583, -0.203878, -0.07715034,
  0.5912697, 0.1469799, -0.88069, 0.3031784, 0.5040108, 0.8283722, -0.5844124, 0.5494877,
  0.6017799, -0.1726654, -0.5554981, 0.1559997, -0.3016369, -0.3900928, -0.5550632, -0.1723762,
  0.925029, 0.2995041, -0.2473137, 0.5538505, 0.9183037, -0.2862392, 0.2469421, 0.6718712,
  0.3916397, -0.4328209, -0.03576927, -0.6220032, -0.04661255, 0.7995201, 0.4402924, 0.3640312,
];
const POISSON_64 = [
  -0.613392, 0.617481, 0.170019, -0.040254, -0.299417, 0.791925, 0.64568, 0.49321,
  -0.651784, 0.717887, 0.421003, 0.02707, -0.817194, -0.271096, -0.705374, -0.668203,
  0.97705, -0.108615, 0.063326, 0.142369, 0.203528, 0.214331, -0.667531, 0.32609,
  -0.098422, -0.295755, -0.885922, 0.215369, 0.566637, 0.605213, 0.039766, -0.3961,
  0.751946, 0.453352, 0.078707, -0.715323, -0.075838, -0.529344, 0.724479, -0.580798,
  0.222999, -0.215125, -0.467574, -0.405438, -0.248268, -0.814753, 0.354411, -0.88757,
  0.175817, 0.382366, 0.487472, -0.063082, -0.084078, 0.898312, 0.488876, -0.783441,
  0.470016, 0.217933, -0.69689, -0.549791, -0.149693, 0.605762, 0.034211, 0.97998,
  0.503098, -0.308878, -0.016205, -0.872921, 0.385784, -0.393902, -0.146886, -0.859249,
  0.643361, 0.164098, 0.634388, -0.049471, -0.688894, 0.007843, 0.464034, -0.188818,
  -0.44084, 0.137486, 0.364483, 0.511704, 0.034028, 0.325968, 0.099094, -0.308023,
  0.69396, -0.366253, 0.678884, -0.204688, 0.001801, 0.780328, 0.145177, -0.898984,
  0.062655, -0.611866, 0.315226, -0.604297, -0.780145, 0.486251, -0.371868, 0.882138,
  0.200476, 0.49443, -0.494552, -0.711051, 0.612476, 0.705252, -0.578845, -0.768792,
  -0.772454, -0.090976, 0.50444, 0.372295, 0.155736, 0.065157, 0.391522, 0.849605,
  -0.620106, -0.328104, 0.789239, -0.419965, -0.545396, 0.538133, -0.178564, -0.596057,
];

function poissonGlsl(name: string, disc: readonly number[]): string {
  const points = Array.from({ length: disc.length / 2 }, (_, index) => `vec2(${disc[index * 2]}, ${disc[index * 2 + 1]})`);
  return `const vec2 ${name}[${points.length}] = vec2[${points.length}](${points.join(", ")});\n`;
}

function poissonWgsl(name: string, disc: readonly number[]): string {
  const points = Array.from({ length: disc.length / 2 }, (_, index) => `vec2f(${disc[index * 2]}, ${disc[index * 2 + 1]})`);
  return `const ${name} = array<vec2f, ${points.length}>(${points.join(", ")});\n`;
}

/**
 * The light block's shadows, read from its views (\`hapticShadowViews\`) and the atlas: a view's (\`hapticShadow\`), a
 * point light's (\`hapticPointShadow\`) and the sun's cascades (\`hapticSunShadowFactor\`). \`surface\`: a mesh's, filtered
 * at the view's quality with receiver-plane bias and honouring Receive Shadows (\`hapticShadowReceiver\`); else a
 * position on no surface (the volumetric march's), one bilinear compare tap, as the march takes on Babylon's maps.
 */
export function hapticShadowGlsl(surface: boolean): string {
  return `// A light's shadow from its view of the atlas (\`hapticShadowViews\`): 1 where lit, the view's darkness where shadowed; 1
// without a view (index < 0), outside its frustum and on a mesh that does not receive shadows. Babylon's PCF at the
// view's filter quality (0 low, 1 medium, 2 high: its computeShadowWithPCF1, 3 and 5): one, four or nine weighted
// bilinear compare taps, each kept a texel inside the view's tile so a neighbouring tile never bleeds in. A sun cascade
// with automatic bias compares each tap against the receiver's plane, from the position's change across the pixel
// (\`dPdx\`, \`dPdy\`, taken where control flow is uniform); low quality then compares four texel centres, as one
// bilinear comparison takes one depth.
float hapticShadowTap(vec4 tile, vec2 texel, float depth) {
  return textureLod(hapticShadowAtlas, vec3(clamp(tile.xy + texel * tile.w, tile.xy + tile.w, tile.xy + tile.z - tile.w), depth), 0.0);
}

${surface ? `// The receiver plane's depth change per texel of a \`size\`-texel tile of the orthographic \`view\`, or none where a
// singular or grazing projection cannot tell it.
vec2 hapticReceiverGradient(mat4 view, vec3 dPdx, vec3 dPdy, float size) {
  vec3 dx = (view * vec4(dPdx, 0.0)).xyz * 0.5;
  vec3 dy = (view * vec4(dPdy, 0.0)).xyz * 0.5;
  float scale = max(max(abs(dx.x), abs(dx.y)), max(abs(dy.x), abs(dy.y)));
  if (scale <= 1e-20 || scale >= 1e20) return vec2(0.0);
  dx /= scale;
  dy /= scale;
  float det = dx.x * dy.y - dx.y * dy.x;
  if (abs(det) <= 1e-4 || abs(det) >= 4.0) return vec2(0.0);
  vec2 gradient = vec2(dx.z * dy.y - dy.z * dx.y, dy.z * dx.x - dx.z * dy.x) / det / size;
  return all(lessThan(abs(gradient), vec2(1e10))) ? gradient : vec2(0.0);
}

// A bilinear tap at \`tap\` texels compared at the receiver plane's depth there (\`gradient\` per texel from \`origin\`),
// lowered by the plane's rise across the tap's footprint.
float hapticPlaneTap(vec4 tile, vec2 tap, vec2 origin, float depth, vec2 gradient, float maximum) {
  vec2 phase = fract(tap - 0.5);
  float bound = dot(max(gradient, 0.0), phase) + dot(max(-gradient, 0.0), 1.0 - phase);
  return hapticShadowTap(tile, tap, clamp(depth + dot(gradient, tap - origin) - bound, 0.0, maximum));
}

// Contact Hardening (Babylon's computeShadowWithPCSS and computeShadowWithCSMPCSS) on a view's tile: the depth around the
// position, over the light's size (\`contact.w\`, a share of the tile, a cascade's corrected toward the first's by
// \`contact.xy\`), is searched for blockers, then compare taps spread over a radius that grows with the blockers' distance
// from the receiver, on Babylon's Poisson discs turned per position, each a bilinear comparison as Babylon's depth texture
// takes. A perspective view compares Babylon's depth metric over its planes (\`contact.xy\`), a cascade its depth scaled
// by its depth correction (\`contact.z\`). Low, medium and high quality take 16, 16 and 32 search taps and 16, 32 and 64
// compare taps; 1 without a blocker. With receiver-plane bias (\`gradient\`, a cascade's under automatic bias) each read
// and tap compares against the receiver's plane there, as the view's PCF does, where Babylon's PCSS compares against the
// receiver's own depth: a flat receiver does not shadow itself. Without it, the blockers' mean distance is Babylon's.
${poissonGlsl("hapticPoisson32", POISSON_32)}${poissonGlsl("hapticPoisson64", POISSON_64)}
// The atlas's depth at a texel of the tile, read without compare (\`hapticShadowAtlasDepth\`).
float hapticShadowDepth(vec4 tile, vec2 texel, float size) {
  return texelFetch(hapticShadowAtlasDepth, ivec2(tile.xy / tile.w + clamp(floor(texel), vec2(0.0), vec2(size - 1.0)) + 0.5), 0).r;
}

// Babylon's depth metric, (clip z + near) / (near + far), of a perspective view with planes \`range\` at an NDC depth,
// through Babylon's projection (GL's depth range).
float hapticDepthMetric(vec2 range, float ndc) {
  float z = 2.0 * range.x * range.y / (range.x + range.y - (range.y - range.x) * ndc);
  return (ndc * z + range.x) / (range.x + range.y);
}

float hapticContactLit(vec4 tile, vec4 shading, vec4 contact, vec4 clip, float depth, vec2 texels, float size, vec2 gradient, float maximum) {
  bool cascade = shading.z > 0.5;
  int quality = int(shading.y - 2.5);
  int searches = quality == 2 ? 32 : 16;
  int taps = quality == 0 ? 16 : quality == 1 ? 32 : 64;
  vec2 correction = cascade ? contact.xy : vec2(1.0);
  float receiver = cascade ? depth : (clip.z + contact.x) / (contact.x + contact.y);
  vec2 search = contact.w * size * correction;
  float blockers = 0.0;
  float sum = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= searches) break;
    vec2 tap = texels + search * hapticPoisson32[i];
    float stored = hapticShadowDepth(tile, tap, size);
    float blocker = cascade ? stored : hapticDepthMetric(contact.xy, stored * 2.0 - 1.0);
    float surface = receiver + dot(gradient, clamp(floor(tap), vec2(0.0), vec2(size - 1.0)) + 0.5 - texels);
    if (blocker < surface) {
      sum += surface - blocker;
      blockers += 1.0;
    }
  }
  if (blockers < 1.0) return 1.0;
  float distance = sum / blockers * (cascade ? contact.z : 1.0);
  vec2 radius = (distance + 10.0 / size) * contact.w * size * correction;
  float angle = fract(sin(dot(clip.xy, vec2(12.9898, 78.233))) * 43758.5453) * 3.1415926;
  vec2 turn = vec2(cos(angle), sin(angle));
  float lit = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= taps) break;
    vec2 offset = quality == 2 ? hapticPoisson64[i] : hapticPoisson32[min(i, 31)];
    offset = vec2(offset.x * turn.x - offset.y * turn.y, offset.y * turn.x + offset.x * turn.y);
    lit += hapticPlaneTap(tile, texels + offset * radius, texels, depth, gradient, maximum);
  }
  return mix(lit / float(taps), 1.0, min(distance, 1.0));
}

` : ""}float hapticShadow(float index, vec3 P, vec3 dPdx, vec3 dPdy) {
  if (index < 0.0${surface ? " || hapticShadowReceiver == 0.0" : ""}) return 1.0;
  int base = int(index) * ${HAPTIC_SHADOW_VIEW_VEC4S};
  mat4 view = mat4(hapticShadowViews[base], hapticShadowViews[base + 1], hapticShadowViews[base + 2], hapticShadowViews[base + 3]);
  vec4 clip = view * vec4(P, 1.0);
  if (clip.w <= 0.0) return 1.0;
  vec3 ndc = clip.xyz / clip.w;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float depth = ndc.z * 0.5 + 0.5;
  vec4 tile = hapticShadowViews[base + 4];
  vec4 shading = hapticShadowViews[base + 5];
  // A cascade clamps its depth, as Babylon's cascaded PCF does.
  float maximum = shading.z > 0.5 ? 0.99999994 : 1.0;
  depth = shading.z > 0.5 ? clamp(depth, 0.0, maximum) : depth;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth < 0.0 || depth > 1.0) return 1.0;
  float size = tile.z / tile.w;
  vec2 texels = uv * size;
${surface ? `  vec2 gradient = shading.w > 0.5 ? hapticReceiverGradient(view, dPdx, dPdy, size) : vec2(0.0);
#ifndef HAPTIC_CEL
  if (shading.y > 2.5) return mix(shading.x, 1.0, hapticContactLit(tile, shading, hapticShadowViews[base + 6], clip, depth, texels, size, gradient, maximum));
#endif
  // CEL draws Contact Hardening as PCF.
  float quality = shading.y > 2.5 ? shading.y - 3.0 : shading.y;
  float lit;
  if (quality < 0.5) {
    if (gradient == vec2(0.0)) return mix(shading.x, 1.0, hapticShadowTap(tile, texels, depth));
    vec2 st = fract(texels - 0.5);
    vec2 a = clamp(floor(texels - 0.5), vec2(0.0), vec2(size - 1.0)) + 0.5;
    vec2 b = clamp(floor(texels - 0.5) + 1.0, vec2(0.0), vec2(size - 1.0)) + 0.5;
    lit = (1.0 - st.x) * (1.0 - st.y) * hapticShadowTap(tile, a, clamp(depth + dot(gradient, a - texels), 0.0, maximum))
      + st.x * (1.0 - st.y) * hapticShadowTap(tile, vec2(b.x, a.y), clamp(depth + dot(gradient, vec2(b.x, a.y) - texels), 0.0, maximum))
      + (1.0 - st.x) * st.y * hapticShadowTap(tile, vec2(a.x, b.y), clamp(depth + dot(gradient, vec2(a.x, b.y) - texels), 0.0, maximum))
      + st.x * st.y * hapticShadowTap(tile, b, clamp(depth + dot(gradient, b - texels), 0.0, maximum));
    return mix(shading.x, 1.0, lit);
  }
  vec2 st = fract(texels + 0.5);
  vec2 corner = floor(texels + 0.5) - 0.5;
  if (quality < 1.5) {
    vec2 w0 = 3.0 - 2.0 * st;
    vec2 w1 = 1.0 + 2.0 * st;
    vec2 a = corner + (2.0 - st) / w0 - 1.0;
    vec2 b = corner + st / w1 + 1.0;
    lit = (w0.x * w0.y * hapticPlaneTap(tile, vec2(a.x, a.y), texels, depth, gradient, maximum)
      + w1.x * w0.y * hapticPlaneTap(tile, vec2(b.x, a.y), texels, depth, gradient, maximum)
      + w0.x * w1.y * hapticPlaneTap(tile, vec2(a.x, b.y), texels, depth, gradient, maximum)
      + w1.x * w1.y * hapticPlaneTap(tile, vec2(b.x, b.y), texels, depth, gradient, maximum)) / 16.0;
  } else {
    vec2 w0 = 4.0 - 3.0 * st;
    vec2 w2 = 1.0 + 3.0 * st;
    vec2 a = corner + (3.0 - 2.0 * st) / w0 - 2.0;
    vec2 b = corner + (3.0 + st) / 7.0;
    vec2 c = corner + st / w2 + 2.0;
    lit = (w0.x * w0.y * hapticPlaneTap(tile, vec2(a.x, a.y), texels, depth, gradient, maximum)
      + 7.0 * w0.y * hapticPlaneTap(tile, vec2(b.x, a.y), texels, depth, gradient, maximum)
      + w2.x * w0.y * hapticPlaneTap(tile, vec2(c.x, a.y), texels, depth, gradient, maximum)
      + w0.x * 7.0 * hapticPlaneTap(tile, vec2(a.x, b.y), texels, depth, gradient, maximum)
      + 49.0 * hapticPlaneTap(tile, vec2(b.x, b.y), texels, depth, gradient, maximum)
      + w2.x * 7.0 * hapticPlaneTap(tile, vec2(c.x, b.y), texels, depth, gradient, maximum)
      + w0.x * w2.y * hapticPlaneTap(tile, vec2(a.x, c.y), texels, depth, gradient, maximum)
      + 7.0 * w2.y * hapticPlaneTap(tile, vec2(b.x, c.y), texels, depth, gradient, maximum)
      + w2.x * w2.y * hapticPlaneTap(tile, vec2(c.x, c.y), texels, depth, gradient, maximum)) / 144.0;
  }
  return mix(shading.x, 1.0, lit);
` : "  return mix(shading.x, 1.0, hapticShadowTap(tile, texels, depth));\n"}}

// A point light's shadow (its record's \`shadow\`: first view, faces): the view of the cube face the position lies in,
// in Babylon's order (+X, -X, -Y, +Y, +Z, -Z); the one view of a point light with a direction.
float hapticPointShadow(vec4 shadow, vec3 fromLight, vec3 P) {
  if (shadow.x < 0.0) return 1.0;
  vec3 a = abs(fromLight);
  float face = shadow.y < 1.5 ? 0.0
    : a.x >= a.y && a.x >= a.z ? (fromLight.x > 0.0 ? 0.0 : 1.0)
    : a.y >= a.z ? (fromLight.y < 0.0 ? 2.0 : 3.0)
    : (fromLight.z > 0.0 ? 4.0 : 5.0);
  return hapticShadow(shadow.x + face, P, vec3(0.0), vec3(0.0));
}

// The sun's shadow from its cascades (\`hapticSunShadow\`): Babylon's choice of the first cascade whose far end lies
// beyond the position's view depth, its blend into the next over the last part of its length, and the fade to unshadowed
// over the last part of the shadow distance; 1 beyond the last cascade.
float hapticSunShadowFactor(vec3 P, vec3 dPdx, vec3 dPdy) {
  vec4 cascades = hapticSunShadow[0];
  int count = int(cascades.x);
  if (count == 0) return 1.0;
  float depth = dot(hapticSunShadow[1], vec4(P, 1.0));
  vec4 ends = hapticSunShadow[2];
  int index = -1;
  float ahead = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= count) break;
    ahead = ends[i] - depth;
    if (ahead >= 0.0) {
      index = i;
      break;
    }
  }
  if (index < 0) return 1.0;
  float shadow = hapticShadow(cascades.w + float(index), P, dPdx, dPdy);
  float blend = clamp(ahead / hapticSunShadow[3][index], 0.0, 1.0) * cascades.y;
  if (index < count - 1 && blend < 1.0) shadow = mix(hapticShadow(cascades.w + float(index + 1), P, dPdx, dPdy), shadow, blend);
  float end = ends[count - 1];
  if (cascades.z > 0.0) shadow = mix(shadow, 1.0, smoothstep(end * (1.0 - cascades.z), end, abs(depth)));
  return shadow;
}

`;
}

/** \`hapticShadowGlsl\`'s WGSL twin. */
export function hapticShadowWgsl(surface: boolean): string {
  return `fn hapticShadowTap(tile: vec4f, texel: vec2f, depth: f32) -> f32 {
  return textureSampleCompareLevel(hapticShadowAtlas, hapticShadowAtlasSampler,
    clamp(tile.xy + texel * tile.w, tile.xy + vec2f(tile.w), tile.xy + vec2f(tile.z - tile.w)), depth);
}

${surface ? `fn hapticReceiverGradient(view: mat4x4f, dPdx: vec3f, dPdy: vec3f, size: f32) -> vec2f {
  // WebGPU's depth range is zero to one: only the texture coordinates halve.
  var dx = (view * vec4f(dPdx, 0.0)).xyz * vec3f(0.5, 0.5, 1.0);
  var dy = (view * vec4f(dPdy, 0.0)).xyz * vec3f(0.5, 0.5, 1.0);
  let scale = max(max(abs(dx.x), abs(dx.y)), max(abs(dy.x), abs(dy.y)));
  if (scale <= 1e-20 || scale >= 1e20) { return vec2f(0.0); }
  dx /= scale;
  dy /= scale;
  let det = dx.x * dy.y - dx.y * dy.x;
  if (abs(det) <= 1e-4 || abs(det) >= 4.0) { return vec2f(0.0); }
  let gradient = vec2f(dx.z * dy.y - dy.z * dx.y, dy.z * dx.x - dx.z * dy.x) / det / size;
  return select(vec2f(0.0), gradient, all(abs(gradient) < vec2f(1e10)));
}

fn hapticPlaneTap(tile: vec4f, tap: vec2f, origin: vec2f, depth: f32, gradient: vec2f, maximum: f32) -> f32 {
  let phase = fract(tap - 0.5);
  let bound = dot(max(gradient, vec2f(0.0)), phase) + dot(max(-gradient, vec2f(0.0)), vec2f(1.0) - phase);
  return hapticShadowTap(tile, tap, clamp(depth + dot(gradient, tap - origin) - bound, 0.0, maximum));
}

${poissonWgsl("hapticPoisson32", POISSON_32)}${poissonWgsl("hapticPoisson64", POISSON_64)}
fn hapticShadowDepth(tile: vec4f, texel: vec2f, size: f32) -> f32 {
  return textureLoad(hapticShadowAtlas, vec2i(tile.xy / tile.w + clamp(floor(texel), vec2f(0.0), vec2f(size - 1.0)) + 0.5), 0);
}

fn hapticDepthMetric(range: vec2f, ndc: f32) -> f32 {
  // WebGPU's depth range is zero to one.
  let z = range.x * range.y / (range.y - (range.y - range.x) * ndc);
  return (ndc * z + range.x) / (range.x + range.y);
}

fn hapticContactLit(tile: vec4f, shading: vec4f, contact: vec4f, clip: vec4f, depth: f32, texels: vec2f, size: f32, gradient: vec2f,
    maximum: f32) -> f32 {
  let cascade = shading.z > 0.5;
  let quality = i32(shading.y - 2.5);
  let searches = select(16, 32, quality == 2);
  let taps = select(select(64, 32, quality == 1), 16, quality == 0);
  let correction = select(vec2f(1.0), contact.xy, cascade);
  let receiver = select((clip.z + contact.x) / (contact.x + contact.y), depth, cascade);
  let search = contact.w * size * correction;
  var blockers = 0.0;
  var sum = 0.0;
  for (var i: i32 = 0; i < 32; i++) {
    if (i >= searches) { break; }
    let tap = texels + search * hapticPoisson32[i];
    let stored = hapticShadowDepth(tile, tap, size);
    let blocker = select(hapticDepthMetric(contact.xy, stored), stored, cascade);
    let surface = receiver + dot(gradient, clamp(floor(tap), vec2f(0.0), vec2f(size - 1.0)) + 0.5 - texels);
    if (blocker < surface) {
      sum += surface - blocker;
      blockers += 1.0;
    }
  }
  if (blockers < 1.0) { return 1.0; }
  let distance = sum / blockers * select(1.0, contact.z, cascade);
  let radius = (distance + 10.0 / size) * contact.w * size * correction;
  let angle = fract(sin(dot(clip.xy, vec2f(12.9898, 78.233))) * 43758.5453) * 3.1415926;
  let turn = vec2f(cos(angle), sin(angle));
  var lit = 0.0;
  for (var i: i32 = 0; i < 64; i++) {
    if (i >= taps) { break; }
    var offset: vec2f;
    if (quality == 2) { offset = hapticPoisson64[i]; } else { offset = hapticPoisson32[min(i, 31)]; }
    offset = vec2f(offset.x * turn.x - offset.y * turn.y, offset.y * turn.x + offset.x * turn.y);
    lit += hapticPlaneTap(tile, texels + offset * radius, texels, depth, gradient, maximum);
  }
  return mix(lit / f32(taps), 1.0, min(distance, 1.0));
}

` : ""}fn hapticShadow(index: f32, P: vec3f, dPdx: vec3f, dPdy: vec3f) -> f32 {
  if (index < 0.0${surface ? " || uniforms.hapticShadowReceiver == 0.0" : ""}) { return 1.0; }
  let base = i32(index) * ${HAPTIC_SHADOW_VIEW_VEC4S};
  let view = mat4x4f(HapticLights.hapticShadowViews[base], HapticLights.hapticShadowViews[base + 1], HapticLights.hapticShadowViews[base + 2],
    HapticLights.hapticShadowViews[base + 3]);
  let clip = view * vec4f(P, 1.0);
  if (clip.w <= 0.0) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * 0.5 + 0.5;
  let tile = HapticLights.hapticShadowViews[base + 4];
  let shading = HapticLights.hapticShadowViews[base + 5];
  let maximum = select(1.0, 0.99999994, shading.z > 0.5);
  // WebGPU's depth range is zero to one.
  let depth = select(ndc.z, clamp(ndc.z, 0.0, maximum), shading.z > 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth < 0.0 || depth > 1.0) { return 1.0; }
  let size = tile.z / tile.w;
  let texels = uv * size;
${surface ? `  var gradient = vec2f(0.0);
  if (shading.w > 0.5) { gradient = hapticReceiverGradient(view, dPdx, dPdy, size); }
#ifndef HAPTIC_CEL
  if (shading.y > 2.5) {
    return mix(shading.x, 1.0, hapticContactLit(tile, shading, HapticLights.hapticShadowViews[base + 6], clip, depth, texels, size,
      gradient, maximum));
  }
#endif
  // CEL draws Contact Hardening as PCF.
  let quality = select(shading.y, shading.y - 3.0, shading.y > 2.5);
  var lit: f32;
  if (quality < 0.5) {
    if (all(gradient == vec2f(0.0))) { return mix(shading.x, 1.0, hapticShadowTap(tile, texels, depth)); }
    let st = fract(texels - 0.5);
    let a = clamp(floor(texels - 0.5), vec2f(0.0), vec2f(size - 1.0)) + 0.5;
    let b = clamp(floor(texels - 0.5) + 1.0, vec2f(0.0), vec2f(size - 1.0)) + 0.5;
    lit = (1.0 - st.x) * (1.0 - st.y) * hapticShadowTap(tile, a, clamp(depth + dot(gradient, a - texels), 0.0, maximum))
      + st.x * (1.0 - st.y) * hapticShadowTap(tile, vec2f(b.x, a.y), clamp(depth + dot(gradient, vec2f(b.x, a.y) - texels), 0.0, maximum))
      + (1.0 - st.x) * st.y * hapticShadowTap(tile, vec2f(a.x, b.y), clamp(depth + dot(gradient, vec2f(a.x, b.y) - texels), 0.0, maximum))
      + st.x * st.y * hapticShadowTap(tile, b, clamp(depth + dot(gradient, b - texels), 0.0, maximum));
    return mix(shading.x, 1.0, lit);
  }
  let st = fract(texels + 0.5);
  let corner = floor(texels + 0.5) - 0.5;
  if (quality < 1.5) {
    let w0 = 3.0 - 2.0 * st;
    let w1 = 1.0 + 2.0 * st;
    let a = corner + (2.0 - st) / w0 - 1.0;
    let b = corner + st / w1 + 1.0;
    lit = (w0.x * w0.y * hapticPlaneTap(tile, vec2f(a.x, a.y), texels, depth, gradient, maximum)
      + w1.x * w0.y * hapticPlaneTap(tile, vec2f(b.x, a.y), texels, depth, gradient, maximum)
      + w0.x * w1.y * hapticPlaneTap(tile, vec2f(a.x, b.y), texels, depth, gradient, maximum)
      + w1.x * w1.y * hapticPlaneTap(tile, vec2f(b.x, b.y), texels, depth, gradient, maximum)) / 16.0;
  } else {
    let w0 = 4.0 - 3.0 * st;
    let w2 = 1.0 + 3.0 * st;
    let a = corner + (3.0 - 2.0 * st) / w0 - 2.0;
    let b = corner + (3.0 + st) / 7.0;
    let c = corner + st / w2 + 2.0;
    lit = (w0.x * w0.y * hapticPlaneTap(tile, vec2f(a.x, a.y), texels, depth, gradient, maximum)
      + 7.0 * w0.y * hapticPlaneTap(tile, vec2f(b.x, a.y), texels, depth, gradient, maximum)
      + w2.x * w0.y * hapticPlaneTap(tile, vec2f(c.x, a.y), texels, depth, gradient, maximum)
      + w0.x * 7.0 * hapticPlaneTap(tile, vec2f(a.x, b.y), texels, depth, gradient, maximum)
      + 49.0 * hapticPlaneTap(tile, vec2f(b.x, b.y), texels, depth, gradient, maximum)
      + w2.x * 7.0 * hapticPlaneTap(tile, vec2f(c.x, b.y), texels, depth, gradient, maximum)
      + w0.x * w2.y * hapticPlaneTap(tile, vec2f(a.x, c.y), texels, depth, gradient, maximum)
      + 7.0 * w2.y * hapticPlaneTap(tile, vec2f(b.x, c.y), texels, depth, gradient, maximum)
      + w2.x * w2.y * hapticPlaneTap(tile, vec2f(c.x, c.y), texels, depth, gradient, maximum)) / 144.0;
  }
  return mix(shading.x, 1.0, lit);
` : "  return mix(shading.x, 1.0, hapticShadowTap(tile, texels, depth));\n"}}

fn hapticPointShadow(shadow: vec4f, fromLight: vec3f, P: vec3f) -> f32 {
  if (shadow.x < 0.0) { return 1.0; }
  let a = abs(fromLight);
  var face = 0.0;
  if (shadow.y > 1.5) {
    if (a.x >= a.y && a.x >= a.z) { face = select(1.0, 0.0, fromLight.x > 0.0); }
    else if (a.y >= a.z) { face = select(3.0, 2.0, fromLight.y < 0.0); }
    else { face = select(5.0, 4.0, fromLight.z > 0.0); }
  }
  return hapticShadow(shadow.x + face, P, vec3f(0.0), vec3f(0.0));
}

fn hapticSunShadowFactor(P: vec3f, dPdx: vec3f, dPdy: vec3f) -> f32 {
  let cascades = HapticLights.hapticSunShadow[0];
  let count = i32(cascades.x);
  if (count == 0) { return 1.0; }
  let depth = dot(HapticLights.hapticSunShadow[1], vec4f(P, 1.0));
  let ends = HapticLights.hapticSunShadow[2];
  var index = -1;
  var ahead = 0.0;
  for (var i: i32 = 0; i < 4; i++) {
    if (i >= count) { break; }
    ahead = ends[i] - depth;
    if (ahead >= 0.0) {
      index = i;
      break;
    }
  }
  if (index < 0) { return 1.0; }
  var shadow = hapticShadow(cascades.w + f32(index), P, dPdx, dPdy);
  let blend = clamp(ahead / HapticLights.hapticSunShadow[3][index], 0.0, 1.0) * cascades.y;
  if (index < count - 1 && blend < 1.0) { shadow = mix(hapticShadow(cascades.w + f32(index + 1), P, dPdx, dPdy), shadow, blend); }
  let end = ends[count - 1];
  if (cascades.z > 0.0) { shadow = mix(shadow, 1.0, smoothstep(end * (1.0 - cascades.z), end, abs(depth))); }
  return shadow;
}

`;
}

export const HAPTIC_LIGHTING_FUNCTIONS_GLSL = `
#define HAPTIC_PI 3.1415926535897932
#define HAPTIC_EPSILON 0.0000001
#ifdef HAPTIC_LIGHT_LOOP_PROOF
// Point and spot lights the loops visited, and those in range (\`setHapticLightLoopProof\`).
int hapticLoopVisited = 0;
int hapticLoopReached = 0;
#endif
float hapticSaturateEps(float x) { return clamp(x, HAPTIC_EPSILON, 1.0); }
float hapticPow5(float x) { float x2 = x * x; return x2 * x2 * x; }
// GGX alpha from perceptual roughness, floored so a smooth surface keeps a highlight.
float hapticAlpha(float roughness) { return roughness * roughness + 0.0005; }
float hapticDistribution(float NdotH, float alpha) {
  float a2 = alpha * alpha;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (HAPTIC_PI * d * d);
}
float hapticVisibility(float NdotL, float NdotV, float alpha) {
  float a2 = alpha * alpha;
  float GGXV = NdotL * sqrt(NdotV * (NdotV - a2 * NdotV) + a2);
  float GGXL = NdotV * sqrt(NdotL * (NdotL - a2 * NdotL) + a2);
  return 0.5 / (GGXV + GGXL);
}
vec3 hapticToLinear(vec3 color) {
#ifdef HAPTIC_EXACT_SRGB
  return mix(pow(0.947867299 * (color + vec3(0.055)), vec3(2.4)), 0.0773993808 * color, vec3(lessThanEqual(color, vec3(0.04045))));
#else
  return pow(color, vec3(2.2));
#endif
}
vec3 hapticFromRGBD(vec4 rgbd) { return hapticToLinear(rgbd.rgb) / rgbd.a; }

struct hapticSurface { vec3 diffuse; vec3 F0; float roughness; float NdotV; };

// A light's specular reflection; NdotL may be wrapped (the fill's).
vec3 hapticSpecular(hapticSurface surface, vec3 N, vec3 V, vec3 L, float NdotL, float roughness) {
  vec3 H = normalize(V + L);
  float VdotH = clamp(dot(V, H), 0.0, 1.0);
  float NdotH = hapticSaturateEps(dot(N, H));
  float alpha = hapticAlpha(roughness);
  vec3 fresnel = surface.F0 + (vec3(1.0) - surface.F0) * hapticPow5(1.0 - VdotH);
  return fresnel * hapticDistribution(NdotH, alpha) * hapticVisibility(NdotL, surface.NdotV, alpha) * NdotL;
}

// Inverse-square falloff, windowed to zero at the light's range.
float hapticRangeFalloff(float distanceSquared, float range) {
  float ratio = distanceSquared / (range * range);
  float window = clamp(1.0 - ratio * ratio, 0.0, 1.0);
  return window * window / max(distanceSquared, HAPTIC_EPSILON);
}

// A spot light's cone, glTF's (KHR_lights_punctual): full inside the inner half angle, zero past the outer, squared
// linear in the cosine between.
float hapticConeFalloff(vec3 lightDirection, vec3 L, float cosOuter, float cosInner) {
  float scale = 1.0 / max(0.001, cosInner - cosOuter);
  float cone = clamp(dot(lightDirection, -L) * scale - cosOuter * scale, 0.0, 1.0);
  return cone * cone;
}

${hapticShadowGlsl(true)}// Rect area lights: linearly transformed cosines from Babylon's two 64x64 tables (its ltcHelperFunctions).
vec3 hapticLtcEdge(vec3 v1, vec3 v2) {
  float x = dot(v1, v2);
  float y = abs(x);
  float a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  float b = 3.4175940 + (4.1616724 + y) * y;
  float v = a / b;
  float thetaSinTheta = x > 0.0 ? v : 0.5 * inversesqrt(max(1.0 - x * x, 1e-7)) - v;
  return cross(v1, v2) * thetaSinTheta;
}
// The emission's prefiltered texel the transformed rect (corners q0, q1, q3) shows, from its layer of the array,
// coarser with distance (Babylon's FetchDiffuseFilteredTexture).
vec3 hapticAreaEmission(vec3 q0, vec3 q1, vec3 q3, float layer) {
  vec3 V1 = q1 - q0;
  vec3 V2 = q3 - q0;
  vec3 planeOrtho = cross(V1, V2);
  float planeAreaSquared = dot(planeOrtho, planeOrtho);
  float planeDistance = dot(planeOrtho, q0);
  vec3 P = planeDistance * planeOrtho / planeAreaSquared - q0;
  float V1V2 = dot(V1, V2);
  float inverseV1V1 = 1.0 / dot(V1, V1);
  vec3 V2Orthogonal = V2 - V1 * V1V2 * inverseV1V1;
  vec2 uv;
  uv.y = dot(V2Orthogonal, P) / dot(V2Orthogonal, V2Orthogonal);
  uv.x = dot(V1, P) * inverseV1V1 - V1V2 * inverseV1V1 * uv.y;
  float lod = log(2048.0 * abs(planeDistance) / pow(planeAreaSquared, 0.75)) / log(3.0);
  vec2 sampleUV = vec2(0.125) + vec2(0.75) * uv;
  sampleUV.x = 1.0 - sampleUV.x;
  return textureLod(hapticAreaEmissionSampler, vec3(sampleUV, layer), lod).rgb;
}
// The rect's form factor at P through the inverse transform (identity for diffuse), times its emission when it has
// a layer; zero behind its emitting side.
vec3 hapticLtcEvaluate(vec3 N, vec3 V, vec3 P, mat3 mInv, vec3 c0, vec3 c1, vec3 c2, vec3 c3, float layer) {
  if (dot(cross(c1 - c0, c3 - c0), P - c0) < 0.0) return vec3(0.0);
  vec3 T1 = normalize(V - N * dot(V, N));
  vec3 T2 = -cross(N, T1);
  mat3 m = mInv * transpose(mat3(T1, T2, N));
  vec3 q0 = m * (c0 - P);
  vec3 q1 = m * (c1 - P);
  vec3 q2 = m * (c2 - P);
  vec3 q3 = m * (c3 - P);
  vec3 emission = layer < 0.0 ? vec3(1.0) : hapticAreaEmission(q0, q1, q3, layer);
  vec3 p0 = normalize(q0);
  vec3 p1 = normalize(q1);
  vec3 p2 = normalize(q2);
  vec3 p3 = normalize(q3);
  vec3 f = hapticLtcEdge(p0, p1) + hapticLtcEdge(p1, p2) + hapticLtcEdge(p2, p3) + hapticLtcEdge(p3, p0);
  float l = length(f);
  return max((l * l + f.z) / (l + 1.0), 0.0) * emission;
}
// Rect i's diffuse and specular form factors, and the table's Fresnel terms (x scales F0, y scales F90 - F0).
struct hapticArea { vec3 diffuse; vec3 specular; vec2 fresnel; };
hapticArea hapticAreaLight(vec3 P, vec3 N, vec3 V, int i, float roughness) {
  vec3 center = hapticRect[i * 4].xyz;
  vec3 halfWidth = hapticRect[i * 4 + 1].xyz;
  vec3 halfHeight = hapticRect[i * 4 + 2].xyz;
  vec3 c0 = center + halfWidth - halfHeight;
  vec3 c1 = center - halfWidth - halfHeight;
  vec3 c2 = center - halfWidth + halfHeight;
  vec3 c3 = center + halfWidth + halfHeight;
  vec2 uv = vec2(roughness, sqrt(1.0 - clamp(dot(N, V), 0.0, 1.0))) * (63.0 / 64.0) + 0.5 / 64.0;
  vec4 t1 = textureLod(hapticAreaLtc1Sampler, uv, 0.0);
  vec4 t2 = textureLod(hapticAreaLtc2Sampler, uv, 0.0);
  mat3 mInv = mat3(vec3(t1.x, 0.0, t1.y), vec3(0.0, 1.0, 0.0), vec3(t1.z, 0.0, t1.w));
  hapticArea area;
  float layer = hapticRect[i * 4 + 3].w;
  area.diffuse = hapticLtcEvaluate(N, V, P, mat3(1.0), c0, c1, c2, c3, layer);
  area.specular = hapticLtcEvaluate(N, V, P, mInv, c0, c1, c2, c3, layer);
  area.fresnel = t2.xy;
  return area;
}

// Every light of the block: diffuse irradiance (before the surface's diffuse colour) and specular radiance.
void hapticDirectLights(hapticSurface surface, vec3 P, vec3 N, vec3 V, inout vec3 diffuse, inout vec3 specular) {
  // Before any branch: the sun's receiver plane reads them.
  vec3 dPdx = dFdx(P);
  vec3 dPdy = dFdy(P);
  if (hapticFillDirection.w > 0.0) {
    vec3 L = normalize(hapticFillDirection.xyz);
    float NdotL = hapticSaturateEps(dot(N, L) * 0.5 + 0.5);
    diffuse += mix(hapticFillGround.rgb, hapticFillSky.rgb, NdotL);
    specular += hapticSpecular(surface, N, V, L, NdotL, surface.roughness) * hapticFillSky.rgb;
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.directional}; i++) {
    if (i >= int(hapticCounts.x)) break;
    vec3 L = normalize(-hapticDirectional[i * 2].xyz);
    float NdotL = hapticSaturateEps(dot(N, L));
    vec4 record = hapticDirectional[i * 2 + 1];
    vec3 color = record.rgb * (record.w > 0.5 ? hapticSunShadowFactor(P, dPdx, dPdy) : 1.0);
    diffuse += color * (NdotL / HAPTIC_PI);
    specular += hapticSpecular(surface, N, V, L, NdotL, surface.roughness) * color;
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= int(hapticCounts.y)) break;
    vec4 position = hapticPoint[i * 3];
    vec4 color = hapticPoint[i * 3 + 1];
    vec3 offset = position.xyz - P;
    float distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) continue;
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    float lightDistance = sqrt(distanceSquared);
    vec3 L = offset / max(lightDistance, HAPTIC_EPSILON);
    float NdotL = hapticSaturateEps(dot(N, L));
    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w) * hapticPointShadow(hapticPoint[i * 3 + 2], -offset, P);
    diffuse += radiance * (NdotL / HAPTIC_PI);
    // A light's radius widens its highlight.
    float roughness = clamp(position.w / max(lightDistance, HAPTIC_EPSILON) + surface.roughness, 0.0, 1.0);
    specular += hapticSpecular(surface, N, V, L, NdotL, roughness) * radiance;
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.spot}; i++) {
    if (i >= int(hapticCounts.z)) break;
    vec4 position = hapticSpot[i * 4];
    vec4 direction = hapticSpot[i * 4 + 1];
    vec4 color = hapticSpot[i * 4 + 2];
    vec3 offset = position.xyz - P;
    float distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) continue;
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    float lightDistance = sqrt(distanceSquared);
    vec3 L = offset / max(lightDistance, HAPTIC_EPSILON);
    float NdotL = hapticSaturateEps(dot(N, L));
    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w, hapticSpot[i * 4 + 3].y)
      * hapticShadow(hapticSpot[i * 4 + 3].x, P, vec3(0.0), vec3(0.0));
    diffuse += radiance * (NdotL / HAPTIC_PI);
    float roughness = clamp(position.w / max(lightDistance, HAPTIC_EPSILON) + surface.roughness, 0.0, 1.0);
    specular += hapticSpecular(surface, N, V, L, NdotL, roughness) * radiance;
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.rect}; i++) {
    if (i >= int(hapticCounts.w)) break;
    hapticArea area = hapticAreaLight(P, N, V, i, surface.roughness);
    vec3 color = hapticRect[i * 4 + 3].rgb;
    diffuse += color * area.diffuse;
    specular += color * (surface.F0 * area.fresnel.x + (vec3(1.0) - surface.F0) * area.fresnel.y) * area.specular;
  }
}

#ifdef HAPTIC_CEL
// CEL: every light's raw brightness through one ramp and CEL's light mixing, with hard highlights (cel-shader.ts).
struct hapticCelLight { vec3 diffuse; vec3 specular; float peak; };
void hapticCelAdd(inout hapticCelLight result, vec3 diffuse, vec3 specular) {
  float strength = slateCelStrength(diffuse);
  float wins = strength > result.peak + max(1.0, result.peak) * 0.00001 ? 1.0 : 0.0;
  result.peak = max(result.peak, strength);
  result.diffuse = slateCelAccumulate(result.diffuse, diffuse, wins);
  result.specular = slateCelAccumulate(result.specular, specular, wins);
}
// A light's hard highlight in its colour times intensity, as its record holds it.
vec3 hapticCelHighlight(vec3 N, vec3 V, vec3 L, float NdotL, vec3 color) {
  return slateCelHighlight(max(dot(N, normalize(V + L)), 0.0), NdotL) * slateCelTint(color);
}
// The surface's display colour: the lights and the environment's irradiance on its display base colour.
vec3 hapticCelLighting(vec3 P, vec3 N, vec3 V, vec3 base, float environmentInfluence) {
  vec3 dPdx = dFdx(P);
  vec3 dPdy = dFdy(P);
  hapticCelLight result = hapticCelLight(vec3(0.0), vec3(0.0), 0.0);
  if (hapticFillDirection.w > 0.0) {
    // The fill bands its wrapped N.L before mixing ground and sky, so it adds no smooth hue gradient.
    vec3 L = normalize(hapticFillDirection.xyz);
    float band = slateCelBand(dot(N, L) * 0.5 + 0.5);
    hapticCelAdd(result, mix(hapticFillGround.rgb, hapticFillSky.rgb, band), hapticCelHighlight(N, V, L, band, hapticFillSky.rgb));
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.directional}; i++) {
    if (i >= int(hapticCounts.x)) break;
    vec3 L = normalize(-hapticDirectional[i * 2].xyz);
    float NdotL = max(dot(N, L), 0.0);
    vec4 record = hapticDirectional[i * 2 + 1];
    vec3 color = record.rgb;
    float shadow = record.w > 0.5 ? slateCelShadowVisibility(hapticSunShadowFactor(P, dPdx, dPdy)) : 1.0;
    hapticCelAdd(result, color * (NdotL * shadow), hapticCelHighlight(N, V, L, NdotL, color) * shadow);
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= int(hapticCounts.y)) break;
    vec4 color = hapticPoint[i * 3 + 1];
    vec3 offset = hapticPoint[i * 3].xyz - P;
    float distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) continue;
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    vec3 L = normalize(offset);
    float NdotL = max(dot(N, L), 0.0);
    float shadow = slateCelShadowVisibility(hapticPointShadow(hapticPoint[i * 3 + 2], -offset, P));
    hapticCelAdd(result, color.rgb * (NdotL * hapticRangeFalloff(distanceSquared, color.w) * shadow), hapticCelHighlight(N, V, L, NdotL, color.rgb) * shadow);
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.spot}; i++) {
    if (i >= int(hapticCounts.z)) break;
    vec4 direction = hapticSpot[i * 4 + 1];
    vec4 color = hapticSpot[i * 4 + 2];
    vec3 offset = hapticSpot[i * 4].xyz - P;
    float distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) continue;
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    vec3 L = normalize(offset);
    float NdotL = max(dot(N, L), 0.0);
    float falloff = hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w, hapticSpot[i * 4 + 3].y);
    // The highlight stops where the cone does, at its outer angle.
    float inCone = step(direction.w, dot(-L, direction.xyz));
    // CEL's hard shadow edge, as Babylon's CEL light block steps the shadow.
    float shadow = slateCelShadowVisibility(hapticShadow(hapticSpot[i * 4 + 3].x, P, vec3(0.0), vec3(0.0)));
    hapticCelAdd(result, color.rgb * (NdotL * falloff * shadow), hapticCelHighlight(N, V, L, NdotL, color.rgb) * (inCone * shadow));
  }
  // Rect lights at a fixed roughness of one half, as Babylon's light block evaluates them; the highlight is the
  // specular form factor past CEL's threshold.
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.rect}; i++) {
    if (i >= int(hapticCounts.w)) break;
    hapticArea area = hapticAreaLight(P, N, V, i, 0.5);
    vec3 color = hapticRect[i * 4 + 3].rgb;
    hapticCelAdd(result, color * area.diffuse, slateCelHighlight(slateCelStrength(area.specular), slateCelStrength(area.diffuse)) * slateCelTint(color));
  }
  hapticCelAdd(result, slateCelEnvironmentLight(N) * environmentInfluence, vec3(0.0));
  return slateCelSurfaceLight(result.diffuse, result.peak) * base + slateCelSurfaceSpecular(result.specular);
}
#endif

// The split-sum table: x scales F90 - F0, y scales F0.
vec3 hapticBrdfLookup(float NdotV, float roughness) {
  vec4 lookup = texture(hapticEnvironmentBrdfSampler, vec2(NdotV, roughness));
#ifdef HAPTIC_BRDF_RGBD
  return hapticFromRGBD(lookup);
#else
  return lookup.rgb;
#endif
}

#ifdef HAPTIC_ENVIRONMENT
// World direction into the cube's frame (its rotation and handedness).
vec3 hapticEnvironmentDirection(vec3 direction) {
  vec3 result = (hapticEnvironmentMatrix * vec4(direction, 0.0)).xyz;
#ifdef HAPTIC_ENVIRONMENT_INVERTY
  result.y *= -1.0;
#endif
#ifdef HAPTIC_ENVIRONMENT_OPPOSITEZ
  result.z *= -1.0;
#endif
  return result;
}
vec3 hapticIrradiance(vec3 N) {
  vec3 n = hapticEnvironmentDirection(N);
  return hapticIrradiance_l00.rgb + hapticIrradiance_l1_1.rgb * n.y + hapticIrradiance_l10.rgb * n.z + hapticIrradiance_l11.rgb * n.x +
    hapticIrradiance_l2_2.rgb * (n.y * n.x) + hapticIrradiance_l2_1.rgb * (n.y * n.z) + hapticIrradiance_l20.rgb * (3.0 * n.z * n.z - 1.0) +
    hapticIrradiance_l21.rgb * (n.z * n.x) + hapticIrradiance_l22.rgb * (n.x * n.x - n.y * n.y);
}
// The prefiltered cube along the reflection, box-projected onto a reflection probe's volume.
vec3 hapticRadiance(vec3 P, vec3 N, vec3 V, float alpha) {
  vec3 R = normalize(reflect(-V, N));
#ifdef HAPTIC_ENVIRONMENT_BOX
  vec3 halfSize = hapticEnvironmentBoxSize.xyz * 0.5;
  vec3 farthest = max((hapticEnvironmentBoxPosition.xyz + halfSize - P) / R, (hapticEnvironmentBoxPosition.xyz - halfSize - P) / R);
  R = P + R * min(min(farthest.x, farthest.y), farthest.z) - hapticEnvironmentBoxPosition.xyz;
#endif
  float lod = log2(hapticEnvironment.x * alpha) * hapticEnvironment.y + hapticEnvironment.z;
  vec4 radiance = textureLod(hapticEnvironmentSampler, hapticEnvironmentDirection(R), lod);
#ifdef HAPTIC_ENVIRONMENT_RGBD
  return hapticFromRGBD(radiance);
#elif defined(HAPTIC_ENVIRONMENT_GAMMA)
  return hapticToLinear(radiance.rgb);
#else
  return radiance.rgb;
#endif
}
#endif
`;

/** The block's fragment code: its four outputs (declared zero) from the surface inputs. Arguments are GLSL expressions. */
export function hapticLightingGlsl(input: {
  worldPosition: string; worldNormal: string; normal: string; cameraPosition: string;
  baseColor: string; metallic: string; specular: string; roughness: string; environmentInfluence: string;
}, output: { diffuseDirect: string; specularDirect: string; diffuseIndirect: string; specularIndirect: string }): string {
  return `vec3 hapticN = normalize(${input.normal});
vec3 hapticGeometricN = normalize(${input.worldNormal}.xyz);
#ifdef HAPTIC_TWO_SIDED
if (!gl_FrontFacing) { hapticN = -hapticN; hapticGeometricN = -hapticGeometricN; }
#endif
vec3 hapticP = ${input.worldPosition}.xyz;
vec3 hapticV = normalize(${input.cameraPosition} - hapticP);
float hapticInfluence = clamp(${input.environmentInfluence}, 0.0, 1.0);
#ifdef HAPTIC_CEL
// CEL lights in display space; the Material's display conversion encodes this back to the same colour.
${output.diffuseDirect} = hapticToLinear(max(hapticCelLighting(hapticP, hapticN, hapticV, slateCelTextureToDisplay(${input.baseColor}), hapticInfluence), vec3(0.0)));
#else
float hapticNdotVUnclamped = dot(hapticN, hapticV);
float hapticMetallic = clamp(${input.metallic}, 0.0, 1.0);
// A non-metal reflects 0.08 times Specular (0.04 at the default 0.5) and diffuses what it does not reflect.
float hapticDielectricF0 = 0.08 * clamp(${input.specular}, 0.0, 1.0);
hapticSurface hapticS;
hapticS.diffuse = ${input.baseColor} * ((1.0 - hapticDielectricF0) * (1.0 - hapticMetallic));
hapticS.F0 = mix(vec3(hapticDielectricF0), ${input.baseColor}, hapticMetallic);
hapticS.roughness = clamp(${input.roughness}, 0.0, 1.0);
hapticS.NdotV = abs(hapticNdotVUnclamped) + HAPTIC_EPSILON;
vec3 hapticBrdf = hapticBrdfLookup(hapticS.NdotV, hapticS.roughness);
vec3 hapticEnergy = vec3(1.0) + hapticS.F0 * (1.0 / hapticBrdf.y - 1.0);
vec3 hapticDiffuseLight = vec3(0.0);
vec3 hapticSpecularLight = vec3(0.0);
hapticDirectLights(hapticS, hapticP, hapticN, hapticV, hapticDiffuseLight, hapticSpecularLight);
${output.diffuseDirect} = hapticDiffuseLight * hapticS.diffuse;
${output.specularDirect} = max(hapticSpecularLight, vec3(0.0)) * hapticEnergy;
#ifdef HAPTIC_ENVIRONMENT
float hapticEnvironmentScale = hapticEnvironment.w * hapticInfluence;
${output.diffuseIndirect} = hapticIrradiance(hapticN) * hapticEnvironmentScale * hapticS.diffuse;
float hapticHorizon = clamp(1.0 + 1.1 * dot(reflect(-hapticV, hapticN), hapticGeometricN), 0.0, 1.0);
float hapticOcclusion = hapticHorizon * hapticHorizon * clamp((hapticNdotVUnclamped + 1.0) * (hapticNdotVUnclamped + 1.0), 0.0, 1.0);
vec3 hapticReflectance = (vec3(1.0) - hapticS.F0) * hapticBrdf.x + hapticS.F0 * hapticBrdf.y;
${output.specularIndirect} = hapticRadiance(hapticP, hapticN, hapticV, hapticAlpha(hapticS.roughness)) * hapticEnvironmentScale * hapticReflectance * hapticOcclusion * hapticEnergy;
#endif
#endif
#ifdef HAPTIC_LIGHT_LOOP_PROOF
// Visited and in-range light counts, 4/255 apart in display space; nothing else lights the pixel.
${output.diffuseDirect} = hapticToLinear(vec3(float(hapticLoopVisited), float(hapticLoopReached), 0.0) * (4.0 / 255.0));
${output.specularDirect} = vec3(0.0);
${output.diffuseIndirect} = vec3(0.0);
${output.specularIndirect} = vec3(0.0);
#endif
`;
}

/** The same functions in WGSL. */
export const HAPTIC_LIGHTING_FUNCTIONS_WGSL = `
const HAPTIC_PI: f32 = 3.1415926535897932;
const HAPTIC_EPSILON: f32 = 0.0000001;
#ifdef HAPTIC_LIGHT_LOOP_PROOF
var<private> hapticLoopVisited: i32 = 0;
var<private> hapticLoopReached: i32 = 0;
#endif
fn hapticSaturateEps(x: f32) -> f32 { return clamp(x, HAPTIC_EPSILON, 1.0); }
fn hapticPow5(x: f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }
fn hapticAlpha(roughness: f32) -> f32 { return roughness * roughness + 0.0005; }
fn hapticDistribution(NdotH: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (HAPTIC_PI * d * d);
}
fn hapticVisibility(NdotL: f32, NdotV: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let GGXV = NdotL * sqrt(NdotV * (NdotV - a2 * NdotV) + a2);
  let GGXL = NdotV * sqrt(NdotL * (NdotL - a2 * NdotL) + a2);
  return 0.5 / (GGXV + GGXL);
}
fn hapticToLinear(color: vec3f) -> vec3f {
#ifdef HAPTIC_EXACT_SRGB
  return select(pow(0.947867299 * (color + vec3f(0.055)), vec3f(2.4)), 0.0773993808 * color, color <= vec3f(0.04045));
#else
  return pow(color, vec3f(2.2));
#endif
}
fn hapticFromRGBD(rgbd: vec4f) -> vec3f { return hapticToLinear(rgbd.rgb) / rgbd.a; }

struct hapticSurface { diffuse: vec3f, F0: vec3f, roughness: f32, NdotV: f32 };

fn hapticSpecular(surface: hapticSurface, N: vec3f, V: vec3f, L: vec3f, NdotL: f32, roughness: f32) -> vec3f {
  let H = normalize(V + L);
  let VdotH = clamp(dot(V, H), 0.0, 1.0);
  let NdotH = hapticSaturateEps(dot(N, H));
  let alpha = hapticAlpha(roughness);
  let fresnel = surface.F0 + (vec3f(1.0) - surface.F0) * hapticPow5(1.0 - VdotH);
  return fresnel * hapticDistribution(NdotH, alpha) * hapticVisibility(NdotL, surface.NdotV, alpha) * NdotL;
}

fn hapticRangeFalloff(distanceSquared: f32, range: f32) -> f32 {
  let ratio = distanceSquared / (range * range);
  let window = clamp(1.0 - ratio * ratio, 0.0, 1.0);
  return window * window / max(distanceSquared, HAPTIC_EPSILON);
}

fn hapticConeFalloff(lightDirection: vec3f, L: vec3f, cosOuter: f32, cosInner: f32) -> f32 {
  let scale = 1.0 / max(0.001, cosInner - cosOuter);
  let cone = clamp(dot(lightDirection, -L) * scale - cosOuter * scale, 0.0, 1.0);
  return cone * cone;
}

${hapticShadowWgsl(true)}fn hapticLtcEdge(v1: vec3f, v2: vec3f) -> vec3f {
  let x = dot(v1, v2);
  let y = abs(x);
  let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  let b = 3.4175940 + (4.1616724 + y) * y;
  let v = a / b;
  let thetaSinTheta = select(0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - v, v, x > 0.0);
  return cross(v1, v2) * thetaSinTheta;
}
fn hapticAreaEmission(q0: vec3f, q1: vec3f, q3: vec3f, layer: f32) -> vec3f {
  let V1 = q1 - q0;
  let V2 = q3 - q0;
  let planeOrtho = cross(V1, V2);
  let planeAreaSquared = dot(planeOrtho, planeOrtho);
  let planeDistance = dot(planeOrtho, q0);
  let P = planeDistance * planeOrtho / planeAreaSquared - q0;
  let V1V2 = dot(V1, V2);
  let inverseV1V1 = 1.0 / dot(V1, V1);
  let V2Orthogonal = V2 - V1 * V1V2 * inverseV1V1;
  let v = dot(V2Orthogonal, P) / dot(V2Orthogonal, V2Orthogonal);
  let u = dot(V1, P) * inverseV1V1 - V1V2 * inverseV1V1 * v;
  let lod = log(2048.0 * abs(planeDistance) / pow(planeAreaSquared, 0.75)) / log(3.0);
  var sampleUV = vec2f(0.125) + vec2f(0.75) * vec2f(u, v);
  sampleUV.x = 1.0 - sampleUV.x;
  return textureSampleLevel(hapticAreaEmissionSampler, hapticAreaEmissionSamplerSampler, sampleUV, i32(layer), lod).rgb;
}
fn hapticLtcEvaluate(N: vec3f, V: vec3f, P: vec3f, mInv: mat3x3f, c0: vec3f, c1: vec3f, c2: vec3f, c3: vec3f, layer: f32) -> vec3f {
  if (dot(cross(c1 - c0, c3 - c0), P - c0) < 0.0) { return vec3f(0.0); }
  let T1 = normalize(V - N * dot(V, N));
  let T2 = -cross(N, T1);
  let m = mInv * transpose(mat3x3f(T1, T2, N));
  let q0 = m * (c0 - P);
  let q1 = m * (c1 - P);
  let q2 = m * (c2 - P);
  let q3 = m * (c3 - P);
  var emission = vec3f(1.0);
  if (layer >= 0.0) { emission = hapticAreaEmission(q0, q1, q3, layer); }
  let p0 = normalize(q0);
  let p1 = normalize(q1);
  let p2 = normalize(q2);
  let p3 = normalize(q3);
  let f = hapticLtcEdge(p0, p1) + hapticLtcEdge(p1, p2) + hapticLtcEdge(p2, p3) + hapticLtcEdge(p3, p0);
  let l = length(f);
  return max((l * l + f.z) / (l + 1.0), 0.0) * emission;
}
struct hapticArea { diffuse: vec3f, specular: vec3f, fresnel: vec2f };
fn hapticAreaLight(P: vec3f, N: vec3f, V: vec3f, i: i32, roughness: f32) -> hapticArea {
  let center = HapticLights.hapticRect[i * 4].xyz;
  let halfWidth = HapticLights.hapticRect[i * 4 + 1].xyz;
  let halfHeight = HapticLights.hapticRect[i * 4 + 2].xyz;
  let c0 = center + halfWidth - halfHeight;
  let c1 = center - halfWidth - halfHeight;
  let c2 = center - halfWidth + halfHeight;
  let c3 = center + halfWidth + halfHeight;
  let uv = vec2f(roughness, sqrt(1.0 - clamp(dot(N, V), 0.0, 1.0))) * (63.0 / 64.0) + 0.5 / 64.0;
  let t1 = textureSampleLevel(hapticAreaLtc1Sampler, hapticAreaLtc1SamplerSampler, uv, 0.0);
  let t2 = textureSampleLevel(hapticAreaLtc2Sampler, hapticAreaLtc2SamplerSampler, uv, 0.0);
  let mInv = mat3x3f(vec3f(t1.x, 0.0, t1.y), vec3f(0.0, 1.0, 0.0), vec3f(t1.z, 0.0, t1.w));
  let layer = HapticLights.hapticRect[i * 4 + 3].w;
  return hapticArea(hapticLtcEvaluate(N, V, P, mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0), c0, c1, c2, c3, layer),
    hapticLtcEvaluate(N, V, P, mInv, c0, c1, c2, c3, layer), t2.xy);
}

fn hapticDirectLights(surface: hapticSurface, P: vec3f, N: vec3f, V: vec3f, diffuse: ptr<function, vec3f>, specular: ptr<function, vec3f>) {
  // Before any branch: derivatives need uniform control flow, and the sun's receiver plane reads them.
  let dPdx = dpdx(P);
  let dPdy = dpdy(P);
  if (HapticLights.hapticFillDirection.w > 0.0) {
    let L = normalize(HapticLights.hapticFillDirection.xyz);
    let NdotL = hapticSaturateEps(dot(N, L) * 0.5 + 0.5);
    *diffuse += mix(HapticLights.hapticFillGround.rgb, HapticLights.hapticFillSky.rgb, NdotL);
    *specular += hapticSpecular(surface, N, V, L, NdotL, surface.roughness) * HapticLights.hapticFillSky.rgb;
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.directional}; i++) {
    if (i >= i32(HapticLights.hapticCounts.x)) { break; }
    let L = normalize(-HapticLights.hapticDirectional[i * 2].xyz);
    let NdotL = hapticSaturateEps(dot(N, L));
    let record = HapticLights.hapticDirectional[i * 2 + 1];
    var color = record.rgb;
    if (record.w > 0.5) { color *= hapticSunShadowFactor(P, dPdx, dPdy); }
    *diffuse += color * (NdotL / HAPTIC_PI);
    *specular += hapticSpecular(surface, N, V, L, NdotL, surface.roughness) * color;
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= i32(HapticLights.hapticCounts.y)) { break; }
    let position = HapticLights.hapticPoint[i * 3];
    let color = HapticLights.hapticPoint[i * 3 + 1];
    let offset = position.xyz - P;
    let distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) { continue; }
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    let lightDistance = sqrt(distanceSquared);
    let L = offset / max(lightDistance, HAPTIC_EPSILON);
    let NdotL = hapticSaturateEps(dot(N, L));
    let radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w) * hapticPointShadow(HapticLights.hapticPoint[i * 3 + 2], -offset, P);
    *diffuse += radiance * (NdotL / HAPTIC_PI);
    let roughness = clamp(position.w / max(lightDistance, HAPTIC_EPSILON) + surface.roughness, 0.0, 1.0);
    *specular += hapticSpecular(surface, N, V, L, NdotL, roughness) * radiance;
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.spot}; i++) {
    if (i >= i32(HapticLights.hapticCounts.z)) { break; }
    let position = HapticLights.hapticSpot[i * 4];
    let direction = HapticLights.hapticSpot[i * 4 + 1];
    let color = HapticLights.hapticSpot[i * 4 + 2];
    let offset = position.xyz - P;
    let distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) { continue; }
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    let lightDistance = sqrt(distanceSquared);
    let L = offset / max(lightDistance, HAPTIC_EPSILON);
    let NdotL = hapticSaturateEps(dot(N, L));
    let radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w, HapticLights.hapticSpot[i * 4 + 3].y)
      * hapticShadow(HapticLights.hapticSpot[i * 4 + 3].x, P, vec3f(0.0), vec3f(0.0));
    *diffuse += radiance * (NdotL / HAPTIC_PI);
    let roughness = clamp(position.w / max(lightDistance, HAPTIC_EPSILON) + surface.roughness, 0.0, 1.0);
    *specular += hapticSpecular(surface, N, V, L, NdotL, roughness) * radiance;
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.rect}; i++) {
    if (i >= i32(HapticLights.hapticCounts.w)) { break; }
    let area = hapticAreaLight(P, N, V, i, surface.roughness);
    let color = HapticLights.hapticRect[i * 4 + 3].rgb;
    *diffuse += color * area.diffuse;
    *specular += color * (surface.F0 * area.fresnel.x + (vec3f(1.0) - surface.F0) * area.fresnel.y) * area.specular;
  }
}

#ifdef HAPTIC_CEL
struct hapticCelLight { diffuse: vec3f, specular: vec3f, peak: f32 };
fn hapticCelAdd(result: ptr<function, hapticCelLight>, diffuse: vec3f, specular: vec3f) {
  let strength = slateCelStrength(diffuse);
  let wins = select(0.0, 1.0, strength > (*result).peak + max(1.0, (*result).peak) * 0.00001);
  (*result).peak = max((*result).peak, strength);
  (*result).diffuse = slateCelAccumulate((*result).diffuse, diffuse, wins);
  (*result).specular = slateCelAccumulate((*result).specular, specular, wins);
}
fn hapticCelHighlight(N: vec3f, V: vec3f, L: vec3f, NdotL: f32, color: vec3f) -> vec3f {
  return slateCelHighlight(max(dot(N, normalize(V + L)), 0.0), NdotL) * slateCelTint(color);
}
fn hapticCelLighting(P: vec3f, N: vec3f, V: vec3f, base: vec3f, environmentInfluence: f32) -> vec3f {
  let dPdx = dpdx(P);
  let dPdy = dpdy(P);
  var result = hapticCelLight(vec3f(0.0), vec3f(0.0), 0.0);
  if (HapticLights.hapticFillDirection.w > 0.0) {
    let L = normalize(HapticLights.hapticFillDirection.xyz);
    let band = slateCelBand(dot(N, L) * 0.5 + 0.5);
    hapticCelAdd(&result, mix(HapticLights.hapticFillGround.rgb, HapticLights.hapticFillSky.rgb, band), hapticCelHighlight(N, V, L, band, HapticLights.hapticFillSky.rgb));
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.directional}; i++) {
    if (i >= i32(HapticLights.hapticCounts.x)) { break; }
    let L = normalize(-HapticLights.hapticDirectional[i * 2].xyz);
    let NdotL = max(dot(N, L), 0.0);
    let record = HapticLights.hapticDirectional[i * 2 + 1];
    let color = record.rgb;
    var shadow = 1.0;
    if (record.w > 0.5) { shadow = slateCelShadowVisibility(hapticSunShadowFactor(P, dPdx, dPdy)); }
    hapticCelAdd(&result, color * (NdotL * shadow), hapticCelHighlight(N, V, L, NdotL, color) * shadow);
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= i32(HapticLights.hapticCounts.y)) { break; }
    let color = HapticLights.hapticPoint[i * 3 + 1];
    let offset = HapticLights.hapticPoint[i * 3].xyz - P;
    let distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) { continue; }
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    let L = normalize(offset);
    let NdotL = max(dot(N, L), 0.0);
    let shadow = slateCelShadowVisibility(hapticPointShadow(HapticLights.hapticPoint[i * 3 + 2], -offset, P));
    hapticCelAdd(&result, color.rgb * (NdotL * hapticRangeFalloff(distanceSquared, color.w) * shadow), hapticCelHighlight(N, V, L, NdotL, color.rgb) * shadow);
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.spot}; i++) {
    if (i >= i32(HapticLights.hapticCounts.z)) { break; }
    let direction = HapticLights.hapticSpot[i * 4 + 1];
    let color = HapticLights.hapticSpot[i * 4 + 2];
    let offset = HapticLights.hapticSpot[i * 4].xyz - P;
    let distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopVisited++;
#endif
    if (distanceSquared >= color.w * color.w) { continue; }
#ifdef HAPTIC_LIGHT_LOOP_PROOF
    hapticLoopReached++;
#endif
    let L = normalize(offset);
    let NdotL = max(dot(N, L), 0.0);
    let falloff = hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w, HapticLights.hapticSpot[i * 4 + 3].y);
    let inCone = step(direction.w, dot(-L, direction.xyz));
    let shadow = slateCelShadowVisibility(hapticShadow(HapticLights.hapticSpot[i * 4 + 3].x, P, vec3f(0.0), vec3f(0.0)));
    hapticCelAdd(&result, color.rgb * (NdotL * falloff * shadow), hapticCelHighlight(N, V, L, NdotL, color.rgb) * (inCone * shadow));
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.rect}; i++) {
    if (i >= i32(HapticLights.hapticCounts.w)) { break; }
    let area = hapticAreaLight(P, N, V, i, 0.5);
    let color = HapticLights.hapticRect[i * 4 + 3].rgb;
    hapticCelAdd(&result, color * area.diffuse, slateCelHighlight(slateCelStrength(area.specular), slateCelStrength(area.diffuse)) * slateCelTint(color));
  }
  hapticCelAdd(&result, slateCelEnvironmentLight(N) * environmentInfluence, vec3f(0.0));
  return slateCelSurfaceLight(result.diffuse, result.peak) * base + slateCelSurfaceSpecular(result.specular);
}
#endif

fn hapticBrdfLookup(NdotV: f32, roughness: f32) -> vec3f {
  let lookup = textureSampleLevel(hapticEnvironmentBrdfSampler, hapticEnvironmentBrdfSamplerSampler, vec2f(NdotV, roughness), 0.0);
#ifdef HAPTIC_BRDF_RGBD
  return hapticFromRGBD(lookup);
#else
  return lookup.rgb;
#endif
}

#ifdef HAPTIC_ENVIRONMENT
fn hapticEnvironmentDirection(direction: vec3f) -> vec3f {
  var result = (uniforms.hapticEnvironmentMatrix * vec4f(direction, 0.0)).xyz;
#ifdef HAPTIC_ENVIRONMENT_INVERTY
  result.y *= -1.0;
#endif
#ifdef HAPTIC_ENVIRONMENT_OPPOSITEZ
  result.z *= -1.0;
#endif
  return result;
}
fn hapticIrradiance(N: vec3f) -> vec3f {
  let n = hapticEnvironmentDirection(N);
  return uniforms.hapticIrradiance_l00.rgb + uniforms.hapticIrradiance_l1_1.rgb * n.y + uniforms.hapticIrradiance_l10.rgb * n.z + uniforms.hapticIrradiance_l11.rgb * n.x +
    uniforms.hapticIrradiance_l2_2.rgb * (n.y * n.x) + uniforms.hapticIrradiance_l2_1.rgb * (n.y * n.z) + uniforms.hapticIrradiance_l20.rgb * (3.0 * n.z * n.z - 1.0) +
    uniforms.hapticIrradiance_l21.rgb * (n.z * n.x) + uniforms.hapticIrradiance_l22.rgb * (n.x * n.x - n.y * n.y);
}
fn hapticRadiance(P: vec3f, N: vec3f, V: vec3f, alpha: f32) -> vec3f {
  var R = normalize(reflect(-V, N));
#ifdef HAPTIC_ENVIRONMENT_BOX
  let halfSize = uniforms.hapticEnvironmentBoxSize.xyz * 0.5;
  let farthest = max((uniforms.hapticEnvironmentBoxPosition.xyz + halfSize - P) / R, (uniforms.hapticEnvironmentBoxPosition.xyz - halfSize - P) / R);
  R = P + R * min(min(farthest.x, farthest.y), farthest.z) - uniforms.hapticEnvironmentBoxPosition.xyz;
#endif
  let lod = log2(uniforms.hapticEnvironment.x * alpha) * uniforms.hapticEnvironment.y + uniforms.hapticEnvironment.z;
  let radiance = textureSampleLevel(hapticEnvironmentSampler, hapticEnvironmentSamplerSampler, hapticEnvironmentDirection(R), lod);
#ifdef HAPTIC_ENVIRONMENT_RGBD
  return hapticFromRGBD(radiance);
#elif defined(HAPTIC_ENVIRONMENT_GAMMA)
  return hapticToLinear(radiance.rgb);
#else
  return radiance.rgb;
#endif
}
#endif
`;

/** `hapticLightingGlsl` in WGSL. */
export function hapticLightingWgsl(input: {
  worldPosition: string; worldNormal: string; normal: string; cameraPosition: string;
  baseColor: string; metallic: string; specular: string; roughness: string; environmentInfluence: string;
}, output: { diffuseDirect: string; specularDirect: string; diffuseIndirect: string; specularIndirect: string }): string {
  return `var hapticN = normalize(${input.normal});
var hapticGeometricN = normalize(${input.worldNormal}.xyz);
#ifdef HAPTIC_TWO_SIDED
if (!fragmentInputs.frontFacing) { hapticN = -hapticN; hapticGeometricN = -hapticGeometricN; }
#endif
let hapticP = ${input.worldPosition}.xyz;
let hapticV = normalize(${input.cameraPosition} - hapticP);
let hapticInfluence = clamp(${input.environmentInfluence}, 0.0, 1.0);
#ifdef HAPTIC_CEL
${output.diffuseDirect} = hapticToLinear(max(hapticCelLighting(hapticP, hapticN, hapticV, slateCelTextureToDisplay(${input.baseColor}), hapticInfluence), vec3f(0.0)));
#else
let hapticNdotVUnclamped = dot(hapticN, hapticV);
let hapticMetallic = clamp(${input.metallic}, 0.0, 1.0);
let hapticDielectricF0 = 0.08 * clamp(${input.specular}, 0.0, 1.0);
var hapticS: hapticSurface;
hapticS.diffuse = ${input.baseColor} * ((1.0 - hapticDielectricF0) * (1.0 - hapticMetallic));
hapticS.F0 = mix(vec3f(hapticDielectricF0), ${input.baseColor}, hapticMetallic);
hapticS.roughness = clamp(${input.roughness}, 0.0, 1.0);
hapticS.NdotV = abs(hapticNdotVUnclamped) + HAPTIC_EPSILON;
let hapticBrdf = hapticBrdfLookup(hapticS.NdotV, hapticS.roughness);
let hapticEnergy = vec3f(1.0) + hapticS.F0 * (1.0 / hapticBrdf.y - 1.0);
var hapticDiffuseLight = vec3f(0.0);
var hapticSpecularLight = vec3f(0.0);
hapticDirectLights(hapticS, hapticP, hapticN, hapticV, &hapticDiffuseLight, &hapticSpecularLight);
${output.diffuseDirect} = hapticDiffuseLight * hapticS.diffuse;
${output.specularDirect} = max(hapticSpecularLight, vec3f(0.0)) * hapticEnergy;
#ifdef HAPTIC_ENVIRONMENT
let hapticEnvironmentScale = uniforms.hapticEnvironment.w * hapticInfluence;
${output.diffuseIndirect} = hapticIrradiance(hapticN) * hapticEnvironmentScale * hapticS.diffuse;
let hapticHorizon = clamp(1.0 + 1.1 * dot(reflect(-hapticV, hapticN), hapticGeometricN), 0.0, 1.0);
let hapticOcclusion = hapticHorizon * hapticHorizon * clamp((hapticNdotVUnclamped + 1.0) * (hapticNdotVUnclamped + 1.0), 0.0, 1.0);
let hapticReflectance = (vec3f(1.0) - hapticS.F0) * hapticBrdf.x + hapticS.F0 * hapticBrdf.y;
${output.specularIndirect} = hapticRadiance(hapticP, hapticN, hapticV, hapticAlpha(hapticS.roughness)) * hapticEnvironmentScale * hapticReflectance * hapticOcclusion * hapticEnergy;
#endif
#endif
#ifdef HAPTIC_LIGHT_LOOP_PROOF
// Visited and in-range light counts, 4/255 apart in display space; nothing else lights the pixel.
${output.diffuseDirect} = hapticToLinear(vec3f(f32(hapticLoopVisited), f32(hapticLoopReached), 0.0) * (4.0 / 255.0));
${output.specularDirect} = vec3f(0.0);
${output.diffuseIndirect} = vec3f(0.0);
${output.specularIndirect} = vec3f(0.0);
#endif
`;
}
