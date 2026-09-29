import { Color3, DirectionalLight, HemisphericLight, MaterialPluginBase, Matrix, PBRMaterial, type MaterialDefines, RawTexture, ShaderLanguage, Texture, Vector3, type AbstractMesh, type Scene, type UniformBuffer } from "@babylonjs/core";
import { WATER_CREST_MEAN, WATER_CREST_RANGE, waterWaveComponents, type WaterBodyProperties, type WaterColor, type WaterDefinition } from "@babylonslate/core";
import type { WaterContactField } from "./water-contact-field";
import { WATER_FIELD_DEPTH_RANGE, WATER_FIELD_FINE_DEPTH_SPAN, WATER_FIELD_SHORE_RANGE as SHORE, type WaterField } from "./water-field";
import { sceneWaterRemovals, waterRemovalShapeVector, waterRemovalWorldRadius } from "./water-removal-mesh";

/**
 * Wind-chop octaves: [heading offset (radians), wavenumber multiplier, slope, speed, phase].
 * Sharp-crested `exp(sin - 1)` waves with a little domain drag read as wind chop rather than
 * the regular interference of plain sines. All are world-space and advect with the current.
 * Realistic uses all six (WebGL shader-size budget, with headroom for four lights); Stylized uses the first three.
 */
const DETAIL_OCTAVES = [
  [0.0, 1.0, 0.22, 1.0, 0.0], [0.9, 1.61, 0.2, 0.93, 1.7], [-0.7, 2.59, 0.17, 1.07, 4.1],
  [2.1, 4.17, 0.14, 0.9, 2.3], [-1.9, 6.71, 0.11, 1.1, 5.6], [0.35, 10.8, 0.08, 0.95, 0.9],
] as const;
const STYLIZED_OCTAVES = 3;

/** Compile-time style switch: each material compiles only its own style's shading. */
export const WATER_STYLIZED_DEFINE = "SLATE_WATER_STYLIZED";

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
float swCells(vec2 p) {
  vec2 b = floor(p - vec2(0.5));
  float d0 = swCellDistance(p, b);
  float d1 = swCellDistance(p, b + vec2(1.0, 0.0));
  float d2 = swCellDistance(p, b + vec2(0.0, 1.0));
  float d3 = swCellDistance(p, b + vec2(1.0, 1.0));
  float swNear = min(min(d0, d1), min(d2, d3));
  float swSecond = min(min(max(d0, d1), max(d2, d3)), max(min(d0, d1), min(d2, d3)));
  return swSecond - swNear;
}
`;

const f = (n: number) => n.toFixed(6);

type WaterShaderStyle = "realistic" | "stylized";

/** Swell, wind chop, contacts and depth shared by both styles; Stylized runs fewer chop octaves. */
function surfaceSource(style: WaterShaderStyle): string {
  const realistic = style === "realistic";
  const swell = waterWaveComponents.map(([turn, frequency, amplitude, phase], i) => `
float swK${i} = ${f(2 * Math.PI * frequency)} / U.slateWaterWaves.y;
vec2 swD${i} = vec2(cos(U.slateWaterWaves.w + ${f(turn)} * swSpread), sin(U.slateWaterWaves.w + ${f(turn)} * swSpread));
float swP${i} = swK${i} * dot(swD${i}, swWorld) - sqrt(9.81 * swK${i}) * U.slateWaterWaves.z * swTime + ${f(phase)};
float swA${i} = U.slateWaterWaves.x * ${f(amplitude)};
float swFd${i} = 1.0 - smoothstep(0.6, 2.2, swK${i} * (abs(dot(swD${i}, swFootX)) + abs(dot(swD${i}, swFootY))));
float swF${i} = swFd${i} * swA${i};
float swS${i} = sin(swP${i});
float swC${i} = cos(swP${i});
float swE${i} = exp(swS${i} - 1.0);
swHeight += mix(swS${i}, (swE${i} - ${f(WATER_CREST_MEAN)}) / ${f(WATER_CREST_RANGE)}, swChopShape) * swF${i};
swGradient += swD${i} * (mix(swC${i}, swE${i} * swC${i} / ${f(WATER_CREST_RANGE)}, swChopShape) * swK${i} * swF${i});
swFold += swK${i} * swF${i} * mix(swS${i}, swE${i} * (swS${i} - swC${i} * swC${i}) / ${f(WATER_CREST_RANGE)}, swChopShape);
swSteep += swK${i} * swA${i};
swResolved += swK${i} * swF${i};${realistic ? `
swLost += swK${i} * swA${i} * swK${i} * swA${i} * (1.0 - swFd${i} * swFd${i});` : ""}`).join("");
  const octaves = realistic ? DETAIL_OCTAVES : DETAIL_OCTAVES.slice(0, STYLIZED_OCTAVES);
  const detail = octaves.map(([turn, multiplier, slope, speed, phase], i) => `
