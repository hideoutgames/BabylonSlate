import type { InstancesBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/instancesBlock";
import { NodeMaterialBlockConnectionPointTypes as Types } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets as Targets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/**
 * The vertex attributes a draw batch's mesh carries its members' world matrices in: the first three rows, a row each.
 * The fourth of an affine matrix is (0, 0, 0, 1), and WebGPU guarantees a draw only eight vertex buffers.
 */
export const DRAW_BATCH_WORLD_KINDS = ["batchWorld0", "batchWorld1", "batchWorld2"] as const;

const batchMeshes = new WeakSet<AbstractMesh>();

/** Marks `mesh` as a draw batch's: its Material draws it with each vertex's own world matrix (`DrawBatchWorldBlock`). */
export function markDrawBatchMesh(mesh: AbstractMesh): void {
  batchMeshes.add(mesh);
}

export function isDrawBatchMesh(mesh: AbstractMesh): boolean {
  return batchMeshes.has(mesh);
}

/**
 * Vertex: the world matrix a draw transforms with. A draw batch's mesh (`overlay-draw-batcher.ts`) holds its members'
 * own vertices and, per vertex, the rows of the member's world matrix as its own draw uploads them
 * (`DRAW_BATCH_WORLD_KINDS`). Under `HAPTIC_BATCH` the matrix is built from those, so the vertex stage transforms each
 * vertex with the same expression on the same 32-bit values as the member's draw, whatever its pose. Every other draw
 * passes `world` through, and declares none of the attributes: WebGPU draws only with a buffer for each one declared.
 */
export class DrawBatchWorldBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Vertex);
    this.registerInput("world", Types.Matrix);
    this.registerOutput("output", Types.Matrix);
  }
  get world(): NodeMaterialConnectionPoint { return this._inputs[0]!; }
  get output(): NodeMaterialConnectionPoint { return this._outputs[0]!; }
  override getClassName(): string { return "DrawBatchWorldBlock"; }

  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    defines.setValue("HAPTIC_BATCH", !!mesh && batchMeshes.has(mesh), true);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    const wgsl = state.shaderLanguage === ShaderLanguage.WGSL;
    for (const kind of DRAW_BATCH_WORLD_KINDS) {
      if (state.attributes.includes(kind)) continue;
      state.attributes.push(kind);
      state._attributeDeclaration += `#ifdef HAPTIC_BATCH\nattribute ${wgsl ? `${kind}: vec4f` : `vec4 ${kind}`};\n#endif\n`;
    }
    const [x, y, z] = DRAW_BATCH_WORLD_KINDS.map((kind) => `${wgsl ? "vertexInputs." : ""}${kind}`);
    const vec4 = wgsl ? "vec4f" : "vec4";
    // Column by column, from the rows.
    const columns = ["x", "y", "z", "w"].map((part) => `${vec4}(${x}.${part}, ${y}.${part}, ${z}.${part}, ${part === "w" ? "1.0" : "0.0"})`).join(", ");
    state.compilationString += `#ifdef HAPTIC_BATCH\n${state._declareOutput(this.output)} = ${wgsl ? "mat4x4f" : "mat4"}(${columns});\n#else\n` +
      `${state._declareOutput(this.output)} = ${this.world.associatedVariableName};\n#endif\n`;
    return this;
  }
}
RegisterClass("BABYLON.DrawBatchWorldBlock", DrawBatchWorldBlock);

/** The world matrix of a Material whose draws may batch: `instances`' output, or a draw batch's per-vertex matrix. */
export function drawBatchWorld(name: string, instances: InstancesBlock, blocks: NodeMaterialBlock[]): NodeMaterialConnectionPoint {
  const world = new DrawBatchWorldBlock(`${name}_batchWorld`);
  instances.output.connectTo(world.world);
  blocks.push(world);
  return world.output;
}
