import {
  NodeMaterialBlock,
  NodeMaterialBlockTargets,
  NodeMaterialBlockConnectionPointTypes,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Convert linear graph color once before CEL's display-space light ramp. */
export class DisplayColorBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput("color", NodeMaterialBlockConnectionPointTypes.Color3);
    this.registerOutput("output", NodeMaterialBlockConnectionPointTypes.Color3);
  }
  get color() {
    return this._inputs[0]!;
  }
  get output() {
    return this._outputs[0]!;
  }
  override getClassName(): string {
    return "DisplayColorBlock";
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = state.shaderLanguage === 1;
    const fn = wgsl
      ? "fn slateLinearToDisplay(color: vec3f) -> vec3f { return mix(12.92 * color, 1.055 * pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055), step(vec3f(0.0031308), color)); }"
      : "vec3 slateLinearToDisplay(vec3 color) { return mix(12.92 * color, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - vec3(0.055), step(vec3(0.0031308), color)); }";
    state._emitFunction(
      "slateLinearToDisplay",
      fn,
      "Linear material color to display color",
    );
    state.compilationString += `${state._declareOutput(this.output)} = slateLinearToDisplay(${this.color.associatedVariableName});\n`;
    return this;
  }
}
RegisterClass("BABYLON.DisplayColorBlock", DisplayColorBlock);
