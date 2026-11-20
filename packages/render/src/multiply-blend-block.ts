import { FragmentOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/fragmentOutputBlock";
import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { isTargetedLayerScene } from "./layer-composite";

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
 * A Scene Layer Multiply visual's output, for its layer's blend (`layerMultiplyAlphaMode`). The factor is
 * f = mix(1, color, alpha) in display values (`encode`: `color` is linear and f is encoded by the Engine's sRGB curve,
 * as every other overlay colour is; otherwise `color` is already display colour, a Text Material's). A direct layer
 * writes (f, 0): destination × f, its alpha kept. A targeted layer writes (0, 0, 0, 1 − g), g the Rec. 709 luma of f,
 * clamped to 0..1: its premultiplied over multiplies the target's colour, and what shows through it, by g. One program
 * serves both: `layerTargeted` is a uniform, bound from the Scene at each draw (`isTargetedLayerScene`). The code sits
 * inline in main and has no helper of its own, so it has a single exit (ANGLE's D3D11 translator).
 */
export class LayerMultiplyBlock extends NodeMaterialBlock {
  /** Build-time: `color` is linear and encoded here (a Surface Material); false for display colour (Text). */
  encode = true;
  private targetedUniform = "";
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput("color", Types.Color3);
    this.registerInput("alpha", Types.Float);
    this.registerOutput("rgba", Types.Color4);
  }
  get color(): NodeMaterialConnectionPoint { return this._inputs[0]!; }
  get alpha(): NodeMaterialConnectionPoint { return this._inputs[1]!; }
  get rgba(): NodeMaterialConnectionPoint { return this._outputs[0]!; }
  override getClassName(): string { return "LayerMultiplyBlock"; }
  override bind(effect: Effect, material: NodeMaterial): void {
    effect.setFloat(this.targetedUniform, isTargetedLayerScene(material.getScene()) ? 1 : 0);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    this.targetedUniform = state._getFreeVariableName("layerTargeted");
    state._emitUniformFromString(this.targetedUniform, Types.Float);
    state.sharedData.forcedBindableBlocks.push(this);
    if (this.encode) state._emitFunctionFromInclude("helperFunctions", `//${this.name}`);
    const factor = state._getFreeVariableName("layerMultiplyFactor");
    const grey = state._getFreeVariableName("layerMultiplyGrey");
    const linear = `max(mix(vec3(1.0), ${this.color.associatedVariableName}.rgb, clamp(${this.alpha.associatedVariableName}, 0.0, 1.0)), vec3(0.0))`;
    state.compilationString += `vec3 ${factor} = ${this.encode ? `toGammaSpace(${linear})` : linear};\n`;
    state.compilationString += `float ${grey} = clamp(dot(${factor}, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);\n`;
    state.compilationString += `${state._declareOutput(this.rgba)} = mix(vec4(${factor}, 0.0), vec4(0.0, 0.0, 0.0, 1.0 - ${grey}), ${this.targetedUniform});\n`;
    return this;
  }
  protected override _dumpPropertiesCode(): string {
    return `${super._dumpPropertiesCode()}${this._codeVariableName}.encode = ${this.encode};\n`;
  }
}
RegisterClass("BABYLON.LayerMultiplyBlock", LayerMultiplyBlock);

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
