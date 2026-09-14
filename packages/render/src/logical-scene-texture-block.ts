import { CurrentScreenBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/currentScreenBlock";

export type LogicalSceneBuffer = "sceneDepth" | "sceneNormal";
export const LOGICAL_SCENE_SAMPLERS = {
  sceneDepth: "blSceneDepthSampler",
  sceneNormal: "blSceneNormalSampler",
} as const;

/** A graph-bound sampler: no legacy depth/pre-pass renderer or owned texture. */
export class LogicalSceneTextureBlock extends CurrentScreenBlock {
  constructor(name: string, resource: LogicalSceneBuffer) {
    super(name);
    this._samplerName = LOGICAL_SCENE_SAMPLERS[resource];
  }
}
