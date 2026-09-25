import { Color3, DirectionalLight, HemisphericLight, MaterialPluginBase, PBRMaterial, ShaderLanguage, type Scene, type UniformBuffer } from "@babylonjs/core";
import { waterWaveComponents, type WaterBodyProperties, type WaterColor, type WaterDefinition } from "@babylonslate/core";

/**
 * Detail octaves: [heading offset (radians), wavenumber multiplier, slope, speed, phase].
 * Sharp-crested `exp(sin - 1)` waves with a little domain drag read as wind chop rather than
 * the regular interference of plain sines. All are world-space and advect with the current.
 */
const DETAIL_OCTAVES = [
  [0.0, 1.0, 0.3, 1.0, 0.0], [0.9, 1.53, 0.27, 0.93, 1.7], [-0.7, 2.31, 0.24, 1.07, 4.1], [2.1, 3.37, 0.2, 0.9, 2.3],
  [-1.9, 4.93, 0.17, 1.1, 5.6], [0.35, 7.21, 0.14, 0.95, 0.9], [-2.6, 10.3, 0.11, 1.05, 3.3], [1.4, 14.9, 0.09, 1.0, 6.0],
] as const;

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
`;

const f = (n: number) => n.toFixed(6);

function fragmentSource(): string {
  const swell = waterWaveComponents.map(([turn, frequency, amplitude, phase], i) => `
float swK${i} = ${f(2 * Math.PI * frequency)} / U.slateWaterWaves.y;
vec2 swD${i} = vec2(cos(U.slateWaterWaves.w + ${f(turn)}), sin(U.slateWaterWaves.w + ${f(turn)}));
float swP${i} = swK${i} * dot(swD${i}, swWorld) - sqrt(9.81 * swK${i}) * U.slateWaterWaves.z * swTime + ${f(phase)};
float swF${i} = 1.0 - smoothstep(0.6, 2.2, fwidth(swP${i}));
swHeight += U.slateWaterWaves.x * ${f(amplitude)} * sin(swP${i}) * swF${i};
swGradient += swD${i} * (U.slateWaterWaves.x * ${f(amplitude)} * swK${i} * cos(swP${i}) * swF${i});`).join("");
  const detail = DETAIL_OCTAVES.map(([turn, multiplier, slope, speed, phase], i) => `
float swOK${i} = swBaseK * ${f(multiplier)};
vec2 swOD${i} = vec2(cos(U.slateWaterWaves.w + ${f(turn)}), sin(U.slateWaterWaves.w + ${f(turn)}));
float swOX${i} = swOK${i} * dot(swOD${i}, swChop) - sqrt(9.81 * swOK${i}) * ${f(speed)} * U.slateWaterWaves.z * swTime + ${f(phase)};
float swOW${i} = exp(sin(swOX${i}) - 1.0);
float swOA${i} = ${f(slope)} * (1.0 - smoothstep(0.45, 1.5, fwidth(swOX${i}))) * (1.0 - swStylized * ${f(Math.min(0.85, i * 0.14))});
swDetail += swOD${i} * (swOW${i} * cos(swOX${i}) * swOA${i});
swChopH += (swOW${i} - 0.37) * swOA${i};
swChop -= swOD${i} * (swOW${i} * cos(swOX${i}) * 0.3 / swOK${i});`).join("");
  return `
vec2 swWorld = IN.vPositionW.xz;
float swTime = U.slateWaterMotion.x;
float swStylized = U.slateWaterLook.w;
vec2 swFlowed = swWorld - IN.vSlateWaterFlow.xz * swTime;
float swHeight = 0.0;
vec2 swGradient = vec2(0.0);
${swell}
float swBaseK = 6.2831853 * U.slateWaterMotion.y / 6.0;
vec2 swChop = swFlowed;
vec2 swDetail = vec2(0.0);
float swChopH = 0.0;
${detail}
float swBank = max(0.0, IN.vSlateWater.y);
float swBodyDepth = max(0.01, IN.vSlateWater.z);
float swLarge = swNoise(swWorld * 0.07);
float swMedium = swNoise(swFlowed * 0.43 + vec2(swTime * 0.03, 0.0));
float swFine = swNoise(swFlowed * 2.9 - vec2(0.0, swTime * 0.09));
float swFoamWidth = max(0.001, U.slateWaterMotion.w);
float swCalm = smoothstep(0.0, swFoamWidth * 2.0 + 0.5, swBank);
vec3 swBaseNormal = normalize(IN.vSlateWaterBaseNormal);
vec2 swSlope = swGradient + swDetail * U.slateWaterMotion.z * (0.35 + 0.65 * swCalm);
normalW = normalize(vec3(swBaseNormal.x / max(0.001, swBaseNormal.y) - swSlope.x, 1.0, swBaseNormal.z / max(0.001, swBaseNormal.y) - swSlope.y));
float swNdotV = clamp(dot(normalW, viewDirectionW), 0.0, 1.0);

