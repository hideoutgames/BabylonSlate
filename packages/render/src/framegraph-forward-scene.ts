import { activeRenderFrameCapture } from "./render-frame-report";
import { pausedSceneRedrawIssue, renderSceneWithGameTime } from "./scene-game-time";
import { PostProcessRetirement } from "./post-process-retirement";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { createScenePostProcessGraph, type ScenePostProcessGraph } from "./scene-post-process-graph";
import { FrameGraphCopyToTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { ScenePostProcessOwner } from "./scene-post-process-owner";
import { SceneEffectsGraph } from "./scene-effects-graph";
import { upscaledRenderSize } from "./scene-effects";
import { liveSceneEffectsKey } from "./spatial-effects";
import type { SharedOutlineView } from "./shared-outline";
import { FrameGraphSharedOutlineTask } from "./shared-outline-task";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { sceneRenderingSettings, sceneWaterQualityRevision } from "./render-settings";
import { WaterSceneCopyGraph, waterSceneCopyDemand, waterSceneCopyScale } from "./water-scene-copy";
import type { AttachedPostProcessStack, AttachPostProcessStackOptions } from "./post-process-material";
import { Constants } from "@babylonjs/core";
import type { AbstractMesh, Camera, FrameGraphObjectList, InternalTexture, Light, Observable, Observer, Scene } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import {
  backbufferColorTextureHandle,
  backbufferDepthStencilTextureHandle,
} from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { HasStencilAspect } from "@babylonjs/core/Materials/Textures/textureHelper.functions";
import { isSceneFrameReady, withSceneReadinessState } from "./scene-perf";
import { admittedSceneMeshes, admittedSceneParticles } from "./scene-stream-admission";
import { findSceneShadowController } from "./shadow-controller";
import { syncSceneLighting } from "./scene-lighting";
import { FrameGraphClusteredLightsTask } from "./framegraph-clustered-lights";
import { isManagedClusteredLight } from "./clustered-light-policy";
import {
  ManagedShadowObjectRendererTask,
  ManagedShadowsTask,
  unsupportedManagedShadows,
} from "./framegraph-managed-shadows";

/** The FrameGraph is the only scene renderer; a frame it cannot draw is skipped. */
export type ForwardSceneGraphResult = { path: "frameGraph" };
export type ForwardSceneGraphReadiness = ForwardSceneGraphResult & {
  ready: boolean;
  /** Why the scene cannot draw yet, or at all. */
  reason?: string;
  /** Missing or stale resources need preparation; a temporary shader/scene
   * readiness failure on an already prepared path only needs another probe. */
  preparationRequired?: true;
};
const outlineAttachments = new WeakMap<SharedOutlineView, ForwardSceneFrameGraph>();
/** Readiness-relevant collection sizes, compared in place each frame. */
const membershipCounts: readonly ((scene: Scene) => number)[] = [
  (scene) => scene.meshes.length,
  (scene) => scene.materials.length,
  (scene) => scene.lights.length,
  (scene) => scene.textures.length,
  (scene) => scene.cameras.length,
  (scene) => scene.skeletons.length,
  (scene) => scene.particleSystems.length,
  (scene) => scene.customRenderTargets.length,
  (scene) => scene.layers.length,
  (scene) => scene.effectLayers?.length ?? 0,
  (scene) => scene.proceduralTextures?.length ?? 0,
  // Custom readiness checks register without any observable.
  (scene) => (scene as unknown as { _isReadyChecks?: { length: number }[] })
    ._isReadyChecks?.length ?? 0,
];

/** Native camera frustum calculation reads the currently bound target's aspect. */
class CameraOutputCullTask extends FrameGraphCullObjectsTask {
  override _execute(): void {
    const target = this.camera.outputRenderTarget?.renderTarget;
    if (!target) return super._execute();
    const engine = this.camera.getEngine();
    // Every preceding graph render pass restores the backbuffer. Bind only for
    // the official cull task, without clearing or invoking RTT render observers.
    try {
      engine.bindFramebuffer(target);
      this.camera.getViewMatrix();
      this.camera.getProjectionMatrix(true);
      super._execute();
    } finally {
      engine.restoreDefaultFramebuffer();
    }
  }
}

/**
 * The scene renderer: a Forward FrameGraph drawing to the backbuffer or an
 * explicit 2D color/depth target. The caller retains its existing frame
 * scheduler and calls render instead of Scene.render, exactly once per frame.
 * prepare only builds/probes effects; it never presents or consumes a frame.
 * A scene the graph cannot draw fails preparation; there is no native fallback.
 */
export class ForwardSceneFrameGraph {
  private measureWork = false;
  private readonly work = { graphBuilds: 0, shadowAdmissions: 0, shadowAdmissionMs: 0 };

  diagnostics() {
    this.measureWork = true;
    return { ...this.work, strictReadinessChecks: this.strictReadinessChecks };
  }
  private graph: FrameGraph | undefined;
  private readonly retainedGraphs = new Map<FrameGraph, { count: number; release?: () => void }>();
  private postProcessOwner: ScenePostProcessOwner | undefined;
  private postProcessGraph: ScenePostProcessGraph | undefined;
  private effectsGraph: SceneEffectsGraph | undefined;
  private outlineView: SharedOutlineView | undefined;
  private preparedOutlineView: SharedOutlineView | undefined;
  private outlineTask: FrameGraphSharedOutlineTask | undefined;
  private observedOutlineRevision = -1;
  private outputCopy: FrameGraphTask | undefined;
  private postProcessRevision = 0;
  private preparedPostProcessRevision = -1;
  private preparedEffectsKey: string | undefined;
  /** Water quality the graph's water-owned passes were planned for. */
  private preparedWaterRevision = -1;
  /** waterSceneCopyDemand when the graph was planned; -1 before any plan. */
  private preparedWaterDemand = -1;
  private water: WaterSceneCopyGraph | undefined;
  private retirement: Promise<void> | undefined;
  private released: Promise<void> | undefined;
  private readonly postProcessRetirement = new PostProcessRetirement();
  private cleanupFailure: unknown;
  private objects: ManagedShadowObjectRendererTask | undefined;
  private shadows: ManagedShadowsTask | undefined;
  private clustered: FrameGraphClusteredLightsTask | undefined;
  private cull: FrameGraphCullObjectsTask | undefined;
  private clear: FrameGraphClearTextureTask | undefined;
  private preparedWidth = 0;
  private preparedHeight = 0;
  private outputColor: InternalTexture | null = null;
  private outputDepth: InternalTexture | null = null;
  private pending: Promise<ForwardSceneGraphResult> | undefined;
  private disposed = false;
  private failure: string | undefined;
  private failedOutput: ReturnType<ForwardSceneFrameGraph["output"]> & { camera: Camera } | undefined;
  private renderingCamera: Camera | undefined;
  private suppressCameraMark = 0;
  private readinessDirtyFlag = true;
  private readinessRevision = 0;
  private readonly membership: number[] = [];
  private membershipRecorded = false;
  private strictChecks = 0;
  // One-shot record of readiness()'s admission for an immediately following
  // render. Any invalidation bumps the revision; a strict probe bumps checks.
  private admittedCamera: Camera | undefined;
  private admittedRevision = -1;
  private admittedChecks = -1;
  // render()'s per-frame scratch; probeReadiness keeps its own snapshot.
  private readonly shadowLights: Light[] = [];
  private readonly shadowFlags: boolean[] = [];
  private readonly sceneObjects: FrameGraphObjectList = { meshes: null, particleSystems: null };
  private graphRender: Scene["customRenderFunction"];
  // Scene.render already updates the selected camera. The pinned graph
  // function would update every scene camera a second time if passed true.
  private readonly pinnedGraphRender = (_update: boolean, ignoreAnimations: boolean) =>
    this.graphRender!.call(this.scene, false, ignoreAnimations);
  private readonly readinessDetach: (() => void)[] = [];
  private readonly meshMaterialObservers = new Map<AbstractMesh, Observer<AbstractMesh>>();
  private readonly lightEnabledObservers = new Map<Light, Observer<boolean>>();
  private readonly beforeRender: Observer<Scene>;
  private readonly onDispose: Observer<Scene>;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    // Strict readiness probes rebuild every light/material variant. Cache the
    // result and re-probe only after scene or rendering-definition changes.
    const mark = () => this.markReadinessDirty();
    const watch = <T>(observable: Observable<T>, notify: (event: T) => void) => {
      const observer = observable.add(notify);
      this.readinessDetach.push(() => observable.remove(observer));
    };
    watch(scene.onNewMeshAddedObservable, (mesh) => { this.watchMesh(mesh); mark(); });
    watch(scene.onMeshRemovedObservable, (mesh) => { this.unwatchMesh(mesh); mark(); });
    watch(scene.onNewMaterialAddedObservable, mark);
    watch(scene.onMaterialRemovedObservable, mark);
    watch(scene.onNewLightAddedObservable, (light) => { this.watchLight(light); mark(); });
    watch(scene.onLightRemovedObservable, (light) => { this.unwatchLight(light); mark(); });
    watch(scene.onNewTextureAddedObservable, mark);
    watch(scene.onTextureRemovedObservable, mark);
    watch(scene.onNewCameraAddedObservable, mark);
    watch(scene.onCameraRemovedObservable, mark);
    // Babylon clears and restores activeCamera inside its own graph render;
    // the coordinator also pins it per frame. Only authored changes count.
    watch(scene.onActiveCameraChanged, () => {
      if (this.renderingCamera === undefined && this.suppressCameraMark === 0 && !renderTargetCaptureDrawing.has(scene))
        mark();
    });
    watch(scene.onNewSkeletonAddedObservable, mark);
    watch(scene.onSkeletonRemovedObservable, mark);
    for (const mesh of scene.meshes) this.watchMesh(mesh);
    for (const light of scene.lights) this.watchLight(light);
    // Babylon 9.29 clears activeCamera at the start of its graph render method.
    // Restore it before existing lighting/floating-origin/lifecycle observers.
    this.beforeRender = scene.onBeforeRenderObservable.add(
      () => {
        if (this.renderingCamera) scene.activeCamera = this.renderingCamera;
      },
      -1,
      true,
    );
    this.onDispose = scene.onDisposeObservable.add(() => this.dispose());
  }

  attachPostProcess(options: AttachPostProcessStackOptions, invalidate: () => void): AttachedPostProcessStack {
    if (this.disposed || options.scene !== this.scene) throw new Error("Post-process owner is not a live matching Scene.");
    this.releasePostProcessOwner();
    const owner = new ScenePostProcessOwner(options);
    this.postProcessOwner = owner;
    this.postProcessRevision += 1;
    this.failure = undefined;
    invalidate();
    if (!this.pending) this.releaseGraph();
    const current = () => !this.disposed && this.postProcessOwner === owner;
    return {
      whenDisposed: () => owner.whenDisposed(),
      whenReleased: () => owner.whenReleased(),
      setParameter: (id, name, value) => current() && owner.setParameter(id, name, value),
      getParameter: (id, name) => current() ? owner.getParameter(id, name) : null,
      resetParameter: (id, name) => current() && owner.resetParameter(id, name),
      dispose: () => {
        if (!current()) return;
        this.releasePostProcessOwner();
        this.postProcessOwner = undefined;
        this.postProcessRevision += 1;
        this.failure = undefined;
        invalidate();
        if (!this.pending) this.releaseGraph();
      },
    };
  }

  /** A view contributes explicitly; the graph borrows its CPU membership.
   * Attaching does not enable outlines or allocate any outline GPU resources. */
  attachSharedOutline(view: SharedOutlineView, invalidate: () => void): () => void {
    if (this.disposed) throw new Error("Shared outline coordinator is disposed.");
    if (view.isDisposed) throw new Error("Shared outline view is disposed.");
    if (view.scene !== this.scene) throw new Error("Shared outline view belongs to another Scene.");
    if (this.outlineView) throw new Error("This rendering view already has a shared outline owner.");
    if (outlineAttachments.has(view)) throw new Error("Shared outline view is already attached to another coordinator.");
    outlineAttachments.set(view, this);
    this.outlineView = view;
    this.observedOutlineRevision = -1;
    if (view.active) {
      invalidate();
      if (!this.pending) this.releaseGraph();
    }
    return () => {
      if (this.outlineView !== view) return;
      const wasActive = view.active || this.preparedOutlineView === view;
      outlineAttachments.delete(view);
      this.outlineView = undefined;
      this.observedOutlineRevision = -1;
      if (wasActive && !this.disposed) {
        invalidate();
        if (!this.pending) this.releaseGraph();
      }
    };
  }

  postProcessPassCount(): number {
    if (this.disposed) return 0;
    const stackPasses = this.postProcessGraph
      ? this.postProcessGraph.postProcessTasks.filter((task) => task.isActive).length
      : 0;
    const graphEffects =
      this.effectsGraph?.tasks.filter((task) => task !== this.outlineTask && !task.disabled).length ?? 0;
    return stackPasses + graphEffects + (this.outlineTask ? 1 : 0);
  }

  /** Prepared graph task names in record order, for diagnostics and tests. */
  taskNames(): string[] {
    return this.graph?.tasks.map((task) => task.name) ?? [];
  }

  /** Actual mask/compose drawing passes, separately from clear records. */
  sharedOutlineDiagnostics(): { drawingPassCount: number; renderRecordCount: number } {
    return {
      drawingPassCount: this.outlineTask?.drawingPassCount ?? 0,
      renderRecordCount: this.outlineTask?.renderRecordCount ?? 0,
    };
  }

  /** The prepared graph's water scene copy plan and per-frame work; null when no copy is planned. */
  waterSceneCopyDiagnostics(): ReturnType<WaterSceneCopyGraph["diagnostics"]> | null {
    return this.water?.diagnostics() ?? null;
  }

  /** Hold the current valid graph while the view prepares a replacement. Superseded candidates are not retained. */
  retainResources(): () => void {
    const graph = this.graph;
    if (!graph || this.disposed) return () => {};
    const retained: { count: number; release?: () => void } = this.retainedGraphs.get(graph) ?? { count: 0 };
    this.retainedGraphs.set(graph, retained);
    retained.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.retainedGraphs.get(graph) !== retained) return;
      if (--retained.count === 0) {
        this.retainedGraphs.delete(graph);
        retained.release?.();
      }
    };
  }

  /** Settle CPU ownership before a host releases a borrowed output target. */
  retire(): Promise<void> {
    if (this.retirement) return this.retirement;
    try { this.dispose(); }
    catch (error) { this.retirement = Promise.reject(error); return this.retirement; }
    this.retirement = (async () => {
      // Cancellation rejects preparation; its cleanup still runs before this continuation.
      try { await this.pending; } catch { /* preparation failure is not cleanup failure */ }
      if (this.cleanupFailure) throw this.cleanupFailure;
      this.releaseGraph();
      await this.postProcessRetirement.whenDisposed();
    })();
    return this.retirement;
  }

  /** Confirm actual CPU/native release even after a bounded cleanup timeout. */
  whenReleased(): Promise<void> {
    if (this.released) return this.released;
    try { this.dispose(); }
    catch (error) { this.released = Promise.reject(error); return this.released; }
    this.released = (async () => {
      try { await this.pending; } catch { /* cancellation still finishes owned cleanup */ }
      if (this.cleanupFailure) throw this.cleanupFailure;
      this.releaseGraph();
      await this.postProcessRetirement.whenReleased();
      if (this.cleanupFailure) throw this.cleanupFailure;
    })();
    return this.released;
  }

  invalidate(): void {
    this.failure = undefined;
    this.failedOutput = undefined;
    this.markReadinessDirty();
  }

  /** Steady-state frames skip the strict probe until a change marks it dirty. */
  get readinessDirty(): boolean {
    // Deferred entity observables may not have fired yet; membership diffs are
    // the synchronous backstop for mesh/material/light/texture changes.
    this.syncMembership();
    return this.readinessDirtyFlag;
  }

  markReadinessDirty(): void {
    this.readinessDirtyFlag = true;
    this.readinessRevision += 1;
  }

  /** Strict scene/graph probe invocations; steady-state frames add none. */
  get strictReadinessChecks(): number {
    return this.strictChecks;
  }

  /**
   * Babylon defers its entity add/remove observables to a later task. Compare
   * the readiness-relevant collection sizes each frame so a membership change
   * still invalidates the cache before the very next render.
   */
  private syncMembership(): void {
    const outlineRevision = this.outlineView?.revision ?? -1;
    if (outlineRevision !== this.observedOutlineRevision) {
      this.observedOutlineRevision = outlineRevision;
      this.markReadinessDirty();
    }
    const membership = this.membership;
    let changed = false;
    for (let index = 0; index < membershipCounts.length; index += 1) {
      const count = membershipCounts[index]!(this.scene);
      if (count === membership[index]) continue;
      membership[index] = count;
      changed = true;
    }
    // The first call only records the sizes.
    if (changed && this.membershipRecorded) this.markReadinessDirty();
    this.membershipRecorded = true;
  }

  /** Assign activeCamera without tripping the readiness-dirty subscription. */
  private setActiveCamera(camera: Camera | null): void {
    this.suppressCameraMark += 1;
    try {
      this.scene.activeCamera = camera;
    } finally {
      this.suppressCameraMark -= 1;
    }
  }

  /**
   * Strict scene probe gated by the dirty flag: a clean cache reports the last
   * admitted result; a dirty one re-probes and re-arms only on success. A
   * current prepared graph re-runs the full task probe; otherwise the
   * scene-level probe gates preparation.
   */
  sceneStrictlyReady(camera: Camera): boolean {
    if (this.unavailable(camera)) return false;
    this.syncMembership();
    // A settings change stales a prepared graph like a stack revision; with
    // no graph yet there is no baked chain to re-key.
    if (!this.readinessDirtyFlag &&
      (!this.graph || this.preparedEffectsKey === this.effectsKey(camera) && this.outlineMatches() && this.waterMatches(camera)))
      return true;
    if (
      this.graph && !this.pending &&
      this.preparedPostProcessRevision === this.postProcessRevision &&
      this.preparedEffectsKey === this.effectsKey(camera) && this.outlineMatches() && this.waterMatches(camera)
    ) {
      this.assignCamera(camera);
      this.syncSceneInputs();
      if (!this.isReady()) return false;
    } else {
      this.strictChecks += 1;
      if (!isSceneFrameReady(this.scene)) return false;
    }
    this.readinessDirtyFlag = false;
    return true;
  }

  private watchMesh(mesh: AbstractMesh): void {
    if (this.meshMaterialObservers.has(mesh)) return;
    this.meshMaterialObservers.set(
      mesh,
      mesh.onMaterialChangedObservable.add(() => this.markReadinessDirty()),
    );
  }

  private unwatchMesh(mesh: AbstractMesh): void {
    const observer = this.meshMaterialObservers.get(mesh);
    if (!observer) return;
    mesh.onMaterialChangedObservable.remove(observer);
    this.meshMaterialObservers.delete(mesh);
  }

  private watchLight(light: Light): void {
    if (this.lightEnabledObservers.has(light)) return;
    this.lightEnabledObservers.set(
      light,
      light.onEnabledStateChangedObservable.add(() => this.markReadinessDirty()),
    );
  }

  private unwatchLight(light: Light): void {
    const observer = this.lightEnabledObservers.get(light);
    if (!observer) return;
    light.onEnabledStateChangedObservable.remove(observer);
    this.lightEnabledObservers.delete(light);
  }

  private refreshFailure(camera: Camera): void {
    if (!this.failedOutput) return;
    const output = this.output(camera);
    if (this.failedOutput.camera !== camera ||
      output.width !== this.failedOutput.width || output.height !== this.failedOutput.height ||
      output.color !== this.failedOutput.color || output.depth !== this.failedOutput.depth) this.invalidate();
  }

  /** Build or resize the persistent tasks and await actual object/effect readiness. */
  prepare(camera: Camera, assertCurrent: () => void = () => {}): Promise<ForwardSceneGraphResult> {
    assertCurrent();
    this.markReadinessDirty();
    if (this.pending) return this.pending.then((result) => { assertCurrent(); return result; });
    if (!this.unavailable(camera)) this.syncShadowAdmission(camera);
    this.refreshFailure(camera);
    const reason = this.unsupported(camera) ?? this.failure;
    if (reason) {
      this.releaseGraph();
      return Promise.reject(new Error(`Scene cannot render: ${reason}`));
    }
    const work = this.prepareGraph(camera, assertCurrent);
    this.pending = work;
    const settled = () => {
      this.pending = undefined;
      if (this.disposed) {
        try { this.releaseGraph(); }
        catch (error) { this.cleanupFailure = error; }
      }
    };
    void work.then(settled, settled);
    return work;
  }

  /** Preparation reports an unsupported scene or a failed build as an error. */
  readiness(camera: Camera): ForwardSceneGraphReadiness {
    this.admittedCamera = undefined;
    const unavailable = this.unavailable(camera);
    if (unavailable) return { path: "frameGraph", reason: unavailable, ready: false };
    this.syncMembership();
    this.syncShadowAdmission(camera);
    this.admittedCamera = camera;
    this.admittedRevision = this.readinessRevision;
    this.admittedChecks = this.strictChecks;
    this.refreshFailure(camera);
    // Preparation rejects with this reason, so the owner surfaces it.
    const reason = this.unsupported(camera) ?? this.failure;
    if (reason) return { path: "frameGraph", reason, ready: false, preparationRequired: true };
    const outputCurrent = this.outputMatches(this.output(camera));
    if (this.graph && !outputCurrent) this.markReadinessDirty();
    if (this.pending) return { path: "frameGraph", ready: false };
    if (!this.graph || this.preparedPostProcessRevision !== this.postProcessRevision ||
      this.preparedEffectsKey !== this.effectsKey(camera) || !this.outlineMatches() || !this.waterMatches(camera) ||
      this.shadows?.needsPreparation() ||
      this.clustered?.needsPreparation(camera) ||
      !outputCurrent)
      return { path: "frameGraph", ready: false, preparationRequired: true };
    this.assignCamera(camera);
    this.syncSceneInputs();
    if (this.readinessDirty) {
      if (!this.isReady()) return { path: "frameGraph", ready: false };
      this.readinessDirtyFlag = false;
    }
    return { path: "frameGraph", ready: true };
  }

  /** Render one scene frame, or skip it with the reason it cannot draw yet.
   * reuseAdmission is for a caller that invokes readiness() immediately before
   * with no scene work between; any invalidation or strict probe re-admits. */
  render(camera: Camera, updateCameras = true, reuseAdmission = false): ForwardSceneGraphResult & { rendered?: false; reason?: string } {
    const admitted = this.admittedCamera;
    this.admittedCamera = undefined;
    const unavailable = this.unavailable(camera) ?? pausedSceneRedrawIssue(this.scene);
    if (unavailable) return { path: "frameGraph", reason: unavailable, rendered: false };
    this.syncMembership();
    if (!reuseAdmission || admitted !== camera || this.admittedRevision !== this.readinessRevision ||
      this.admittedChecks !== this.strictChecks)
      this.syncShadowAdmission(camera);
    const engine = this.scene.getEngine();
    this.refreshFailure(camera);
    const outputCurrent = this.outputMatches(this.output(camera));
    const reason =
      this.unsupported(camera) ??
      this.failure ??
      (this.shadows?.needsPreparation() ||
      this.clustered?.needsPreparation(camera)
        ? "Lighting allocation changes require FrameGraph preparation."
        : undefined) ??
      (this.pending ||
      !this.graph || this.preparedPostProcessRevision !== this.postProcessRevision ||
      this.preparedEffectsKey !== this.effectsKey(camera) || !this.outlineMatches() || !this.waterMatches(camera) ||
      !outputCurrent
        ? "FrameGraph preparation is required."
        : undefined);
    if (this.graph && !outputCurrent) this.markReadinessDirty();
    this.setActiveCamera(camera);
    if (reason) return { path: "frameGraph", reason, rendered: false };

    const graph = this.graph!;
    this.assignCamera(camera);
    this.syncSceneInputs();
    if (this.readinessDirty) {
      if (!this.isReady()) return { path: "frameGraph", reason: "FrameGraph is not ready.", rendered: false };
      this.readinessDirtyFlag = false;
    }
    const cameras = this.scene.activeCameras;
    const ubo = this.scene.getSceneUniformBuffer();
    const renderPass = engine.currentRenderPassId;
    const oit = this.scene._depthPeelingRenderer;
    const intermediate = this.scene._intermediateRendering;
    const lights = this.scene.lights;
    const shadowLights = this.shadowLights;
    const shadowFlags = this.shadowFlags;
    // Overwrite, then truncate: clearing to zero would drop the backing store.
    for (let index = 0; index < lights.length; index += 1) {
      shadowLights[index] = lights[index]!;
      shadowFlags[index] = lights[index]!.shadowEnabled;
    }
    shadowLights.length = shadowFlags.length = lights.length;
    try {
      this.renderingCamera = camera;
      this.scene.frameGraph = graph;
      this.scene.activeCamera = camera;
      this.graphRender = this.scene.customRenderFunction!;
      this.scene.customRenderFunction = this.pinnedGraphRender;
      const revision = this.readinessRevision;
      const capture = activeRenderFrameCapture(engine);
      if (capture) capture.frameGraph(this.scene, graph, this.work.graphBuilds,
        () => renderSceneWithGameTime(this.scene, updateCameras));
      else renderSceneWithGameTime(this.scene, updateCameras);
      this.syncMembership();
      return { path: "frameGraph", ...(revision === this.readinessRevision ? {} : { rendered: false }) };
    } finally {
      this.scene.frameGraph = null;
      this.scene.activeCamera = camera;
      this.scene.activeCameras = cameras;
      this.scene.setSceneUniformBuffer(ubo);
      this.scene._depthPeelingRenderer = oit;
      this.scene._intermediateRendering = intermediate;
      engine.currentRenderPassId = renderPass;
      for (let index = 0; index < shadowLights.length; index += 1)
        shadowLights[index]!.shadowEnabled = shadowFlags[index]!;
      this.renderingCamera = undefined;
    }
  }

  /** Releases only this coordinator's tasks and graph, never the scene/Engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.outlineView) outlineAttachments.delete(this.outlineView);
    this.outlineView = undefined;
    const retained = [...this.retainedGraphs.values()];
    this.retainedGraphs.clear();
    for (const entry of retained) entry.release?.();
    this.releasePostProcessOwner();
    for (const detach of this.readinessDetach) detach();
    this.readinessDetach.length = 0;
    for (const [mesh, observer] of this.meshMaterialObservers)
      mesh.onMaterialChangedObservable.remove(observer);
    this.meshMaterialObservers.clear();
    for (const [light, observer] of this.lightEnabledObservers)
      light.onEnabledStateChangedObservable.remove(observer);
    this.lightEnabledObservers.clear();
    this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.scene.onDisposeObservable.remove(this.onDispose);
    if (!this.pending) this.releaseGraph();
  }

  private unavailable(camera: Camera): string | undefined {
    if (this.disposed || this.scene.isDisposed)
      return "FrameGraph coordinator is disposed.";
    if (camera.getScene() !== this.scene || camera.isDisposed())
      return "Camera does not belong to this live scene.";
    if (
      camera.outputRenderTarget &&
      (camera.outputRenderTarget.getScene() !== this.scene ||
        !camera.outputRenderTarget.getInternalTexture())
    )
      return "Render target does not belong to this live scene.";
    return undefined;
  }

  private unsupported(camera: Camera): string | undefined {
    const scene = this.scene;
    const unavailable = this.unavailable(camera);
    if (unavailable) return unavailable;
    if (
      scene.lights.some(
        (light) =>
          light.getClassName() === "ClusteredLightContainer" &&
          !isManagedClusteredLight(scene, light),
      )
    )
      return "Unmanaged clustered light masks are not supported.";
    if (scene.frameGraph || scene.customRenderFunction)
      return "Scene already has a render owner.";
    if (scene.activeCameras?.length || camera.cameraRigMode !== 0)
      return "Multiple and rig cameras are not supported.";
    // Native freezing retains a submesh/LOD render queue, not just mesh
    // membership. A new ObjectRenderer would re-filter it for the new camera.
    if (scene._activeMeshesFrozen)
      return "Frozen active-mesh queues are not supported.";
    // FrameGraph restores the default framebuffer around execution. Only take
    // a camera's explicit output from an otherwise unbound frame boundary.
    if (scene.getEngine()._currentRenderTarget)
      return "A caller-bound render target is not supported.";
    const target = camera.outputRenderTarget;
    if (
      target &&
      (target.isCube ||
        target.is2DArray ||
        target.samples !== 1 ||
        !target.depthStencilTexture)
    )
      return "FrameGraph output requires a single-sample 2D color/depth texture.";
    // Post-processing runs as graph tasks attached through attachPostProcess.
    if (camera._postProcesses.some(Boolean) || scene.postProcesses.length)
      return "Native camera post-processes are not supported; attach them to the render coordinator.";
    if (
      scene.customRenderTargets.length ||
      scene.environmentTexture?.isRenderTarget
    )
      return "Scene custom render targets are not supported.";
    return unsupportedManagedShadows(scene);
  }

  private syncShadowAdmission(camera: Camera): void {
    const started = this.measureWork ? performance.now() : 0;
    if (this.measureWork) this.work.shadowAdmissions += 1;
    const controller = findSceneShadowController(this.scene);
    withSceneReadinessState(this.scene, () => {
      this.setActiveCamera(camera);
      // Admit the conventional prefix before shadows spend shared texture units.
      syncSceneLighting(this.scene);
      controller?.sync();
      // Allocation/participation changes alter the material shadow layout.
      // Commit that layout before probing effects, so onBeforeRender cannot
      // invalidate the variants we just declared ready for the first frame.
      syncSceneLighting(this.scene);
    });
    if (this.measureWork) this.work.shadowAdmissionMs += performance.now() - started;
  }

  private async prepareGraph(camera: Camera, assertCurrent: () => void): Promise<ForwardSceneGraphResult> {
    const scene = this.scene;
    try {
      assertCurrent();
      const output = this.output(camera);
      // Everything drawn into an FSR chain, water copy included, runs at its
      // internal size.
      const renderSize = upscaledRenderSize(sceneRenderingSettings(scene).effectsPlan, output.width, output.height);
      if (this.preparedPostProcessRevision !== this.postProcessRevision ||
        this.preparedEffectsKey !== this.effectsKey(camera) || !this.outlineMatches() || !this.waterMatches(camera) ||
        this.clustered?.needsPreparation(camera) ||
        this.outputColor !== output.color || this.outputDepth !== output.depth ||
        (this.postProcessGraph || this.effectsGraph || this.outlineTask) &&
          (this.preparedWidth !== output.width || this.preparedHeight !== output.height))
        this.releaseGraph();
      // A water scene copy follows a backbuffer resize in place: like the
      // default graph, the rebuild keeps every task and render pass id.
      else if (this.water && (this.preparedWidth !== output.width || this.preparedHeight !== output.height) &&
        !this.water.resize(renderSize.width, renderSize.height))
        this.releaseGraph();
      // Record the inputs the tasks are built from; a change during the awaits
      // below must leave this graph stale.
      const postProcessRevision = this.postProcessRevision;
      const effectsKey = this.effectsKey(camera);
      const waterRevision = sceneWaterQualityRevision(scene);
      const waterDemand = waterSceneCopyDemand(scene, camera);
      if (!this.graph) {
        this.graph = new FrameGraph(scene);
        this.preparedOutlineView = this.outlineView?.active ? this.outlineView : undefined;
        // Explicit owner: Scene.dispose must not race an asynchronous build.
        scene.removeFrameGraph(this.graph);
        this.outputColor = output.color;
        this.outputDepth = output.depth;
        const textures = this.graph.textureManager;
        const color = output.color
          ? textures.importTexture("Forward output color", output.color)
          : backbufferColorTextureHandle;
        const depth = output.depth
          ? textures.importTexture("Forward output depth", output.depth)
          : backbufferDepthStencilTextureHandle;
        if (output.depth) {
          const borrowedDepth = output.depth;
          const createTarget = textures.createRenderTarget.bind(textures);
          // Babylon 9.29 retains imported color attachments for its wrappers,
          // but not depth. Each owned wrapper must retain borrowed depth too,
          // since wrapper.dispose releases both. Scope this to this graph only.
          textures.createRenderTarget = (...args) => {
            const target = createTarget(...args);
            if (
              target.renderTargetWrapper?.depthStencilTexture === borrowedDepth
            )
              borrowedDepth.incrementReferences();
            return target;
          };
        }
        const effectsState = sceneRenderingSettings(scene);
        const effectsPlan = effectsState.effectsPlan;
        const postProcessOwner = this.postProcessOwner;
        if (postProcessOwner) {
          postProcessOwner.useGraph();
          const plan = postProcessOwner.plan();
          for (const diagnostic of plan.diagnostics) postProcessOwner.options.onDiagnostic?.(diagnostic);
          const result = createScenePostProcessGraph({
            frameGraph: this.graph, plan, library: postProcessOwner.options.library,
            camera, width: renderSize.width, height: renderSize.height,
            resolutionScale: postProcessOwner.options.resolutionScale,
            // Authored passes run inside the Scene Linear stage; their
            // intermediates stay half-float so HDR reaches the display stage.
            sceneColorType: effectsPlan?.sceneLinear
              ? Constants.TEXTURETYPE_HALF_FLOAT
              : undefined,
            onDiagnostic: postProcessOwner.options.onDiagnostic,
          });
          this.postProcessGraph = result.owner ?? undefined;
          if (result.ok === false) throw new Error(result.reason);
          if (this.postProcessGraph) postProcessOwner.useGraph(this.postProcessGraph);
        }
        const composeOutline = (target: FrameGraphTextureHandle) => {
          const task = new FrameGraphSharedOutlineTask("Shared outlines", this.graph!, this.preparedOutlineView!);
          this.outlineTask = task;
          task.camera = camera;
          task.targetTexture = target;
          return { task, outputTexture: task.outputTexture };
        };
        if (effectsPlan) {
          this.effectsGraph = new SceneEffectsGraph({
            frameGraph: this.graph,
            plan: effectsPlan,
            effects: effectsState.effects,
            camera,
            authoredOutputTexture: this.postProcessGraph?.outputTexture,
            width: renderSize.width,
            height: renderSize.height,
            outputWidth: output.width,
            outputHeight: output.height,
            beforeAntialiasing: this.preparedOutlineView ? composeOutline : undefined,
          });
        } else if (this.preparedOutlineView) {
          composeOutline(this.postProcessGraph?.outputTexture ?? color);
        }
        this.clear = new FrameGraphClearTextureTask(
          "Forward clear",
          this.graph,
        );
        this.clear.targetTexture =
          this.postProcessGraph?.sceneColorTexture ??
          this.effectsGraph?.sceneColorTexture ??
          color;
        this.clear.depthTexture = this.postProcessGraph?.depthTexture ?? this.effectsGraph?.depthTexture ?? depth;
        this.cull = new CameraOutputCullTask(
          "Forward cull",
          this.graph,
          scene,
        );
        this.objects = new ManagedShadowObjectRendererTask(
          "Forward objects",
          this.graph,
          scene,
          // The pinned graph initializes ObjectRenderer before binding its
          // target. Recompute projection after binding, as Scene.render does.
          { doNotChangeAspectRatio: false },
        );
        this.objects.targetTexture = this.clear.outputTexture;
        this.objects.depthTexture = this.clear.outputDepthTexture;
        this.objects.isMainObjectRenderer = true;
        // Clustered lighting rejects the copy; checked only here, since the
        // graph already re-plans when the cluster target changes.
        const waterScale = waterDemand > 0 ? waterSceneCopyScale(scene, camera) : 0;
        if (waterScale > 0) {
          // Sample the chain's scene targets or an imported output directly;
          // only the backbuffer (or a stencil depth) needs an own pair.
          const sceneColor = this.postProcessGraph?.sceneColorTexture ?? this.effectsGraph?.sceneColorTexture;
          const sceneDepth = this.postProcessGraph?.depthTexture ?? this.effectsGraph?.depthTexture;
          const sampleable = sceneColor != null && sceneDepth != null
            ? { color: sceneColor, depth: sceneDepth }
            : output.color && output.depth && !HasStencilAspect(output.depth.format) ? { color, depth } : undefined;
          this.water = WaterSceneCopyGraph.create({
            frameGraph: this.graph, camera, scale: waterScale, width: renderSize.width, height: renderSize.height,
            clear: this.clear, cull: this.cull, objects: this.objects, scene: sampleable,
            output: { color, texture: Boolean(output.color) },
          });
        }
        // Temporal anti-aliasing jitters the scene draw with its geometry pass,
        // including the water split's transparent pass, which draws over the
        // jittered opaque depth and samples the jittered scene copy.
        const jitter = this.effectsGraph?.spatial?.jitter;
        jitter?.jitterRenderer(this.objects.objectRenderer);
        if (this.water) jitter?.jitterRenderer(this.water.transparent.objectRenderer);
        this.shadows = new ManagedShadowsTask(this.graph, scene, this.objects);
        for (const receiver of this.water?.shadowReceivers ?? []) this.shadows.addReceiver(receiver);
        this.clustered = new FrameGraphClusteredLightsTask(
          this.graph,
          scene,
          this.objects,
        );
        this.graph.addTask(this.shadows);
        this.graph.addTask(this.clustered);
        if (this.water?.splitsClear) {
          // The own-pair split switches the output clear: decide before it runs.
          this.graph.addTask(this.cull);
          this.graph.addTask(this.water.split);
          this.graph.addTask(this.clear);
        } else {
          this.graph.addTask(this.clear);
          this.graph.addTask(this.cull);
        }
        for (const task of this.postProcessGraph?.geometryTasks ?? []) this.graph.addTask(task);
        if (this.effectsGraph?.spatial) {
          this.graph.addTask(this.effectsGraph.spatial.clear);
          this.graph.addTask(this.effectsGraph.spatial.geometry);
        }
        if (this.water && !this.water.splitsClear) this.graph.addTask(this.water.split);
        this.graph.addTask(this.objects);
        // The opaque copy and transparent pass precede every chain and the output copy.
        for (const task of this.water?.afterObjects ?? []) this.graph.addTask(task);
        for (const task of this.postProcessGraph?.postProcessTasks ?? []) this.graph.addTask(task);
        for (const task of this.effectsGraph?.tasks ?? []) this.graph.addTask(task);
        if (this.outlineTask && !this.effectsGraph) this.graph.addTask(this.outlineTask);
        // The single output owner: every authored or settings-driven chain
        // feeds this copy; nothing else writes the view's output.
        const chainOutput =
          this.effectsGraph?.outputTexture ??
          (this.postProcessGraph ? this.outlineTask?.outputTexture ?? this.postProcessGraph.outputTexture : undefined);
        if (chainOutput) {
          if (output.color) {
            const copy = new FrameGraphCopyToTextureTask("Scene post-process output", this.graph);
            copy.sourceTexture = chainOutput;
            copy.targetTexture = color;
            this.outputCopy = copy;
          } else {
            const copy = new FrameGraphCopyToBackbufferColorTask("Scene post-process output", this.graph);
            copy.sourceTexture = chainOutput;
            this.outputCopy = copy;
          }
          this.graph.addTask(this.outputCopy);
        }
      }
      this.assignCamera(camera);
      this.syncSceneInputs();
      const { width, height } = output;
      if (width !== this.preparedWidth || height !== this.preparedHeight) {
        // Babylon buildAsync preserves External entries, including the old
        // default-backbuffer dimensions. Refresh them through the public API
        // before tasks record their viewport dimensions for the resized frame.
        this.graph.textureManager.resetBackBufferTextures();
        // Native buildAsync awaits imports before recording/allocating. Check
        // this owner again at that boundary, before it can touch a removed
        // Scene's borrowed targets or disposed ObjectRenderer.
        const tasks = this.graph.tasks;
        const restore = tasks.map((task) => {
          const record = task.record;
          const guarded = () => {
            if (this.disposed || scene.isDisposed) throw new Error("FrameGraph coordinator is disposed.");
            assertCurrent(); record.call(task); assertCurrent();
          };
          task.record = guarded;
          return () => { if (task.record === guarded) task.record = record; };
        });
        try { this.work.graphBuilds += 1; await this.graph.buildAsync(false); }
        finally { for (const action of restore) action(); }
        assertCurrent();
        this.postProcessGraph?.reconcile();
        this.effectsGraph?.spatial?.reconcile();
        this.outlineTask?.reconcileResources();
        this.water?.reconcile();
      }
      // Unlike Babylon whenReadyAsync cancellation, disposal settles our waiter.
      const deadline = performance.now() + 10_000;
      while (!this.disposed && !this.isReady()) {
        assertCurrent();
        // A failed shader never becomes ready; report it instead of timing out.
        const compileFailure = this.effectsGraph?.spatial?.compileFailure.message ?? this.outlineTask?.compileFailure.message;
        if (compileFailure) throw new Error(compileFailure);
        if (performance.now() >= deadline)
          throw new Error("Forward FrameGraph readiness timed out.");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      if (this.disposed) throw new Error("FrameGraph coordinator is disposed.");
      this.readinessDirtyFlag = false;
      assertCurrent();
      this.preparedPostProcessRevision = postProcessRevision;
      this.preparedEffectsKey = effectsKey;
      this.preparedWaterRevision = waterRevision;
      this.preparedWaterDemand = waterDemand;
      this.preparedWidth = width;
      this.preparedHeight = height;
      this.failure = undefined;
      return { path: "frameGraph" };
    } catch (error) {
      this.releaseGraph();
      // Cancellation belongs to the old loading owner. Validate before latching
      // a failure so a superseded build cannot poison its replacement.
      assertCurrent();
      this.failure = error instanceof Error ? error.message : String(error);
      this.failedOutput = { ...this.output(camera), camera };
      throw new Error(`FrameGraph preparation failed: ${this.failure}`, { cause: error });
    }
  }

  /** The live settings key baked into the prepared graph's effect tasks. The
   * cached value only changes when updateSceneRenderingSettings runs, so a
   * steady-state frame compares strings without serializing the block. */
  private effectsKey(camera: Camera): string {
    return liveSceneEffectsKey(this.scene, camera);
  }

  /** Membership and style revisions update the fixed tasks in place. Only
   * activation or an attached-view change alters the graph structure. */
  private outlineMatches(): boolean {
    return this.preparedOutlineView === (this.outlineView?.active ? this.outlineView : undefined);
  }

  /** Water-owned passes (scene copy, planar, FFT) are planned with the graph,
   * so a project Water quality change, or a change in scene-copy demand
   * (copy-sampling water added or removed, group clears, output), re-plans it.
   * Number compares per frame, with no allocation. */
  private waterMatches(camera: Camera): boolean {
    return this.preparedWaterRevision === sceneWaterQualityRevision(this.scene) &&
      this.preparedWaterDemand === waterSceneCopyDemand(this.scene, camera);
  }

  /** Every camera-bound task of the prepared graph follows the frame's camera. */
  private assignCamera(camera: Camera): void {
    this.objects!.camera = camera;
    this.cull!.camera = camera;
    this.water?.setCamera(camera);
  }

  private output(camera: Camera) {
    const target = camera.outputRenderTarget;
    const size = target?.getSize();
    const engine = this.scene.getEngine();
    return {
      width: size?.width ?? engine.getRenderWidth(true),
      height: size?.height ?? engine.getRenderHeight(true),
      color: target?.getInternalTexture() ?? null,
      depth: target?.depthStencilTexture ?? null,
    };
  }

  /** Whether the prepared graph was built for this exact output size and attachments. */
  private outputMatches(output: ReturnType<ForwardSceneFrameGraph["output"]>): boolean {
    return this.preparedWidth === output.width && this.preparedHeight === output.height &&
      this.outputColor === output.color && this.outputDepth === output.depth;
  }

  private isReady(): boolean {
    this.strictChecks += 1;
    const cameras = this.scene.activeCameras;
    const shadowFlags = this.scene.lights.map(
      (light) => [light, light.shadowEnabled] as const,
    );
    const objectList = this.objects!.objectList;
    const geometry = this.postProcessGraph?.geometryTask;
    const geometryObjects = geometry?.objectList;
    const spatial = this.effectsGraph?.spatial?.geometry;
    const spatialObjects = spatial?.objectList;
    try {
      // The previous frame's culled list may omit a newly visible mesh. Probe
      // all current candidates before presenting; culling itself never draws.
      this.objects!.objectList = this.cull!.objectList;
      if (geometry) geometry.objectList = this.cull!.objectList;
      if (spatial) spatial.objectList = this.cull!.objectList;
      this.water?.beginProbe(this.cull!.objectList);
      return withSceneReadinessState(this.scene, () => {
        const camera = this.objects!.camera;
        // Keep scene-owned camera/material/pass readiness alongside the task's
        // own render-pass variants, without waiting on unrelated Engine effects.
        this.scene._activeCamera = camera;
        this.scene.getEngine().currentRenderPassId = camera.renderPassId;
        const cameraReady = isSceneFrameReady(this.scene);
        return this.graph!.isReady() && cameraReady;
      });
    } finally {
      this.water?.endProbe();
      this.objects!.objectList = objectList;
      if (geometry && geometryObjects) geometry.objectList = geometryObjects;
      if (spatial && spatialObjects) spatial.objectList = spatialObjects;
      // ObjectRenderer's shadow toggles also lack finally around readiness
      // hooks. The common guard owns camera/matrices/UBO/Engine state.
      this.scene.activeCameras = cameras;
      for (const [light, enabled] of shadowFlags) light.shadowEnabled = enabled;
    }
  }

  private syncSceneInputs(): void {
    if (this.outlineTask) this.outlineTask.camera = this.objects!.camera;
    this.clear!.color = this.scene.clearColor;
    this.clear!.clearColor = this.scene.autoClear;
    this.clear!.clearDepth = this.scene.autoClearDepthAndStencil;
    this.clear!.clearStencil = this.scene.autoClearDepthAndStencil;
    // Reference the live scene arrays; membership changes do not rebuild tasks.
    this.sceneObjects.meshes = admittedSceneMeshes(this.scene) ?? this.scene.meshes;
    this.sceneObjects.particleSystems = admittedSceneParticles(this.scene) ?? this.scene.particleSystems;
    this.cull!.objectList = this.sceneObjects;
    this.objects!.objectList = this.cull!.outputObjectList;
    this.water?.syncInputs();
    const geometry = this.postProcessGraph?.geometryTask;
    if (geometry) {
      geometry.objectList = this.cull!.outputObjectList;
      geometry.camera = this.objects!.camera;
    }
    if (this.effectsGraph?.spatial) {
      this.effectsGraph.spatial.geometry.objectList = this.cull!.outputObjectList;
      this.effectsGraph.spatial.geometry.camera = this.objects!.camera;
    }
  }

  private releasePostProcessOwner(): void {
    try {
      if (this.postProcessOwner) {
        this.postProcessOwner.dispose();
        this.postProcessRetirement.add(this.postProcessOwner);
        this.postProcessOwner = undefined;
      }
    }
    catch (error) { this.cleanupFailure = error; throw error; }
  }

  private releaseGraph(): void {
    try { this.releaseGraphResources(); }
    catch (error) { this.cleanupFailure = error; throw error; }
  }

  private releaseGraphResources(): void {
    this.admittedCamera = undefined;
    // Babylon FrameGraph.clear/dispose reset tasks without disposing their
    // ObjectRenderer, OIT renderer and render-pass resources.
    this.postProcessOwner?.clearGraph();
    const { graph, postProcessGraph, effectsGraph, outlineTask, outputCopy, objects, shadows, clustered, clear, cull, water } = this;
    const release = () => {
      postProcessGraph?.disposeTasks();
      effectsGraph?.disposeTasks();
      // Unregisters the transparent pass id together with the tasks that used it.
      water?.disposeTasks();
      outlineTask?.dispose();
      outputCopy?.dispose(); objects?.dispose(); shadows?.dispose(); clustered?.dispose(); clear?.dispose(); cull?.dispose();
      graph?.dispose();
      if (postProcessGraph) this.postProcessRetirement.add(postProcessGraph);
      if (effectsGraph) this.postProcessRetirement.add(effectsGraph);
      void postProcessGraph?.releaseAfterGraphDisposal().catch((error: unknown) => { this.cleanupFailure = error; });
      void effectsGraph?.spatial?.releaseAfterGraphDisposal().catch((error: unknown) => { this.cleanupFailure = error; });
      void outlineTask?.releaseAfterGraphDisposal().catch((error: unknown) => { this.cleanupFailure = error; });
      if (outlineTask) this.postProcessRetirement.add(outlineTask);
      if (water) this.postProcessRetirement.add(water);
      void water?.releaseAfterGraphDisposal().catch((error: unknown) => { this.cleanupFailure = error; });
    };
    const retained = graph && this.retainedGraphs.get(graph);
    if (retained && !this.disposed) retained.release = release;
    else release();
    this.postProcessGraph = undefined;
    this.effectsGraph = undefined;
    this.outlineTask = undefined;
    this.preparedOutlineView = undefined;
    this.preparedEffectsKey = undefined;
    this.preparedWaterRevision = -1;
    this.preparedWaterDemand = -1;
    this.water = undefined;
    this.outputCopy = undefined;
    this.objects = undefined;
    this.shadows = undefined;
    this.clustered = undefined;
    this.clear = undefined;
    this.cull = undefined;
    this.graph = undefined;
    this.outputColor = this.outputDepth = null;
    this.preparedWidth = this.preparedHeight = 0;
  }
}
