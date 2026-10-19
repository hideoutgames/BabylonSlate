import { activeRenderFrameCapture } from "./render-frame-report";
import type { AttachedPostProcessStack, AttachPostProcessStackOptions } from "./post-process-material";
import type { Camera, FrameGraphObjectList, Scene } from "@babylonjs/core";
import { ForwardSceneFrameGraph, type ForwardSceneGraphResult } from "./framegraph-forward-scene";
import { onSceneReadinessDirty } from "./scene-perf";
import type { SharedOutlineView } from "./shared-outline";
import { flushSceneCables } from "./cable-mesh";
import { DriverCompileWatch } from "./driver-compile";
import { beginPipelineDeferral, PIPELINE_DEFERRAL_HOLD_CAP_MS, type PipelineDeferral } from "./webgpu-pipeline-deferral";
import { whenPresentationFenceClear } from "./presented-frame";
import { flushDynamicRuntimeMeshes } from "./dynamic-runtime-mesh";
import { flushSceneLatticeDeformers } from "./lattice-deformer";
import { retainWaterPlanarReflections } from "./water-planar-reflection";
import { heldThreadMs, SCENE_PREPARATION_CEILING_MS, SCENE_THREAD_HELD_BUDGET_MS } from "./stall-deadline";

class PreparationChanged extends Error {}

/** Bound on one preparation generation without readiness or compile progress. */
const PREPARATION_TIMEOUT_MS = 10_000;
/**
 * Bound on one owner's preparation across every invalidation restart without
 * compile progress. Progress renews both; `SCENE_PREPARATION_CEILING_MS` bounds
 * the whole preparation.
 */
const PREPARATION_TOTAL_TIMEOUT_MS = 60_000;
/** An auxiliary view's wait before retrying a failed preparation. */
const AUXILIARY_RETRY_MS = 1_000;

function outputSnapshot(scene: Scene, camera: Camera) {
  const target = camera.outputRenderTarget;
  const size = target?.getSize();
  const engine = scene.getEngine();
  return [camera, target, target?.getInternalTexture(), target?.depthStencilTexture,
    size?.width ?? engine.getRenderWidth(true), size?.height ?? engine.getRenderHeight(true)] as const;
}