// Bottom estimate: a shelving bank with an irregular floor, capped by the component Depth.
float swShelf = 0.28 + 0.35 * swLarge;
float swDepth = swBodyDepth * (1.0 - exp(-swBank * swShelf / swBodyDepth));
float swAbsorb = max(0.01, U.slateWaterLook.y);
float swView = clamp(abs(viewDirectionW.y), 0.06, 1.0);
float swTransmit = exp(-swDepth * (1.0 + 1.0 / swView) / swAbsorb);
float swTone = 1.0 - exp(-swDepth * 2.0 / swAbsorb);
float swBandCount = max(1.0, U.slateWaterLook.x);
float swBand = swTone * swBandCount;
float swBandAA = fwidth(swBand) + 0.04;
float swBanded = (floor(swBand) + smoothstep(0.5 - swBandAA, 0.5 + swBandAA, fract(swBand))) / swBandCount;
float swToon = step(1.5, U.slateWaterLook.x) * swStylized;
swTone = mix(swTone, swBanded, swToon);
vec3 swBody = mix(U.slateWaterShallow.rgb, U.slateWaterDeep.rgb, swTone);

// Stylized light streaks: where two drifting noise fields cross, a thin wavy network appears.
float swStreakA = swNoise(swFlowed * 0.55 + vec2(swTime * 0.07, swTime * 0.04) + swSlope * 0.6);
float swStreakB = swNoise(swFlowed * 0.55 * 1.31 - vec2(swTime * 0.05, -swTime * 0.06) + vec2(7.3, 1.9));
float swStreakW = fwidth(swStreakA - swStreakB) + 0.035;
float swStreak = (1.0 - smoothstep(0.0, swStreakW, abs(swStreakA - swStreakB))) * (1.0 - smoothstep(0.02, 0.2, fwidth(swFlowed.x * 0.55))) * smoothstep(0.3, 0.65, swMedium);

// Realistic foam: broken lace washing up the bank and a thin contact line.
float swCrest = swHeight / max(0.001, U.slateWaterWaves.x);
float swLace = swMedium * 0.55 + swFine * 0.45;
float swWashPhase = swBank / swFoamWidth - swTime * 0.45 + swMedium * 1.4;
float swWash = exp(-swBank / swFoamWidth * 2.2);
float swLaceAA = fwidth(swLace) + 0.02;
float swLines = 1.0 - smoothstep(0.035, 0.035 + swLaceAA * 2.0, abs(swLace + 0.18 * sin(swWashPhase * 6.2831853) - 0.5));
float swShoreFoam = swWash * mix(swLines, 1.0, smoothstep(0.62, 0.8, swFine) * swWash) * (0.55 + 0.45 * swMedium);
swShoreFoam = max(swShoreFoam, (1.0 - smoothstep(0.0, 0.12 * swFoamWidth + 0.03, swBank)) * smoothstep(0.35, 0.6, swFine));
float swRealFoam = clamp(swShoreFoam, 0.0, 1.0);

// Stylized foam: a crisp wobbling outline plus a travelling second ring.
float swEdgeUnit = swBank / swFoamWidth;
float swEdgeAA = fwidth(swEdgeUnit) + 0.015;
float swWobble = (swNoise(swWorld * 0.9 + vec2(swTime * 0.21, swTime * 0.13)) - 0.5) * 0.45 + sin(swTime * 1.7 + swLarge * 18.0) * 0.08;
float swEdge = swEdgeUnit + swWobble;
float swOutline = 1.0 - smoothstep(0.55 - swEdgeAA, 0.55 + swEdgeAA, swEdge);
float swRingAge = fract(swTime * 0.16);
float swRing = (1.0 - smoothstep(0.07, 0.07 + swEdgeAA * 1.5, abs(swEdge - 0.95 - swRingAge * 1.4))) * (1.0 - swRingAge);
swRing *= smoothstep(0.32, 0.42, swNoise(swWorld * 1.1 + vec2(swTime * 0.1, 0.0)));
float swToonFoam = max(swOutline, swRing);
float swFoam = clamp(mix(swRealFoam, swToonFoam, swStylized) * U.slateWaterFoam.w * mix(1.35, 1.0, swStylized), 0.0, 1.0);

