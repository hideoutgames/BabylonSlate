import { HAPTIC_LIGHT_MAXIMUM, HAPTIC_SHADOW_VIEW_VEC4S } from "./haptic-lights";
import { CLUSTER_SLICES, CLUSTER_TILES_X, CLUSTER_TILES_Y } from "./light-clusters";

/**
 * The lighting function of `HapticLightingBlock`, in GLSL: a metallic-roughness
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
 * The shadow atlas read plainly, beside its compare sampler, for Contact Hardening's blocker search: the same
 * depth texture on another unit with a sampler object without compare (`plainDepthSampler`).
 */
export const HAPTIC_SHADOW_ATLAS_DEPTH = "hapticShadowAtlasDepth";

/**
 * CEL's shadow edge: its four-tap kernel ramps across an edge over about this many texels (its 3 × 3 box over the
 * bilinear taps), which CEL sharpens to one pixel.
 */
const CEL_SHADOW_EDGE_TEXELS = 3;
/**
 * The least CEL sharpens a shadow by: its ramp then reaches no lower than a share of zero, so a shadow's inside stays
 * dark.
 */
const CEL_SHADOW_MINIMUM_GAIN = 2;

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

/**
 * The light block's shadows, read from its views (\`hapticShadowViews\`) and the atlas: a view's (\`hapticShadow\`), a
 * point light's (\`hapticPointShadow\`) and the sun's cascades (\`hapticSunShadowFactor\`). \`surface\`: a mesh's, filtered
 * at the view's quality with receiver-plane bias and honouring Receive Shadows (\`hapticShadowReceiver\`); else a
 * position on no surface (the volumetric march's), one bilinear compare tap, as the march takes on Babylon's maps.
 */
