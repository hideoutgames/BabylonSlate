import { PBRMetallicRoughnessBlock } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { bindNodeShadowView } from "./node-shadow-view";

/** App-owned PBR graph lighting; keep the native block's discovery/type contract. */
export class ScenePbrLightingBlock extends PBRMetallicRoughnessBlock {
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    const start = state.compilationString.length;
    super._buildBlock(state);
    bindNodeShadowView(state, start, this.view.associatedVariableName);
    return this;
  }
}
