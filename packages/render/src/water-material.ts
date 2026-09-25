import { Color3, MaterialPluginBase, PBRMaterial, ShaderLanguage, type UniformBuffer } from "@babylonjs/core";
import type { WaterBodyProperties, WaterDefinition } from "@babylonslate/core";

/** Procedural water shading on native PBR, including separately authored WGSL. */
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
  override getAttributes(attributes: string[]): void { attributes.push("slateWaterData", "slateWaterFlow"); }
  override getUniforms() {
    const names = ["slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook"];
    return { ubo: names.map((name) => ({ name, size: 4, type: "vec4" })) };
  }
  override hardBindForSubMesh(buffer: UniformBuffer): void {
    const w = this.water, b = this.body;
    buffer.updateFloat4("slateWaterShallow", ...w.shallowColor, w.opacity);
    buffer.updateFloat4("slateWaterDeep", ...w.deepColor, w.waveHeight * b.waveScale);
    buffer.updateFloat4("slateWaterFoam", ...w.foamColor, w.foamAmount);
    buffer.updateFloat4("slateWaterMotion", this.time, w.rippleScale, w.rippleStrength, w.foamWidth);
    buffer.updateFloat4("slateWaterLook", w.colorBands, w.depthColorDistance, b.depth, w.style === "stylized" ? 1 : 0);
  }
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    const wgsl = language === ShaderLanguage.WGSL;
    if (shaderType === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: wgsl ? "attribute slateWaterData: vec4f; attribute slateWaterFlow: vec3f; varying vSlateWater: vec4f; varying vSlateWaterFlow: vec2f;" : "attribute vec4 slateWaterData; attribute vec3 slateWaterFlow; varying vec4 vSlateWater; varying vec2 vSlateWaterFlow;",
      CUSTOM_VERTEX_MAIN_END: wgsl
        ? "vertexOutputs.vSlateWater = vec4f(positionUpdated.xz, vertexInputs.slateWaterData.y, vertexInputs.slateWaterData.x); vertexOutputs.vSlateWaterFlow = vertexInputs.slateWaterFlow.xz;"
        : "vSlateWater = vec4(positionUpdated.xz, slateWaterData.y, slateWaterData.x); vSlateWaterFlow = slateWaterFlow.xz;",
    };
    if (shaderType !== "fragment") return null;
    const p = wgsl ? "uniforms." : "", v = wgsl ? "fragmentInputs.vSlateWater" : "vSlateWater";
    const decl = (type: string, name: string, expression: string) => wgsl ? `var ${name}: ${type === "float" ? "f32" : type + "f"} = ${expression};` : `${type} ${name} = ${expression};`;
    const vector = wgsl ? "vec3f" : "vec3";
    const code = [
      decl("vec2", "swUV", `(${v}.xy - ${wgsl ? "fragmentInputs." : ""}vSlateWaterFlow * ${p}slateWaterMotion.x) * ${p}slateWaterMotion.y`),
      decl("float", "swTime", `${p}slateWaterMotion.x`),
      decl("float", "swNoise", "sin(swUV.x + sin(swUV.y * 0.73 + swTime)) * sin(swUV.y * 1.17 - swTime * 0.6)"),
      decl("float", "swDepth", `min(${p}slateWaterLook.z, max(0.0, ${v}.z) * 0.7)`),
      decl("float", "swMix", `clamp(swDepth / ${p}slateWaterLook.y, 0.0, 1.0)`),
      `if (${p}slateWaterLook.x > 1.0) { swMix = floor(swMix * ${p}slateWaterLook.x) / ${p}slateWaterLook.x; }`,
      decl("float", "swShore", `1.0 - smoothstep(0.0, max(0.001, ${p}slateWaterMotion.w), ${v}.z + swNoise * ${p}slateWaterMotion.w * 0.35)`),
      decl("float", "swCrest", `smoothstep(0.5, 0.95, ${v}.w / max(0.001, ${p}slateWaterDeep.w)) * smoothstep(0.1, 0.7, swNoise)`),
      decl("float", "swFoam", `clamp((swShore + swCrest) * ${p}slateWaterFoam.w * 2.0, 0.0, 1.0)`),
      `surfaceAlbedo = mix(mix(${p}slateWaterShallow.rgb, ${p}slateWaterDeep.rgb, swMix), ${p}slateWaterFoam.rgb, swFoam);`,
      `normalW = normalize(normalW + ${vector}(cos(swUV.x + swTime), 0.0, sin(swUV.y - swTime * 0.7)) * ${p}slateWaterMotion.z * (1.0 - swFoam));`,
      `alpha = mix(${p}slateWaterShallow.a, 1.0, swFoam);`,
    ].join("\n");
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? "varying vSlateWater: vec4f; varying vSlateWaterFlow: vec2f;" : "varying vec4 vSlateWater; varying vec2 vSlateWaterFlow;",
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: code,
    };
  }
}

export function configureWaterMaterial(material: PBRMaterial, water: WaterDefinition): void {
  material.albedoColor = Color3.White();
  material.metallic = 0;
  material.roughness = water.roughness;
  material.indexOfRefraction = 1.333;
  material.environmentIntensity = water.reflectionStrength;
  material.alpha = water.opacity;
  material.backFaceCulling = false;
  material.needDepthPrePass = true;
  if (water.style === "stylized") material.emissiveColor = Color3.FromArray(water.shallowColor).scale(0.15);
}
