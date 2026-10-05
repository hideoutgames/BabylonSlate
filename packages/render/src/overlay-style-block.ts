import { NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, type Effect, type Mesh, type NodeMaterial } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { overlayVisualStyle } from "./overlay-visual-style";

/** Per-component values on an otherwise shared, immutable authored material. */
export class OverlayStyleBlock extends NodeMaterialBlock {
  private uniform = "";
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("rgba", Types.Color4);
    this.registerOutput("rgb", Types.Color3);
    this.registerOutput("alpha", Types.Float);
  }
  get rgba() { return this._outputs[0]!; }
  get rgb() { return this._outputs[1]!; }
  get alpha() { return this._outputs[2]!; }
  override getClassName(): string { return "OverlayStyleBlock"; }
  override bind(effect: Effect, _material: NodeMaterial, mesh?: Mesh): void {
    const { opacity, tint } = overlayVisualStyle(mesh);
    effect.setFloat4(this.uniform, tint[0], tint[1], tint[2], tint[3] * opacity);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    this.uniform = state._getFreeVariableName("overlayVisualTint");
    state._emitUniformFromString(this.uniform, Types.Vector4);
    state.sharedData.forcedBindableBlocks.push(this);
    const value = `${state.shaderLanguage === 1 ? "uniforms." : ""}${this.uniform}`;
    state.compilationString += `${state._declareOutput(this.rgba)} = ${value};\n`;
    state.compilationString += `${state._declareOutput(this.rgb)} = ${value}.rgb;\n`;
    state.compilationString += `${state._declareOutput(this.alpha)} = ${value}.a;\n`;
    return this;
  }
}
RegisterClass("BABYLON.OverlayStyleBlock", OverlayStyleBlock);
