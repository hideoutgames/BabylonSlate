import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";

/**
 * A colour moved between linear and display space on its RGB, alpha kept: `display` encodes (`toGammaSpace`, the
 * encoding a fragment output's `convertToGammaSpace` applies), `linear` decodes (`toLinearSpace`). Every Material
 * graph's colour is linear; this is where a display-space colour enters one (Particle Color) or where the graph's
 * colour meets display colours (a glyph's span colour, the particle blend). Binds nothing, so draws still batch.
 */
export class ColorEncodingBlock extends NodeMaterialBlock {
  readonly to: "display" | "linear";
  constructor(name: string, to: "display" | "linear") {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.to = to;
    this.registerInput("input", Types.Color4);
    this.registerOutput("output", Types.Color4);
  }
  get input(): NodeMaterialConnectionPoint { return this._inputs[0]!; }
  get output(): NodeMaterialConnectionPoint { return this._outputs[0]!; }
  override getClassName(): string { return "ColorEncodingBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitFunctionFromInclude("helperFunctions", `//${this.name}`);
    const convert = this.to === "display" ? "toGammaSpace" : "toLinearSpace";
    state.compilationString += `${state._declareOutput(this.output)} = ${convert}(${this.input.associatedVariableName});\n`;
    return this;
  }
}
RegisterClass("BABYLON.ColorEncodingBlock", ColorEncodingBlock);
