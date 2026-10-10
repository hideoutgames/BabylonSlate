import { activeRenderFrameCapture } from "./render-frame-report";
import type { AttachedPostProcessStack, AttachPostProcessStackOptions } from "./post-process-material";
import type { Camera, Scene } from "@babylonjs/core";
import { ForwardSceneFrameGraph, type ForwardSceneGraphResult } from "./framegraph-forward-scene";
import { onSceneReadinessDirty } from "./scene-perf";
import type { SharedOutlineView } from "./shared-outline";
import { flushSceneCables } from "./cable-mesh";
import { flushDynamicRuntimeMeshes } from "./dynamic-runtime-mesh";
import { flushSceneLatticeDeformers } from "./lattice-deformer";
import { retainWaterPlanarReflections } from "./water-planar-reflection";

class PreparationChanged extends Error {}

/** Bound on one preparation generation without observable readiness. */
const PREPARATION_TIMEOUT_MS = 10_000;
/** Bound on one owner's preparation across every invalidation restart. */
const PREPARATION_TOTAL_TIMEOUT_MS = 60_000;

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
  private readonly detachReadinessDirty: () => void;
  private outlineView: SharedOutlineView | undefined;
  private outlineRevision = -1;
  private editorOverlay: ((camera: Camera) => void) | undefined;
  /** Views may draw planar water reflections; previews and thumbnails never retain one. */
  private readonly releaseWaterPlanarReflections: () => void;

  constructor(scene: Scene, options: { waterPlanarReflections?: boolean } = {}) {
    this.scene = scene;
    this.graph = new ForwardSceneFrameGraph(scene);
    this.detachReadinessDirty = onSceneReadinessDirty(scene, () =>
      this.graph.markReadinessDirty(),
    );
    this.releaseWaterPlanarReflections = options.waterPlanarReflections === false
      ? () => {}
      : retainWaterPlanarReflections(scene);
  }

  attachPostProcess(options: AttachPostProcessStackOptions): AttachedPostProcessStack {
    return this.graph.attachPostProcess(options, () => this.invalidate());
  }

  /** The view owns its overlay across graph rebuilds. Draw after final output,
   * before the host copies the view/RTT. */
  attachEditorOverlay(draw: (camera: Camera) => void): () => void {
    if (this.disposed || this.editorOverlay)
      throw new Error("Editor overlay requires a live, unattached view.");
    this.editorOverlay = draw;
    return () => {
      if (this.editorOverlay === draw) this.editorOverlay = undefined;
    };
  }

  /** Explicit candidate opt-in for this view. Contributions remain owned by
   * the caller; editor selection is never inferred from the Scene. */
  attachSharedOutline(view: SharedOutlineView): () => void {
    const detach = this.graph.attachSharedOutline(view, () => this.invalidate());
    this.outlineView = view;
    this.outlineRevision = view.revision;
    return () => {
      detach();
      if (this.outlineView === view) {
        this.outlineView = undefined;
        this.outlineRevision = -1;
      }
    };
  }

  postProcessPassCount(): number { return this.graph.postProcessPassCount(); }

  /** Prepared graph task names in record order; [] before preparation. */
  taskNames(): string[] { return this.graph.taskNames(); }

  sharedOutlineDiagnostics(): { drawingPassCount: number; renderRecordCount: number } {
    return this.graph.sharedOutlineDiagnostics();
  }

  retainResources(): () => void { return this.graph.retainResources(); }

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

  /**
   * No drawing: a resize, camera change or invalidation restarts preparation
   * with a fresh deadline while the owner stays current. Asset arrival during a
   * load (for example an Area Light's emission texture) invalidates the graph;
   * only the owner's own cancellation or disposal ends the preparation.
   */
  prepare(assertCurrent: () => void = () => {}): Promise<ForwardSceneGraphResult> {
    assertCurrent();
    this.refreshOutline();
    if (this.pending?.generation === this.generation)
      return this.pending.promise.then((result) => { assertCurrent(); return result; });
    const previous = this.pending;
    const pending = { generation: this.generation, promise: undefined as unknown as Promise<ForwardSceneGraphResult> };
    let deadline = 0;
    let finalDeadline = Infinity;
    const restartDeadline = () => { deadline = Math.min(performance.now() + PREPARATION_TIMEOUT_MS, finalDeadline); };
    const check = () => {
      assertCurrent();
      if (this.disposed || this.scene.isDisposed)
        throw new PreparationChanged("Scene rendering preparation was superseded or disposed.");
      if (this.generation !== pending.generation) {
        pending.generation = this.generation;
        restartDeadline();
      }
    };
    const promise = (async () => {
      if (previous) {
        // A previous owner's cancellation cannot reject its replacement.
        try { await previous.promise; }
        catch { /* previous owner's outcome */ }
      }
      finalDeadline = performance.now() + PREPARATION_TOTAL_TIMEOUT_MS;
      restartDeadline();
      check();
      for (;;) {
        check();
        flushSceneLatticeDeformers(this.scene);
        if (performance.now() >= deadline)
          throw new Error("Scene rendering preparation timed out.");
        const camera = this.scene.activeCamera;
        if (!camera) throw new Error("Scene rendering requires an active camera.");
        const snapshot = outputSnapshot(this.scene, camera);
        const iteration = pending.generation;
        const checkOutput = () => {
          check();
          // An invalidated build is stale: abort it and rebuild for the new generation.
          if (pending.generation !== iteration)
            throw new PreparationChanged("Scene rendering was invalidated during preparation.");
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
            return { path: "frameGraph" as const };
          }
        } catch (error) {
          check();
          if (!(error instanceof PreparationChanged) && pending.generation === iteration) throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    })();
    pending.promise = promise;
    this.pending = pending;
    const settled = () => { if (this.pending === pending) this.pending = undefined; };
    void promise.then(settled, settled);
    return promise;
  }

  /** True while strict readiness must be re-probed after an invalidation. */
  get readinessDirty(): boolean {
    this.refreshOutline();
    return this.graph.readinessDirty;
  }

  /** Strict readiness probes the graph ran; unchanged frames add none. */
  get strictReadinessChecks(): number {
    return this.graph.strictReadinessChecks;
  }

  diagnostics() { return this.graph.diagnostics(); }

  /** Loading owners require the prepared selected path, including after resize. */
  isReady(): boolean {
    this.refreshOutline();
    if (this.failure) throw this.failure;
    if (this.pending) return false;
    const camera = this.scene.activeCamera;
    if (this.disposed || this.scene.isDisposed || !camera) return false;
    flushSceneLatticeDeformers(this.scene);
    if (!this.graph.sceneStrictlyReady(camera)) {
      this.advanceReadiness(camera);
      return false;
    }
    // The strict scene probe is cached behind the graph's dirty flag; its own
    // readiness() re-probes only after an invalidation.
    const status = this.graph.readiness(camera);
    if (!status.ready) this.requestPreparation();
    return status.ready;
  }

  /** A frame the graph cannot draw yet (preparing, rebuilding, not ready) is
   * skipped and reported as not rendered.
   * Without presentation validation a drawn frame skips the post-draw probe and
   * is never readyForPresentation; the next frame's readiness admits again. */
  render(validatePresentation = true): ForwardSceneGraphResult & { rendered: boolean; readyForPresentation: boolean; reason?: string } {
    this.refreshOutline();
    const camera = this.scene.activeCamera;
    if (this.disposed || this.scene.isDisposed || !camera)
      return { path: "frameGraph", reason: "Scene is not ready to render.", rendered: false, readyForPresentation: false };
    flushSceneLatticeDeformers(this.scene);
    if (!this.graph.sceneStrictlyReady(camera)) {
      this.advanceReadiness(camera);
      return { path: "frameGraph", reason: "Scene is not ready to render.", rendered: false, readyForPresentation: false };
    }
    // Dynamic cable bounds must reach shadow admission before its cached caster
    // decision. The scene observer covers direct/native Scene.render callers.
    flushSceneCables(this.scene);
    flushDynamicRuntimeMeshes(this.scene);
    const status = this.graph.readiness(camera);
    if (!status.ready) this.requestPreparation();
    // Draw on readiness's admission; graph preparation or invalidation re-admits.
    const result = this.graph.render(camera, true, true);
    if (result.rendered !== false && this.editorOverlay) {
      const capture = activeRenderFrameCapture(this.scene.getEngine());
      if (capture) capture.stage(this.scene, { name: "Viewport editor overlay", kind: "overlay" },
        () => this.editorOverlay?.(camera));
      else this.editorOverlay(camera);
    }
    if (!validatePresentation && result.rendered !== false)
      return { ...result, rendered: true, readyForPresentation: false };
    const after = this.graph.readiness(camera);
    return { ...result, rendered: result.rendered !== false,
      readyForPresentation: result.rendered !== false && !this.pending && status.ready && after.ready };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.editorOverlay = undefined;
    this.outlineView = undefined;
    this.invalidate();
    this.detachReadinessDirty();
    this.releaseWaterPlanarReflections();
    this.graph.dispose();
  }

  private requestPreparation(): void {
    if (this.pending?.generation === this.generation) return;
    const generation = this.generation;
    void this.prepare().catch((error: unknown) => {
      if (!this.disposed && generation === this.generation) this.failure = error;
    });
  }

  private advanceReadiness(camera: Camera): void {
    // A shader probe can still refer to the previous shadow layout. Admit the
    // requested lights/maps and prepare their graph even while that probe is
    // false, or neither the old shaders nor the new resources can progress.
    // A temporary check on current resources must recover on the next ready
    // frame without starting an unnecessary asynchronous preparation wait.
    // Dynamic geometry uploads remain behind successful scene admission.
    if (this.graph.readiness(camera).preparationRequired) this.requestPreparation();
  }

  /** A corrected contribution may retry a failed preparation. Style changes
   * clear failure/readiness only; they neither cancel nor rebuild a graph. */
  private refreshOutline(): void {
    const revision = this.outlineView?.revision ?? -1;
    if (revision === this.outlineRevision) return;
    this.outlineRevision = revision;
    this.failure = undefined;
    this.graph.invalidate();
  }
}
