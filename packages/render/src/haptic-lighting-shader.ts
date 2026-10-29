import { HAPTIC_LIGHT_MAXIMUM } from "./haptic-lights";

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

export const HAPTIC_LIGHTING_FUNCTIONS_GLSL = `
#define HAPTIC_PI 3.1415926535897932
#define HAPTIC_EPSILON 0.0000001
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

// A spot light's cone: a spherical Gaussian around its direction, at 1% at the cone's half angle.
float hapticConeFalloff(vec3 lightDirection, vec3 L, float cosHalfAngle) {
  float kappa = 6.64385618977 / (1.0 - cosHalfAngle);
  return exp2(dot(vec4(L, 1.0), vec4(-lightDirection * kappa, -kappa)));
}

// A light's shadow from its view of the atlas (\`hapticShadowViews\`): 1 where lit, the view's darkness where shadowed; 1
// without a view (index < 0), outside its frustum and on a mesh that does not receive shadows. Babylon's PCF at the
// view's filter quality (0 low, 1 medium, 2 high: its computeShadowWithPCF1, 3 and 5): one, four or nine weighted
// bilinear compare taps, each kept a texel inside the view's tile so a neighbouring tile never bleeds in.
float hapticShadowTap(vec4 tile, vec2 texel, float depth) {
  return textureLod(hapticShadowAtlas, vec3(clamp(tile.xy + texel * tile.w, tile.xy + tile.w, tile.xy + tile.z - tile.w), depth), 0.0);
}

float hapticShadow(float index, vec3 P) {
  if (index < 0.0 || hapticShadowReceiver == 0.0) return 1.0;
  int base = int(index) * 6;
  vec4 clip = mat4(hapticShadowViews[base], hapticShadowViews[base + 1], hapticShadowViews[base + 2], hapticShadowViews[base + 3]) * vec4(P, 1.0);
  if (clip.w <= 0.0) return 1.0;
  vec3 ndc = clip.xyz / clip.w;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float depth = ndc.z * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth < 0.0 || depth > 1.0) return 1.0;
  vec4 tile = hapticShadowViews[base + 4];
  vec4 shading = hapticShadowViews[base + 5];
  vec2 texels = uv * (tile.z / tile.w);
  if (shading.y < 0.5) return mix(shading.x, 1.0, hapticShadowTap(tile, texels, depth));
  vec2 st = fract(texels + 0.5);
  vec2 corner = floor(texels + 0.5) - 0.5;
  float lit;
  if (shading.y < 1.5) {
    vec2 w0 = 3.0 - 2.0 * st;
    vec2 w1 = 1.0 + 2.0 * st;
    vec2 a = corner + (2.0 - st) / w0 - 1.0;
    vec2 b = corner + st / w1 + 1.0;
    lit = (w0.x * w0.y * hapticShadowTap(tile, vec2(a.x, a.y), depth) + w1.x * w0.y * hapticShadowTap(tile, vec2(b.x, a.y), depth)
      + w0.x * w1.y * hapticShadowTap(tile, vec2(a.x, b.y), depth) + w1.x * w1.y * hapticShadowTap(tile, vec2(b.x, b.y), depth)) / 16.0;
  } else {
    vec2 w0 = 4.0 - 3.0 * st;
    vec2 w2 = 1.0 + 3.0 * st;
    vec2 a = corner + (3.0 - 2.0 * st) / w0 - 2.0;
    vec2 b = corner + (3.0 + st) / 7.0;
    vec2 c = corner + st / w2 + 2.0;
    lit = (w0.x * w0.y * hapticShadowTap(tile, vec2(a.x, a.y), depth) + 7.0 * w0.y * hapticShadowTap(tile, vec2(b.x, a.y), depth)
      + w2.x * w0.y * hapticShadowTap(tile, vec2(c.x, a.y), depth) + w0.x * 7.0 * hapticShadowTap(tile, vec2(a.x, b.y), depth)
      + 49.0 * hapticShadowTap(tile, vec2(b.x, b.y), depth) + w2.x * 7.0 * hapticShadowTap(tile, vec2(c.x, b.y), depth)
      + w0.x * w2.y * hapticShadowTap(tile, vec2(a.x, c.y), depth) + 7.0 * w2.y * hapticShadowTap(tile, vec2(b.x, c.y), depth)
      + w2.x * w2.y * hapticShadowTap(tile, vec2(c.x, c.y), depth)) / 144.0;
  }
  return mix(shading.x, 1.0, lit);
}

// Rect area lights: linearly transformed cosines from Babylon's two 64x64 tables (its ltcHelperFunctions).
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
    vec3 color = hapticDirectional[i * 2 + 1].rgb;
    diffuse += color * (NdotL / HAPTIC_PI);
    specular += hapticSpecular(surface, N, V, L, NdotL, surface.roughness) * color;
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= int(hapticCounts.y)) break;
    vec4 position = hapticPoint[i * 2];
    vec4 color = hapticPoint[i * 2 + 1];
    vec3 offset = position.xyz - P;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) continue;
    float lightDistance = sqrt(distanceSquared);
    vec3 L = offset / max(lightDistance, HAPTIC_EPSILON);
    float NdotL = hapticSaturateEps(dot(N, L));
    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w);
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
    if (distanceSquared >= color.w * color.w) continue;
    float lightDistance = sqrt(distanceSquared);
    vec3 L = offset / max(lightDistance, HAPTIC_EPSILON);
    float NdotL = hapticSaturateEps(dot(N, L));
    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w)
      * hapticShadow(hapticSpot[i * 4 + 3].x, P);
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
    vec3 color = hapticDirectional[i * 2 + 1].rgb;
    hapticCelAdd(result, color * NdotL, hapticCelHighlight(N, V, L, NdotL, color));
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= int(hapticCounts.y)) break;
    vec4 color = hapticPoint[i * 2 + 1];
    vec3 offset = hapticPoint[i * 2].xyz - P;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) continue;
    vec3 L = normalize(offset);
    float NdotL = max(dot(N, L), 0.0);
    hapticCelAdd(result, color.rgb * (NdotL * hapticRangeFalloff(distanceSquared, color.w)), hapticCelHighlight(N, V, L, NdotL, color.rgb));
  }
  for (int i = 0; i < ${HAPTIC_LIGHT_MAXIMUM.spot}; i++) {
    if (i >= int(hapticCounts.z)) break;
    vec4 direction = hapticSpot[i * 4 + 1];
    vec4 color = hapticSpot[i * 4 + 2];
    vec3 offset = hapticSpot[i * 4].xyz - P;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) continue;
    vec3 L = normalize(offset);
    float NdotL = max(dot(N, L), 0.0);
    float falloff = hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w);
    // The cone never reaches zero, so the highlight stops at its half angle.
    float inCone = step(direction.w, dot(-L, direction.xyz));
    // CEL's hard shadow edge, as Babylon's CEL light block steps the shadow.
    float shadow = slateCelShadowVisibility(hapticShadow(hapticSpot[i * 4 + 3].x, P));
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
`;
}