float swOK${i} = swBaseK * ${f(multiplier)};
vec2 swOD${i} = vec2(cos(U.slateWaterWaves.w + ${f(turn)}), sin(U.slateWaterWaves.w + ${f(turn)}));
float swOX${i} = swOK${i} * dot(swOD${i}, swChop) - sqrt(9.81 * swOK${i}) * ${f(speed)} * U.slateWaterWaves.z * swTime + ${f(phase)};
float swOW${i} = exp(sin(swOX${i}) - 1.0);
float swOFd${i} = 1.0 - smoothstep(0.3, 1.1, swOK${i} * swFoot);
float swOA${i} = ${f(realistic ? slope : slope * (1 - Math.min(0.85, i * 0.14)))} * swOFd${i};
swDetail += swOD${i} * (swOW${i} * cos(swOX${i}) * swOA${i});
swChopH += (swOW${i} - 0.37) * swOA${i};
swChop -= swOD${i} * (swOW${i} * cos(swOX${i}) * 0.3 / swOK${i});${realistic ? `
swLostDetail += ${f(0.07 * slope * slope)} * (1.0 - swOFd${i} * swOFd${i});` : ""}`).join("");
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
vec2 swFlowed = swWorld - IN.vSlateWaterFlow.xz * swTime;
float swHeight = 0.0;
vec2 swGradient = vec2(0.0);
// Crest sharpness a*k*(-P''): positive and largest on steep, sharp crests.
float swFold = 0.0;
float swSteep = 0.0;
float swResolved = 0.0;${realistic ? `
float swLost = 0.0;
float swLostDetail = 0.0;` : ""}
float swChopShape = U.slateWaterShape.x;
float swSpread = U.slateWaterShape.y * 2.0;
${swell}
float swBaseK = 6.2831853 * U.slateWaterMotion.y / 6.0;
// Anti-tiling: the chop domain turns slowly across the surface and gusts roughen or calm patches.
float swLarge = swNoise(swWorld * 0.07);
float swGust = swNoise(swWorld * 0.013 + vec2(swTime * 0.004, 0.0));
float swTurn = (swNoise(swWorld * 0.021 + vec2(3.7, 1.3)) - 0.5) * 1.6;
vec2 swChop = vec2(swFlowed.x * cos(swTurn) - swFlowed.y * sin(swTurn), swFlowed.x * sin(swTurn) + swFlowed.y * cos(swTurn));
vec2 swDetail = vec2(0.0);
float swChopH = 0.0;
${detail}
// What meets the water: terrain shoreline and true depth, and objects crossing the surface.
// Values stay continuous at the field's edges and range limits, so derivative-based antialiasing never spikes.
float swFieldShore = mix(${f(SHORE[1])}, swTerrainShore, swFieldOn);
float swKnown = swField.a * swFieldOn;
// Distance to the object waterline at this fragment's rendered height (metres; contacts sampled in the cut code).
float swObject = abs(swContactSigned);
float swBank = min(min(max(0.0, IN.vSlateWater.y), max(0.0, swFieldShore)), ${f(SHORE[1])});
float swBodyDepth = max(0.01, IN.vSlateWater.z);
float swMedium = swNoise(swFlowed * 0.43 + vec2(swTime * 0.03, 0.0));
float swFine = swNoise(swFlowed * 2.9 - vec2(0.0, swTime * 0.09));
float swFoamWidth = max(0.001, U.slateWaterMotion.w);
float swCalm = smoothstep(0.0, swFoamWidth * 2.0 + 0.5, swBank);
vec3 swBaseNormal = normalize(IN.vSlateWaterBaseNormal);
// Small waves around objects that cut the surface: they travel outward at the deep-water speed of their
// wavelength, fade with distance, and a drifting noise bends and breaks them so they never read as perfect rings.
float swContactW = max(0.05, U.slateWaterShape.w);
float swOutside = max(swContactSigned, 0.0);
float swRippleK = 6.2831853 / (0.35 + swContactW * 0.45);
float swRippleNoise = swNoise(swWorld * 1.3 + vec2(swTime * 0.13, swTime * -0.07));
float swRipplePhase = swRippleK * swOutside - sqrt(9.81 * swRippleK) * swTime + swRippleNoise * 2.6;
float swRippleAA = 1.0 - smoothstep(0.6, 1.8, fwidth(swRipplePhase));
// Distances clamp at the contact range: fade out before it, so open water carries no ripple residue.
float swNearContact = 1.0 - smoothstep(0.55, 0.95, swObject / max(0.001, U.slateWaterContactInfo.y));
float swRippleFade = exp(-swOutside / (swContactW * 1.4)) * smoothstep(-0.05, 0.08, swContactSigned) * swRippleAA * swNearContact;
float swAgitate = exp(-swObject / swContactW) * swRippleAA * swNearContact;
vec2 swRipple = swContactDir * (cos(swRipplePhase) * swRippleFade * (0.1 + 0.3 * U.slateWaterMotion.z) * (0.45 + 0.55 * swRippleNoise));
float swChopGain = U.slateWaterMotion.z * (0.35 + 0.65 * swCalm + swAgitate) * (0.5 + swGust);
vec2 swSlope = swGradient + swDetail * swChopGain + swRipple;
float swBaseX = swBaseNormal.x / max(0.001, swBaseNormal.y);
float swBaseZ = swBaseNormal.z / max(0.001, swBaseNormal.y);
normalW = normalize(vec3(swBaseX - swSlope.x, 1.0, swBaseZ - swSlope.y));
// The swell alone, without chop: the large-scale wave shape used for lighting through crests.
vec3 swSwellNormal = normalize(vec3(swBaseX - swGradient.x, 1.0, swBaseZ - swGradient.y));

// Bottom estimate: a shelving bank with an irregular floor, capped by the component Depth.
float swShelf = 0.28 + 0.35 * swLarge;
float swDepth = mix(swBodyDepth * (1.0 - exp(-swBank * swShelf / swBodyDepth)), max(0.0, swTerrainDepth), swKnown);
float swAbsorb = max(0.01, U.slateWaterLook.y);
float swTone = 1.0 - exp(-swDepth * 2.0 / swAbsorb);
float swCrest = swHeight / max(0.001, U.slateWaterWaves.x);
// Crest sharpness relative to what the waves can reach, gated by how steep the sea is (long gentle swell and small
// lake waves never break) and by how much of the swell is still resolved, so distant filtered swell never breaks
// in regular rows.
float swFoldN = swFold / max(0.0001, swSteep * (1.0 + swChopShape * ${f(1 / WATER_CREST_RANGE - 1)}));
float swRough = smoothstep(0.03, 0.35, swSteep) * smoothstep(0.5, 0.9, swResolved / max(0.0001, swSteep));
vec2 swWindDir = vec2(cos(U.slateWaterWaves.w), sin(U.slateWaterWaves.w));

vec3 swL = U.slateWaterSun.xyz;
vec3 swSun = U.slateWaterSunColor.rgb * U.slateWaterSun.w;
vec3 swAmb = U.slateWaterLight.rgb;
float swFoamAmount = U.slateWaterFoam.w;
// Contact foam keeps its own strength: a low Foam Amount calms shores and crests but still marks every
// waterline on objects; only a Foam Amount near zero (or Contact Foam Width 0) removes it.
float swContactStrength = smoothstep(0.0, 0.1, swFoamAmount) * max(swFoamAmount, 0.85) * smoothstep(0.0, 0.05, U.slateWaterShape.w);

// Sun glints on a jittered world grid; they twinkle and fade before they would alias.
vec2 swSparkUv = swFlowed * 0.9 * U.slateWaterMotion.y;
vec2 swCellId = floor(swSparkUv);
float swRnd = swHash(swCellId);
vec2 swJitter = vec2(swHash(swCellId + vec2(17.0, 3.0)), swHash(swCellId + vec2(5.0, 29.0))) - vec2(0.5);
vec2 swDelta = fract(swSparkUv) - vec2(0.5) - swJitter * 0.6;
float swTwinkle = pow(max(0.0, sin(swTime * (2.0 + swRnd * 3.0) + swRnd * 40.0)), 10.0);
float swCore = max(0.0, 1.0 - length(swDelta) * 7.0);
float swSparkBase = swCore * swCore * swTwinkle * smoothstep(0.4, 0.5, swRnd) * (1.0 - smoothstep(0.1, 0.35, swFoot * 0.9 * U.slateWaterMotion.y)) * U.slateWaterLook.z * min(1.0, U.slateWaterSun.w);
`;
}

