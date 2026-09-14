import type {
  Camera,
  InternalTexture,
  RenderTargetTexture,
  Scene,
} from "@babylonjs/core";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { clusteredLightTarget } from "./clustered-light-policy";
import { withSceneReadinessState } from "./scene-perf";
import type { ManagedShadowObjectRendererTask } from "./framegraph-managed-shadows";

/** One ordered borrowed mask draw; readiness never executes the native proxy pass. */
export class FrameGraphClusteredLightsTask extends FrameGraphTask {
  private target: RenderTargetTexture | undefined;
  private texture: InternalTexture | null = null;

  constructor(
    graph: FrameGraph,
    private readonly scene: Scene,
    private readonly objects: ManagedShadowObjectRendererTask,
  ) {
    super("Clustered light mask", graph);
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
    this.objects.setOwnedTextureDependencies(
      "clustered",
      this.texture
        ? [
            this._frameGraph.textureManager.importTexture(
              "Borrowed clustered light mask",
              this.texture,
            ),
          ]
        : [],
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
      const engine = this.scene.getEngine();
      const target = engine._currentRenderTarget;
      const intermediate = this.scene._intermediateRendering;
      const stages = this.target._disableEngineStages;
      const depth = engine.getDepthBuffer(),
        write = engine.getDepthWrite();
      const alpha = engine.getAlphaMode();
      const errors: unknown[] = [];
      try {
        this.target._disableEngineStages = true;
        withSceneReadinessState(this.scene, () =>
          context.renderUnmanaged(this.target!),
        );
      } catch (error) {
        errors.push(error);
      } finally {
        const restore = (action: () => void) => {
          try {
            action();
          } catch (error) {
            errors.push(error);
          }
        };
        this.target._disableEngineStages = stages;
        this.scene._intermediateRendering = intermediate;
        restore(() => engine.setDepthBuffer(depth));
        restore(() => engine.setDepthWrite(write));
        restore(() => engine.setAlphaMode(alpha));
        restore(() => {
          if (engine._currentRenderTarget !== target) {
            if (target) engine.bindFramebuffer(target);
            else engine.restoreDefaultFramebuffer(true);
          }
        });
      }
      if (errors.length)
        throw new AggregateError(errors, "Clustered mask rendering failed.");
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
    super.dispose();
  }
}
