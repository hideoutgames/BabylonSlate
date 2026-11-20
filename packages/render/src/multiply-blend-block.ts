import { FragmentOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/fragmentOutputBlock";
import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/**
 * A Multiply blend's factor: `mix(1, color, alpha)`, so Opacity 0 leaves the scene as it is and Opacity 1 multiplies it
 * by the colour. The blend (`Constants.ALPHA_MULTIPLY`, destination × source) multiplies its rgb in and keeps alpha.
 */
export class MultiplyBlendFactorBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput("color", Types.Color3);
    this.registerInput("alpha", Types.Float);
    this.registerOutput("factor", Types.Color3);
  }
  get color(): NodeMaterialConnectionPoint { return this._inputs[0]!; }
  get alpha(): NodeMaterialConnectionPoint { return this._inputs[1]!; }
  get factor(): NodeMaterialConnectionPoint { return this._outputs[0]!; }
  override getClassName(): string { return "MultiplyBlendFactorBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.compilationString += `${state._declareOutput(this.factor)} = mix(vec3(1.0), ${this.color.associatedVariableName}.rgb, clamp(${this.alpha.associatedVariableName}, 0.0, 1.0));\n`;
    return this;
  }
}
RegisterClass("BABYLON.MultiplyBlendFactorBlock", MultiplyBlendFactorBlock);

/**
 * The output of a Multiply blend's linear factor: encoded for display (gamma only) unless a Scene Linear display stage
 * encodes the frame, and never tone mapped or exposed, which would turn a factor of 1 into something else.
 */
export class MultiplyFactorOutputBlock extends FragmentOutputBlock {
  override getClassName(): string { return "MultiplyFactorOutputBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, material: NodeMaterial): void {
    this.convertToGammaSpace = !material.imageProcessingConfiguration.applyByPostProcess;
    super.prepareDefines(defines, material);
  }
}
RegisterClass("BABYLON.MultiplyFactorOutputBlock", MultiplyFactorOutputBlock);
