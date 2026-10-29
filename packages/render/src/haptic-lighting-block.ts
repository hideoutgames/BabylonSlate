import {
  Constants,
  GetEnvironmentBRDFTexture,
  NodeMaterialBlock,
  NodeMaterialBlockConnectionPointTypes,
  NodeMaterialBlockTargets,
  ShaderLanguage,
  type AbstractMesh,
  type BaseTexture,
  type CubeTexture,
  type Effect,
  type Mesh,
  type NodeMaterial,
  type NodeMaterialDefines,
  type Scene,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { SphericalHarmonics, type SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { areaEmissionTexture } from "./area-emission-array";
import { CEL_UNIFORMS, bindCelSettings, celFunctions } from "./cel-shader";
import { HAPTIC_LIGHTS_GLSL, HAPTIC_LIGHTS_WGSL, bindHapticLights } from "./haptic-lights";
import {
  HAPTIC_IRRADIANCE_KEYS,
  HAPTIC_IRRADIANCE_UNIFORMS,
  HAPTIC_LIGHTING_FUNCTIONS_GLSL,
  HAPTIC_LIGHTING_FUNCTIONS_WGSL,
  hapticLightingGlsl,
  hapticLightingWgsl,
} from "./haptic-lighting-shader";
import { sceneRenderingSettings } from "./render-settings";
import { shadowAtlasTexture } from "./shadow-atlas";

const SHADOW_ATLAS_SAMPLER = "hapticShadowAtlas";

const VECTOR4_UNIFORMS = ["hapticEnvironment", "hapticEnvironmentBoxPosition", "hapticEnvironmentBoxSize", ...HAPTIC_IRRADIANCE_UNIFORMS];

const harmonicsByPolynomial = new WeakMap<SphericalPolynomial, SphericalHarmonics>();

/** The harmonics Babylon's PBR lights with: converted from the cube's polynomial and pre-scaled, once per polynomial. */
function renderingHarmonics(polynomial: SphericalPolynomial | null): SphericalHarmonics | null {
  if (!polynomial) return null;
  let harmonics = harmonicsByPolynomial.get(polynomial);
  if (!harmonics) {
    harmonics = SphericalHarmonics.FromPolynomial(polynomial);
    harmonics.preScaleForRendering();
    harmonicsByPolynomial.set(polynomial, harmonics);
  }
  return harmonics;
}

function celMode(scene: Scene): boolean {
  return sceneRenderingSettings(scene).mode === "cel";
}

const celEffects = new WeakMap<Effect, boolean>();

/** Whether `effect` is a CEL program. A draw binds for its own Effect, which can be the previous mode's until the new one compiles. */
function celEffect(effect: Effect): boolean {
  let cel = celEffects.get(effect);
  if (cel === undefined) {
    cel = /^#define HAPTIC_CEL$/m.test(effect.defines);
    celEffects.set(effect, cel);
  }
  return cel;
}

/** The Scene's environment cube as it lights `scene`'s current mesh (a reflection probe's, `mesh-environment.ts`). */
function environmentCube(scene: Scene): BaseTexture | null {
  const texture = scene.environmentTexture;
  return texture && texture.isCube && texture.isReadyOrNotBlocking() ? texture : null;
}

/**
 * Lit surface shading for graph Materials (lighting plan): every light from the `HapticLights` block and the
 * Scene's environment cube, through one lighting function (`haptic-lighting-shader.ts`). No Babylon light block
 * is involved, so a Material drawing with it compiles no light defines and no light change recompiles it. CEL is
 * the `HAPTIC_CEL` define, set from the Scene's render mode: a mode change recompiles, as a settings change may.
 */
export class HapticLightingBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput("worldPosition", NodeMaterialBlockConnectionPointTypes.Vector4, false, NodeMaterialBlockTargets.Fragment);
    this.registerInput("worldNormal", NodeMaterialBlockConnectionPointTypes.Vector4, false, NodeMaterialBlockTargets.Fragment);
    this.registerInput("cameraPosition", NodeMaterialBlockConnectionPointTypes.Vector3, false, NodeMaterialBlockTargets.Fragment);
    this.registerInput("baseColor", NodeMaterialBlockConnectionPointTypes.Color3, false, NodeMaterialBlockTargets.Fragment);
    this.registerInput("metallic", NodeMaterialBlockConnectionPointTypes.Float, false, NodeMaterialBlockTargets.Fragment);
    this.registerInput("roughness", NodeMaterialBlockConnectionPointTypes.Float, false, NodeMaterialBlockTargets.Fragment);
    // A world-space shading normal (a normal map's); the interpolated world normal otherwise.
    this.registerInput("normal", NodeMaterialBlockConnectionPointTypes.Vector3, true, NodeMaterialBlockTargets.Fragment);
    this.registerInput("environmentInfluence", NodeMaterialBlockConnectionPointTypes.Float, true, NodeMaterialBlockTargets.Fragment);
    // A non-metal's reflectance, F0 = 0.08 x Specular; 0.5 (F0 0.04) unconnected.
    this.registerInput("specular", NodeMaterialBlockConnectionPointTypes.Float, true, NodeMaterialBlockTargets.Fragment);
    for (const name of ["diffuseDirect", "specularDirect", "diffuseIndirect", "specularIndirect"])
      this.registerOutput(name, NodeMaterialBlockConnectionPointTypes.Color3, NodeMaterialBlockTargets.Fragment);
  }

  override getClassName(): string {
    return "HapticLightingBlock";
  }

  get worldPosition() { return this._inputs[0]!; }
  get worldNormal() { return this._inputs[1]!; }
  get cameraPosition() { return this._inputs[2]!; }
  get baseColor() { return this._inputs[3]!; }
  get metallic() { return this._inputs[4]!; }
  get roughness() { return this._inputs[5]!; }
  get normal() { return this._inputs[6]!; }
  get environmentInfluence() { return this._inputs[7]!; }
  get specular() { return this._inputs[8]!; }
  get diffuseDirect() { return this._outputs[0]!; }
  get specularDirect() { return this._outputs[1]!; }
  get diffuseIndirect() { return this._outputs[2]!; }
  get specularIndirect() { return this._outputs[3]!; }

  override prepareDefines(defines: NodeMaterialDefines, nodeMaterial: NodeMaterial, mesh?: AbstractMesh): void {
    if (!mesh) return;
    const scene = mesh.getScene();
    const cel = celMode(scene);
    // CEL lights with the cube's irradiance polynomial alone (`bindCelSettings`), so its programs ignore the cube.
    const environment = cel ? null : environmentCube(scene);
    defines.setValue("HAPTIC_CEL", cel, true);
    // A different cube format or projection is a settings change, which may compile; lights never are.
    defines.setValue("HAPTIC_ENVIRONMENT", !!environment, true);
    defines.setValue("HAPTIC_ENVIRONMENT_RGBD", !!environment?.isRGBD, true);
    defines.setValue("HAPTIC_ENVIRONMENT_GAMMA", !!environment && !environment.isRGBD && environment.gammaSpace, true);
    defines.setValue("HAPTIC_ENVIRONMENT_BOX", !!(environment as CubeTexture | null)?.boundingBoxSize, true);
    defines.setValue("HAPTIC_ENVIRONMENT_OPPOSITEZ", !!environment && (scene.useRightHandedSystem ? !environment.invertZ : environment.invertZ), true);
    defines.setValue("HAPTIC_ENVIRONMENT_INVERTY", environment?.coordinatesMode === Constants.TEXTURE_INVCUBIC_MODE, true);
    defines.setValue("HAPTIC_BRDF_RGBD", !!GetEnvironmentBRDFTexture(scene)?.isRGBD, true);
    defines.setValue("HAPTIC_EXACT_SRGB", scene.getEngine().useExactSrgbConversions, true);
    defines.setValue("HAPTIC_TWO_SIDED", !nodeMaterial.backFaceCulling, true);
  }

  override isReady(mesh: AbstractMesh): boolean {
    const scene = mesh.getScene(), brdf = GetEnvironmentBRDFTexture(scene);
    // Every program binds the split-sum table; CEL ignores the cube.
    return (!brdf || brdf.isReady()) && (celMode(scene) || (scene.environmentTexture?.isReadyOrNotBlocking() ?? true));
  }

  override updateUniformsAndSamples(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines, uniformBuffers: string[]): void {
    super.updateUniformsAndSamples(state, material, defines, uniformBuffers);
    uniformBuffers.push("HapticLights");
  }

  override bind(effect: Effect, _nodeMaterial: NodeMaterial, mesh?: Mesh): void {
    if (!mesh) return;
    const scene = mesh.getScene();
    bindHapticLights(scene, effect);
    effect.setTexture("hapticAreaLtc1Sampler", scene._ltcTextures?.LTC1 ?? null);
    effect.setTexture("hapticAreaLtc2Sampler", scene._ltcTextures?.LTC2 ?? null);
    effect.setTexture("hapticAreaEmissionSampler", areaEmissionTexture(scene));
    effect.setDepthStencilTexture(SHADOW_ATLAS_SAMPLER, shadowAtlasTexture(scene));
    effect.setFloat("hapticShadowReceiver", mesh.receiveShadows ? 1 : 0);
    // WebGPU draws only with every declared texture bound: the table always, the cube where a program declares it.
    effect.setTexture("hapticEnvironmentBrdfSampler", GetEnvironmentBRDFTexture(scene));
    if (celEffect(effect)) {
      bindCelSettings(effect, scene);
      return;
    }
    const environment = environmentCube(scene);
    if (!environment) return;
    effect.setTexture("hapticEnvironmentSampler", environment);
    effect.setMatrix("hapticEnvironmentMatrix", environment.getReflectionTextureMatrix());
    effect.setFloat4("hapticEnvironment", environment.getSize().width, environment.lodGenerationScale, environment.lodGenerationOffset,
      scene.iblIntensity * environment.level);
    const box = environment as CubeTexture;
    if (box.boundingBoxSize) {
      effect.setFloat4("hapticEnvironmentBoxPosition", box.boundingBoxPosition.x, box.boundingBoxPosition.y, box.boundingBoxPosition.z, 0);
      effect.setFloat4("hapticEnvironmentBoxSize", box.boundingBoxSize.x, box.boundingBoxSize.y, box.boundingBoxSize.z, 0);
    }
    const harmonics = renderingHarmonics(environment.sphericalPolynomial);
    for (let index = 0; index < HAPTIC_IRRADIANCE_KEYS.length; index++) {
      const value = harmonics?.[HAPTIC_IRRADIANCE_KEYS[index]!];
      effect.setFloat4(HAPTIC_IRRADIANCE_UNIFORMS[index]!, value?.x ?? 0, value?.y ?? 0, value?.z ?? 0, 0);
    }
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    if (state.target !== NodeMaterialBlockTargets.Fragment) return this;
    // As Babylon's PBR block: defines, readiness and the light block's name for the Effect, and a bind on every
    // draw, since the environment cube is per mesh and other programs reuse the light block's binding point.
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.blockingBlocks.push(this);
    state.sharedData.dynamicUniformBlocks.push(this);
    state.sharedData.forcedBindableBlocks.push(this);
    for (const uniform of VECTOR4_UNIFORMS) state._emitUniformFromString(uniform, NodeMaterialBlockConnectionPointTypes.Vector4);
    for (const uniform of CEL_UNIFORMS) state._emitUniformFromString(uniform, NodeMaterialBlockConnectionPointTypes.Vector4, "HAPTIC_CEL");
    state._emitUniformFromString("hapticEnvironmentMatrix", NodeMaterialBlockConnectionPointTypes.Matrix);
    state._emitUniformFromString("hapticShadowReceiver", NodeMaterialBlockConnectionPointTypes.Float);
    state._emitCubeSampler("hapticEnvironmentSampler", "defined(HAPTIC_ENVIRONMENT)");
    state._emit2DSampler("hapticEnvironmentBrdfSampler");
    state._emit2DSampler("hapticAreaLtc1Sampler");
    state._emit2DSampler("hapticAreaLtc2Sampler");
    state._emit2DArraySampler("hapticAreaEmissionSampler");
    const wgsl = state.shaderLanguage === ShaderLanguage.WGSL;
    // The shadow atlas compares as it samples (`shadow-atlas.ts`); the build state has no helper for a compare sampler.
    if (!state.samplers.includes(SHADOW_ATLAS_SAMPLER)) {
      state._samplerDeclaration += wgsl
        ? `var ${SHADOW_ATLAS_SAMPLER}Sampler: sampler_comparison;\nvar ${SHADOW_ATLAS_SAMPLER}: texture_depth_2d;\n`
        : `uniform highp sampler2DShadow ${SHADOW_ATLAS_SAMPLER};\n`;
      state.samplers.push(SHADOW_ATLAS_SAMPLER);
    }
    state._emitFunction("hapticLights", wgsl ? HAPTIC_LIGHTS_WGSL : HAPTIC_LIGHTS_GLSL, "// HapticLights");
    state._emitFunction("hapticCelFunctions", `#ifdef HAPTIC_CEL\n${celFunctions(wgsl)}\n#endif\n`, "// CEL");
    state._emitFunction("hapticLightingFunctions", wgsl ? HAPTIC_LIGHTING_FUNCTIONS_WGSL : HAPTIC_LIGHTING_FUNCTIONS_GLSL, "// Haptic lighting");
    for (const output of this._outputs) state.compilationString += `${state._declareOutput(output)} = ${wgsl ? "vec3f" : "vec3"}(0.0);\n`;
    state.compilationString += (wgsl ? hapticLightingWgsl : hapticLightingGlsl)({
      worldPosition: this.worldPosition.associatedVariableName,
      worldNormal: this.worldNormal.associatedVariableName,
      normal: this.normal.isConnected ? this.normal.associatedVariableName : `${this.worldNormal.associatedVariableName}.xyz`,
      cameraPosition: this.cameraPosition.associatedVariableName,
      baseColor: this.baseColor.associatedVariableName,
      metallic: this.metallic.associatedVariableName,
      specular: this.specular.isConnected ? this.specular.associatedVariableName : "0.5",
      roughness: this.roughness.associatedVariableName,
      environmentInfluence: this.environmentInfluence.isConnected ? this.environmentInfluence.associatedVariableName : "1.0",
    }, {
      diffuseDirect: this.diffuseDirect.associatedVariableName,
      specularDirect: this.specularDirect.associatedVariableName,
      diffuseIndirect: this.diffuseIndirect.associatedVariableName,
      specularIndirect: this.specularIndirect.associatedVariableName,
    });
    return this;
  }
}
RegisterClass("BABYLON.HapticLightingBlock", HapticLightingBlock);

/** A render-mode change re-prepares `material`'s defines (`HAPTIC_CEL`) on its next draw, frozen or not. */
export function followRenderMode(material: NodeMaterial): void {
  const listeners = sceneRenderingSettings(material.getScene()).listeners;
  const listener = () => material.markDirty(true);
  listeners.add(listener);
  material.onDisposeObservable.addOnce(() => listeners.delete(listener));
}