// Sun-facing sparkles on a jittered world grid; they twinkle and fade before they would alias.
vec2 swSparkUv = swFlowed * 0.9 * U.slateWaterMotion.y;
vec2 swCellId = floor(swSparkUv);
float swRnd = swHash(swCellId);
vec2 swJitter = vec2(swHash(swCellId + vec2(17.0, 3.0)), swHash(swCellId + vec2(5.0, 29.0))) - vec2(0.5);
vec2 swDelta = fract(swSparkUv) - vec2(0.5) - swJitter * 0.6;
float swTwinkle = pow(max(0.0, sin(swTime * (2.0 + swRnd * 3.0) + swRnd * 40.0)), 10.0);
float swCore = max(0.0, 1.0 - length(swDelta) * 6.0);
float swRays = max(0.0, 1.0 - abs(swDelta.x) * 30.0) * max(0.0, 1.0 - abs(swDelta.y) * 4.0) + max(0.0, 1.0 - abs(swDelta.y) * 30.0) * max(0.0, 1.0 - abs(swDelta.x) * 4.0);
vec3 swReflected = reflect(-viewDirectionW, normalW);
float swSunAlign = pow(max(dot(swReflected, U.slateWaterSun.xyz), 0.0), 5.0);
float swSpark = (swCore * swCore * 2.5 + swRays) * swTwinkle * smoothstep(0.4, 0.5, swRnd);
swSpark *= (1.0 - smoothstep(0.1, 0.35, fwidth(swSparkUv.x))) * U.slateWaterLook.z * (0.3 + 1.7 * swSunAlign) * (1.0 - swFoam);

// In-scattered body light is emitted rather than diffusely lit, so ripples stay glassy instead of plastic.
vec3 swSunLight = U.slateWaterSunColor.rgb * U.slateWaterSun.w;
vec3 swLight = U.slateWaterLight.rgb;
vec3 swEmissive = swBody * mix(swLight * 0.42, swLight * 0.7 + vec3(0.3), swStylized);
float swBehind = pow(max(dot(U.slateWaterSun.xyz, -viewDirectionW), 0.0), 4.0);
float swSss = swBehind * clamp(swCrest * 0.5 + 0.5 + swChopH, 0.0, 1.0) * (1.0 - swNdotV * 0.6);
swEmissive += U.slateWaterShallow.rgb * swSunLight * swSss * 0.45 * (1.0 - swStylized);
swEmissive = mix(swEmissive, (U.slateWaterShallow.rgb * 1.2 + vec3(0.1)) * mix(swLight, vec3(1.0), 0.5), swStreak * swStylized * (0.3 - swTone * 0.12));
vec3 swFoamLight = mix(swLight + swSunLight * max(U.slateWaterSun.y, 0.0), vec3(1.0), swStylized);
swEmissive = mix(swEmissive, U.slateWaterFoam.rgb * swFoamLight, swFoam) + vec3(swSpark);
surfaceAlbedo = vec3(0.0);