/** The same functions in WGSL. */
export const HAPTIC_LIGHTING_FUNCTIONS_WGSL = `
const HAPTIC_PI: f32 = 3.1415926535897932;
const HAPTIC_EPSILON: f32 = 0.0000001;
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

fn hapticConeFalloff(lightDirection: vec3f, L: vec3f, cosHalfAngle: f32) -> f32 {
  let kappa = 6.64385618977 / (1.0 - cosHalfAngle);
  return exp2(dot(vec4f(L, 1.0), vec4f(-lightDirection * kappa, -kappa)));
}

fn hapticShadowTap(tile: vec4f, texel: vec2f, depth: f32) -> f32 {
  return textureSampleCompareLevel(hapticShadowAtlas, hapticShadowAtlasSampler,
    clamp(tile.xy + texel * tile.w, tile.xy + vec2f(tile.w), tile.xy + vec2f(tile.z - tile.w)), depth);
}

fn hapticShadow(index: f32, P: vec3f) -> f32 {
  if (index < 0.0 || uniforms.hapticShadowReceiver == 0.0) { return 1.0; }
  let base = i32(index) * 6;
  let clip = mat4x4f(HapticLights.hapticShadowViews[base], HapticLights.hapticShadowViews[base + 1], HapticLights.hapticShadowViews[base + 2],
    HapticLights.hapticShadowViews[base + 3]) * vec4f(P, 1.0);
  if (clip.w <= 0.0) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * 0.5 + 0.5;
  // WebGPU's depth range is zero to one.
  let depth = ndc.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth < 0.0 || depth > 1.0) { return 1.0; }
  let tile = HapticLights.hapticShadowViews[base + 4];
  let shading = HapticLights.hapticShadowViews[base + 5];
  let texels = uv * (tile.z / tile.w);
  if (shading.y < 0.5) { return mix(shading.x, 1.0, hapticShadowTap(tile, texels, depth)); }
  let st = fract(texels + 0.5);
  let corner = floor(texels + 0.5) - 0.5;
  var lit: f32;
  if (shading.y < 1.5) {
    let w0 = 3.0 - 2.0 * st;
    let w1 = 1.0 + 2.0 * st;
    let a = corner + (2.0 - st) / w0 - 1.0;
    let b = corner + st / w1 + 1.0;
    lit = (w0.x * w0.y * hapticShadowTap(tile, vec2f(a.x, a.y), depth) + w1.x * w0.y * hapticShadowTap(tile, vec2f(b.x, a.y), depth)
      + w0.x * w1.y * hapticShadowTap(tile, vec2f(a.x, b.y), depth) + w1.x * w1.y * hapticShadowTap(tile, vec2f(b.x, b.y), depth)) / 16.0;
  } else {
    let w0 = 4.0 - 3.0 * st;
    let w2 = 1.0 + 3.0 * st;
    let a = corner + (3.0 - 2.0 * st) / w0 - 2.0;
    let b = corner + (3.0 + st) / 7.0;
    let c = corner + st / w2 + 2.0;
    lit = (w0.x * w0.y * hapticShadowTap(tile, vec2f(a.x, a.y), depth) + 7.0 * w0.y * hapticShadowTap(tile, vec2f(b.x, a.y), depth)
      + w2.x * w0.y * hapticShadowTap(tile, vec2f(c.x, a.y), depth) + w0.x * 7.0 * hapticShadowTap(tile, vec2f(a.x, b.y), depth)
      + 49.0 * hapticShadowTap(tile, vec2f(b.x, b.y), depth) + w2.x * 7.0 * hapticShadowTap(tile, vec2f(c.x, b.y), depth)
      + w0.x * w2.y * hapticShadowTap(tile, vec2f(a.x, c.y), depth) + 7.0 * w2.y * hapticShadowTap(tile, vec2f(b.x, c.y), depth)
      + w2.x * w2.y * hapticShadowTap(tile, vec2f(c.x, c.y), depth)) / 144.0;
  }
  return mix(shading.x, 1.0, lit);
}

fn hapticLtcEdge(v1: vec3f, v2: vec3f) -> vec3f {
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
    let color = HapticLights.hapticDirectional[i * 2 + 1].rgb;
    *diffuse += color * (NdotL / HAPTIC_PI);
    *specular += hapticSpecular(surface, N, V, L, NdotL, surface.roughness) * color;
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= i32(HapticLights.hapticCounts.y)) { break; }
    let position = HapticLights.hapticPoint[i * 2];
    let color = HapticLights.hapticPoint[i * 2 + 1];
    let offset = position.xyz - P;
    let distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) { continue; }
    let lightDistance = sqrt(distanceSquared);
    let L = offset / max(lightDistance, HAPTIC_EPSILON);
    let NdotL = hapticSaturateEps(dot(N, L));
    let radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w);
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
    if (distanceSquared >= color.w * color.w) { continue; }
    let lightDistance = sqrt(distanceSquared);
    let L = offset / max(lightDistance, HAPTIC_EPSILON);
    let NdotL = hapticSaturateEps(dot(N, L));
    let radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w)
      * hapticShadow(HapticLights.hapticSpot[i * 4 + 3].x, P);
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
    let color = HapticLights.hapticDirectional[i * 2 + 1].rgb;
    hapticCelAdd(&result, color * NdotL, hapticCelHighlight(N, V, L, NdotL, color));
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.point}; i++) {
    if (i >= i32(HapticLights.hapticCounts.y)) { break; }
    let color = HapticLights.hapticPoint[i * 2 + 1];
    let offset = HapticLights.hapticPoint[i * 2].xyz - P;
    let distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) { continue; }
    let L = normalize(offset);
    let NdotL = max(dot(N, L), 0.0);
    hapticCelAdd(&result, color.rgb * (NdotL * hapticRangeFalloff(distanceSquared, color.w)), hapticCelHighlight(N, V, L, NdotL, color.rgb));
  }
  for (var i: i32 = 0; i < ${HAPTIC_LIGHT_MAXIMUM.spot}; i++) {
    if (i >= i32(HapticLights.hapticCounts.z)) { break; }
    let direction = HapticLights.hapticSpot[i * 4 + 1];
    let color = HapticLights.hapticSpot[i * 4 + 2];
    let offset = HapticLights.hapticSpot[i * 4].xyz - P;
    let distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) { continue; }
    let L = normalize(offset);
    let NdotL = max(dot(N, L), 0.0);
    let falloff = hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w);
    let inCone = step(direction.w, dot(-L, direction.xyz));
    let shadow = slateCelShadowVisibility(hapticShadow(HapticLights.hapticSpot[i * 4 + 3].x, P));
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
`;
}
