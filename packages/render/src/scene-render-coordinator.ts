import type { AttachedPostProcessStack, AttachPostProcessStackOptions } from "./post-process-material";
import type { Camera, Scene } from "@babylonjs/core";
import { ForwardSceneFrameGraph, type ForwardSceneGraphResult } from "./framegraph-forward-scene";
import { isSceneFrameReady } from "./scene-perf";

class PreparationChanged extends Error {}

function outputSnapshot(scene: Scene, camera: Camera) {
  const target = camera.outputRenderTarget;
  const size = target?.getSize();
  const engine = scene.getEngine();
  return [camera, target, target?.getInternalTexture(), target?.depthStencilTexture,
    size?.width ?? engine.getRenderWidth(true), size?.height ?? engine.getRenderHeight(true)] as const;
}

/** Scene-owned graph lifetime; the host still owns scheduling and presentation. */
export class SceneRenderCoordinator {
  private readonly graph: ForwardSceneFrameGraph;
  private generation = 0;
  private disposed = false;
  private failure: unknown;
  private pending: { generation: number; promise: Promise<ForwardSceneGraphResult> } | undefined;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    this.graph = new ForwardSceneFrameGraph(scene);
  }

  attachPostProcess(options: AttachPostProcessStackOptions): AttachedPostProcessStack {
    return this.graph.attachPostProcess(options, () => this.invalidate());
  }

  postProcessPassCount(): number { return this.graph.postProcessPassCount(); }

  async retire(): Promise<void> {
    this.dispose();
    await this.graph.retire();
  }

  /** Actual CPU/native release; never waits for an Engine presentation frame. */
  async whenReleased(): Promise<void> {
    this.dispose();
    await this.graph.whenReleased();
  }

  invalidate(): void {
    this.generation += 1;
    this.failure = undefined;
    this.graph.invalidate();
  }

  /** No drawing: a resize or camera change restarts preparation within one deadline. */
  prepare(assertCurrent: () => void = () => {}): Promise<ForwardSceneGraphResult> {
    assertCurrent();
    const generation = this.generation;
    if (this.pending?.generation === generation)
      return this.pending.promise.then((result) => { assertCurrent(); return result; });
    const previous = this.pending;
    const check = () => {
      assertCurrent();
      if (this.disposed || this.scene.isDisposed || this.generation !== generation)
        throw new PreparationChanged("Scene rendering preparation was superseded or disposed.");
    };
    const promise = (async () => {
      if (previous) {
        // A previous owner's cancellation cannot reject its replacement.
        try { await previous.promise; }
        catch (error) { if (previous.generation === generation) throw error; }
      }
      check();
      const deadline = performance.now() + 10_000;
      for (;;) {
        check();
        if (performance.now() >= deadline)
          throw new Error("Scene rendering preparation timed out.");
        const camera = this.scene.activeCamera;
        if (!camera) throw new Error("Scene rendering requires an active camera.");
        const snapshot = outputSnapshot(this.scene, camera);
        const checkOutput = () => {
          check();
          if (performance.now() >= deadline)
            throw new Error("Scene rendering preparation timed out.");
          const current = outputSnapshot(this.scene, camera);
          if (this.scene.activeCamera !== camera || snapshot.some((value, index) => value !== current[index]))
            throw new PreparationChanged("Scene camera or output changed during rendering preparation.");
        };
        try {
          await this.graph.prepare(camera, checkOutput);
          checkOutput();
          const status = this.graph.readiness(camera);
          if (status.ready) {
            this.failure = undefined;
            return status.path === "frameGraph" ? { path: "frameGraph" as const } : { path: "classic" as const, reason: status.reason };
          }
        } catch (error) {
          check();
          if (!(error instanceof PreparationChanged)) throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    })();
    const pending = { generation, promise };
    this.pending = pending;
    const settled = () => { if (this.pending === pending) this.pending = undefined; };
    void promise.then(settled, settled);
    return promise;
  }

  /** Loading owners require the prepared selected path, including after resize. */
  isReady(): boolean {
    if (this.failure) throw this.failure;
    if (this.pending) return false;
    const camera = this.scene.activeCamera;
    if (this.disposed || this.scene.isDisposed || !camera || !isSceneFrameReady(this.scene)) return false;
    const status = this.graph.readiness(camera);
    if (!status.ready) this.requestPreparation();
    return status.ready;
  }

  /** Ready owners may draw a validated native frame while their graph rebuilds. */
  render(): ForwardSceneGraphResult & { rendered: boolean; readyForPresentation: boolean } {
    const camera = this.scene.activeCamera;
    if (this.disposed || this.scene.isDisposed || !camera || !isSceneFrameReady(this.scene))
      return { path: "classic", reason: "Scene is not ready to render.", rendered: false, readyForPresentation: false };
    const status = this.graph.readiness(camera);
    if (!status.ready) this.requestPreparation();
    const result = this.graph.render(camera);
    const after = this.graph.readiness(camera);
    return { ...result, rendered: result.rendered !== false,
      readyForPresentation: result.rendered !== false && !this.pending && status.ready && after.ready && result.path === status.path && result.path === after.path };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.graph.dispose();
  }

  private requestPreparation(): void {
    if (this.pending?.generation === this.generation) return;
    const generation = this.generation;
    void this.prepare().catch((error: unknown) => {
      if (!this.disposed && generation === this.generation) this.failure = error;
    });
  }
}
