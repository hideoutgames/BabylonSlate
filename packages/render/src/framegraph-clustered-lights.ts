import type {
  Camera,
  InternalTexture,
  RenderTargetTexture,
  Scene,
} from "@babylonjs/core";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { clusteredLightTarget } from "./clustered-light-policy";
import { withSceneReadinessState } from "./scene-perf";
import type { ManagedShadowObjectRendererTask } from "./framegraph-managed-shadows";
import { drawBorrowedTarget, type BorrowedDrawPolicy } from "./framegraph-borrowed-draw";

/** The mask pass also restores blend state and always wraps a failed draw. */
const MASK_DRAW: BorrowedDrawPolicy = {
  restoreAlpha: true,
  wrapDrawFailure: true,
  message: "Clustered mask rendering failed.",
};

/** One ordered borrowed mask draw; readiness never executes the native proxy pass. */
export class FrameGraphClusteredLightsTask extends FrameGraphTask {
  private target: RenderTargetTexture | undefined;
  private texture: InternalTexture | null = null;
  private handle: FrameGraphTextureHandle | undefined;

  private readonly scene: Scene;
  private readonly objects: ManagedShadowObjectRendererTask;

  constructor(
    graph: FrameGraph,
    scene: Scene,
    objects: ManagedShadowObjectRendererTask,
  ) {
    super("Clustered light mask", graph);
    this.scene = scene;
    this.objects = objects;
  }

  needsPreparation(camera: Camera): boolean {
    const target = clusteredLightTarget(this.scene, camera);
    return (
      target !== this.target ||
      (target?.getInternalTexture() ?? null) !== this.texture
    );
  }

  override record(): void {
    this.target = clusteredLightTarget(this.scene, this.objects.camera);
    this.texture = this.target?.getInternalTexture() ?? null;
    if (this.target && !this.texture)
      throw new Error("Clustered mask allocation is missing.");
    // Rebuilds keep External entries; reuse the handle instead of adding one.
    if (this.texture)
      this.handle = this._frameGraph.textureManager.importTexture(
        "Borrowed clustered light mask",
        this.texture,
        this.handle,
      );
    this.objects.setOwnedTextureDependencies(
      "clustered",
      this.texture && this.handle !== undefined ? [this.handle] : [],
    );
    this._frameGraph.addPass(this.name).setExecuteFunc((context) => {
      if (
        !this.target ||
        !this.scene.lightsEnabled ||
        !this.scene.renderTargetsEnabled
      )
        return;
      if (this.needsPreparation(this.objects.camera))
        throw new Error(
          "Clustered allocation changed before its ordered draw.",
        );
      const target = this.target;
      drawBorrowedTarget(
        this.scene,
        target,
        () =>
          withSceneReadinessState(this.scene, () =>
            context.renderUnmanaged(target),
          ),
        MASK_DRAW,
      );
    });
  }

  override isReady(): boolean {
    return (
      !this.target ||
      withSceneReadinessState(this.scene, () =>
        this.target!.isReadyForRendering(),
      )
    );
  }

  override dispose(): void {
    this.target = undefined;
    this.texture = null;
    this.handle = undefined;
    super.dispose();
  }
}
