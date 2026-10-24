import { NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, type AbstractMesh, type NodeMaterial, type NodeMaterialDefines } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { meshVertexWaves, WATER_GPU_WAVES_DEFINE } from "./water-material";

/** Set for a mesh that carries the water vertex data: Water Surface and Water Waves read it. */
export const WATER_SURFACE_DEFINE = "SLATE_WATER_SURFACE";

/** Whether `mesh` is a water surface carrying the per-vertex data the water nodes read. */
export function isWaterSurfaceMesh(mesh?: AbstractMesh): boolean {
  return mesh?.isVerticesDataPresent("slateWaterData") === true && mesh.isVerticesDataPresent("slateWaterFlow");
}

/**
 * Declares water vertex attributes, together under `define`, that this shader has not declared yet: the water nodes of one
 * graph share them.
 */
export function declareWaterAttributes(state: NodeMaterialBuildState, define: string, attributes: ReadonlyArray<readonly [name: string, components: 2 | 3 | 4]>): void {
  const wgsl = state.shaderLanguage === 1;
  const fresh = attributes.filter(([name]) => !state.attributes.includes(name));
  if (!fresh.length) return;
  for (const [name] of fresh) state.attributes.push(name);
  // A define name, or a condition (`defined(A) || defined(B)`) where blocks under different defines read one attribute.
  const guard = define.includes("(") ? `#if ${define}` : `#ifdef ${define}`;
  state._attributeDeclaration += `${guard}\n${fresh.map(([name, components]) => wgsl ? `attribute ${name}: vec${components}f;` : `attribute vec${components} ${name};`).join("\n")}\n#endif\n`;
}

/**
 * Per-vertex water data, with defined zero values on ordinary preview meshes.
 *
 * Wave Height and Simulation Time come from the vertex data only where the surface mesh uploads displaced vertices (a
 * Custom Material without a Water Waves node). With a Water Waves node in the graph the mesh keeps a static rest grid
 * and the vertex stage displaces it, so those two follow that node's Wave Height and Simulation Time (the compiler
 * connects them); Bank Distance, Water Depth and Local Flow are the same either way.
 */
export class WaterSurfaceBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Vertex);
    this.registerInput("gpuWaveHeight", Types.Float, true);
    this.registerInput("gpuTime", Types.Float, true);
    for (const name of ["waveHeight", "bankDistance", "waterDepth", "time"]) this.registerOutput(name, Types.Float);
    this.registerOutput("flow", Types.Vector3);
  }
  /** The Water Waves node's Wave Height, for a surface whose vertex stage displaces its rest grid. */
  get gpuWaveHeight() { return this._inputs[0]!; }
  /** The Water Waves node's Simulation Time, likewise. */
  get gpuTime() { return this._inputs[1]!; }
  override getClassName(): string { return "WaterSurfaceBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    defines.setValue(WATER_SURFACE_DEFINE, isWaterSurfaceMesh(mesh), true);
    // Only graphs with a Water Waves node connect them: the others compile exactly as they did.
    if (this.gpuWaveHeight.isConnected || this.gpuTime.isConnected) defines.setValue(WATER_GPU_WAVES_DEFINE, isWaterSurfaceMesh(mesh) && meshVertexWaves(mesh) !== null, true);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    const wgsl = state.shaderLanguage === 1;
    declareWaterAttributes(state, WATER_SURFACE_DEFINE, [["slateWaterData", 4], ["slateWaterFlow", 3]]);
    for (const [index, output] of this._outputs.entries()) {
      const zero = index === 4 ? (wgsl ? "vec3f(0.0)" : "vec3(0.0)") : "0.0";
      const source = index === 4 ? "slateWaterFlow" : `slateWaterData.${"xyzw"[index]}`;
      state.compilationString += `${state._declareOutput(output)} = ${zero};\n#ifdef ${WATER_SURFACE_DEFINE}\n${output.associatedVariableName} = ${wgsl ? "vertexInputs." : ""}${source};\n#endif\n`;
      const gpu = index === 0 ? this.gpuWaveHeight : index === 3 ? this.gpuTime : null;
      if (gpu?.isConnected) state.compilationString += `#ifdef ${WATER_GPU_WAVES_DEFINE}\n${output.associatedVariableName} = ${gpu.associatedVariableName};\n#endif\n`;
    }
    return this;
  }
}
RegisterClass("BABYLON.WaterSurfaceBlock", WaterSurfaceBlock);
