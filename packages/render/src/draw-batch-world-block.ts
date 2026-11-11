import type { InstancesBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/instancesBlock";
import { NodeMaterialBlockConnectionPointTypes as Types } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets as Targets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { Material } from "@babylonjs/core/Materials/material";
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

/**
 * The vertex attributes a draw batch's mesh carries its members' own colour and tint in (`drawBatchValue`): values a
 * member's draw binds, which differ between members that otherwise draw the same.
 */
export const DRAW_BATCH_COLOR_KIND = "batchColor";
export const DRAW_BATCH_TINT_KIND = "batchTint";
/**
 * The vertex attribute a batch of the unlit Material carries each member's texel grid in (`unlitTexelGrid`): the size
 * of the member's image and where it starts on the texture the batch samples.
 */
export const DRAW_BATCH_TEXEL_KIND = "batchTexel";
/**
 * The vertex attributes a batch of a text Material's glyphs carries each glyph's own values in: its rectangle on the
 * atlas, its rectangle in the text's Material space, and its span colour with its visibility.
 */
export const DRAW_BATCH_TEXT_KINDS = ["batchTextAtlasRect", "batchTextMaterialRect", "batchTextTint"] as const;

const batchMeshes = new WeakSet<AbstractMesh>();

/** Marks `mesh` as a draw batch's: its Material draws it with each vertex's own world matrix (`DrawBatchWorldBlock`). */
export function markDrawBatchMesh(mesh: AbstractMesh): void {
  batchMeshes.add(mesh);
}

export function isDrawBatchMesh(mesh: AbstractMesh): boolean {
  return batchMeshes.has(mesh);
}

const boundedMaterials = new WeakSet<Material>();

/**
 * Marks an authored `material` whose vertex stage keeps every vertex on its mesh's own geometry (no World Position
 * Offset, no custom or wave stage): a mesh drawing it stays inside its bounds, whatever the Material binds per mesh. A
 * batcher orders its batches around such a draw by where it is, even when it cannot join one.
 */
export function markBoundedMaterial(material: Material): void {
  boundedMaterials.add(material);
}

export function isBoundedMaterial(material: Material): boolean {
  return boundedMaterials.has(material);
}

/** Authored Materials whose draws may batch, and whether each is a text's. */
const batchMaterials = new WeakMap<Material, boolean>();

/**
 * Marks an authored `material` whose draws may batch: but for the world matrix and the overlay style, which a batch
 * carries per vertex, and Receive Shadows, which its members share, it draws every mesh the same (the compiler marks a
 * Scene Layer surface with the stock vertex stage and nothing else bound per mesh). A `text` Material's glyphs each
 * bind values of their own besides, which a batch carries per vertex too (`DRAW_BATCH_TEXT_KINDS`).
 */
export function markDrawBatchMaterial(material: Material, text = false): void {
  batchMaterials.set(material, text);
}

export function isDrawBatchMaterial(material: Material): boolean {
  return batchMaterials.has(material);
}

/** Whether `material` is a text's whose glyphs may batch. */
export function isDrawBatchTextMaterial(material: Material): boolean {
  return batchMaterials.get(material) === true;
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

/**
 * Fragment: a per-mesh vec4 that a draw batch's mesh carries with each vertex instead of binding it. Under `HAPTIC_BATCH`
 * the value is the vertex attribute `kind`, handed on flat: every vertex of a member holds the same value, and a flat
 * varying gives the fragment stage exactly it, where an interpolated one could round. Every other draw reads `bound`,
 * the expression of the value as it binds it. Returns a local that holds the value, for the block's code to use.
 */
export function drawBatchValue(state: NodeMaterialBuildState, kind: string, bound: string): string {
  const wgsl = state.shaderLanguage === ShaderLanguage.WGSL;
  const vertex = state._vertexState;
  const varying = `v_${kind}`;
  if (!vertex.attributes.includes(kind)) {
    vertex.attributes.push(kind);
    vertex._attributeDeclaration += `#ifdef HAPTIC_BATCH\nattribute ${wgsl ? `${kind}: vec4f` : `vec4 ${kind}`};\n#endif\n`;
    state._emitVaryingFromString(varying, Types.Vector4, "HAPTIC_BATCH");
    // GLSL `varying vec4 v;` and WGSL `varying v: vec4f;`, which Babylon's processors turn into `flat in/out` and
    // `@interpolate(flat)`.
    const declaration = new RegExp(`(^|\\n)varying (\\w+ ${varying};|${varying}:)`, "g");
    const shared = state.sharedData;
    shared.varyingDeclaration = shared.varyingDeclaration.replace(declaration, "$1flat varying $2");
    shared.varyingDeclarationFragment = shared.varyingDeclarationFragment.replace(declaration, "$1flat varying $2");
    vertex.compilationString += `#ifdef HAPTIC_BATCH\n${wgsl ? "vertexOutputs." : ""}${varying} = ${wgsl ? "vertexInputs." : ""}${kind};\n#endif\n`;
  }
  const local = state._getFreeVariableName(`${kind}Value`);
  const declared = state._declareLocalVar(local, Types.Vector4);
  state.compilationString += `#ifdef HAPTIC_BATCH\n${declared} = ${varying};\n#else\n${declared} = ${bound};\n#endif\n`;
  return local;
}
