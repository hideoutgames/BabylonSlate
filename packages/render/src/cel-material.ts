import {
  Color3,
  ImageProcessingConfiguration,
  PBRMaterial,
  ShaderStore,
  StandardMaterial,
  type Material,
  type Scene,
} from "@babylonjs/core";
import { defaultVertexShader } from "@babylonjs/core/Shaders/default.vertex";
import { defaultPixelShader } from "@babylonjs/core/Shaders/default.fragment";
import { defaultVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/default.vertex";
import { defaultPixelShaderWGSL } from "@babylonjs/core/ShadersWGSL/default.fragment";
import { bindCelSettings, CEL_UNIFORMS } from "./cel-shader";

for (const wgsl of [false, true]) {
  const store = ShaderStore.GetShadersStore(wgsl ? 1 : 0);
  store.slateCelVertexShader = (
    wgsl ? defaultVertexShaderWGSL : defaultVertexShader
  ).shader;
  const uniforms = CEL_UNIFORMS.map((name) =>
    wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`,
  ).join("\n");
  store.slateCelPixelShader = (
    wgsl ? defaultPixelShaderWGSL : defaultPixelShader
  ).shader
    .replace(
      "#include<lightsFragmentFunctions>",
      `${uniforms}\n#include<slateCelLightsFragmentFunctions>`,
    )
    .replaceAll("#include<lightFragment>", "#include<slateCelLightFragment>")
    .replace(
      "#ifdef EMISSIVEASILLUMINATION",
      "diffuseBase=slateCelSurfaceLight(diffuseBase);\n#ifdef EMISSIVEASILLUMINATION",
    );
}

/** Native non-PBR surface adapter for imported and engine fallback materials. */
export class CelMaterial extends StandardMaterial {
  readonly source: PBRMaterial | StandardMaterial;
  private sourceFillMode = -1;
  private sourceLighting: boolean | undefined;
  constructor(source: PBRMaterial | StandardMaterial, scene: Scene) {
    super(`${source.name}:CEL`, scene);
    this.source = source;
    this.imageProcessingConfiguration = new ImageProcessingConfiguration();
    this.imageProcessingConfiguration.isEnabled = false;
    this.specularColor = Color3.White();
    this.useSpecularOverAlpha = false;
    this.useEmissiveAsIllumination = true;
    this.customShaderNameResolve = (_shader, uniforms) => {
      uniforms.push(...CEL_UNIFORMS);
      return "slateCel";
    };
    this.onBindObservable.add(() => {
      const effect = this.getEffect();
      if (effect) bindCelSettings(effect, scene, this.disableLighting);
    });
    this.syncSource();
  }

  override getClassName(): string {
    return "CelMaterial";
  }

  syncSource(): void {
    const source = this.source;
    const common = [
      "alpha",
      "alphaMode",
      "transparencyMode",
      "backFaceCulling",
      "sideOrientation",
      "twoSidedLighting",
      "zOffset",
      "zOffsetUnits",
      "fogEnabled",
      "disableDepthWrite",
      "needDepthPrePass",
      "pointSize",
    ] as const;
    for (const key of common)
      if (this[key] !== source[key]) this[key] = source[key] as never;
    this.metadata = source.metadata;
    this.bumpTexture = source.bumpTexture;
    this.invertNormalMapX = source.invertNormalMapX;
    this.invertNormalMapY = source.invertNormalMapY;
    this.opacityTexture = source.opacityTexture;
    this.emissiveTexture = source.emissiveTexture;
    this.alphaCutOff = source.alphaCutOff;
    if (this.sourceFillMode !== source.fillMode) {
      this.fillMode = source.fillMode;
      this.sourceFillMode = source.fillMode;
    }
    const unlit =
      source.disableLighting || (source instanceof PBRMaterial && source.unlit);
    if (this.sourceLighting !== unlit) {
      this.disableLighting = unlit;
      this.sourceLighting = unlit;
    }
    if (source instanceof PBRMaterial) {
      // glTF color factors are linear; textures retain their authored sRGB pixels.
      source.albedoColor.toGammaSpaceToRef(
        this.diffuseColor,
        this.getScene().getEngine().useExactSrgbConversions,
      );
      source.emissiveColor.toGammaSpaceToRef(
        this.emissiveColor,
        this.getScene().getEngine().useExactSrgbConversions,
      );
      this.emissiveColor.scaleInPlace(source.emissiveIntensity);
      this.diffuseTexture = source.albedoTexture;
      this.useAlphaFromDiffuseTexture = source.useAlphaFromAlbedoTexture;
    } else {
      this.diffuseColor.copyFrom(source.diffuseColor);
      this.emissiveColor.copyFrom(source.emissiveColor);
      this.diffuseTexture = source.diffuseTexture;
      this.useAlphaFromDiffuseTexture = source.useAlphaFromDiffuseTexture;
    }
  }
}

export function canUseCelMaterial(
  material: Material,
): material is PBRMaterial | StandardMaterial {
  if (material instanceof CelMaterial) return false;
  if (material instanceof PBRMaterial)
    return !material.unlit && !material.disableLighting;
  return material instanceof StandardMaterial && !material.disableLighting;
}
