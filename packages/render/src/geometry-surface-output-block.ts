import {
  FragmentOutputBlock,
  InputBlock,
  NodeMaterialBlockConnectionPointTypes as Types,
  NodeMaterialSystemValues,
  type NodeMaterialBlock,
  type NodeMaterialConnectionPoint,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import type { MaterialPlumbing } from "./material-block-registry";

/** Surface output with the same geometry encodings as Babylon's native materials. */
export class GeometrySurfaceOutputBlock extends FragmentOutputBlock {
  constructor(name: string) {
    super(name);
    this.registerInput("geometryPosition", Types.Vector4);
    this.registerInput("geometryNormal", Types.Vector3);
    this.registerInput("geometryView", Types.Matrix);
    this.registerInput("geometryCamera", Types.Vector4);
  }

  get geometryPosition() { return this.getInputByName("geometryPosition")!; }
  get geometryNormal() { return this.getInputByName("geometryNormal")!; }
  get geometryView() { return this.getInputByName("geometryView")!; }
  get geometryCamera() { return this.getInputByName("geometryCamera")!; }
  override getClassName(): string { return "GeometrySurfaceOutputBlock"; }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = state.shaderLanguage === 1;
    const vec4 = state._getShaderType(Types.Vector4);
    const normal = this.geometryNormal.associatedVariableName;
    const position = this.geometryPosition.associatedVariableName;
    const view = this.geometryView.associatedVariableName;
    const camera = this.geometryCamera.associatedVariableName;
    const color = wgsl ? "fragmentOutputsColor" : "gl_FragColor";
    const savedColor = state._getFreeVariableName("geometrySurfaceColor");
    state.compilationString += `#ifdef PREPASS\n${state._declareLocalVar(savedColor, Types.Vector4)} = ${color};\n#endif\n`;
    // FragmentOutputBlock assumes attachment zero is color. Geometry tasks can
    // put color last or omit it entirely, so overwrite each requested slot after
    // the native output, within this block (including after CEL/PBR switches).
    for (let index = 0; index < 8; index++) {
      const target = wgsl ? `fragmentOutputs.fragData${index}` : `gl_FragData[${index}]`;
      for (const [define, value] of [
        ["PREPASS_COLOR", savedColor],
        ["PREPASS_NORMALIZED_VIEW_DEPTH", `${vec4}(((${view} * ${position}).z - ${camera}.y) / (${camera}.z - ${camera}.y), 0.0, 0.0, 1.0)`],
        ["PREPASS_WORLD_NORMAL", `${vec4}(normalize(${normal}) * 0.5 + 0.5, 1.0)`],
      ]) {
        state.compilationString += `#if defined(PREPASS) && defined(${define}) && ${define}_INDEX == ${index}\n${target} = ${value};\n#endif\n`;
      }
    }
    return this;
  }
}
RegisterClass("BABYLON.GeometrySurfaceOutputBlock", GeometrySurfaceOutputBlock);

export function connectGeometrySurfaceOutput(
  block: GeometrySurfaceOutputBlock,
  plumbing: MaterialPlumbing,
  normal: NodeMaterialConnectionPoint | null,
  created: NodeMaterialBlock[],
): void {
  plumbing.worldPosition!.connectTo(block.geometryPosition);
  (normal ?? plumbing.worldNormal)!.connectTo(block.geometryNormal);
  plumbing.view!.connectTo(block.geometryView);
  const camera = new InputBlock(`${block.name}_geometryCamera`);
  camera.setAsSystemValue(NodeMaterialSystemValues.CameraParameters);
  camera.output.connectTo(block.geometryCamera);
  created.push(camera);
}