/**
 * Realistic: lit PBR. Everything here is premultiplied by coverage; `CUSTOM_FRAGMENT_BEFORE_FOG` divides by alpha so
 * standard blending yields reflection + specular + (1 - F) * (T * background + (1 - T) * in-scattered light).
 */
function realisticSource(): string {
  return surfaceSource("realistic") + `
vec3 swV = viewDirectionW;
// Keep reflected rays above the horizon: below it the water would reflect only more water, never the ground
// half of the sky. The shading normal becomes the half vector between the view and the clamped reflection.
// Detail filtered away at a distance still roughens the surface (bounded), so far water keeps a broad sun path.
// Toward the horizon the chop flattens into the swell, so distant water keeps reflecting the horizon sky.
normalW = normalize(mix(normalW, swSwellNormal, pow(1.0 - clamp(swV.y, 0.0, 1.0), 12.0) * 0.6));
// Rougher (filtered) water lifts its reflection further, so a blurred lobe stays in the sky.
swSlopeVariance = min(swLost + swLostDetail * swChopGain * swChopGain, 0.004);
vec3 swRefl = reflect(-swV, normalW);
swRefl.y = mix(swRefl.y, max(swRefl.y, 0.025 + sqrt(swSlopeVariance) * 1.2), step(0.0, swV.y));
normalW = normalize(swV + normalize(swRefl));
float swNdotV = clamp(dot(normalW, swV), 0.0, 1.0);
float swFres = 0.02 + 0.98 * pow(1.0 - swNdotV, 5.0);
// Beer-Lambert absorption down to the floor and back along the refracted ray (water IOR 1.333).
float swCosT = sqrt(1.0 - (1.0 - swNdotV * swNdotV) * 0.5625);
float swTransmit = max(exp(-swDepth * (1.0 + 1.0 / swCosT) / swAbsorb), 1.0 - U.slateWaterShallow.a);
vec3 swCol = mix(U.slateWaterShallow.rgb, U.slateWaterDeep.rgb, swTone);
// In-scattering: sky and sun light the body; sunlight passing through thin crests turns them bright and
// green when seen toward the sun, and wave tops stay a little lighter from every side (Subsurface).
float swSwellDotV = clamp(dot(swSwellNormal, swV), 0.0, 1.0);
float swBehind = pow(max(dot(swL, -swV), 0.0), 4.0);
float swPeak = clamp(swCrest * 0.5 + 0.5 + swChopH * 0.6, 0.0, 1.2);
float swThrough = U.slateWaterLook.w * (swBehind * swPeak * (1.0 - swSwellDotV * 0.5) * 1.6 + smoothstep(0.2, 0.9, swFoldN) * swRough * 0.15);
vec3 swScatter = swCol * (swAmb * 0.75 + swSun * (0.3 * swSwellDotV * swSwellDotV + 0.3 * max(dot(swSwellNormal, swL), 0.0)))
  + U.slateWaterShallow.rgb * vec3(0.9, 1.15, 0.85) * swSun * swThrough;

// Foam: a clumpy, bubbly pattern thresholded by a foam density (Crest-style), so dense foam is solid, then
// breaks into lace and scattered patches as it thins.
vec2 swFoamUv = swFlowed * 1.1 + swSlope * 0.4 + vec2(swMedium - 0.5, swFine - 0.5) * 0.8;
float swFoamFade = smoothstep(0.2, 0.8, swFoot * 2.4);
float swWebA = swCells(swFoamUv);
float swWebB = swCells(swFoamUv * 2.3 + vec2(3.1, swTime * 0.07));
float swClump = swNoise(swFoamUv * 0.5 + vec2(7.3, swTime * 0.02));
float swBlob = swNoise(swFoamUv * 1.7 + vec2(1.9, swTime * -0.05));
float swLace = 1.0 - smoothstep(0.0, 0.3, swWebA);
float swBubbles = 1.0 - smoothstep(0.0, 0.25, swWebB);
// Spread over 0-1 so a foam density maps evenly to coverage.
float swFoamTex = mix(smoothstep(0.05, 0.85, swClump * 0.4 + swBlob * 0.25 + swLace * 0.22 + swBubbles * 0.13), 0.45, swFoamFade);
// Shores wash in bands. Whitecaps form where crests steepen (Crest Foam sets coverage) and leave streaky foam
// trailing on their windward backs.
float swWashPhase = swBank / swFoamWidth - swTime * 0.45 + swMedium * 1.4;
float swWash = exp(-swBank / swFoamWidth) * (0.85 + 0.3 * sin(swWashPhase * 6.2831853));
float swBack = max(dot(swGradient, swWindDir), 0.0) / max(0.0001, swSteep);
// Only some crests break at a time: breaking zones drift slowly downwind.
float swBreakZone = swNoise(swWorld * 0.045 - swWindDir * (swTime * 0.12) + vec2(5.1, 2.7));
float swCapDrive = (swFoldN * 1.8 + swBack * 0.5 + swChopH * 0.8 + (swBreakZone - 0.5) * 0.7 + (swGust - 0.5) * 0.4) * swRough;
// Never solid: even the densest cap keeps bubbles and holes.
float swCap = smoothstep(1.0 - U.slateWaterShape.z, 1.5 - U.slateWaterShape.z, swCapDrive) * (0.55 + 0.35 * swClump);
vec2 swWindUv = vec2(dot(swFlowed, swWindDir), dot(swFlowed, vec2(-swWindDir.y, swWindDir.x)));
float swTrailTex = swNoise(swWindUv * vec2(0.3, 2.2) + swSlope * 0.5 + vec2(swTime * 0.05, 0.0));
float swTrail = smoothstep(0.75 - U.slateWaterShape.z, 1.2 - U.slateWaterShape.z, swCapDrive + swBack * swRough * 0.8) * smoothstep(0.3, 0.8, swTrailTex) * 0.6;
// Wind streaks: long, thin foam lines drawn out along the wind where gusts are strong (Surface Foam).
float swStreak = smoothstep(0.66, 0.95, swNoise(swWindUv * vec2(0.05, 1.3) + swSlope * 0.25 + vec2(swLarge * 2.0, 0.0)) * 0.75 + swGust * 0.35) * U.slateWaterSunColor.w * (0.3 + swGust) * swCalm * 1.4;
float swDensity = clamp(max(max(swWash, swCap), max(swTrail, swStreak)), 0.0, 1.0);
float swFoamSoft = 0.1 + 0.15 * (1.0 - swDensity) + fwidth(swFoamTex);
// Bubble grain keeps the foam from reading as flat paint; it averages out before it would alias.
float swGrain = mix(swNoise(swFoamUv * 9.0 + vec2(0.0, swTime * 0.2)), 0.5, swFoamFade);
float swRealFoam = smoothstep(1.0 - swDensity, 1.0 - swDensity + swFoamSoft, swFoamTex) * (0.45 + 0.55 * swDensity);
float swShoreLine = 1.0 - smoothstep(0.0, 0.2 * swFoamWidth + 0.05, swBank);
swRealFoam = max(swRealFoam, swShoreLine * (0.6 + 0.35 * smoothstep(0.2, 0.5, swFoamTex)));
// Contact foam hugs the actual waterline on objects: a dense churned band where the water meets them,
// breaking into lace and patches that ripple crests carry outward.
float swHug = clamp(exp(-swObject / swContactW * 3.2) * (0.55 + 0.9 * swClump) + max(0.0, cos(swRipplePhase)) * swRippleFade * 0.2, 0.0, 1.0);
float swBubbleTex = mix(smoothstep(0.1, 0.8, swClump * 0.3 + swBlob * 0.3 + swBubbles * 0.25 + swLace * 0.15), 0.45, swFoamFade);
float swHugSoft = 0.08 + 0.12 * (1.0 - swHug) + fwidth(swBubbleTex);
float swRealContact = smoothstep(1.0 - swHug, 1.0 - swHug + swHugSoft, swBubbleTex) * (0.35 + 0.65 * swHug);
float swContactLine = 1.0 - smoothstep(0.0, 0.1 * swContactW + 0.06 + fwidth(swObject), swObject);
swRealContact = max(swRealContact, swContactLine * (0.8 + 0.2 * smoothstep(0.15, 0.5, swBubbleTex)));
float swFoam = clamp(max(swRealFoam * swFoamAmount * 1.35, swRealContact * swContactStrength), 0.0, 1.0);
// Air churned under foam lightens and clouds the water around it, without a pattern.
float swAerated = max(swDensity * swFoamAmount, swHug * 0.6);
swTransmit *= 1.0 - swAerated * 0.35;
swScatter += mix(swCol, U.slateWaterFoam.rgb, 0.5) * (swAmb + swSun * max(swL.y, 0.0)) * swAerated * 0.2;

// Sun glitter: half the reflected sunlight is a slightly enlarged sun disc mirrored by the resolved ripples
// (sparkles; Roughness widens it), half a broad sun path from the slopes of ripples too small to shade. Both widen
// with the slope variance lost to filtering; normalized lobes keep the reflected sunlight constant.
vec3 swReflected = reflect(-swV, normalW);
float swRL = max(dot(swReflected, swL), 0.0);
float swLobeWiden = U.slateWaterOrigin.w * U.slateWaterOrigin.w * 0.5 + 4.0 * swSlopeVariance;
float swSparkLobe = 0.0006 + swLobeWiden;
float swPathLobe = 0.012 + 0.02 * swChopGain * swChopGain + swLobeWiden;
float swSunFres = 0.02 + 0.98 * pow(1.0 - clamp(dot(swV, normalize(swV + swL)), 0.0, 1.0), 5.0);
vec3 swGlint = swSun * (swSunFres * step(0.0, swL.y) * 0.0796 * (exp((swRL - 1.0) / swSparkLobe) / swSparkLobe + exp((swRL - 1.0) / swPathLobe) / swPathLobe));
float swSpark = swSparkBase * 3.0 * pow(swRL, 40.0) * (1.0 - swFoam);

// Foam is matte and lit: PBR shades it as albedo, and its roughness and coverage remove the mirror.
float swEdgeFade = smoothstep(0.0, 0.2, swBank + 0.02);
float swGloss = (1.0 - swFoam) * swEdgeFade;
// Thicker foam is brighter; bubbles vary it slightly.
surfaceAlbedo = U.slateWaterFoam.rgb * (swFoam * swEdgeFade * (0.78 + 0.22 * swGrain));
swMatte = swFoam;
vec3 swEmissive = swScatter * ((1.0 - swFres) * (1.0 - swTransmit) * swGloss) + (swGlint + vec3(swSpark) * swSun) * swGloss;
alpha = (1.0 - (1.0 - swFres) * swTransmit * (1.0 - swFoam)) * swEdgeFade;
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
vec3 swLitScale = vec3(0.3) + swAmb * 0.35 + swSun * (0.25 * max(swL.y, 0.0));
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
// Caustic cell lines in the shallows.
vec2 swCausticUv = swFlowed * 0.75 * U.slateWaterMotion.y + vec2(swMedium, swFine) * 0.45 + vec2(swTime * 0.06, swTime * 0.04);
float swCausticCells = swCells(swCausticUv);
float swCausticAA = fwidth(swCausticCells) + 0.015;
float swCaustic = (1.0 - smoothstep(0.02, 0.02 + swCausticAA, swCausticCells)) * (1.0 - smoothstep(0.08, 0.3, swFoot * 0.75 * U.slateWaterMotion.y)) * (1.0 - swTone) * smoothstep(0.25, 0.6, swMedium);
swLit += swShallowLit * (swCaustic * 0.3);

// Toon highlight: a crisp sun disc on the water, sized by Roughness.
vec3 swReflected = reflect(-swV, normalW);
float swAlign = dot(swReflected, swL);
float swSpecThreshold = 1.0 - 0.05 * U.slateWaterOrigin.w - 0.002;
float swSpecAA = fwidth(swAlign) + 0.001;
float swSpec = smoothstep(swSpecThreshold - swSpecAA, swSpecThreshold + swSpecAA, swAlign) * step(0.0, swL.y) * min(1.0, U.slateWaterSun.w);

// Shoreline: a crisp wobbling outline plus a travelling second ring.
float swEdgeUnit = swBank / swFoamWidth;
float swEdgeAA = fwidth(swEdgeUnit) + 0.015;
float swWobble = (swMedium - 0.5) * 0.5 + sin(swTime * 1.7 + swLarge * 18.0) * 0.08;
float swEdge = swEdgeUnit + swWobble;
float swOutline = 1.0 - smoothstep(0.7 - swEdgeAA, 0.7 + swEdgeAA, swEdge);
// Two foam lines take turns washing in toward the shore, fading as they arrive; phases vary along the coast.
float swRingAge = fract(swTime * 0.16 + swLarge * 2.3);
float swRingAgeB = fract(swRingAge + 0.5);
float swRing = max((1.0 - smoothstep(0.08, 0.08 + swEdgeAA * 1.5, abs(swEdge - 0.95 - (1.0 - swRingAge) * 1.6))) * swRingAge,
  (1.0 - smoothstep(0.08, 0.08 + swEdgeAA * 1.5, abs(swEdge - 0.95 - (1.0 - swRingAgeB) * 1.6))) * swRingAgeB);
swRing *= smoothstep(0.3, 0.42, swFine * 0.6 + swMedium * 0.4);
// Contacts: a wobbling collar at the waterline and graphic ripple rings that ride outward and break up.
float swObjectUnit = swObject / swContactW + swWobble * 0.6;
float swObjectAA = fwidth(swObjectUnit) + 0.02;
float swCollar = 1.0 - smoothstep(0.55 - swObjectAA, 0.55 + swObjectAA, swObjectUnit);
float swRingWave = cos(swRipplePhase);
float swRingAA = fwidth(swRingWave) + 0.03;
float swToonRings = smoothstep(0.72 - swRingAA, 0.72 + swRingAA, swRingWave) * smoothstep(0.25, 0.45, swRippleNoise) * swRippleFade * 1.6;
float swToonContact = clamp(max(swCollar, swToonRings), 0.0, 1.0);
// Binary white caps on the sharpest crests (Crest Foam sets coverage, not brightness).
float swCapDrive = (swFoldN * 1.3 + swCrest * 0.2 + (swFine - 0.5) * 0.3) * swRough;
float swCapThreshold = 1.1 - 0.6 * U.slateWaterShape.z;
float swCapAA = fwidth(swCapDrive) + 0.01;
float swToonCap = smoothstep(swCapThreshold - swCapAA, swCapThreshold + swCapAA, swCapDrive) * step(0.001, U.slateWaterShape.z);
// Surface foam: drifting, distorted noise cut into crisp patches, denser near shores and objects (Surface Foam).
float swNearEdge = clamp(min(swBank / (swFoamWidth * 3.0), swObject / (swContactW * 3.0)), 0.0, 1.0);
vec2 swSurfUv = swFlowed * 0.65 * U.slateWaterMotion.y + swSlope * 0.6 + vec2(swMedium - 0.5, swFine - 0.5) * 0.7 + vec2(swTime * 0.05, swTime * 0.03);
float swSurfNoise = swNoise(swSurfUv) * 0.6 + swNoise(swSurfUv * 2.3 + vec2(4.1, swTime * 0.07)) * 0.4;
float swSurfCut = mix(1.02, 0.68, U.slateWaterSunColor.w) * mix(0.95, 1.0, swNearEdge);
float swSurfAA = fwidth(swSurfNoise) + 0.008;
float swSurf = smoothstep(swSurfCut - swSurfAA, swSurfCut + swSurfAA, swSurfNoise) * (1.0 - smoothstep(0.06, 0.2, swFoot * 0.65 * U.slateWaterMotion.y));
float swFoam = clamp(max(max(max(swOutline, swRing), max(swToonCap, swSurf)) * swFoamAmount, swToonContact * swContactStrength), 0.0, 1.0);

float swSpark = swSparkBase * 2.5 * (0.3 + 1.7 * pow(max(swAlign, 0.0), 5.0)) * (1.0 - swFoam);
vec3 swFoamLit = U.slateWaterFoam.rgb * clamp(swLitScale * 1.1, vec3(0.35), vec3(1.0));
vec3 swEmissive = mix(swLit, swFoamLit, swFoam) + vec3(swSpec * 0.95 * (1.0 - swFoam) + swSpark);
surfaceAlbedo = vec3(0.0);
alpha = clamp(max(mix(U.slateWaterShallow.a * 0.55, U.slateWaterShallow.a, smoothstep(0.0, 0.5, swTone)), max(swFoam, max(swSpec, swSpark))), 0.0, 1.0);
`;
}

