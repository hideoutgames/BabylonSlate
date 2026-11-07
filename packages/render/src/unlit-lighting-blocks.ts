import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets as Targets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import {
  HAPTIC_2D_LIGHT_FUNCTION_GLSL, HAPTIC_2D_LIGHT_FUNCTION_WGSL, HAPTIC_2D_LIGHTS_GLSL, HAPTIC_2D_LIGHTS_WGSL, bind2DLights,
} from "./lights-2d";

/**
 * Fragment: the unlit colour (display space) times the Scene's 2D light at the pixel's world XY (`haptic2DLight`), read
 * from the one per-Scene block every 2D-lit surface binds. Bound for every draw: other programs reuse the block's
 * binding point.
 */
export class Light2DBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Fragment);
    this.registerInput("color", Types.Color3);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerOutput("output", Types.Color3);
  }
  get color() { return this._inputs[0]!; }
  get worldPosition() { return this._inputs[1]!; }
  get output() { return this._outputs[0]!; }
  override getClassName(): string { return "Light2DBlock"; }

  override updateUniformsAndSamples(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines, uniformBuffers: string[]): void {
    super.updateUniformsAndSamples(state, material, defines, uniformBuffers);
    uniformBuffers.push("Haptic2DLights");
  }

  override bind(effect: Effect, _material: NodeMaterial, mesh?: Mesh): void {
    if (mesh) bind2DLights(mesh.getScene(), effect);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.dynamicUniformBlocks.push(this);
    state.sharedData.forcedBindableBlocks.push(this);
    const wgsl = state.shaderLanguage === 1;
    state._emitFunction("haptic2DLights", wgsl ? HAPTIC_2D_LIGHTS_WGSL : HAPTIC_2D_LIGHTS_GLSL, "// Haptic2DLights");
    state._emitFunction("haptic2DLightFunction", wgsl ? HAPTIC_2D_LIGHT_FUNCTION_WGSL : HAPTIC_2D_LIGHT_FUNCTION_GLSL, "// 2D light");
    state.compilationString += `${state._declareOutput(this.output)} = ${this.color.associatedVariableName} * haptic2DLight(${this.worldPosition.associatedVariableName}.xy);\n`;
    return this;
  }
}
RegisterClass("BABYLON.Light2DBlock", Light2DBlock);

/** Fragment: a display-space colour decoded to linear, as image processing decodes an unlit surface's. */
export class UnlitLinearColorBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Fragment);
    this.registerInput("input", Types.Color3);
    this.registerOutput("output", Types.Color3);
  }
  get input() { return this._inputs[0]!; }
  get output() { return this._outputs[0]!; }
  override getClassName(): string { return "UnlitLinearColorBlock"; }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitFunctionFromInclude("helperFunctions", "");
    const decode = state.shaderLanguage === 1 ? "toLinearSpaceVec3" : "toLinearSpace";
    state.compilationString += `${state._declareOutput(this.output)} = ${decode}(${this.input.associatedVariableName});\n`;
    return this;
  }
}
RegisterClass("BABYLON.UnlitLinearColorBlock", UnlitLinearColorBlock);
