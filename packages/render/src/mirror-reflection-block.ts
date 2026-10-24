import {
  Matrix,
  NodeMaterialBlock,
  NodeMaterialBlockConnectionPointTypes as Types,
  NodeMaterialBlockTargets,
  type AbstractMesh,
  type Effect,
  type NodeMaterial,
  type NodeMaterialDefines,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/helperFunctions";
import { isMirrorSurfaceMesh, mirrorReflectionBinding } from "./mirror-surface-state";
import { existingShadowSamplerPlaceholders } from "./shadow-sampler-placeholders";

const scratchOffset = new Matrix();
const scratchMatrix = new Matrix();

/**
 * The reflection a Mirror component drew, sampled at the surface's own screen position plus Offset (texture units).
 *
 * The sampler and its code compile only into a Mirror surface's variant (a per-mesh define), so the same Material on
 * any other mesh, or in a preview, outputs black and binds nothing. A surface whose reflection has not drawn yet (or
 * holds no storage) binds the scene's one-texel placeholder and outputs black. `builtIn` is the Mirror's own surface:
 * the stored colour unchanged (already in the view's colour space) times the component's Tint. Otherwise the output is
 * linear colour, as graph colours are: display-encoded reflections are decoded.
 */
export class MirrorReflectionBlock extends NodeMaterialBlock {
  readonly builtIn: boolean;
  private sampler = "";
  private define = "";
  private matrix = "";
  private parameters = "";
  private tint = "";

  constructor(name: string, builtIn = false) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.builtIn = builtIn;
    this.registerInput("worldPosition", Types.Vector4, false);
    this.registerInput("offset", Types.Vector2, true);
    this.registerOutput("color", Types.Color3);
  }

  get worldPosition() { return this._inputs[0]!; }
  get offset() { return this._inputs[1]!; }
  get color() { return this._outputs[0]!; }

  override getClassName(): string { return "MirrorReflectionBlock"; }

  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    defines.setValue(this.define, isMirrorSurfaceMesh(mesh), true);
  }

  override bind(effect: Effect, material: NodeMaterial, mesh?: AbstractMesh): void {
    const binding = mirrorReflectionBinding(mesh);
    if (!binding) return;
    const scene = material.getScene();
    const texture = binding.texture?.getInternalTexture() ? binding.texture : null;
    if (texture) {
      effect.setTexture(this.sampler, texture);
      // Positions arrive relative to this pass's floating origin; the matrix takes them relative to the drawn one.
      const offset = scene.floatingOriginOffset, origin = binding.origin;
      const dx = offset.x - origin.x, dy = offset.y - origin.y, dz = offset.z - origin.z;
      if (dx === 0 && dy === 0 && dz === 0) effect.setMatrix(this.matrix, binding.viewProjection);
      else {
        Matrix.TranslationToRef(dx, dy, dz, scratchOffset);
        scratchOffset.multiplyToRef(binding.viewProjection, scratchMatrix);
        effect.setMatrix(this.matrix, scratchMatrix);
      }
    } else {
      const placeholder = existingShadowSamplerPlaceholders(scene)?.plain;
      if (placeholder) effect.setTexture(this.sampler, placeholder);
      effect.setMatrix(this.matrix, Matrix.IdentityReadOnly);
    }
    effect.setFloat4(this.parameters, texture ? 1 : 0, binding.gammaSpace ? 1 : 0, 0, 0);
    if (this.builtIn) effect.setFloat3(this.tint, binding.tint[0], binding.tint[1], binding.tint[2]);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = state.shaderLanguage === 1;
    this.sampler = state._getFreeVariableName("slateMirrorSampler");
    this.define = state._getFreeDefineName("SLATE_MIRROR_REFLECTION");
    this.matrix = state._getFreeVariableName("slateMirrorViewProjection");
    this.parameters = state._getFreeVariableName("slateMirrorParameters");
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.bindableBlocks.push(this);
    state._emit2DSampler(this.sampler, this.define);
    state._emitUniformFromString(this.matrix, Types.Matrix);
    state._emitUniformFromString(this.parameters, Types.Vector4);
    if (this.builtIn) {
      this.tint = state._getFreeVariableName("slateMirrorTint");
      state._emitUniformFromString(this.tint, Types.Vector3);
    } else {
      state._emitFunctionFromInclude("helperFunctions", "Mirror reflection decoding");
    }
    const uniform = wgsl ? "uniforms." : "";
    const vec2 = wgsl ? "vec2f" : "vec2", vec3 = wgsl ? "vec3f" : "vec3", vec4 = wgsl ? "vec4f" : "vec4";
    const clip = state._getFreeVariableName("slateMirrorClip");
    const uv = state._getFreeVariableName("slateMirrorUv");
    const sampled = state._getFreeVariableName("slateMirrorSample");
    const output = this.color.associatedVariableName;
    const offset = this.offset.isConnected ? this.offset.associatedVariableName : `${vec2}(0.0)`;
    state.compilationString += `${state._declareOutput(this.color)} = ${vec3}(0.0);\n#ifdef ${this.define}\n`;
    state.compilationString += `${state._declareLocalVar(clip, Types.Vector4)} = ${uniform}${this.matrix} * ${vec4}(${this.worldPosition.associatedVariableName}.xyz, 1.0);\n`;
    state.compilationString += `${state._declareLocalVar(uv, Types.Vector2)} = ${vec2}(0.5) + ${vec2}(0.5) * ${clip}.xy / max(${clip}.w, 1e-6) + ${offset};\n`;
    state.compilationString += `${state._declareLocalVar(sampled, Types.Vector4)} = ${state._generateTextureSample(uv, this.sampler)};\n`;
    if (this.builtIn) {
      state.compilationString += `${output} = ${sampled}.rgb * ${uniform}${this.tint} * ${uniform}${this.parameters}.x;\n`;
    } else {
      state.compilationString += `${output} = ${sampled}.rgb;\n`;
      state.compilationString += `if (${uniform}${this.parameters}.y > 0.5) { ${output} = ${wgsl ? "toLinearSpaceVec3" : "toLinearSpace"}(${output}); }\n`;
      state.compilationString += `${output} = ${output} * ${uniform}${this.parameters}.x;\n`;
    }
    state.compilationString += "#endif\n";
    return this;
  }
}
RegisterClass("BABYLON.MirrorReflectionBlock", MirrorReflectionBlock);
