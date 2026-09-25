import { Color3, MaterialPluginBase, PBRMaterial, ShaderLanguage, type UniformBuffer } from "@babylonjs/core";
import { waterWaveComponents, type WaterBodyProperties, type WaterDefinition } from "@babylonslate/core";

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
    return { ubo: ["slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves"].map((name) => ({ name, size: 4, type: "vec4" })) };
  }
  override hardBindForSubMesh(buffer: UniformBuffer): void {
    const w = this.water, b = this.body;
    buffer.updateFloat4("slateWaterShallow", ...w.shallowColor, w.opacity);
    buffer.updateFloat4("slateWaterDeep", ...w.deepColor, w.reflectionStrength);
    buffer.updateFloat4("slateWaterFoam", ...w.foamColor, w.foamAmount);
    buffer.updateFloat4("slateWaterMotion", this.time, w.rippleScale, w.rippleStrength, w.foamWidth);
    buffer.updateFloat4("slateWaterLook", w.colorBands, w.depthColorDistance, w.roughness, w.style === "stylized" ? 1 : 0);
    buffer.updateFloat4("slateWaterWaves", w.waveHeight * b.waveScale, w.waveLength, w.waveSpeed, w.waveDirection * Math.PI / 180);
  }
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    const wgsl = language === ShaderLanguage.WGSL;
    const f = wgsl ? "f32" : "float", v2 = wgsl ? "vec2f" : "vec2", v3 = wgsl ? "vec3f" : "vec3";
    const decl = (type: string, name: string, value: string) => wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
    const varying = (type: string, name: string) => wgsl ? `varying ${name}: ${type};` : `varying ${type} ${name};`;
    const varyings = varying(wgsl ? "vec4f" : "vec4", "vSlateWater") + varying(v3, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal");
    if (shaderType === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: (wgsl
        ? "attribute slateWaterData: vec4f; attribute slateWaterFlow: vec3f; attribute slateWaterBaseNormal: vec3f;"
        : "attribute vec4 slateWaterData; attribute vec3 slateWaterFlow; attribute vec3 slateWaterBaseNormal;") + varyings,
      CUSTOM_VERTEX_MAIN_END: ["Water", "WaterFlow", "WaterBaseNormal"].map((name) => `${wgsl ? "vertexOutputs." : ""}vSlate${name} = ${wgsl ? "vertexInputs." : ""}slate${name === "Water" ? "WaterData" : name};`).join("\n"),
    };
    if (shaderType !== "fragment") return null;
    const p = wgsl ? "uniforms." : "", input = wgsl ? "fragmentInputs." : "";
    const w = p + "slateWaterWaves", motion = p + "slateWaterMotion", look = p + "slateWaterLook";
    const data = input + "vSlateWater";
    const fn = (name: string, arg: string, type: string, body: string) => wgsl ? `fn ${name}(${arg}: ${type}) -> ${f} { ${body} }` : `${f} ${name}(${type} ${arg}) { ${body} }`;
    const noise = fn("swHash", "p", v2, [
      decl(v3, "q", `fract(${v3}(p.x, p.y, p.x) * 0.1031)`),
      `q += ${v3}(dot(q, q.yzx + ${v3}(33.33))); return fract((q.x + q.y) * q.z);`,
    ].join("\n")) + fn("swNoise", "p", v2, [
      decl(v2, "i", "floor(p)"), decl(v2, "t", "fract(p)"), `t = t * t * (${v2}(3.0) - 2.0 * t);`,
      `return mix(mix(swHash(i), swHash(i + ${v2}(1.0, 0.0)), t.x), mix(swHash(i + ${v2}(0.0, 1.0)), swHash(i + ${v2}(1.0, 1.0)), t.x), t.y);`,
    ].join("\n"));
    const code = [
      decl(v2, "swWorld", `${input}vPositionW.xz`),
      decl(f, "swTime", `${motion}.x`),
      decl(v2, "swUV", `(swWorld - ${input}vSlateWaterFlow.xz * swTime) * ${motion}.y`),
      decl(f, "swHeight", "0.0"), decl(v2, "swGradient", `${v2}(0.0)`),
      // Analytic per-pixel wave normals stay detailed where the mesh has coarser LOD.
      ...waterWaveComponents.flatMap(([turn, frequency, amplitude, phase], i) => [
        decl(f, `swK${i}`, `${(2 * Math.PI * frequency).toFixed(9)} / ${w}.y`),
        decl(v2, `swD${i}`, `${v2}(cos(${w}.w + ${turn.toFixed(4)}), sin(${w}.w + ${turn.toFixed(4)}))`),
        decl(f, `swP${i}`, `swK${i} * dot(swD${i}, swWorld) - sqrt(9.81 * swK${i}) * ${w}.z * swTime + ${phase.toFixed(4)}`),
        `swHeight += ${w}.x * ${amplitude.toFixed(4)} * sin(swP${i});`,
        `swGradient += swD${i} * (${w}.x * ${amplitude.toFixed(4)} * swK${i} * cos(swP${i}));`,
      ]),
      decl(f, "swWarp", `swNoise(swUV * 0.14 + ${v2}(swTime * 0.035, -swTime * 0.027)) * 2.0`),
      decl(v2, "swRipple", `${v2}(0.0)`),
      ...[[0.94, 0.34, 1, 1.2], [-0.42, 0.91, 1.63, -0.9], [0.74, -0.67, 2.37, 1.5], [0.2, 0.98, 3.91, -1.1]].flatMap(([x, z, frequency, speed], i) => [
        decl(v2, `swRD${i}`, `${v2}(${x!.toFixed(4)}, ${z!.toFixed(4)})`),
        decl(f, `swRP${i}`, `dot(swUV, swRD${i}) * ${frequency!.toFixed(4)} + swWarp * ${(1 + i * .3).toFixed(4)} - swTime * ${speed!.toFixed(4)}`),
        `swRipple += swRD${i} * cos(swRP${i}) * ${(0.5 / (1 + i * .6)).toFixed(5)};`,
      ]),
      decl(f, "swPixel", "length(fwidth(swUV))"),
      decl(f, "swDetail", "1.0 - smoothstep(0.3, 1.5, swPixel)"),
      decl(f, "swBroad", `swNoise(swWorld * 0.16 - ${input}vSlateWaterFlow.xz * swTime * 0.1)`),
      decl(f, "swSmall", `swNoise(swUV * 0.7 + ${v2}(swWarp, -swTime * 0.06))`),
      decl(f, "swDepth", `min(${data}.z, max(0.0, ${data}.y) * 0.65)`),
      decl(f, "swAbsorb", `1.0 - exp(-swDepth / ${look}.y)`),
      decl(f, "swCrest", `swHeight / max(0.001, ${w}.x)`),
      decl(f, "swTone", "clamp(swAbsorb * 0.9 + (swBroad - 0.5) * 0.13 - swCrest * 0.08, 0.0, 1.0)"),
      `if (${look}.w > 0.5 && ${look}.x > 1.0) {`,
      decl(f, "swBand", `swTone * ${look}.x`),
      decl(f, "swAA", "max(0.035, fwidth(swBand))"),
      `swTone = (floor(swBand) + smoothstep(0.5 - swAA, 0.5 + swAA, fract(swBand))) / ${look}.x; }`,
      decl(f, "swFoamWidth", `max(0.001, ${motion}.w)`),
      decl(f, "swBank", `max(0.0, ${data}.y) / swFoamWidth`),
      decl(f, "swWash", "swBank + (swBroad - 0.5) * 0.6 + sin(swTime * 1.1 + swBroad * 6.0) * 0.12"),
      decl(f, "swShore", "(1.0 - smoothstep(0.1, 0.75, swWash)) * (0.55 + swSmall * 0.45)"),
      decl(f, "swLace", "1.0 - smoothstep(0.06, 0.20, abs(swSmall - 0.5))"),
      decl(f, "swBreaker", "smoothstep(0.28, 0.8, swCrest) * smoothstep(0.3, 0.7, swBroad)"),
      decl(f, "swFoam", `clamp((swShore * step(0.001, ${motion}.w) + swBreaker * swLace * swDetail) * ${p}slateWaterFoam.w * 1.65, 0.0, 1.0)`),
      `swFoam = mix(swFoam, smoothstep(0.18, 0.65, swFoam), ${look}.w);`,
      decl(v3, "swBaseNormal", `normalize(${input}vSlateWaterBaseNormal)`),
      `swGradient += swRipple * ${motion}.z * swDetail * (1.0 - swFoam) * mix(1.0, 0.55, ${look}.w);`,
      `normalW = normalize(${v3}(swBaseNormal.x / max(0.001, swBaseNormal.y) - swGradient.x, 1.0, swBaseNormal.z / max(0.001, swBaseNormal.y) - swGradient.y));`,
      `surfaceAlbedo = mix(${p}slateWaterShallow.rgb, ${p}slateWaterDeep.rgb, swTone);`,
      decl(f, "swFresnel", "pow(1.0 - clamp(dot(normalW, viewDirectionW), 0.0, 1.0), 4.0)"),
      `surfaceAlbedo = mix(surfaceAlbedo, ${p}slateWaterShallow.rgb, swFresnel * 0.22 * ${p}slateWaterDeep.w);`,
      `surfaceAlbedo = mix(surfaceAlbedo, ${p}slateWaterFoam.rgb, swFoam);`,
      `alpha = mix(${p}slateWaterShallow.a, 1.0, max(swFoam, swFresnel * 0.65));`,
    ].join("\n");
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: varyings + noise,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: code,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `finalEmissive += surfaceAlbedo * ${look}.w * 0.12;`,
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
  material.alpha = water.opacity;
  material.backFaceCulling = false;
  material.needDepthPrePass = true;
}