export type SceneRenderCoordinatorOptions = {
  /** Views may draw planar water reflections; previews, thumbnails and auxiliary views pass false. */
  waterPlanarReflections?: boolean;
  /**
   * An auxiliary view (a Full Quality Render Target Capture): renders `camera`
   * into its output target from inside the scene view's frame, drawing only
   * `objects` (see ForwardSceneFrameGraphOptions). Its camera is never the
   * scene's active camera.
   */
  auxiliary?: { camera: Camera; objects: FrameGraphObjectList };
  /**
   * WebGPU: a draw in one of the graph's object passes whose render pipeline is
   * not cached creates it asynchronously and is skipped (`beginPipelineDeferral`),
   * and the frame is reported not rendered, so the owner keeps its last image
   * until the pipelines exist. After `PIPELINE_DEFERRAL_HOLD_CAP_MS` of such
   * frames in a row, new misses compile synchronously again. Only for a view
   * that draws every frame and presents only rendered frames: the world view
   * and its Full Quality captures, never previews or thumbnails.
   */
  deferPipelines?: boolean;
};

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
  private readonly auxiliaryCamera: Camera | undefined;
  private readonly deferPipelines: boolean;
  /** The last drawn frame's deferral, while it skipped draws. */
  private deferral: PipelineDeferral | undefined;
  /** When the current run of frames held for deferred pipelines began. */
  private deferredSince: number | undefined;
  private readonly ownsPass = (renderPassId: number) => this.graph.ownsObjectPass(renderPassId);
  private failedAt = 0;
  private warnedFailure: string | undefined;

  constructor(scene: Scene, options: SceneRenderCoordinatorOptions = {}) {
    this.scene = scene;
    this.auxiliaryCamera = options.auxiliary?.camera;
    this.deferPipelines = options.deferPipelines === true;
    this.graph = new ForwardSceneFrameGraph(scene, options.auxiliary ? { auxiliary: { objects: options.auxiliary.objects } } : {});
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

  /** The prepared graph's water scene copy plan and work; null when it plans none. */
  waterSceneCopyDiagnostics(): ReturnType<ForwardSceneFrameGraph["waterSceneCopyDiagnostics"]> {
    return this.graph.waterSceneCopyDiagnostics();
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
    let checkpoint = 0;
    let creditLeft = 0;
    const restartDeadline = () => { deadline = Math.min(performance.now() + PREPARATION_TIMEOUT_MS, finalDeadline); };
    /**
     * A long gap between checkpoints is a synchronous call that held the thread,
     * or a host that did not run this loop: time the preparation could neither
     * spend nor observe. It extends both bounds, up to a budget per preparation,
     * so a scene that never becomes ready still fails.
     */
    const creditHeldThread = () => {
      const now = performance.now();
      const grant = Math.min(heldThreadMs(now - checkpoint), creditLeft);
      checkpoint = now;
      if (grant > 0) { creditLeft -= grant; deadline += grant; finalDeadline += grant; }
    };
    /**
     * Created after the first presentation-fence wait (it asks every Engine
     * effect for readiness, a synchronous GL query for one still linking), its
     * ceiling counted from `started`, once a previous owner's preparation
     * settled: it bounds this preparation alone.
     */
    let compiles!: DriverCompileWatch;
    let started = 0;
    /**
     * Shaders that finished compiling since the last renewal, or a driver still
     * compiling, renew both bounds: synchronous links each shorter than
     * SCENE_THREAD_HELD_MS are progress the held-thread credit never sees. Only
     * the ceiling ends a preparation that keeps progressing.
     */
    const expired = () => {
      const now = performance.now();
      if (now >= compiles.ceiling) return true;
      if (now < deadline) return false;
      if (!compiles.renew(now)) return true;
      finalDeadline = now + PREPARATION_TOTAL_TIMEOUT_MS;
      restartDeadline();
      return false;
    };
    const timedOut = () => {
      const limit = performance.now() >= compiles.ceiling
        ? `its ${SCENE_PREPARATION_CEILING_MS / 1000} s limit` : `${PREPARATION_TIMEOUT_MS / 1000} s without progress`;
      return new Error(`Scene rendering preparation timed out after ${limit}. ${compiles.describe()}`);
    };
    /** `credit: false` for a wait whose whole duration the caller already credits. */
    const check = (credit = true) => {
      assertCurrent();
      if (this.disposed || this.scene.isDisposed)
        throw new PreparationChanged("Scene rendering preparation was superseded or disposed.");
      if (credit) creditHeldThread();
      else checkpoint = performance.now();
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
      checkpoint = started = performance.now();
      creditLeft = SCENE_THREAD_HELD_BUDGET_MS;
      finalDeadline = checkpoint + PREPARATION_TOTAL_TIMEOUT_MS;
      restartDeadline();
      check();
      for (;;) {
        check();
        // Preparing creates and finalises effects, and each synchronous GL query
        // waits behind the presented draw's driver compile. The wait is not
        // preparation time, so it extends both bounds.
        const waited = await whenPresentationFenceClear(this.scene.getEngine(), () => check(false));
        if (waited > 0) { finalDeadline += waited; restartDeadline(); }
        compiles ??= new DriverCompileWatch(this.scene.getEngine(), started);
        flushSceneLatticeDeformers(this.scene);
        if (expired()) throw timedOut();
        const camera = this.camera();
        if (!camera) throw new Error("Scene rendering requires an active camera.");
        const snapshot = outputSnapshot(this.scene, camera);
        const iteration = pending.generation;
        const checkOutput = () => {
          check();
          // An invalidated build is stale: abort it and rebuild for the new generation.
          if (pending.generation !== iteration)
            throw new PreparationChanged("Scene rendering was invalidated during preparation.");
          if (expired()) throw timedOut();
          const current = outputSnapshot(this.scene, camera);
          if (this.camera() !== camera || snapshot.some((value, index) => value !== current[index]))
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

  /** No preparation is running and none has failed. Only then can an edit that
   * leaves every readiness input alone skip `invalidate()`: nothing is waiting
   * for a restart, and no latched failure needs the retry an invalidation grants. */
  get settled(): boolean {
    return !this.pending && this.failure === undefined;
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

  /** Outline-task-only probes; a selection change adds these and no strict scene probe. */
  get outlineReadinessChecks(): number {
    return this.graph.outlineReadinessChecks;
  }

  diagnostics() { return this.graph.diagnostics(); }

  /** Loading owners require the prepared selected path, including after resize. */
  isReady(): boolean {
    this.refreshOutline();
    if (this.failure) throw this.failure;
    if (this.pending) return false;
    const camera = this.camera();
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
    const camera = this.camera();
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
    // Like a scene that is not ready yet, a frame that skipped draws for
    // pipelines still compiling draws nothing until they exist.
    if (this.deferral?.waiting())
      return { path: "frameGraph", reason: "Render pipelines are compiling.", rendered: false, readyForPresentation: false };
    // Draw on readiness's admission; graph preparation or invalidation re-admits.
    const deferral = this.deferPipelines
      ? beginPipelineDeferral(this.scene.getEngine(), this.ownsPass,
        this.deferredSince === undefined || performance.now() - this.deferredSince < PIPELINE_DEFERRAL_HOLD_CAP_MS)
      : undefined;
    let result: ReturnType<ForwardSceneFrameGraph["render"]>;
    try {
      result = this.graph.render(camera, true, true);
    } finally {
      // Skipped draws (nested captures' included) leave this frame incomplete.
      this.deferral = deferral?.close() ? deferral : undefined;
      if (this.deferral) this.deferredSince ??= performance.now();
      else this.deferredSince = undefined;
    }
    if (this.deferral)
      return { ...result, reason: "Render pipelines are compiling.", rendered: false, readyForPresentation: false };
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

  /** The view's camera: an auxiliary view's own, otherwise the scene's active camera. */
  private camera(): Camera | null {
    return this.auxiliaryCamera ?? this.scene.activeCamera;
  }

  private requestPreparation(): void {
    if (this.pending?.generation === this.generation) return;
    // An auxiliary view retries a failed preparation (a refused budget, an
    // unsupported scene) at most once per AUXILIARY_RETRY_MS instead of every
    // frame, warning once per distinct failure. Its owner keeps the last image.
    if (this.auxiliaryCamera && this.failure !== undefined) {
      if (performance.now() - this.failedAt < AUXILIARY_RETRY_MS) return;
      this.failure = undefined;
      this.graph.clearFailure();
    }
    const generation = this.generation;
    void this.prepare().catch((error: unknown) => {
      if (this.disposed || generation !== this.generation) return;
      this.failure = error;
      this.failedAt = performance.now();
      const message = String(error);
      if (this.auxiliaryCamera && message !== this.warnedFailure) {
        this.warnedFailure = message;
        console.warn(`[render] Full Quality capture is not drawn while its preparation fails: ${message}`);
      }
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

  /** A corrected contribution may retry a failed preparation. Membership and
   * style changes neither cancel nor rebuild a graph; the graph notices the
   * revision itself and re-probes only the outline task. */
  private refreshOutline(): void {
    const revision = this.outlineView?.revision ?? -1;
    if (revision === this.outlineRevision) return;
    this.outlineRevision = revision;
    this.failure = undefined;
    this.graph.clearFailure();
  }
}
