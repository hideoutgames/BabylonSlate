import { acquireTextureVariant, type ResourceLease } from "./resource-cache";
import type { Texture } from "@babylonjs/core";
import {
  MaterialPluginBase,
  RegisterMaterialPlugin,
  PBRBaseMaterial,
  StandardMaterial,
  TextureBlock,
  NodeMaterialBlockTargets,
  NodeMaterialBlockConnectionPointTypes,
  type Effect,
  type Material,
  type NodeMaterial,
  type Scene,
  type ShaderLanguage,
  type UniformBuffer,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { applyMaterialTextureAnisotropy, sceneRenderingSettings } from "./render-settings";

/** Implicit material samples may bias mip choice; explicit LOD and shadow samples remain authored. */
export function textureLodSamplePattern(
  samplers: string,
  wgsl: boolean,
): string {
  return wgsl
    ? `textureSample\\((` + samplers + `),\\s*(\\w+),\\s*([^()]+)\\)`
    : `texture2D\\((` + samplers + `),\\s*([^()]+)\\)`;
}

export class QualityTextureBlock extends TextureBlock {
  private qualityLease?: ResourceLease<Texture>;
  private qualitySource?: Texture;
  private qualityAnisotropy?: number;
  override get texture(): Texture | null {
    return this.qualityLease?.resource ?? super.texture;
  }
  override set texture(texture: Texture | null) {
    if (super.texture !== texture) {
      this.qualityLease?.release();
      this.qualityLease = undefined;
      this.qualitySource = undefined;
    }
    super.texture = texture;
  }
  override dispose(): void {
    this.qualityLease?.release(); this.qualityLease = undefined;
    super.dispose();
  }
  override getClassName(): string {
    return "QualityTextureBlock";
  }
  override bind(effect: Effect, material?: NodeMaterial): void {
    const source = super.texture;
    if (material && source) {
      const anisotropy = sceneRenderingSettings(material.getScene()).textureAnisotropy;
      if (this.qualitySource !== source || this.qualityAnisotropy !== anisotropy) {
        const next = source.anisotropicFilteringLevel === anisotropy ? null
          : acquireTextureVariant(source, { anisotropicFilteringLevel: anisotropy });
        this.qualityLease?.release(); this.qualityLease = next ?? undefined;
        this.qualitySource = source; this.qualityAnisotropy = anisotropy;
        // Imported, individually owned wrappers retain their existing behavior.
        if (!next && source.anisotropicFilteringLevel !== anisotropy) applyMaterialTextureAnisotropy(source, anisotropy);
      }
    }
    super.bind(effect);
    effect.setFloat(
      "slateTextureLodBias",
      material?.mode === 0
        ? sceneRenderingSettings(material.getScene()).textureLodBias
        : 0,
    );
  }
  protected override _buildBlock(
    state: NodeMaterialBuildState,
  ): this | undefined {
    const start = state.compilationString.length;
    const result = super._buildBlock(state);
    // Babylon 9.20 selects the scalar WGSL helper for Color4 outputs. Keep
    // conversion local to this block and preserve alpha with its vec4 helper.
    if (state.shaderLanguage === 1) {
      const generated = state.compilationString.slice(start).replaceAll(
        `toLinearSpace(${this.rgba.associatedVariableName})`,
        `toLinearSpaceVec4(${this.rgba.associatedVariableName})`,
      );
      state.compilationString = state.compilationString.slice(0, start) + generated;
    }
    if (state.target !== NodeMaterialBlockTargets.Fragment) return result;
    state._emitUniformFromString(
      "slateTextureLodBias",
      NodeMaterialBlockConnectionPointTypes.Float,
    );
    const wgsl = state.shaderLanguage === 1;
    const generated = state.compilationString
      .slice(start)
      .replace(
        new RegExp(textureLodSamplePattern(this.samplerName, wgsl), "g"),
        wgsl
          ? "textureSampleBias($1,$2,$3,uniforms.slateTextureLodBias)"
          : "texture2D($1,$2,slateTextureLodBias)",
      );
    state.compilationString =
      state.compilationString.slice(0, start) + generated;
    return result;
  }
}
RegisterClass("BABYLON.QualityTextureBlock", QualityTextureBlock);

const MATERIAL_SAMPLERS =
  "(?:albedo|diffuse|ambient|opacity|emissive|specular|reflectivity|metallicReflectance|reflectance|microSurface|bump|lightmap)Sampler";
export class TextureQualityPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "SlateTextureQuality", 210, {}, true, false);
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override isCompatible(): boolean {
    return true;
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene): void {
    buffer.updateFloat(
      "slateTextureLodBias",
      sceneRenderingSettings(scene).textureLodBias,
    );
  }
  override getUniforms() {
    return { ubo: [{ name: "slateTextureLodBias", size: 1, type: "float" }] };
  }
  override getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== "fragment") return null;
    const wgsl = language === 1;
    return {
      ["!" + textureLodSamplePattern(MATERIAL_SAMPLERS, wgsl)]: wgsl
        ? "textureSampleBias($1,$2,$3,uniforms.slateTextureLodBias)"
        : "texture2D($1,$2,slateTextureLodBias)",
    };
  }
}
RegisterMaterialPlugin("SlateTextureQuality", (material) =>
  material instanceof PBRBaseMaterial || material instanceof StandardMaterial
    ? new TextureQualityPlugin(material)
    : null,
);
