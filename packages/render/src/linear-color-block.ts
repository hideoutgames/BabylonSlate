import { NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Scene fog is authored in display space; surface lighting is linear. */
export class LinearColorBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput("color", Types.Color3);
    this.registerOutput("output", Types.Color3);
  }
  get color() { return this._inputs[0]!; }
  get output() { return this._outputs[0]!; }
  override getClassName(): string { return "LinearColorBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitFunctionFromInclude("helperFunctions", "Scene fog color conversion");
    state.compilationString += `${state._declareOutput(this.output)} = toLinearSpace(${this.color.associatedVariableName});\n`;
    return this;
  }
}
RegisterClass("BABYLON.LinearColorBlock", LinearColorBlock);