/** Signed distance to a removal primitive (shape code in x, half extents in yzw), in its local space. */
const REMOVAL_HELPER = `
float swRemoval(mat4 inv, vec4 shape, vec3 p) {
  vec3 q = (inv * vec4(p, 1.0)).xyz;
  vec3 h = shape.yzw;
  if (shape.x < 0.5) { return 1.0; }
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
  const fineAt = (uv: string) => wgsl
    ? `textureSampleLevel(slateWaterFieldSampler, slateWaterFieldSamplerSampler, ${uv}, 0.0).b`
    : `texture2D(slateWaterFieldSampler, ${uv}).b`;
  const removals = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `swRemoval(U.slateWaterRemoval${i}, U.slateWaterRemovalShape${i}, swPosW)`);
  return `
// Large-world rendering makes vPositionW eye-relative; rebuild the absolute world position.
vec3 swPosW = IN.vPositionW + U.slateWaterOrigin.xyz;
vec2 swFieldUv = (swPosW.xz - U.slateWaterFieldBounds.xy) * U.slateWaterFieldBounds.zw;
${sample}
float swFieldOn = U.slateWaterFieldInfo.x * step(0.0, swFieldUv.x) * step(swFieldUv.x, 1.0) * step(0.0, swFieldUv.y) * step(swFieldUv.y, 1.0);
// Geometry displacement, not the unfiltered per-pixel normal waves, sets the waterline. Shallows read the fine
// depth channel, so gentle shores have no terraces; deeper water falls back to the full-range channel.
float swCoarseDepth = mix(U.slateWaterFieldInfo.z, U.slateWaterFieldInfo.w, swField.g);
float swFineDepth = U.slateWaterFieldInfo.y + swField.b * ${f(WATER_FIELD_FINE_DEPTH_SPAN)};
float swFineTop = U.slateWaterFieldInfo.y + ${f(WATER_FIELD_FINE_DEPTH_SPAN)};
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
// Convert wave-relative depth to a local world-space shoreline distance: the displaced depth over the terrain
// slope. Central differences of the fine depth one cell apart keep that slope continuous (a bilinear field's own
// gradient steps at every cell). Rest-height distance stays exact when waves are off.
vec2 swFieldStep = U.slateWaterFieldStep.xy;
vec2 swTerrainSlope = vec2(${fineAt("swFieldUv + vec2(swFieldStep.x, 0.0)")} - ${fineAt("swFieldUv - vec2(swFieldStep.x, 0.0)")},
  ${fineAt("swFieldUv + vec2(0.0, swFieldStep.y)")} - ${fineAt("swFieldUv - vec2(0.0, swFieldStep.y)")}) * ${f(WATER_FIELD_FINE_DEPTH_SPAN * 0.5)} / max(swFieldStep / U.slateWaterFieldBounds.zw, vec2(0.000001));
