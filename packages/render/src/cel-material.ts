import { checkedShader } from "./checked-shader";
import {
  Color3,
  ImageProcessingConfiguration,
  PBRMaterial,
  ShaderStore,
  StandardMaterial,
  type Material,
  type AbstractMesh,
  type Observer,
  type Scene,
  type SubMesh,
} from "@babylonjs/core";
import { withLegacyLightDefines } from "./fixed-light-binding";
import { defaultVertexShader } from "@babylonjs/core/Shaders/default.vertex";
import { defaultPixelShader } from "@babylonjs/core/Shaders/default.fragment";
import { defaultVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/default.vertex";
import { defaultPixelShaderWGSL } from "@babylonjs/core/ShadersWGSL/default.fragment";
import {
  bindCelSettings,
  celLightAccumulators,
  celEnvironmentAccumulation,
  CEL_UNIFORMS,
} from "./cel-shader";
import { reflectivityWrite, STANDARD_REFLECTIVITY_WRITE } from "./standard-reflectivity";

/**
 * `slateCelTextures`: x, y diffuse and emissive texture linear, z PBR source, w reflection glossiness.
 * `slateCelReflectivity`: rgb non-metal F0, a metalness; all zero for an unlit source.
 */
const NATIVE_CEL_UNIFORMS = [...CEL_UNIFORMS, "slateCelTextures", "slateCelReflectivity"];
for (const wgsl of [false, true]) {
  const store = ShaderStore.GetShadersStore(wgsl ? 1 : 0);
  store.slateCelVertexShader = (
    wgsl ? defaultVertexShaderWGSL : defaultVertexShader
  ).shader;
  const uniforms = NATIVE_CEL_UNIFORMS.map((name) =>
    wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`,
  ).join("\n");
  const textureFlags = wgsl ? "uniforms.slateCelTextures" : "slateCelTextures";
  const emissiveSample = wgsl
    ? "TEXRD(emissiveSampler,emissiveSamplerSampler,fragmentInputs.vEmissiveUV+uvOffset).rgb"
    : "TEXRD(emissiveSampler,vEmissiveUV+uvOffset).rgb";
  const emissiveLevel = wgsl ? "uniforms.vEmissiveInfos.y" : "vEmissiveInfos.y";
  const reflectivity = wgsl ? "uniforms.slateCelReflectivity" : "slateCelReflectivity";
  const reflectance = `${wgsl ? "vec4f" : "vec4"}(mix(${reflectivity}.rgb,${wgsl ? "toLinearSpaceVec3" : "toLinearSpace"}(baseColor.rgb*diffuseColor),${reflectivity}.a),${textureFlags}.w)*writeGeometryInfo`;
  store.slateCelPixelShader = checkedShader((
    wgsl ? defaultPixelShaderWGSL : defaultPixelShader
  ).shader, wgsl ? "native WGSL" : "native GLSL")
    .replace(
      "#include<lightsFragmentFunctions>",
      `${uniforms}\n#include<slateCelLightsFragmentFunctions>`,
    )
    .replaceAll("#include<lightFragment>", "#include<slateCelLightFragment>", 1)
    .replace(
      /(vec3 diffuseBase|var diffuseBase: vec3f)/,
      `${celLightAccumulators(wgsl)}$1`,
    )
    .replace(
      "#define CUSTOM_FRAGMENT_UPDATE_DIFFUSE",
      `${wgsl ? `baseColor=vec4f(mix(baseColor.rgb,slateCelTextureToDisplay(baseColor.rgb),${textureFlags}.x),baseColor.a);` : `baseColor.rgb=mix(baseColor.rgb,slateCelTextureToDisplay(baseColor.rgb),${textureFlags}.x);`}\n#define CUSTOM_FRAGMENT_UPDATE_DIFFUSE`,
    )
    .replace(
      `emissiveColor+=${emissiveSample}*${emissiveLevel};`,
      `${wgsl ? "var celEmission: vec3f" : "vec3 celEmission"}=${emissiveSample};\ncelEmission=mix(celEmission,slateCelTextureToDisplay(celEmission),${textureFlags}.y)*${emissiveLevel};\nemissiveColor=mix(emissiveColor+celEmission,emissiveColor*celEmission,${textureFlags}.z);`,
    )
    .replace(
      "#ifdef EMISSIVEASILLUMINATION",
      `${celEnvironmentAccumulation(wgsl)}\ndiffuseBase=slateCelSurfaceLight(diffuseBase,slateCelPeak);\n#ifdef SPECULARTERM\nspecularBase=slateCelSurfaceSpecular(specularBase);\n#endif\n#ifdef EMISSIVEASILLUMINATION`,
      2,
    )
    // Reflect as the source does in PBR, from its factors: a metal's F0 is its base color, linearized from display.
    .replace(STANDARD_REFLECTIVITY_WRITE, `#ifdef PREPASS_REFLECTIVITY\n${reflectivityWrite(wgsl, reflectance)}\n`).value;
}

const linearSpecular = new Color3();

/** Reflectivity uniforms (rgb non-metal F0, metalness, glossiness) for a source as Babylon's PBR draws it. */
export function celSourceReflectivity(
  source: PBRMaterial | StandardMaterial,
  unlit: boolean,
): [number, number, number, number, number] {
  if (unlit) return [0, 0, 0, 0, 0];
  if (source instanceof PBRMaterial) {
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    // Metallic workflow, as Babylon selects it. A metalness texture is not read here, so it reads as non-metal.
    if (source.metallic !== null || source.roughness !== null)
      return [0.04, 0.04, 0.04, source.metallicTexture ? 0 : clamp(source.metallic ?? 1), 1 - clamp(source.roughness ?? 1)];
    // Specular-glossiness workflow: the reflectivity color is F0. A reflectivity texture is not read, so none.
    if (source.reflectivityTexture) return [0, 0, 0, 0, 0];
    const color = source.reflectivityColor;
    return [color.r, color.g, color.b, 0, clamp(source.microSurface)];
  }
  // Babylon's Standard encoding: the linear specular color at full gloss. A specular map is not read, so none.
  if (source.specularTexture) return [0, 0, 0, 0, 0];
  source.specularColor.toLinearSpaceToRef(linearSpecular);
  return [linearSpecular.r, linearSpecular.g, linearSpecular.b, 0, 1];
}

/** Native non-PBR surface adapter for imported and engine fallback materials. */
export class CelMaterial extends StandardMaterial {
  readonly source: PBRMaterial | StandardMaterial;
  private sourceFillMode = -1;
  private sourceLighting: boolean | undefined;
  /** Read only by the reflectivity geometry pass (`PREPASS_REFLECTIVITY`), which Real-Time Reflections request. */
  private reflectivity: readonly number[] = [0, 0, 0, 0, 0];
  private readonly shadowShaderResolver: Material["customShaderNameResolve"];
  private readonly shadowBindObserver: Observer<AbstractMesh>;
  constructor(source: PBRMaterial | StandardMaterial, scene: Scene) {
    super(`${source.name}:CEL`, scene);
    this.source = source;
    this.imageProcessingConfiguration = new ImageProcessingConfiguration();
    this.imageProcessingConfiguration.isEnabled = false;
    this.specularColor = Color3.White();
    this.useSpecularOverAlpha = false;
    this.useEmissiveAsIllumination = true;
    this.customShaderNameResolve = this.shadowShaderResolver = (_shader, uniforms) => {
      uniforms.push(...NATIVE_CEL_UNIFORMS);
      return "slateCel";
    };
    this.shadowBindObserver = this.onBindObservable.add(() => {
      const effect = this.getEffect();
      if (effect) {
        bindCelSettings(effect, scene, this.disableLighting, source instanceof PBRMaterial ? source.environmentIntensity : 1);
        effect.setFloat4(
          "slateCelTextures",
          this.diffuseTexture
            ? this.diffuseTexture.gammaSpace
              ? 0
              : 1
            : source instanceof PBRMaterial
              ? 1
              : 0,
          this.emissiveTexture && !this.emissiveTexture.gammaSpace ? 1 : 0,
          source instanceof PBRMaterial ? 1 : 0,
          this.reflectivity[4]!,
        );
        const reflectivity = this.reflectivity;
        effect.setFloat4("slateCelReflectivity", reflectivity[0]!, reflectivity[1]!, reflectivity[2]!, reflectivity[3]!);
      }
    });
    this.syncSource();
  }

  override getClassName(): string {
    return "CelMaterial";
  }

  /** CEL's light include is derived from Babylon's own, so it keeps Babylon's light defines under fixed-shape lighting. */
  override isReadyForSubMesh(mesh: AbstractMesh, subMesh: SubMesh, useInstances?: boolean): boolean {
    return withLegacyLightDefines(() => super.isReadyForSubMesh(mesh, subMesh, useInstances));
  }

  /** Shadow caching may rely only on the adapter's own vertex/bind hooks. */
  hasOriginalShadowHooks(): boolean {
    return this.customShaderNameResolve === this.shadowShaderResolver &&
      this.onBindObservable.observers.length === 1 &&
      this.onBindObservable.observers[0] === this.shadowBindObserver;
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
    this.reflectivity = celSourceReflectivity(source, unlit);
    if (source instanceof PBRMaterial) {
      // glTF color factors are linear; textures retain their authored sRGB pixels.
      source.albedoColor.toGammaSpaceToRef(this.diffuseColor, true);
      source.emissiveColor.toGammaSpaceToRef(this.emissiveColor, true);
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