float swOpacity = U.slateWaterShallow.a;
float swRealAlpha = (1.0 - swTransmit) * swOpacity * smoothstep(0.0, 0.2, swBank + 0.02);
float swToonAlpha = mix(0.4, swOpacity, smoothstep(0.0, 0.6, swTone * 1.6));
alpha = clamp(max(mix(swRealAlpha, swToonAlpha, swStylized), swFoam), 0.0, 1.0);
`;
}

/** Translate the restricted GLSL-shaped source above. Only the constructs it uses are supported. */
export function toWgsl(source: string): string {
  const type = (t: string) => ({ float: "f32", vec2: "vec2f", vec3: "vec3f", vec4: "vec4f" })[t] ?? t;
  return source
    .replace(/^(\s*)(float|vec2|vec3|vec4) (\w+)\(([^)]*)\) \{/gm, (_, indent: string, ret: string, name: string, args: string) =>
      `${indent}fn ${name}(${args.split(",").map((arg) => arg.trim().split(" ")).map(([t, n]) => `${n}: ${type(t!)}`).join(", ")}) -> ${type(ret)} {`)
    .replace(/^(\s*)(float|vec2|vec3|vec4) (\w+) = /gm, (_, indent: string, t: string, name: string) => `${indent}var ${name}: ${type(t)} = `)
    .replace(/\bvec([234])\(/g, "vec$1f(");
}

export function waterShaderSource(language: ShaderLanguage): { helpers: string; main: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const bind = (code: string) => code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bIN\./g, wgsl ? "fragmentInputs." : "");
  return wgsl ? { helpers: toWgsl(HELPERS), main: bind(toWgsl(fragmentSource())) } : { helpers: HELPERS, main: bind(fragmentSource()) };
}

const linear = (c: WaterColor): [number, number, number] => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];

/** Sun direction/color and a diffuse light estimate used to light the water body. */
export function waterLighting(scene: Scene, environmentStrength: number, reflective: boolean) {
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
  if (reflective || scene.environmentTexture) ambient.addInPlace(new Color3(0.8, 0.9, 1).scale(0.45 * environmentStrength));
  if (ambient.r + ambient.g + ambient.b < 0.25) ambient.set(Math.max(ambient.r, 0.08), Math.max(ambient.g, 0.08), Math.max(ambient.b, 0.08));
  return {
    ambient: [ambient.r, ambient.g, ambient.b] as const,
    sun: direction ? [direction.x, direction.y, direction.z, sun!.intensity] as const : [-0.4, 0.8, 0.45, 0] as const,
    sunColor: sun ? [sun.diffuse.r, sun.diffuse.g, sun.diffuse.b] as const : [1, 1, 1] as const,
  };
}

/** World-space water shading on native PBR; both backends use the same wave spectrum. */
export class WaterMaterialPlugin extends MaterialPluginBase {
  time = 0;
  readonly water: WaterDefinition;
  readonly body: WaterBodyProperties;
  constructor(material: PBRMaterial, water: WaterDefinition, body: WaterBodyProperties) {
    super(material, "SlateWater", 180, { SLATE_WATER: true }, true, false);
    this.water = water;
    this.body = body;
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override isCompatible(): boolean { return true; }
  override getClassName(): string { return "WaterMaterialPlugin"; }
  override getAttributes(attributes: string[]): void { attributes.push("slateWaterData", "slateWaterFlow", "slateWaterBaseNormal"); }
  override getUniforms() {
    return { ubo: ["slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves", "slateWaterSun", "slateWaterSunColor", "slateWaterLight"].map((name) => ({ name, size: 4, type: "vec4" })) };
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene): void {
    const w = this.water, b = this.body;
    const material = this._material as PBRMaterial;
    const light = waterLighting(scene, w.reflectionStrength, material.reflectionTexture !== null);
    buffer.updateFloat4("slateWaterShallow", ...linear(w.shallowColor), w.opacity);
    buffer.updateFloat4("slateWaterDeep", ...linear(w.deepColor), w.reflectionStrength);
    buffer.updateFloat4("slateWaterFoam", ...linear(w.foamColor), w.foamAmount);
    buffer.updateFloat4("slateWaterMotion", this.time, w.rippleScale, w.rippleStrength, w.foamWidth);
    buffer.updateFloat4("slateWaterLook", w.colorBands, w.depthColorDistance, w.sparkles, w.style === "stylized" ? 1 : 0);
    buffer.updateFloat4("slateWaterWaves", w.waveHeight * b.waveScale, w.waveLength, w.waveSpeed, w.waveDirection * Math.PI / 180);
    buffer.updateFloat4("slateWaterSun", ...light.sun);
    buffer.updateFloat4("slateWaterSunColor", ...light.sunColor, 0);
    buffer.updateFloat4("slateWaterLight", ...light.ambient, 0);
  }
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    const wgsl = language === ShaderLanguage.WGSL;
    const v3 = wgsl ? "vec3f" : "vec3";
    const varying = (type: string, name: string) => wgsl ? `varying ${name}: ${type};` : `varying ${type} ${name};`;
    const varyings = varying(wgsl ? "vec4f" : "vec4", "vSlateWater") + varying(v3, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal");
    if (shaderType === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: (wgsl
        ? "attribute slateWaterData: vec4f; attribute slateWaterFlow: vec3f; attribute slateWaterBaseNormal: vec3f;"
        : "attribute vec4 slateWaterData; attribute vec3 slateWaterFlow; attribute vec3 slateWaterBaseNormal;") + varyings,
      CUSTOM_VERTEX_MAIN_END: ["Water", "WaterFlow", "WaterBaseNormal"].map((name) => `${wgsl ? "vertexOutputs." : ""}vSlate${name} = ${wgsl ? "vertexInputs." : ""}slate${name === "Water" ? "WaterData" : name};`).join("\n"),
    };
    if (shaderType !== "fragment") return null;
    const source = waterShaderSource(language);
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: varyings + source.helpers,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: source.main,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "finalEmissive += swEmissive;",
    };
  }
}

export function configureWaterMaterial(material: PBRMaterial, water: WaterDefinition): void {
  material.albedoColor = Color3.White();
  material.metallic = 0;
  material.roughness = water.roughness;
  material.indexOfRefraction = 1.333;
  material.environmentIntensity = water.reflectionStrength;
  material.enableSpecularAntiAliasing = true;
  // The shader derives per-pixel transmittance from depth; blending must stay on even at full Opacity.
  material.alpha = 1;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  material.backFaceCulling = false;
  material.needDepthPrePass = true;
}