export function hapticShadowGlsl(surface: boolean): string {
  return `// A light's shadow from its view of the atlas (\`hapticShadowViews\`): 1 where lit, the view's darkness where shadowed; 1
// without a view (index < 0), outside its frustum and on a mesh that does not receive shadows. Filtered at the view's
// quality (0 low: Castaño's four weighted bilinear compare taps over 3 × 3 texels; 1 medium: his nine over 5 × 5; 2 high:
// his sixteen over 7 × 7; a view with coarser texels than its reference takes his smaller kernel nearest that width in
// the world, so the softness holds across cascades and tiles),
// each tap kept a texel inside the view's tile so a neighbouring tile never bleeds in. A sun cascade
// with automatic bias compares each tap against the receiver's plane, from the position's change across the pixel
// (\`dPdx\`, \`dPdy\`, taken where control flow is uniform). ESSL 3.00 has no \`textureLod\` for an array compare sampler;
// the atlas has a single level, so the implicit level reads that level as an explicit 0 did.
float hapticShadowTap(vec4 tile, float layer, vec2 texel, float depth) {
  return texture(hapticShadowAtlas, vec4(clamp(tile.xy + texel * tile.w, tile.xy + tile.w, tile.xy + tile.z - tile.w), layer, depth));
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
float hapticPlaneTap(vec4 tile, float layer, vec2 tap, vec2 origin, float depth, vec2 gradient, float maximum) {
  vec2 phase = fract(tap - 0.5);
  float bound = dot(max(gradient, 0.0), phase) + dot(max(-gradient, 0.0), 1.0 - phase);
  return hapticShadowTap(tile, layer, tap, clamp(depth + dot(gradient, tap - origin) - bound, 0.0, maximum));
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
// CEL never draws it (\`HAPTIC_SHADOW_NARROW\`), and its programs do not declare the plain read.
#ifndef HAPTIC_CEL
${poissonGlsl("hapticPoisson32", POISSON_32)}${poissonGlsl("hapticPoisson64", POISSON_64)}
// The atlas's depth at a texel of the tile, read without compare (\`hapticShadowAtlasDepth\`).
float hapticShadowDepth(vec4 tile, float layer, vec2 texel, float size) {
  return texelFetch(hapticShadowAtlasDepth, ivec3(ivec2(tile.xy / tile.w + clamp(floor(texel), vec2(0.0), vec2(size - 1.0)) + 0.5), int(layer)), 0).r;
}

// Babylon's depth metric, (clip z + near) / (near + far), of a perspective view with planes \`range\` at an NDC depth,
// through Babylon's projection (GL's depth range).
float hapticDepthMetric(vec2 range, float ndc) {
  float z = 2.0 * range.x * range.y / (range.x + range.y - (range.y - range.x) * ndc);
  return (ndc * z + range.x) / (range.x + range.y);
}

float hapticContactLit(vec4 tile, float layer, vec4 shading, vec4 contact, vec4 clip, float depth, vec2 texels, float size, vec2 gradient, float maximum) {
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
    float stored = hapticShadowDepth(tile, layer, tap, size);
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
    lit += hapticPlaneTap(tile, layer, texels + offset * radius, texels, depth, gradient, maximum);
  }
  return mix(lit / float(taps), 1.0, min(distance, 1.0));
}
#endif

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
  // The atlas page (the depth texture layer) the tile is in.
  float layer = hapticShadowViews[base + 7].y;
  vec4 shading = hapticShadowViews[base + 5];
  // A cascade clamps its depth, as Babylon's cascaded PCF does.
  float maximum = shading.z > 0.5 ? 0.99999994 : 1.0;
  depth = shading.z > 0.5 ? clamp(depth, 0.0, maximum) : depth;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth < 0.0 || depth > 1.0) return 1.0;
  float size = tile.z / tile.w;
  vec2 texels = uv * size;
${surface ? `  vec2 gradient = shading.w > 0.5 ? hapticReceiverGradient(view, dPdx, dPdy, size) : vec2(0.0);
#ifndef HAPTIC_SHADOW_NARROW
  if (shading.y > 2.5) return mix(shading.x, 1.0, hapticContactLit(tile, layer, shading, hapticShadowViews[base + 6], clip, depth, texels, size, gradient, maximum));
#endif
  // Water and CEL (\`HAPTIC_SHADOW_NARROW\`) draw every filter, Contact Hardening's too, as low quality's four taps.
  float lit;
  // Castaño's exact kernels: 3 × 3 texels (four bilinear compare taps), 5 × 5 (nine) or 7 × 7 (sixteen), their positions
  // and weights from the position within its texel. High quality aims at 7 × 7 texels of the reference view (the first
  // cascade, a local light's requested size), medium at 5 × 5, and a view with coarser texels (its record's eighth vector:
  // the reference texel over its own, \`shadowKernelRatio\`) takes the kernel nearest that width in the world. Low
  // quality always takes 3 × 3: one bilinear tap steps with the texels wherever a texel spans several pixels.
#ifdef HAPTIC_SHADOW_NARROW
  float texelsWide = 3.0;
#else
  float quality = shading.y > 2.5 ? shading.y - 3.0 : shading.y;
  float texelsWide = quality < 0.5 ? 3.0 : (quality < 1.5 ? 5.0 : 7.0) * hapticShadowViews[base + 7].x;
#endif
  vec2 st = fract(texels + 0.5);
  vec2 corner = floor(texels + 0.5) - 0.5;
  if (texelsWide < 4.0) {
    vec2 w0 = 3.0 - 2.0 * st;
    vec2 w1 = 1.0 + 2.0 * st;
    vec2 a = corner + (2.0 - st) / w0 - 1.0;
    vec2 b = corner + st / w1 + 1.0;
    lit = (w0.x * w0.y * hapticPlaneTap(tile, layer, vec2(a.x, a.y), texels, depth, gradient, maximum)
      + w1.x * w0.y * hapticPlaneTap(tile, layer, vec2(b.x, a.y), texels, depth, gradient, maximum)
      + w0.x * w1.y * hapticPlaneTap(tile, layer, vec2(a.x, b.y), texels, depth, gradient, maximum)
      + w1.x * w1.y * hapticPlaneTap(tile, layer, vec2(b.x, b.y), texels, depth, gradient, maximum)) / 16.0;
  }
#ifndef HAPTIC_SHADOW_NARROW
  else if (texelsWide < 6.0) {
    vec2 w0 = 4.0 - 3.0 * st;
    vec2 w2 = 1.0 + 3.0 * st;
    vec2 a = corner + (3.0 - 2.0 * st) / w0 - 2.0;
    vec2 b = corner + (3.0 + st) / 7.0;
    vec2 c = corner + st / w2 + 2.0;
    lit = (w0.x * w0.y * hapticPlaneTap(tile, layer, vec2(a.x, a.y), texels, depth, gradient, maximum)
      + 7.0 * w0.y * hapticPlaneTap(tile, layer, vec2(b.x, a.y), texels, depth, gradient, maximum)
      + w2.x * w0.y * hapticPlaneTap(tile, layer, vec2(c.x, a.y), texels, depth, gradient, maximum)
      + w0.x * 7.0 * hapticPlaneTap(tile, layer, vec2(a.x, b.y), texels, depth, gradient, maximum)
      + 49.0 * hapticPlaneTap(tile, layer, vec2(b.x, b.y), texels, depth, gradient, maximum)
      + w2.x * 7.0 * hapticPlaneTap(tile, layer, vec2(c.x, b.y), texels, depth, gradient, maximum)
      + w0.x * w2.y * hapticPlaneTap(tile, layer, vec2(a.x, c.y), texels, depth, gradient, maximum)
      + 7.0 * w2.y * hapticPlaneTap(tile, layer, vec2(b.x, c.y), texels, depth, gradient, maximum)
      + w2.x * w2.y * hapticPlaneTap(tile, layer, vec2(c.x, c.y), texels, depth, gradient, maximum)) / 144.0;
  } else {
    vec2 w[4] = vec2[4](5.0 * st - 6.0, 11.0 * st - 28.0, -(11.0 * st + 17.0), -(5.0 * st + 1.0));
    vec2 o[4] = vec2[4]((4.0 * st - 5.0) / w[0] - 3.0, (4.0 * st - 16.0) / w[1] - 1.0, -(7.0 * st + 5.0) / w[2] + 1.0, -st / w[3] + 3.0);
    lit = 0.0;
    for (int j = 0; j < 4; j++)
      for (int i = 0; i < 4; i++)
        lit += w[i].x * w[j].y * hapticPlaneTap(tile, layer, corner + vec2(o[i].x, o[j].y), texels, depth, gradient, maximum);
    lit /= 2704.0;
  }
#endif
#ifdef HAPTIC_CEL
  // CEL's shadow edge: the filtered share sharpened to a ramp of roughly one screen pixel, without a derivative of the
  // share (the loop calling this is not uniform control flow). Wherever the share is at least a half (the old hard
  // step's lit side) the light is full: a lit slope facing a local light reads well under one (the kernel's far taps
  // compare against the receiver's depth at the centre, without a receiver plane), which must not darken it. The ramp
  // lies on the shadow's side of that half. \`footprint\` is one pixel's size in the tile's texels, from the
  // position's change across the pixel through the view (the quotient rule for a perspective view); the four-tap
  // kernel's edge ramps over about \`CEL_SHADOW_EDGE_TEXELS\`.
  vec4 viewDx = view * vec4(dPdx, 0.0);
  vec4 viewDy = view * vec4(dPdy, 0.0);
  float footprint = max(length(viewDx.xy - ndc.xy * viewDx.w), length(viewDy.xy - ndc.xy * viewDy.w)) * 0.5 * size / clip.w;
  lit = clamp((lit - 0.5) * clamp(${CEL_SHADOW_EDGE_TEXELS.toFixed(1)} / max(footprint, 1e-6), ${CEL_SHADOW_MINIMUM_GAIN.toFixed(1)}, 64.0) + 1.0, 0.0, 1.0);
#endif
  return mix(shading.x, 1.0, lit);
` : "  return mix(shading.x, 1.0, hapticShadowTap(tile, layer, texels, depth));\n"}}

// A point light's shadow (its record's \`shadow\`: first view, faces): the view of the cube face the position lies in,
// in Babylon's order (+X, -X, -Y, +Y, +Z, -Z); the one view of a point light with a direction.
// -1 for a light that casts none. A lit surface looks it up in its one light loop (\`hapticDirectLights\`).
float hapticPointShadowView(vec4 shadow, vec3 fromLight) {
  if (shadow.x < 0.0) return -1.0;
  vec3 a = abs(fromLight);
  float face = shadow.y < 1.5 ? 0.0
    : a.x >= a.y && a.x >= a.z ? (fromLight.x > 0.0 ? 0.0 : 1.0)
    : a.y >= a.z ? (fromLight.y < 0.0 ? 2.0 : 3.0)
    : (fromLight.z > 0.0 ? 4.0 : 5.0);
  return shadow.x + face;
}
float hapticPointShadow(vec4 shadow, vec3 fromLight, vec3 P) {
  return hapticShadow(hapticPointShadowView(shadow, fromLight), P, vec3(0.0), vec3(0.0));
}

// Where the sun's shadow comes from at a position (\`hapticSunShadow\`): Babylon's choice of the first cascade whose far
// end lies beyond the position's view depth (\`index\`, the views from \`first\`; -1 with no cascade or beyond the last:
// unshadowed), its blend into the next over the last part of its length, and the fade to unshadowed over the last part
// of the shadow distance.
struct hapticSunLookup {
  int index;
  bool blends;
  float blend;
  bool fades;
  float fade;
  float first;
};
hapticSunLookup hapticSunCascade(vec3 P) {
  hapticSunLookup sun = hapticSunLookup(-1, false, 0.0, false, 0.0, 0.0);
  vec4 cascades = hapticSunShadow[0];
  int count = int(cascades.x);
  if (count == 0) return sun;
  float depth = dot(hapticSunShadow[1], vec4(P, 1.0));
  vec4 ends = hapticSunShadow[2];
  float ahead = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= count) break;
    ahead = ends[i] - depth;
    if (ahead >= 0.0) {
      sun.index = i;
      break;
    }
  }
  if (sun.index < 0) return sun;
  sun.first = cascades.w;
  sun.blend = clamp(ahead / hapticSunShadow[3][sun.index], 0.0, 1.0) * cascades.y;
  sun.blends = sun.index < count - 1 && sun.blend < 1.0;
  float end = ends[count - 1];
  sun.fades = cascades.z > 0.0;
  if (sun.fades) sun.fade = smoothstep(end * (1.0 - cascades.z), end, abs(depth));
  return sun;
}
// The sun's shadow from its cascades; 1 beyond the last.
float hapticSunShadowFactor(vec3 P, vec3 dPdx, vec3 dPdy) {
  hapticSunLookup sun = hapticSunCascade(P);
  if (sun.index < 0) return 1.0;
  float shadow = hapticShadow(sun.first + float(sun.index), P, dPdx, dPdy);
  if (sun.blends) shadow = mix(hapticShadow(sun.first + float(sun.index + 1), P, dPdx, dPdy), shadow, sun.blend);
  if (sun.fades) shadow = mix(shadow, 1.0, sun.fade);
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
#ifdef HAPTIC_SCREEN_SHADOWS
// The sun's lit share from Screen-Space Shadows at this pixel (\`hapticScreenShadowLit\`), set before the direct lights.
float hapticScreenLit = 1.0;
// The screen shadows of this draw's pass (\`hapticScreenShadowSampler\`: R the sun's lit share, G the eye distance of the
// surface marched from; \`hapticScreenShadowTerms.x\` 0 where the pass has none, a placeholder then bound), for the surface
// at P only: a fragment at another distance (behind glass or water, or anything the depth did not hold) keeps 1. The
// march's per-pixel noise is filtered spatially: the lit share averages the 3 x 3 neighbours marched from the same surface.
float hapticScreenShadowLit(vec3 P, vec3 eye) {
  if (hapticScreenShadowTerms.x < 0.5) return 1.0;
  ivec2 last = textureSize(hapticScreenShadowSampler, 0) - 1;
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  float distance = length(eye - P);
  float tolerance = 0.004 * distance + 0.01;
  vec2 center = texelFetch(hapticScreenShadowSampler, clamp(pixel, ivec2(0), last), 0).rg;
  if (abs(distance - center.y) >= tolerance) return 1.0;
  float lit = 0.0;
  float weight = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 texel = texelFetch(hapticScreenShadowSampler, clamp(pixel + ivec2(x, y), ivec2(0), last), 0).rg;
      if (abs(distance - texel.y) < 2.0 * tolerance) { lit += texel.x; weight += 1.0; }
    }
  }
  return lit / weight;
}

// Where the sun's cascades darken to (the first cascade's darkness; a map awaiting its first draw is neutral), as far as
// the screen shadows say the sun is blocked.
float hapticSunScreenShadow() {
  vec4 cascades = hapticSunShadow[0];
  float darkness = cascades.x > 0.5 ? hapticShadowViews[int(cascades.w) * ${HAPTIC_SHADOW_VIEW_VEC4S} + 5].x : 1.0;
  return mix(darkness, 1.0, hapticScreenLit);
}
#endif
// The masks of the cluster holding world position P (\`light-clusters.ts\`): every light outside the clusters' view.
uvec2 hapticClusterMask(vec3 P) {
  vec4 slices = hapticClusterHeader[5];
  float depth = dot(hapticClusterHeader[4].xyz, P) + hapticClusterHeader[4].w;
  vec4 clip = mat4(hapticClusterHeader[0], hapticClusterHeader[1], hapticClusterHeader[2], hapticClusterHeader[3]) * vec4(P, 1.0);
  if (slices.z < 0.5 || clip.w <= 0.0 || depth < slices.x) return uvec2(0xffffffffu);
  vec2 ndc = clip.xy / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) return uvec2(0xffffffffu);
  ivec2 tile = clamp(ivec2((ndc * 0.5 + 0.5) * vec2(${CLUSTER_TILES_X}.0, ${CLUSTER_TILES_Y}.0)), ivec2(0), ivec2(${CLUSTER_TILES_X - 1}, ${CLUSTER_TILES_Y - 1}));
  int slice = clamp(int(floor(log(depth / slices.x) * slices.y)), 0, ${CLUSTER_SLICES - 1});
  int cluster = (slice * ${CLUSTER_TILES_Y} + tile.y) * ${CLUSTER_TILES_X} + tile.x;
  uvec4 masks = hapticClusterMasks[cluster / 2];
  return (cluster % 2) == 0 ? masks.xy : masks.zw;
}
// A mask's lights among the first \`count\` records.
uint hapticClusterLights(uint mask, int count) { return count >= 32 ? mask : mask & ((1u << uint(count)) - 1u); }
// The lowest light of \`bits\`, taken out of them: lights visit in record order, as an unculled loop's.
int hapticNextLight(inout uint bits) {
  uint low = bits & (~bits + 1u);
  bits ^= low;
  return int(log2(float(low)) + 0.5);
}
#ifdef HAPTIC_LIGHT_LOOP_PROOF
int hapticBitCount(uint bits) {
  int count = 0;
  for (int i = 0; i < 32; i++) count += int((bits >> uint(i)) & 1u);
  return count;
}
#endif
#ifndef HAPTIC_CEL
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
#endif
vec3 hapticToLinear(vec3 color) {
#ifdef HAPTIC_EXACT_SRGB
  return mix(pow(0.947867299 * (color + vec3(0.055)), vec3(2.4)), 0.0773993808 * color, vec3(lessThanEqual(color, vec3(0.04045))));
#else
  return pow(color, vec3(2.2));
#endif
}
#ifndef HAPTIC_CEL
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
#endif

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
#ifndef HAPTIC_CEL
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
  // The two tables stacked in one texture (\`areaLightLtcTexture\`): LTC1 in the top half, LTC2 in the bottom. A half's
  // rows end at its last texel's centre, so the bilinear tap never reaches the other table.
  vec4 t1 = textureLod(hapticAreaLtcSampler, vec2(uv.x, uv.y * 0.5), 0.0);
  vec4 t2 = textureLod(hapticAreaLtcSampler, vec2(uv.x, uv.y * 0.5 + 0.5), 0.0);
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
  // The fill is a sky and a ground, with no point to reflect: diffuse only. A highlight from its direction would sit
  // where the surface faces between it and the camera, under the camera on a floor, and follow it.
  if (hapticFillDirection.w > 0.0) {
    float NdotL = hapticSaturateEps(dot(N, normalize(hapticFillDirection.xyz)) * 0.5 + 0.5);
    diffuse += mix(hapticFillGround.rgb, hapticFillSky.rgb, NdotL);
  }
  // The sun's two cascade lookups, then the lights of P's cluster (\`light-clusters.ts\`), points before spots, in one
  // loop, so the shadow lookup has one call site: the Direct3D compiler inlines every call, and each copy of the
  // filter adds over a second to the program's link. A slot's contribution is summed where its own loop summed it.
  hapticSunLookup sun = hapticSunCascade(P);
  float sunShadow = 1.0;
  uvec2 clusterMask = hapticClusterMask(P);
  uint points = hapticClusterLights(clusterMask.x, int(hapticCounts.y));
  uint spots = hapticClusterLights(clusterMask.y & 0xffffu, int(hapticCounts.z));
  for (int slot = 0; slot < 2 + ${HAPTIC_LIGHT_MAXIMUM.point} + ${HAPTIC_LIGHT_MAXIMUM.spot}; slot++) {
    bool spot = false;
    int i = 0;
    vec4 position = vec4(0.0);
    vec4 color = vec4(0.0);
    vec3 offset = vec3(0.0);
    float distanceSquared = 0.0;
    // The shadow view this slot looks up, or none.
    float view = -1.0;
    vec3 viewDx = vec3(0.0);
    vec3 viewDy = vec3(0.0);
    if (slot < 2) {
      // The sun's cascade, then the next one where it blends into it.
      if (sun.index >= 0 && (slot == 0 || sun.blends)) {
        view = sun.first + float(sun.index + slot);
        viewDx = dPdx;
        viewDy = dPdy;
      }
    } else {
      spot = points == 0u;
      if (spot && spots == 0u) break;
      if (spot) {
        i = hapticNextLight(spots);
        position = hapticSpot[i * 4];
        color = hapticSpot[i * 4 + 2];
      } else {
        i = hapticNextLight(points);
        position = hapticPoint[i * 3];
        color = hapticPoint[i * 3 + 1];
      }
      offset = position.xyz - P;
      distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
      hapticLoopVisited++;
#endif
      if (distanceSquared >= color.w * color.w) continue;
#ifdef HAPTIC_LIGHT_LOOP_PROOF
      hapticLoopReached++;
#endif
      view = spot ? hapticSpot[i * 4 + 3].x : hapticPointShadowView(hapticPoint[i * 3 + 2], -offset);
    }
    float lit = hapticShadow(view, P, viewDx, viewDy);
    if (slot == 0) {
      sunShadow = lit;
      continue;
    }
    if (slot == 1) {
      if (sun.blends) sunShadow = mix(lit, sunShadow, sun.blend);
      if (sun.fades) sunShadow = mix(sunShadow, 1.0, sun.fade);
      for (int d = 0; d < ${HAPTIC_LIGHT_MAXIMUM.directional}; d++) {
        if (d >= int(hapticCounts.x)) break;
        vec3 L = normalize(-hapticDirectional[d * 2].xyz);
        float NdotL = hapticSaturateEps(dot(N, L));
        vec4 record = hapticDirectional[d * 2 + 1];
#ifdef HAPTIC_SCREEN_SHADOWS
        // The cascades and the screen shadows each block the sun; the darker wins, so neither doubles the other.
        vec3 sunColor = record.rgb * (record.w > 0.5 ? min(sunShadow, hapticSunScreenShadow()) : 1.0);
#else
        vec3 sunColor = record.rgb * (record.w > 0.5 ? sunShadow : 1.0);
#endif
        diffuse += sunColor * (NdotL / HAPTIC_PI);
        specular += hapticSpecular(surface, N, V, L, NdotL, surface.roughness) * sunColor;
      }
      continue;
    }
    float lightDistance = sqrt(distanceSquared);
    vec3 L = offset / max(lightDistance, HAPTIC_EPSILON);
    float NdotL = hapticSaturateEps(dot(N, L));
    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w);
    if (spot) radiance = radiance * hapticConeFalloff(hapticSpot[i * 4 + 1].xyz, L, hapticSpot[i * 4 + 1].w, hapticSpot[i * 4 + 3].y);
    radiance = radiance * lit;
    diffuse += radiance * (NdotL / HAPTIC_PI);
    // A light's radius widens its highlight.
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
#else
// CEL (cel-shader.ts): each light's continuous brightness, summed by CEL's light mixing in the light loop, then one ramp
// after it. Everything with an edge (the bands, the highlights) is thresholded after the loop, in uniform control flow,
// where \`fwidth\` is defined and so each edge is one pixel wide; the loop computes no derivative.
//
// A shadow's edge is not left to the ramp: a step in the light across a pixel would read as a steep slope, and the ramp
// would blend toward the next band wherever the light nears one (a faint line along every shadow), while a shadow edge
// between two bands would alias. So the loop sums the lights twice, a light whose shadow is partial at the pixel on
// (\`on\`) and off (\`off\`), and after the ramp the two mix by that light's anti-aliased shadow (\`hapticShadow\`); the
// ramp's edge width comes from the light without shadows (\`open\`).
struct hapticCelLight {
  vec3 diffuse;
  float peak;
};
struct hapticCelLights {
  hapticCelLight on;
  hapticCelLight off;
  // The lights unshadowed: their sum and their brightest.
  vec3 open;
  float openPeak;
  // The brightest light whose shadow is partial here, and that shadow (1 with none).
  float partial;
  float coverage;
  // The brightest highlight signal (positive inside a highlight) and its light's hue.
  float signal;
  vec3 highlight;
};
void hapticCelAccumulate(inout hapticCelLight result, vec3 diffuse) {
  float strength = slateCelStrength(diffuse);
  float wins = strength > result.peak + max(1.0, result.peak) * 0.00001 ? 1.0 : 0.0;
  result.peak = max(result.peak, strength);
  result.diffuse = slateCelAccumulate(result.diffuse, diffuse, wins);
}
// A light's diffuse light before its shadow, and its shadow's lit share.
void hapticCelAdd(inout hapticCelLights result, vec3 diffuse, float lit) {
  hapticCelAccumulate(result.on, lit > 0.0 ? diffuse : vec3(0.0));
  hapticCelAccumulate(result.off, lit < 1.0 ? vec3(0.0) : diffuse);
  result.open += diffuse;
  float strength = slateCelStrength(diffuse);
  result.openPeak = max(result.openPeak, strength);
  if (lit > 0.0 && lit < 1.0 && strength > result.partial) {
    result.partial = strength;
    result.coverage = lit;
  }
}
// A light's highlight: its \`signal\` is positive inside the highlight's angle where the light's own diffuse light
// reaches the first lit band, so it follows the light's range, cone, N.L and shadow; the brightest signal wins. Its
// colour is the light's hue (\`color\`), not its intensity.
void hapticCelHighlight(inout hapticCelLights result, float signal, vec3 color) {
  if (signal > result.signal) {
    result.signal = signal;
    result.highlight = color / max(slateCelStrength(color), 0.00001);
  }
}
// The ramp's brightness of summed lights: the strongest light's under Blend, the sum's otherwise.
float hapticCelBrightness(hapticCelLight result) {
  return slateCelLight.y > 1.5 ? result.peak : slateCelStrength(result.diffuse);
}
// Summed lights' colour at their band \`level\` with the fill's \`ambient\` light: Strongest takes the brighter,
// Additive sums the two, Blend mixes their hues at the brighter level.
vec3 hapticCelSurfaceLight(hapticCelLight result, float level, vec3 ambient) {
  float strength = slateCelStrength(result.diffuse);
  vec3 hue = result.diffuse / max(strength, 0.00001);
  float ambientStrength = slateCelStrength(ambient);
  if (slateCelLight.y < 0.5) {
    if (ambientStrength > level) {
      hue = ambient / ambientStrength;
      level = ambientStrength;
    }
  } else {
    vec3 sum = hue * level + ambient;
    float total = slateCelStrength(sum);
    hue = sum / max(total, 0.00001);
    level = slateCelLight.y < 1.5 ? total : max(level, ambientStrength);
  }
  return mix(vec3(slateCelBands.z), slateCelTint(hue), min(level, 1.0));
}
// Rect i at a fixed roughness of one half, as Babylon's light block evaluates it: its diffuse form factor, and its
// specular one only where highlights are on (the only read of the LTC table; CEL never reads its Fresnel half).
void hapticCelAreaLight(vec3 P, vec3 N, vec3 V, int i, out vec3 diffuse, out vec3 specular) {
  vec3 center = hapticRect[i * 4].xyz;
  vec3 halfWidth = hapticRect[i * 4 + 1].xyz;
  vec3 halfHeight = hapticRect[i * 4 + 2].xyz;
  vec3 c0 = center + halfWidth - halfHeight;
  vec3 c1 = center - halfWidth - halfHeight;
  vec3 c2 = center - halfWidth + halfHeight;
  vec3 c3 = center + halfWidth + halfHeight;
  float layer = hapticRect[i * 4 + 3].w;
  diffuse = hapticLtcEvaluate(N, V, P, mat3(1.0), c0, c1, c2, c3, layer);
  specular = vec3(0.0);
  if (slateCelSpecular.x > 0.0) {
    vec2 uv = vec2(0.5, sqrt(1.0 - clamp(dot(N, V), 0.0, 1.0))) * (63.0 / 64.0) + 0.5 / 64.0;
    vec4 t1 = textureLod(hapticAreaLtcSampler, vec2(uv.x, uv.y * 0.5), 0.0);
    specular = hapticLtcEvaluate(N, V, P, mat3(vec3(t1.x, 0.0, t1.y), vec3(0.0, 1.0, 0.0), vec3(t1.z, 0.0, t1.w)), c0, c1, c2, c3, layer);
  }
}
// The surface's display colour: the lights and the environment's irradiance on its display base colour. Its highlights
// fade out as its \`roughness\` rises from one half (none at one).
vec3 hapticCelLighting(vec3 P, vec3 N, vec3 V, vec3 base, float environmentInfluence, float roughness) {
  // A Scene with its lights disabled draws its colour as it is.
  if (slateCelLight.z > 0.5) return base;
  vec3 dPdx = dFdx(P);
  vec3 dPdy = dFdy(P);
  hapticCelLights result = hapticCelLights(hapticCelLight(vec3(0.0), 0.0), hapticCelLight(vec3(0.0), 0.0), vec3(0.0), 0.0, 0.0, 1.0, -1.0, vec3(0.0));
  bool highlights = slateCelSpecular.x > 0.0;
  // The fill is ambient: its wrapped N.L banded before mixing ground and sky (so it adds no smooth hue gradient), then
  // added after the ramp at its own strength, so a cast shadow shows wherever the fill differs from the lit band. It
  // has no highlight, as on the PBR path.
  vec3 ambient = vec3(0.0);
  if (hapticFillDirection.w > 0.0) {
    ambient = mix(hapticFillGround.rgb, hapticFillSky.rgb, slateCelBand(dot(N, normalize(hapticFillDirection.xyz)) * 0.5 + 0.5));
  }
  // The sun's two cascade lookups, then the lights of P's cluster (\`light-clusters.ts\`), points before spots, in one
  // loop with one shadow lookup, as \`hapticDirectLights\` has.
  hapticSunLookup sun = hapticSunCascade(P);
  float sunShadow = 1.0;
  uvec2 clusterMask = hapticClusterMask(P);
  uint points = hapticClusterLights(clusterMask.x, int(hapticCounts.y));
  uint spots = hapticClusterLights(clusterMask.y & 0xffffu, int(hapticCounts.z));
  for (int slot = 0; slot < 2 + ${HAPTIC_LIGHT_MAXIMUM.point} + ${HAPTIC_LIGHT_MAXIMUM.spot}; slot++) {
    bool spot = false;
    int i = 0;
    vec4 color = vec4(0.0);
    vec3 offset = vec3(0.0);
    float distanceSquared = 0.0;
    float view = -1.0;
    if (slot < 2) {
      if (sun.index >= 0 && (slot == 0 || sun.blends)) view = sun.first + float(sun.index + slot);
    } else {
      spot = points == 0u;
      if (spot && spots == 0u) break;
      if (spot) {
        i = hapticNextLight(spots);
        color = hapticSpot[i * 4 + 2];
        offset = hapticSpot[i * 4].xyz - P;
      } else {
        i = hapticNextLight(points);
        color = hapticPoint[i * 3 + 1];
        offset = hapticPoint[i * 3].xyz - P;
      }
      distanceSquared = dot(offset, offset);
#ifdef HAPTIC_LIGHT_LOOP_PROOF
      hapticLoopVisited++;
#endif
      if (distanceSquared >= color.w * color.w) continue;
#ifdef HAPTIC_LIGHT_LOOP_PROOF
      hapticLoopReached++;
#endif
      view = spot ? hapticSpot[i * 4 + 3].x : hapticPointShadowView(hapticPoint[i * 3 + 2], -offset);
    }
    // Every view takes the pixel's footprint, for CEL's one-pixel shadow edge; only a cascade's receiver plane reads it.
    float lit = hapticShadow(view, P, dPdx, dPdy);
    if (slot == 0) {
      sunShadow = lit;
      continue;
    }
    if (slot == 1) {
      if (sun.blends) sunShadow = mix(lit, sunShadow, sun.blend);
      if (sun.fades) sunShadow = mix(sunShadow, 1.0, sun.fade);
      for (int d = 0; d < ${HAPTIC_LIGHT_MAXIMUM.directional}; d++) {
        if (d >= int(hapticCounts.x)) break;
        vec3 L = normalize(-hapticDirectional[d * 2].xyz);
        vec4 record = hapticDirectional[d * 2 + 1];
        float shadow = record.w > 0.5 ? sunShadow : 1.0;
        vec3 diffuse = record.rgb * max(dot(N, L), 0.0);
        hapticCelAdd(result, diffuse, shadow);
        diffuse *= shadow;
        if (highlights) hapticCelHighlight(result, min(dot(N, normalize(V + L)) - slateCelSpecular.y, slateCelStrength(diffuse) - slateCelBands.w), record.rgb);
      }
      continue;
    }
    vec3 L = normalize(offset);
    float falloff = hapticRangeFalloff(distanceSquared, color.w);
    if (spot) {
      vec4 direction = hapticSpot[i * 4 + 1];
      falloff = falloff * hapticConeFalloff(direction.xyz, L, direction.w, hapticSpot[i * 4 + 3].y);
    }
    vec3 diffuse = color.rgb * (max(dot(N, L), 0.0) * falloff);
    hapticCelAdd(result, diffuse, lit);
    diffuse *= lit;
    if (highlights) hapticCelHighlight(result, min(dot(N, normalize(V + L)) - slateCelSpecular.y, slateCelStrength(diffuse) - slateCelBands.w), color.rgb);
  }
  // Rect lights: the highlight is the specular form factor past its threshold, where the light reaches the lit band.
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.rect}; i++) {
    if (i >= int(hapticCounts.w)) break;
    vec3 areaDiffuse;
    vec3 areaSpecular;
    hapticCelAreaLight(P, N, V, i, areaDiffuse, areaSpecular);
    vec3 color = hapticRect[i * 4 + 3].rgb;
    vec3 diffuse = color * areaDiffuse;
    hapticCelAdd(result, diffuse, 1.0);
    if (highlights) hapticCelHighlight(result, min(slateCelStrength(areaSpecular) - slateCelSpecular.z, slateCelStrength(diffuse) - slateCelBands.w), color * areaSpecular);
  }
  if (slateCelEnvironment.x > 0.0) hapticCelAdd(result, slateCelEnvironmentLight(N) * environmentInfluence, 1.0);
  // After the loop, in uniform control flow: the ramp, its edge as wide as the unshadowed light's change across the
  // pixel, then the fill, then the shadow's and the highlight's anti-aliased edges.
  float rampOn = slateCelShift(hapticCelBrightness(result.on));
  float rampOpen = slateCelShift(slateCelLight.y > 0.5 && slateCelLight.y < 1.5 ? slateCelStrength(result.open) : result.openPeak);
  float width = min(slateCelEdge(rampOn), slateCelEdge(rampOpen));
  vec3 light = hapticCelSurfaceLight(result.on, slateCelRamp(rampOn, width), ambient);
  if (result.coverage < 1.0) {
    float rampOff = slateCelShift(hapticCelBrightness(result.off));
    light = mix(hapticCelSurfaceLight(result.off, slateCelRamp(rampOff, width), ambient), light, result.coverage);
  }
  // The Material's gloss scales the highlight's strength after its edge, never its shape.
  float gloss = clamp(2.0 * (1.0 - roughness), 0.0, 1.0);
  return light * base + slateCelStep(result.signal) * slateCelSpecular.x * gloss * slateCelTint(result.highlight);
}
#endif

#ifndef HAPTIC_CEL
// The split-sum table: x scales F90 - F0, y scales F0.
vec3 hapticBrdfLookup(float NdotV, float roughness) {
  vec4 lookup = texture(hapticEnvironmentBrdfSampler, vec2(NdotV, roughness));
#ifdef HAPTIC_BRDF_RGBD
  return hapticFromRGBD(lookup);
#else
  return lookup.rgb;
#endif
}
#endif

#ifdef HAPTIC_ENVIRONMENT
// The environment's presence and form are bound values, not variants (\`hapticEnvironmentForm\`: x a reflection probe's
// box projection, y and z the signs of the cube's y and z axes, w its encoding: 0 linear, 1 gamma, 2 RGBD), so an
// environment that appears, a probe's volume a mesh enters or a cube of another encoding compiles nothing.
// World direction into the cube's frame (its rotation and handedness).
vec3 hapticEnvironmentDirection(vec3 direction) {
  return (hapticEnvironmentMatrix * vec4(direction, 0.0)).xyz * vec3(1.0, hapticEnvironmentForm.yz);
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
  if (hapticEnvironmentForm.x > 0.5) {
    vec3 halfSize = hapticEnvironmentBoxSize.xyz * 0.5;
    vec3 farthest = max((hapticEnvironmentBoxPosition.xyz + halfSize - P) / R, (hapticEnvironmentBoxPosition.xyz - halfSize - P) / R);
    R = P + R * min(min(farthest.x, farthest.y), farthest.z) - hapticEnvironmentBoxPosition.xyz;
  }
  float lod = log2(hapticEnvironment.x * alpha) * hapticEnvironment.y + hapticEnvironment.z;
  vec4 radiance = textureLod(hapticEnvironmentSampler, hapticEnvironmentDirection(R), lod);
  if (hapticEnvironmentForm.w > 1.5) return hapticFromRGBD(radiance);
  if (hapticEnvironmentForm.w > 0.5) return hapticToLinear(radiance.rgb);
  return radiance.rgb;
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
${output.diffuseDirect} = hapticToLinear(max(hapticCelLighting(hapticP, hapticN, hapticV, slateCelTextureToDisplay(${input.baseColor}), hapticInfluence,
  clamp(${input.roughness}, 0.0, 1.0)), vec3(0.0)));
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
#ifdef HAPTIC_SCREEN_SHADOWS
hapticScreenLit = hapticScreenShadowLit(hapticP, ${input.cameraPosition});
#endif
hapticDirectLights(hapticS, hapticP, hapticN, hapticV, hapticDiffuseLight, hapticSpecularLight);
${output.diffuseDirect} = hapticDiffuseLight * hapticS.diffuse;
${output.specularDirect} = max(hapticSpecularLight, vec3(0.0)) * hapticEnergy;
#ifdef HAPTIC_ENVIRONMENT
float hapticEnvironmentScale = hapticEnvironment.w * hapticInfluence;
// Zero where no environment lights the mesh (the Scene has none, or its intensity or the Material's influence is zero).
if (hapticEnvironmentScale > 0.0) {
  ${output.diffuseIndirect} = hapticIrradiance(hapticN) * hapticEnvironmentScale * hapticS.diffuse;
  float hapticHorizon = clamp(1.0 + 1.1 * dot(reflect(-hapticV, hapticN), hapticGeometricN), 0.0, 1.0);
  float hapticOcclusion = hapticHorizon * hapticHorizon * clamp((hapticNdotVUnclamped + 1.0) * (hapticNdotVUnclamped + 1.0), 0.0, 1.0);
  vec3 hapticReflectance = (vec3(1.0) - hapticS.F0) * hapticBrdf.x + hapticS.F0 * hapticBrdf.y;
  ${output.specularIndirect} = hapticRadiance(hapticP, hapticN, hapticV, hapticAlpha(hapticS.roughness)) * hapticEnvironmentScale * hapticReflectance * hapticOcclusion * hapticEnergy;
}
#endif
#endif
#ifdef HAPTIC_LIGHT_LOOP_PROOF
// Visited, in-range and in-cluster light counts, 4/255 apart in display space; nothing else lights the pixel.
uvec2 hapticProofMask = hapticClusterMask(hapticP);
float hapticProofCluster = float(hapticBitCount(hapticProofMask.x) + hapticBitCount(hapticProofMask.y & 0xffffu));
${output.diffuseDirect} = hapticToLinear(vec3(float(hapticLoopVisited), float(hapticLoopReached), hapticProofCluster) * (4.0 / 255.0));
${output.specularDirect} = vec3(0.0);
${output.diffuseIndirect} = vec3(0.0);
${output.specularIndirect} = vec3(0.0);
#endif
`;
}
