import {
  NodeMaterialBlockConnectionPointTypes,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Scene } from "@babylonjs/core/scene";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";

/** A Scene resource, deliberately separate from the existing 2D texture pins. */
export class EnvironmentSampleBlock extends NodeMaterialBlock {
  private scene: Scene | null = null;
  private sampler = "";
  private available = "";
  private matrix = "";
  private parameters = "";
  private prefilter = "";

  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput(
      "direction",
      NodeMaterialBlockConnectionPointTypes.Vector3,
    );
    this.registerInput(
      "roughness",
      NodeMaterialBlockConnectionPointTypes.Float,
    );
    this.registerOutput("color", NodeMaterialBlockConnectionPointTypes.Color3);
  }

  get direction() {
    return this._inputs[0]!;
  }
  get roughness() {
    return this._inputs[1]!;
  }
  get color() {
    return this._outputs[0]!;
  }
  get environmentTexture() {
    return this.scene?.environmentTexture ?? null;
  }

  override getClassName(): string {
    return "EnvironmentSampleBlock";
  }

  override prepareDefines(
    defines: NodeMaterialDefines,
    material: NodeMaterial,
  ): void {
    defines.setValue(
      this.available,
      !!material.getScene().environmentTexture,
      true,
    );
  }

  override isReady(): boolean {
    const texture = this.environmentTexture;
    return !texture || (!texture.loadingError && texture.isReady());
  }

  override bind(effect: Effect, material: NodeMaterial): void {
    const scene = material.getScene();
    const texture = scene.environmentTexture;
    if (!texture) return;
    effect.setTexture(this.sampler, texture);
    effect.setMatrix(this.matrix, texture.getReflectionTextureMatrix());
    const oppositeZ = scene.useRightHandedSystem
      ? !texture.invertZ
      : texture.invertZ;
    effect.setFloat4(
      this.parameters,
      Math.log2(texture.getSize().width),
      texture.isRGBD ? 1 : 0,
      texture.gammaSpace ? 1 : 0,
      oppositeZ ? -1 : 1,
    );
    effect.setFloat4(
      this.prefilter,
      texture.getSize().width,
      texture.lodGenerationScale,
      texture.lodGenerationOffset,
      texture.linearSpecularLOD ? 1 : 0,
    );
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    this.scene = state.sharedData.nodeMaterial.getScene();
    this.sampler = state._getFreeVariableName("hapticSampledEnvironmentSampler");
    this.available = state._getFreeDefineName("HAPTIC_SAMPLED_ENVIRONMENT");
    this.matrix = state._getFreeVariableName("hapticSampledEnvironmentMatrix");
    this.parameters = state._getFreeVariableName("hapticSampledEnvironmentParameters");
    this.prefilter = state._getFreeVariableName("hapticSampledEnvironmentPrefilter");
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.blockingBlocks.push(this);
    // NodeMaterial's fullscreen onApply calls this list. Scene view changes
    // invalidate frozen mesh bindings through the environment controller.
    state.sharedData.bindableBlocks.push(this);
    state._emitCubeSampler(this.sampler, this.available);
    state._emitUniformFromString(
      this.matrix,
      NodeMaterialBlockConnectionPointTypes.Matrix,
    );
    state._emitUniformFromString(
      this.parameters,
      NodeMaterialBlockConnectionPointTypes.Vector4,
    );
    state._emitUniformFromString(
      this.prefilter,
      NodeMaterialBlockConnectionPointTypes.Vector4,
    );
    state._emitFunctionFromInclude(
      "helperFunctions",
      "Environment radiance decoding",
    );
    state._emitExtension(
      "shaderTextureLod",
      "#extension GL_EXT_shader_texture_lod : enable",
    );
    const params = this.parameters;
    const prefilter = this.prefilter;
    const direction = state._getFreeVariableName("hapticSampledEnvironmentDirection");
    const sampled = state._getFreeVariableName("hapticSampledEnvironmentSample");
    const roughness = state._getFreeVariableName("hapticSampledEnvironmentRoughness");
    const lod = state._getFreeVariableName("hapticSampledEnvironmentLod");
    const sample = `textureCubeLodEXT(${this.sampler},${direction},${lod})`;
    state.compilationString += `${state._declareOutput(this.color)} = vec3(0.0);\n#ifdef ${this.available}\n`;
    const vec3 = "vec3";
    state.compilationString += `${state._declareLocalVar(direction, NodeMaterialBlockConnectionPointTypes.Vector3)} = clamp(${this.direction.associatedVariableName},${vec3}(-1e8),${vec3}(1e8));\n`;
    state.compilationString += `if (!(dot(${direction},${direction})>1e-12)) { ${direction}=${vec3}(0.0,0.0,1.0); }\n`;
    state.compilationString += `${direction} = (${this.matrix} * vec4(${direction},0.0)).xyz;\n`;
    state.compilationString += `${direction}.z *= ${params}.w;\n`;
    // Babylon 9.29 PBR prefilter mapping at normal incidence. Raw sampling has
    // no view normal, anisotropy or geometric AA input; texture metadata still applies.
    state.compilationString += `${state._declareLocalVar(roughness, NodeMaterialBlockConnectionPointTypes.Float)}=clamp(${this.roughness.associatedVariableName},0.0,1.0);\n`;
    state.compilationString += `${state._declareLocalVar(lod, NodeMaterialBlockConnectionPointTypes.Float)}=log2(${prefilter}.x*(${roughness}*${roughness}+0.0005));\n`;
    state.compilationString += `if (${prefilter}.w>0.5) { ${lod}=${params}.x*${roughness}; }\n`;
    state.compilationString += `${lod}=clamp(${lod}*${prefilter}.y+${prefilter}.z,0.0,${params}.x);\n`;
    state.compilationString += `${state._declareLocalVar(sampled, NodeMaterialBlockConnectionPointTypes.Vector4)} = ${sample};\n`;
    state.compilationString += `${this.color.associatedVariableName} = ${sampled}.rgb;\n`;
    state.compilationString += `if (${params}.y > 0.5) { ${this.color.associatedVariableName} = fromRGBD(${sampled}); } else if (${params}.z > 0.5) { ${this.color.associatedVariableName} = toLinearSpace(${sampled}.rgb); }\n#endif\n`;
    return this;
  }
}
RegisterClass("BABYLON.EnvironmentSampleBlock", EnvironmentSampleBlock);
