import { NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Face normal from the final, deformed world position; never edits shared geometry. */
export class FlatNormalBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput("worldPosition", NodeMaterialBlockConnectionPointTypes.Vector4);
    this.registerInput("modelNormal", NodeMaterialBlockConnectionPointTypes.Vector3);
    this.registerOutput("output", NodeMaterialBlockConnectionPointTypes.Vector3);
  }
  get worldPosition() { return this._inputs[0]!; }
  get modelNormal() { return this._inputs[1]!; }
  get output() { return this._outputs[0]!; }
  override getClassName(): string { return "FlatNormalBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitExtension("derivatives", "#extension GL_OES_standard_derivatives : enable");
    const wgsl = state.shaderLanguage === 1;
    const face = state._getFreeVariableName("faceNormal");
    const position = `${this.worldPosition.associatedVariableName}.xyz`;
    const model = this.modelNormal.associatedVariableName;
    state.compilationString += `${state._declareLocalVar(face, NodeMaterialBlockConnectionPointTypes.Vector3)} = cross(${wgsl ? "dpdx" : "dFdx"}(${position}), ${wgsl ? "dpdy" : "dFdy"}(${position}));\n`;
    // Derivative orientation differs with projection/backend and mirrored transforms.
    // Use the authored normal only to select the outward hemisphere, never its slope.
    state.compilationString += `if (dot(${face}, ${model}) < 0.0) { ${face} = -${face}; }\n`;
    state.compilationString += `${state._declareOutput(this.output)} = normalize(${face});\n`;
    return this;
  }
}
RegisterClass("BABYLON.FlatNormalBlock", FlatNormalBlock);
