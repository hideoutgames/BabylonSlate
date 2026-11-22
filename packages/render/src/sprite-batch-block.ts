import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets as Targets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/**
 * Per-instance vertex attributes a world sprite batch's thin-instanced unit quad carries (`world-sprite-batcher.ts`):
 * - `spriteSizePivot`: `vec4(width, height, pivotX, pivotY)` transforms unit quad `[0,1]x[0,1]` to pivoted world units.
 * - `spriteUvRect`: `vec4(u0, v0, u1 - u0, v1 - v0)` selects sheet cells and handles `Flip Frame` without VBO edits.
 * - `spriteFinish`: `vec4(visibility, 0, 0, 0)` applies post-cutoff crossfade alpha in `UnlitFinishBlock`.
 * - `spriteTexel`: `vec4(gridX, gridY, originX, originY)` selects exact texel centers on whole textures or `LayerImageAtlas`.
 */
export const SPRITE_BATCH_SIZE_PIVOT_KIND = "spriteSizePivot";
export const SPRITE_BATCH_UV_RECT_KIND = "spriteUvRect";
export const SPRITE_BATCH_FINISH_KIND = "spriteFinish";
export const SPRITE_BATCH_TEXEL_KIND = "spriteTexel";

const spriteBatchMeshes = new WeakSet<AbstractMesh>();

/** Marks `mesh` as a world sprite batch quad whose per-instance attributes drive quad size, UVs, alpha and texel grid. */
export function markWorldSpriteBatchMesh(mesh: AbstractMesh): void {
  spriteBatchMeshes.add(mesh);
}

export function isWorldSpriteBatchMesh(mesh: AbstractMesh | null | undefined): boolean {
  return !!mesh && spriteBatchMeshes.has(mesh);
}

/**
 * Vertex: transforms the unit quad `[0,1]x[0,1]` by each thin instance's `(width, height, pivotX, pivotY)` and
 * remaps its UVs by `(u0, v0, du, dv)` under `HAPTIC_SPRITE_BATCH`. Non-batch meshes pass `position` and `uv` through
 * unchanged and declare none of the per-instance sprite attributes.
 */
export class SpriteBatchVertexBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Vertex);
    this.registerInput("position", Types.Vector3);
    this.registerInput("uv", Types.Vector2, true);
    this.registerOutput("positionOutput", Types.Vector3);
    this.registerOutput("uvOutput", Types.Vector2);
  }

  get position(): NodeMaterialConnectionPoint { return this._inputs[0]!; }
  get uv(): NodeMaterialConnectionPoint { return this._inputs[1]!; }
  get positionOutput(): NodeMaterialConnectionPoint { return this._outputs[0]!; }
  get uvOutput(): NodeMaterialConnectionPoint { return this._outputs[1]!; }

  override getClassName(): string { return "SpriteBatchVertexBlock"; }

  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    defines.setValue("HAPTIC_SPRITE_BATCH", isWorldSpriteBatchMesh(mesh), true);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    for (const kind of [SPRITE_BATCH_SIZE_PIVOT_KIND, SPRITE_BATCH_UV_RECT_KIND]) {
      if (state.attributes.includes(kind)) continue;
      state.attributes.push(kind);
      state._attributeDeclaration += `#ifdef HAPTIC_SPRITE_BATCH\nattribute vec4 ${kind};\n#endif\n`;
    }
    const pos = this.position.associatedVariableName;
    const sp = SPRITE_BATCH_SIZE_PIVOT_KIND;
    state.compilationString += `#ifdef HAPTIC_SPRITE_BATCH\n`
      + `${state._declareOutput(this.positionOutput)} = vec3((${pos}.x - ${sp}.z) * ${sp}.x, (${pos}.y - (1.0 - ${sp}.w)) * ${sp}.y, ${pos}.z);\n`
      + `#else\n`
      + `${state._declareOutput(this.positionOutput)} = ${pos};\n`
      + `#endif\n`;
    if (this.uvOutput.hasEndpoints) {
      const uv = this.uv.isConnected ? this.uv.associatedVariableName : "vec2(0.0)";
      const rect = SPRITE_BATCH_UV_RECT_KIND;
      state.compilationString += `#ifdef HAPTIC_SPRITE_BATCH\n`
        + `${state._declareOutput(this.uvOutput)} = ${rect}.xy + ${uv} * ${rect}.zw;\n`
        + `#else\n`
        + `${state._declareOutput(this.uvOutput)} = ${uv};\n`
        + `#endif\n`;
    }
    return this;
  }
}
RegisterClass("BABYLON.SpriteBatchVertexBlock", SpriteBatchVertexBlock);

/**
 * Declares a per-instance `HAPTIC_SPRITE_BATCH` attribute and flat varying in the vertex and fragment shaders and
 * returns the varying name (`v_${kind}`).
 */
export function spriteBatchVarying(state: NodeMaterialBuildState, kind: string): string {
  const vertex = state._vertexState;
  const varying = `v_${kind}`;
  if (!vertex.attributes.includes(kind)) {
    vertex.attributes.push(kind);
    vertex._attributeDeclaration += `#ifdef HAPTIC_SPRITE_BATCH\nattribute vec4 ${kind};\n#endif\n`;
    state._emitVaryingFromString(varying, Types.Vector4, "HAPTIC_SPRITE_BATCH");
    const declaration = new RegExp(`(^|\\n)varying (\\w+ ${varying};)`, "g");
    const shared = state.sharedData;
    shared.varyingDeclaration = shared.varyingDeclaration.replace(declaration, "$1flat varying $2");
    shared.varyingDeclarationFragment = shared.varyingDeclarationFragment.replace(declaration, "$1flat varying $2");
    vertex.compilationString += `#ifdef HAPTIC_SPRITE_BATCH\n${varying} = ${kind};\n#endif\n`;
  }
  return varying;
}

/**
 * Fragment: a per-instance vec4 that a world sprite batch carries per instance instead of binding as a uniform.
 * Under `HAPTIC_SPRITE_BATCH` the attribute is handed on as a flat varying; every other draw reads `bound`.
 */
export function spriteBatchValue(state: NodeMaterialBuildState, kind: string, bound: string): string {
  const varying = spriteBatchVarying(state, kind);
  const local = state._getFreeVariableName(`${kind}Value`);
  const declared = state._declareLocalVar(local, Types.Vector4);
  state.compilationString += `#ifdef HAPTIC_SPRITE_BATCH\n${declared} = ${varying};\n#else\n${declared} = ${bound};\n#endif\n`;
  return local;
}
