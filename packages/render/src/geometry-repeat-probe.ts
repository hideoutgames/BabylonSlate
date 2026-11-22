import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { Scene } from "@babylonjs/core/scene";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";

/**
 * `worlddebug geometryonce off` / `geometryoncescissor off`: a second spatial geometry pass ("Spatial Geometry Probe"),
 * drawn right before the real one with its texture descriptions and object list into scratch targets nothing reads, so
 * its cost is one geometry pass and the picture is unchanged. Scissored, its draws run under a 1x1 scissor after its
 * clears: they keep their state changes, vertices and binning and drop almost every fragment.
 */
export class GeometryRepeatProbeTask extends LogicalGeometryTask {
  readonly scissored: boolean;

  constructor(name: string, graph: FrameGraph, scene: Scene, scissored: boolean) {
    super(name, graph, scene, { doNotChangeAspectRatio: false });
    this.scissored = scissored;
    if (scissored) this.onAfterTaskExecute.add(() => graph.engine.disableScissor());
  }

  protected override _prepareRendering(context: FrameGraphRenderContext, depthEnabled: boolean): number[] {
    const layout = super._prepareRendering(context, depthEnabled);
    // After the clears, which the scissor would cut too; the draws that follow keep it until the task ends.
    if (this.scissored) this._frameGraph.engine.enableScissor(0, 0, 1, 1);
    return layout;
  }
}
