import { NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, type AbstractMesh, type NodeMaterial, type NodeMaterialDefines } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Per-vertex water data, with defined zero values on ordinary preview meshes. */
export class WaterSurfaceBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Vertex);
    for (const name of ["waveHeight", "bankDistance", "waterDepth", "time"]) this.registerOutput(name, Types.Float);
    this.registerOutput("flow", Types.Vector3);
  }
  override getClassName(): string { return "WaterSurfaceBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    defines.setValue("SLATE_WATER_SURFACE", mesh?.isVerticesDataPresent("slateWaterData") === true && mesh.isVerticesDataPresent("slateWaterFlow"), true);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    const wgsl = state.shaderLanguage === 1;
    if (!state.attributes.includes("slateWaterData")) {
      state.attributes.push("slateWaterData", "slateWaterFlow");
      state._attributeDeclaration += `#ifdef SLATE_WATER_SURFACE\n${wgsl
        ? "attribute slateWaterData: vec4f;\nattribute slateWaterFlow: vec3f;"
        : "attribute vec4 slateWaterData;\nattribute vec3 slateWaterFlow;"}\n#endif\n`;
    }
    for (const [index, output] of this._outputs.entries()) {
      const zero = index === 4 ? (wgsl ? "vec3f(0.0)" : "vec3(0.0)") : "0.0";
      const source = index === 4 ? "slateWaterFlow" : `slateWaterData.${"xyzw"[index]}`;
      state.compilationString += `${state._declareOutput(output)} = ${zero};\n#ifdef SLATE_WATER_SURFACE\n${output.associatedVariableName} = ${wgsl ? "vertexInputs." : ""}${source};\n#endif\n`;
    }
    return this;
  }
}
RegisterClass("BABYLON.WaterSurfaceBlock", WaterSurfaceBlock);
