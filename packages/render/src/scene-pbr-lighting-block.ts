import {
  PBRMetallicRoughnessBlock,
  type NodeMaterial,
  type NodeMaterialDefines,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { bindNodeShadowView } from "./node-shadow-view";
import { syncSceneLightSamplers } from "./scene-light-samplers";

/** App-owned PBR graph lighting; keep the native block's discovery/type contract. */
export class ScenePbrLightingBlock extends PBRMetallicRoughnessBlock {
  override getClassName(): string {
    return "ScenePbrLightingBlock";
  }

  override updateUniformsAndSamples(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines, uniformBuffers: string[]): void {
    super.updateUniformsAndSamples(state, material, defines, uniformBuffers);
    syncSceneLightSamplers(state, material, defines);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    const start = state.compilationString.length;
    super._buildBlock(state);
    bindNodeShadowView(state, start, this.view.associatedVariableName);
    return this;
  }
}
RegisterClass("BABYLON.ScenePbrLightingBlock", ScenePbrLightingBlock);
