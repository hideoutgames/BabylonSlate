import { HAPTIC_LIGHT_MAXIMUM } from "./haptic-lights";

/**
 * The lighting function of `HapticLightingBlock` (GLSL): a metallic-roughness surface lit by the `HapticLights` block
 * and the Scene's environment cube. GGX distribution, height-correlated Smith visibility and Schlick Fresnel for
 * specular, Lambert for diffuse, the split-sum environment BRDF table with multi-scatter energy compensation, and
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

// Every light of the block: diffuse irradiance (before the surface's diffuse colour) and specular radiance.
void hapticDirectLights(hapticSurface surface, vec3 P, vec3 N, vec3 V, inout vec3 diffuse, inout vec3 specular) {
  if (hapticCounts.w > 0.0) {
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
    vec4 position = hapticSpot[i * 3];
    vec4 direction = hapticSpot[i * 3 + 1];
    vec4 color = hapticSpot[i * 3 + 2];
    vec3 offset = position.xyz - P;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) continue;
    float lightDistance = sqrt(distanceSquared);
    vec3 L = offset / max(lightDistance, HAPTIC_EPSILON);
    float NdotL = hapticSaturateEps(dot(N, L));
    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w);
    diffuse += radiance * (NdotL / HAPTIC_PI);
    float roughness = clamp(position.w / max(lightDistance, HAPTIC_EPSILON) + surface.roughness, 0.0, 1.0);
    specular += hapticSpecular(surface, N, V, L, NdotL, roughness) * radiance;
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
  if (hapticCounts.w > 0.0) {
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
    vec4 direction = hapticSpot[i * 3 + 1];
    vec4 color = hapticSpot[i * 3 + 2];
    vec3 offset = hapticSpot[i * 3].xyz - P;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared >= color.w * color.w) continue;
    vec3 L = normalize(offset);
    float NdotL = max(dot(N, L), 0.0);
    float falloff = hapticRangeFalloff(distanceSquared, color.w) * hapticConeFalloff(direction.xyz, L, direction.w);
    // The cone never reaches zero, so the highlight stops at its half angle.
    float inCone = step(direction.w, dot(-L, direction.xyz));
    hapticCelAdd(result, color.rgb * (NdotL * falloff), hapticCelHighlight(N, V, L, NdotL, color.rgb) * inCone);
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
  baseColor: string; metallic: string; roughness: string; environmentInfluence: string;
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
hapticSurface hapticS;
hapticS.diffuse = ${input.baseColor} * (0.96 * (1.0 - hapticMetallic));
hapticS.F0 = mix(vec3(0.04), ${input.baseColor}, hapticMetallic);
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
