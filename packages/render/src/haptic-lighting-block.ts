import {
  Constants,
  GetEnvironmentBRDFTexture,
  NodeMaterialBlock,
  NodeMaterialBlockConnectionPointTypes,
  NodeMaterialBlockTargets,
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
import { HAPTIC_LIGHTS_GLSL, bindHapticLights } from "./haptic-lights";
import {
  HAPTIC_IRRADIANCE_KEYS,
  HAPTIC_IRRADIANCE_UNIFORMS,
  HAPTIC_LIGHTING_FUNCTIONS_GLSL,
  hapticLightingGlsl,
} from "./haptic-lighting-shader";

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

/** The Scene's environment cube as it lights `scene`'s current mesh (a reflection probe's, `mesh-environment.ts`). */
function environmentCube(scene: Scene): BaseTexture | null {
  const texture = scene.environmentTexture;
  return texture && texture.isCube && texture.isReadyOrNotBlocking() ? texture : null;
}

/**
 * Lit surface shading for graph Materials (lighting plan): every light from the `HapticLights` block and the
 * Scene's environment cube, through one lighting function (`haptic-lighting-shader.ts`). No Babylon light block
 * is involved, so a Material drawing with it compiles no light defines and no light change recompiles it.
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
  get diffuseDirect() { return this._outputs[0]!; }
  get specularDirect() { return this._outputs[1]!; }
  get diffuseIndirect() { return this._outputs[2]!; }
  get specularIndirect() { return this._outputs[3]!; }

  override prepareDefines(defines: NodeMaterialDefines, nodeMaterial: NodeMaterial, mesh?: AbstractMesh): void {
    if (!mesh) return;
    const scene = mesh.getScene();
    const environment = environmentCube(scene);
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
    const scene = mesh.getScene();
    const brdf = GetEnvironmentBRDFTexture(scene);
    return (!brdf || brdf.isReady()) && (scene.environmentTexture?.isReadyOrNotBlocking() ?? true);
  }

  override updateUniformsAndSamples(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines, uniformBuffers: string[]): void {
    super.updateUniformsAndSamples(state, material, defines, uniformBuffers);
    uniformBuffers.push("HapticLights");
  }

  override bind(effect: Effect, _nodeMaterial: NodeMaterial, mesh?: Mesh): void {
    if (!mesh) return;
    const scene = mesh.getScene();
    bindHapticLights(scene, effect);
    effect.setTexture("hapticEnvironmentBrdfSampler", GetEnvironmentBRDFTexture(scene));
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
    state._emitUniformFromString("hapticEnvironmentMatrix", NodeMaterialBlockConnectionPointTypes.Matrix);
    state._emitCubeSampler("hapticEnvironmentSampler");
    state._emit2DSampler("hapticEnvironmentBrdfSampler");
    state._emitFunction("hapticLights", HAPTIC_LIGHTS_GLSL, "// HapticLights");
    state._emitFunction("hapticLightingFunctions", HAPTIC_LIGHTING_FUNCTIONS_GLSL, "// Haptic lighting");
    for (const output of this._outputs) state.compilationString += state._declareOutput(output) + " = vec3(0.0);\n";
    state.compilationString += hapticLightingGlsl({
      worldPosition: this.worldPosition.associatedVariableName,
      worldNormal: this.worldNormal.associatedVariableName,
      normal: this.normal.isConnected ? this.normal.associatedVariableName : `${this.worldNormal.associatedVariableName}.xyz`,
      cameraPosition: this.cameraPosition.associatedVariableName,
      baseColor: this.baseColor.associatedVariableName,
      metallic: this.metallic.associatedVariableName,
      roughness: this.roughness.associatedVariableName,
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
