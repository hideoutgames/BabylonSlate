import { checkedShader } from "./checked-shader";
import {
  Color3,
  ImageProcessingConfiguration,
  PBRMaterial,
  ShaderStore,
  StandardMaterial,
  type BaseTexture,
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
import { sceneRenderingSettings } from "./render-settings";
import { reflectivityWrite, STANDARD_REFLECTIVITY_WRITE } from "./standard-reflectivity";

/**
 * `slateCelTextures`: x, y diffuse and emissive texture linear, z PBR source, w reflection glossiness.
 * `slateCelReflectivity`: rgb non-metal F0, a metalness; all zero for an unlit source.
 * With a reflectivity map (`SPECULAR`, see `CelReflectivityMap`): `slateCelReflectivityMetal` rgb the metalness
 * channel, w 1 to linearize the map; `slateCelReflectivityGloss` the glossiness or roughness channel;
 * `slateCelReflectivityMap` x 1 to take F0 from the map's rgb, y the channel term without a channel, and glossiness
 * z + w * channel term.
 */
const NATIVE_CEL_UNIFORMS = [
  ...CEL_UNIFORMS,
  "slateCelTextures",
  "slateCelReflectivity",
  "slateCelReflectivityMetal",
  "slateCelReflectivityGloss",
  "slateCelReflectivityMap",
];
const SPECULAR_VERTEX_DECLARATION = "#if defined(SPECULARTERM)\n#include<samplerVertexDeclaration>(_DEFINENAME_,SPECULAR,";
const SPECULAR_VERTEX_IMPLEMENTATION = "#if defined(SPECULARTERM)\n#include<samplerVertexImplementation>(_DEFINENAME_,SPECULAR,";
const SPECULAR_FRAGMENT_DECLARATION = "#if defined(SPECULARTERM)\n#include<samplerFragmentDeclaration>(_DEFINENAME_,SPECULAR,";
const onlyForReflectivity = (declaration: string) =>
  declaration.replace("#if defined(SPECULARTERM)", "#ifdef PREPASS_REFLECTIVITY");
for (const wgsl of [false, true]) {
  const store = ShaderStore.GetShadersStore(wgsl ? 1 : 0);
  // The adapter's specular slot carries only the source's reflectivity map, which only the reflectivity geometry pass
  // reads, so its UVs and sampler exist only there.
  store.slateCelVertexShader = checkedShader((
    wgsl ? defaultVertexShaderWGSL : defaultVertexShader
  ).shader, wgsl ? "native vertex WGSL" : "native vertex GLSL")
    .replace(SPECULAR_VERTEX_DECLARATION, onlyForReflectivity(SPECULAR_VERTEX_DECLARATION))
    .replace(SPECULAR_VERTEX_IMPLEMENTATION, onlyForReflectivity(SPECULAR_VERTEX_IMPLEMENTATION)).value;
  const uniforms = NATIVE_CEL_UNIFORMS.map((name) =>
    wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`,
  ).join("\n");
  const textureFlags = wgsl ? "uniforms.slateCelTextures" : "slateCelTextures";
  const emissiveSample = wgsl
    ? "TEXRD(emissiveSampler,emissiveSamplerSampler,fragmentInputs.vEmissiveUV+uvOffset).rgb"
    : "TEXRD(emissiveSampler,vEmissiveUV+uvOffset).rgb";
  const emissiveLevel = wgsl ? "uniforms.vEmissiveInfos.y" : "vEmissiveInfos.y";
  const reflectivity = wgsl ? "uniforms.slateCelReflectivity" : "slateCelReflectivity";
  const vec4 = wgsl ? "vec4f" : "vec4";
  const linearBase = `${wgsl ? "toLinearSpaceVec3" : "toLinearSpace"}(baseColor.rgb*diffuseColor)`;
  const reflectance = `${vec4}(mix(${reflectivity}.rgb,${linearBase},${reflectivity}.a),${textureFlags}.w)*writeGeometryInfo`;
  const [metalChannel, glossChannel, mapTerms] = [
    "slateCelReflectivityMetal",
    "slateCelReflectivityGloss",
    "slateCelReflectivityMap",
  ].map((name) => (wgsl ? `uniforms.${name}` : name));
  // The source's map, read as its own Material reads it in PBR (`celSourceReflectivityMap`).
  const mappedReflectance = [
    wgsl
      ? "var slateCelMap: vec4f=TEXRD(specularSampler,specularSamplerSampler,fragmentInputs.vSpecularUV+uvOffset);"
      : "vec4 slateCelMap=TEXRD(specularSampler,vSpecularUV+uvOffset);",
    `slateCelMap=mix(slateCelMap,${wgsl ? "toLinearSpaceVec4" : "toLinearSpace"}(slateCelMap),${metalChannel}.w);`,
    `${wgsl ? "let slateCelMetal: f32" : "float slateCelMetal"}=${reflectivity}.a*dot(slateCelMap.rgb,${metalChannel}.rgb);`,
    `${wgsl ? "let slateCelGloss: f32" : "float slateCelGloss"}=clamp(${mapTerms}.z+${mapTerms}.w*(dot(slateCelMap,${glossChannel})+${mapTerms}.y),0.0,1.0);`,
    reflectivityWrite(
      wgsl,
      `${vec4}(mix(${reflectivity}.rgb*mix(${wgsl ? "vec3f" : "vec3"}(1.0),slateCelMap.rgb,${mapTerms}.x),${linearBase},slateCelMetal),slateCelGloss)*writeGeometryInfo`,
    ),
  ].join("\n");
  store.slateCelPixelShader = checkedShader((
    wgsl ? defaultPixelShaderWGSL : defaultPixelShader
  ).shader, wgsl ? "native WGSL" : "native GLSL")
    .replace(SPECULAR_FRAGMENT_DECLARATION, onlyForReflectivity(SPECULAR_FRAGMENT_DECLARATION))
    // CEL highlights never read a specular map: the adapter's specular slot holds only the reflectivity map.
    .replace(/#ifdef SPECULAR\n[^\n]*specularColor=specularMapColor\.rgb;\n#ifdef GLOSSINESS\n[^\n]*\n#endif\n#endif\n/, "")
    .replace(/#ifdef SPECULAR\n#ifdef GLOSSINESS\nbias\*=\(1\.0-specularMapColor\.a\);\n#endif\n#endif\n/, "")
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
    // Reflect as the source does in PBR: a metal's F0 is its base color, linearized from display. Only CEL Reflection
    // Textures bind a map (`SPECULAR`); every other variant compiles the factor write alone.
    .replace(
      STANDARD_REFLECTIVITY_WRITE,
      `#ifdef PREPASS_REFLECTIVITY\n#ifdef SPECULAR\n${mappedReflectance}\n#else\n${reflectivityWrite(wgsl, reflectance)}\n#endif\n`,
    ).value;
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
    if (source.isMetallicWorkflow())
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

type Vec4 = [number, number, number, number];

/** A source's reflectivity map and the uniforms that read it as the source's own Material does in PBR. */
export interface CelReflectivityMap {
  texture: BaseTexture;
  /** `slateCelReflectivity` while the map is bound: rgb non-metal F0 factor, a metalness factor. */
  reflectivity: Vec4;
  metal: Vec4;
  gloss: Vec4;
  terms: Vec4;
}

/**
 * The map CEL Reflection Textures read for a lit source, or null: a PBR metallic workflow's metallic-roughness (ORM)
 * texture with its channel flags, a specular-glossiness workflow's reflectivity texture, or a Standard specular map.
 * The adapter binds it in its specular slot, so Babylon applies the texture's own UV set and transform.
 */
export function celSourceReflectivityMap(
  source: PBRMaterial | StandardMaterial,
  unlit: boolean,
): CelReflectivityMap | null {
  if (unlit) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  if (source instanceof PBRMaterial) {
    if (source.isMetallicWorkflow()) {
      const texture = source.metallicTexture;
      if (!texture) return null;
      // Babylon's pbrBlockReflectivity: metalness from blue or red; roughness from alpha, green or the factor alone.
      const roughness: Vec4 = source.useRoughnessFromMetallicTextureAlpha
        ? [0, 0, 0, 1]
        : source.useRoughnessFromMetallicTextureGreen
          ? [0, 1, 0, 0]
          : [0, 0, 0, 0];
      return {
        texture,
        reflectivity: [0.04, 0.04, 0.04, clamp(source.metallic ?? 1)],
        metal: source.useMetallnessFromMetallicTextureBlue ? [0, 0, 1, 0] : [1, 0, 0, 0],
        gloss: roughness,
        terms: [0, roughness.some(Boolean) ? 0 : 1, 1, -clamp(source.roughness ?? 1)],
      };
    }
    const texture = source.reflectivityTexture;
    if (!texture) return null;
    // Specular-glossiness: the map's rgb, linearized when sRGB and scaled by its level, tints the reflectivity color.
    const color = source.reflectivityColor;
    const alpha = source.useMicroSurfaceFromReflectivityMapAlpha;
    return {
      texture,
      reflectivity: [color.r * texture.level, color.g * texture.level, color.b * texture.level, 0],
      metal: [0, 0, 0, texture.gammaSpace ? 1 : 0],
      gloss: alpha ? [0, 0, 0, 1] : [0, 0, 0, 0],
      terms: [1, alpha ? 0 : 1, 0, clamp(source.microSurface)],
    };
  }
  const texture = source.specularTexture;
  if (!texture) return null;
  // Babylon's Standard write: the linearized specular map, its alpha the glossiness.
  return { texture, reflectivity: [1, 1, 1, 0], metal: [0, 0, 0, 1], gloss: [0, 0, 0, 1], terms: [1, 0, 0, 1] };
}

/** Native non-PBR surface adapter for imported and engine fallback materials. */
export class CelMaterial extends StandardMaterial {
  readonly source: PBRMaterial | StandardMaterial;
  private sourceFillMode = -1;
  private sourceLighting: boolean | undefined;
  /** Read only by the reflectivity geometry pass (`PREPASS_REFLECTIVITY`), which Real-Time Reflections request. */
  private reflectivity: readonly number[] = [0, 0, 0, 0, 0];
  /** In the specular slot only while CEL Reflection Textures apply (`celReflectionTextures`). */
  private reflectivityMap: CelReflectivityMap | null = null;
  /** The `celReflectionTextures` value `reflectivityMap` follows. */
  private reflectionTextures = false;
  private readonly rendering: ReturnType<typeof sceneRenderingSettings>;
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
        const map = this.reflectivityMap;
        const reflectivity = map?.reflectivity ?? this.reflectivity;
        effect.setFloat4("slateCelReflectivity", reflectivity[0]!, reflectivity[1]!, reflectivity[2]!, reflectivity[3]!);
        if (map) {
          effect.setFloat4("slateCelReflectivityMetal", ...map.metal);
          effect.setFloat4("slateCelReflectivityGloss", ...map.gloss);
          effect.setFloat4("slateCelReflectivityMap", ...map.terms);
        }
      }
    });
    this.rendering = sceneRenderingSettings(scene);
    this.syncSource();
  }

  override getClassName(): string {
    return "CelMaterial";
  }

  /**
   * CEL's light include is derived from Babylon's own, so it keeps Babylon's light defines under fixed-shape lighting.
   * Every pass checks readiness before it draws, so the reflectivity map follows `celReflectionTextures` here.
   */
  override isReadyForSubMesh(mesh: AbstractMesh, subMesh: SubMesh, useInstances?: boolean): boolean {
    if (this.reflectionTextures !== this.rendering.celReflectionTextures) this.syncReflectivity();
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
    this.syncReflectivity();
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

  /** Factors always; the source's map only while CEL reflections run with CEL Reflection Textures on. */
  private syncReflectivity(): void {
    const unlit = this.disableLighting;
    this.reflectivity = celSourceReflectivity(this.source, unlit);
    this.reflectionTextures = this.rendering.celReflectionTextures;
    const map = this.reflectionTextures ? celSourceReflectivityMap(this.source, unlit) : null;
    this.reflectivityMap = map;
    const texture = map?.texture ?? null;
    if (this.specularTexture === texture) return;
    this.specularTexture = texture;
    // A frozen material keeps its ready variant until marked dirty.
    if (this.isFrozen) this.markDirty(true);
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