// Derivatives before discard.
vec2 swDx = dFdx(swPosW.xz);
vec2 swDy = dFdy(swPosW.xz);
float swDet = swDx.x * swDy.y - swDx.y * swDy.x;
// Outward world X/Z direction from the nearest object, from the screen derivatives of its distance.
float swSafeDet = mix(1e-12, swDet, step(1e-12, abs(swDet)));
vec2 swContactGrad = vec2(swContactDerivative.x * swDy.y - swContactDerivative.y * swDx.y, swDx.x * swContactDerivative.y - swDy.x * swContactDerivative.x) / swSafeDet;
vec2 swContactDir = swContactGrad / max(length(swContactGrad), 0.00001);
if (U.slateWaterWaves.x > 0.0 && swField.a > 0.5) {
  swTerrainShore = clamp(swTerrainDepth / max(length(swTerrainSlope), 0.001), ${f(SHORE[0])}, ${f(SHORE[1])});
}
float swCut = min(min(${removals[0]}, ${removals[1]}), min(${removals[2]}, ${removals[3]}));
if (swCut < 0.0 || (swField.a * swFieldOn > 0.5 && swTerrainDepth <= 0.0)) { discard; }
`;
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
  const bind = (code: string) => code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bIN\./g, wgsl ? "fragmentInputs." : "").replace(/\bS\./g, wgsl ? "scene." : "");
  const samplerDeclaration = wgsl
    ? "var slateWaterFieldSamplerSampler: sampler;\nvar slateWaterFieldSampler: texture_2d<f32>;\nvar slateWaterContactSamplerSampler: sampler;\nvar slateWaterContactSampler: texture_2d<f32>;\n"
    : "uniform sampler2D slateWaterFieldSampler;\nuniform sampler2D slateWaterContactSampler;\n";
  // Written by the realistic main code and read inside Babylon's reflectivity block (a separate function).
  const roughnessGlobals = wgsl
    ? "var<private> swSlopeVariance: f32 = 0.0;\nvar<private> swMatte: f32 = 0.0;\n"
    : "float swSlopeVariance = 0.0;\nfloat swMatte = 0.0;\n";
  return wgsl
    ? { helpers: samplerDeclaration + roughnessGlobals + toWgsl(HELPERS + REMOVAL_HELPER), cut: bind(toWgsl(cutSource(true))), main: bind(toWgsl(fragmentSource())) }
    : { helpers: samplerDeclaration + roughnessGlobals + HELPERS + REMOVAL_HELPER, cut: bind(cutSource(false)), main: bind(fragmentSource()) };
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
  constructor(material: PBRMaterial, water: WaterDefinition, body: WaterBodyProperties) {
    super(material, "SlateWater", 180, { SLATE_WATER: true, [WATER_STYLIZED_DEFINE]: false }, true, false);
    this.water = water;
    this.body = body;
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override isCompatible(): boolean { return true; }
  override getClassName(): string { return "WaterMaterialPlugin"; }
  override prepareDefines(defines: MaterialDefines): void { defines[WATER_STYLIZED_DEFINE] = this.water.style === "stylized"; }
  override getAttributes(attributes: string[]): void { attributes.push("slateWaterData", "slateWaterFlow", "slateWaterBaseNormal"); }
  override getUniforms() {
    const vectors = ["slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves", "slateWaterSun", "slateWaterSunColor", "slateWaterLight", "slateWaterShape", "slateWaterFieldBounds", "slateWaterFieldInfo", "slateWaterFieldStep", "slateWaterContactBounds", "slateWaterContactInfo", "slateWaterOrigin"];
    const removals = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => i);
    return { ubo: [
      ...[...vectors, ...removals.map((i) => `slateWaterRemovalShape${i}`)].map((name) => ({ name, size: 4, type: "vec4" })),
      ...removals.map((i) => ({ name: `slateWaterRemoval${i}`, size: 16, type: "mat4" })),
    ] };
  }
  override getSamplers(samplers: string[]): void { samplers.push("slateWaterFieldSampler", "slateWaterContactSampler"); }
  override bindForSubMesh(buffer: UniformBuffer, scene: Scene): void {
    buffer.setTexture("slateWaterFieldSampler", this.field?.texture ?? placeholderField(scene));
    buffer.setTexture("slateWaterContactSampler", this.contacts?.texture ?? placeholderField(scene));
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene): void {
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
    buffer.updateFloat4("slateWaterShape", w.choppiness, w.waveSpread, w.crestFoam, w.contactFoamWidth);
    const field = this.field?.texture ? this.field : null;
    const bounds = field?.bounds ?? [0, 0, 1, 1];
    buffer.updateFloat4("slateWaterFieldBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
    buffer.updateFloat4("slateWaterFieldInfo", field ? 1 : 0, field?.fineDepthMin ?? 0, ...(field?.depthRange ?? WATER_FIELD_DEPTH_RANGE));
    const texel = field?.texelSize ?? [1, 1];
    buffer.updateFloat4("slateWaterFieldStep", texel[0], texel[1], 0, 0);
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
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    const wgsl = language === ShaderLanguage.WGSL;
    const v3 = wgsl ? "vec3f" : "vec3";
    // Babylon's shader processors are line-based: every attribute, varying and sampler needs its own line.
    const varying = (type: string, name: string) => (wgsl ? `varying ${name}: ${type};` : `varying ${type} ${name};`) + "\n";
    const varyings = varying(wgsl ? "vec4f" : "vec4", "vSlateWater") + varying(v3, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal");
    if (shaderType === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: (wgsl
        ? "attribute slateWaterData: vec4f;\nattribute slateWaterFlow: vec3f;\nattribute slateWaterBaseNormal: vec3f;\n"
        : "attribute vec4 slateWaterData;\nattribute vec3 slateWaterFlow;\nattribute vec3 slateWaterBaseNormal;\n") + varyings,
      CUSTOM_VERTEX_MAIN_END: ["Water", "WaterFlow", "WaterBaseNormal"].map((name) => `${wgsl ? "vertexOutputs." : ""}vSlate${name} = ${wgsl ? "vertexInputs." : ""}slate${name === "Water" ? "WaterData" : name};`).join("\n"),
    };
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
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: [
        "finalEmissive += swEmissive;",
        `#ifndef ${WATER_STYLIZED_DEFINE}`,
        "#ifdef REFLECTION",
        "finalRadianceScaled *= swGloss;",
        "#else",
        "finalEmissive += swAmb * (swFres * swGloss * 0.35);",
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
