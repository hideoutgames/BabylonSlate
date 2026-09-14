import { ScenePostProcessOwner } from "./scene-post-process-owner";
import type { AttachedPostProcessStack, AttachPostProcessStackOptions } from "./post-process-material";
import type { Camera, InternalTexture, Observer, Scene } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import {
  backbufferColorTextureHandle,
  backbufferDepthStencilTextureHandle,
} from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { isSceneFrameReady, withSceneReadinessState } from "./scene-perf";
import { findSceneShadowController } from "./shadow-controller";
import { syncSceneLighting } from "./scene-lighting";
import { FrameGraphClusteredLightsTask } from "./framegraph-clustered-lights";
import { isManagedClusteredLight } from "./clustered-light-policy";
import {
  ManagedShadowObjectRendererTask,
  ManagedShadowsTask,
  unsupportedManagedShadows,
} from "./framegraph-managed-shadows";

/** Internal proof result; renderer selection and authored settings are untouched. */
export type ForwardSceneGraphResult =
  { path: "frameGraph" } | { path: "classic"; reason: string };
export type ForwardSceneGraphReadiness = ForwardSceneGraphResult & { ready: boolean };

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
 * Opt-in Forward proof for the backbuffer or an explicit 2D color/depth target.
 * The caller retains its existing frame
 * scheduler and calls render instead of Scene.render, exactly once per frame.
 * prepare only builds/probes effects; it never presents or consumes a frame.
 */
export class ForwardSceneFrameGraph {
  private graph: FrameGraph | undefined;
  private postProcessOwner: ScenePostProcessOwner | undefined;
  private postProcessRevision = 0;
  private preparedPostProcessRevision = -1;
  private retirement: Promise<void> | undefined;
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
  private renderingCamera: Camera | undefined;
  private readonly beforeRender: Observer<Scene>;
  private readonly onDispose: Observer<Scene>;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    // Babylon 9.20 clears activeCamera at the start of its graph render method.
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
    this.postProcessOwner?.dispose();
    const owner = new ScenePostProcessOwner(options);
    this.postProcessOwner = owner;
    this.postProcessRevision += 1;
    this.failure = undefined;
    invalidate();
    const current = () => !this.disposed && this.postProcessOwner === owner;
    return {
      get passes() { return current() ? owner.passes : []; },
      setParameter: (id, name, value) => current() && owner.setParameter(id, name, value),
      getParameter: (id, name) => current() ? owner.getParameter(id, name) : null,
      resetParameter: (id, name) => current() && owner.resetParameter(id, name),
      dispose: () => {
        if (!current()) return;
        owner.dispose();
        this.postProcessOwner = undefined;
        this.postProcessRevision += 1;
        this.failure = undefined;
        invalidate();
      },
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
    })();
    return this.retirement;
  }

  /** Build or resize the persistent tasks and await actual object/effect readiness. */
  prepare(camera: Camera, assertCurrent: () => void = () => {}): Promise<ForwardSceneGraphResult> {
    assertCurrent();
    if (this.pending) return this.pending.then((result) => { assertCurrent(); return result; });
    if (!this.unavailable(camera)) this.syncShadowAdmission(camera);
    const reason = this.unsupported(camera);
    if (reason) {
      this.releaseGraph();
      this.postProcessOwner?.useNative(camera);
      return Promise.resolve({ path: "classic", reason });
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

  /** A pending eligible graph is distinct from an admitted classic fallback. */
  readiness(camera: Camera): ForwardSceneGraphReadiness {
    const unavailable = this.unavailable(camera);
    if (unavailable) return { path: "classic", reason: unavailable, ready: false };
    this.syncShadowAdmission(camera);
    const reason = this.unsupported(camera) ?? this.failure;
    if (reason) {
      // Native stack creation belongs to preparation, never a readiness probe.
      return { path: "classic", reason, ready: !this.postProcessOwner?.hasEnabledEntries ||
        this.postProcessOwner.nativeReadyFor(camera) && isSceneFrameReady(this.scene) };
    }
    const output = this.output(camera);
    if (this.pending || !this.graph || this.preparedPostProcessRevision !== this.postProcessRevision || this.shadows?.needsPreparation() ||
      this.preparedWidth !== output.width || this.preparedHeight !== output.height ||
      this.outputColor !== output.color || this.outputDepth !== output.depth)
      return { path: "frameGraph", ready: false };
    this.objects!.camera = camera;
    this.cull!.camera = camera;
    this.syncSceneInputs();
    return { path: "frameGraph", ready: this.isReady() };
  }

  /** Render one scene frame, with an explicit, observable classic fallback. */
  render(camera: Camera, updateCameras = true): ForwardSceneGraphResult & { rendered?: boolean } {
    const unavailable = this.unavailable(camera);
    if (unavailable) return { path: "classic", reason: unavailable };
    this.syncShadowAdmission(camera);
    const engine = this.scene.getEngine();
    const output = this.output(camera);
    const reason =
      this.unsupported(camera) ??
      this.failure ??
      (this.shadows?.needsPreparation() ||
      this.clustered?.needsPreparation(camera)
        ? "Lighting allocation changes require FrameGraph preparation."
        : undefined) ??
      (this.pending ||
      !this.graph || this.preparedPostProcessRevision !== this.postProcessRevision ||
      this.preparedWidth !== output.width ||
      this.preparedHeight !== output.height ||
      this.outputColor !== output.color || this.outputDepth !== output.depth
        ? "FrameGraph preparation is required."
        : undefined);
    this.scene.activeCamera = camera;
    if (reason) {
      if (this.postProcessOwner?.hasEnabledEntries &&
        (this.pending || !this.postProcessOwner.nativeReadyFor(camera) || !isSceneFrameReady(this.scene)))
        return { path: "classic", reason, rendered: false };
      if (!this.disposed && !this.scene.isDisposed)
        this.scene.render(updateCameras);
      return { path: "classic", reason };
    }

    const graph = this.graph!;
    this.objects!.camera = camera;
    this.cull!.camera = camera;
    this.syncSceneInputs();
    if (!this.isReady()) {
      if (this.postProcessOwner?.hasEnabledEntries)
        return { path: "classic", reason: "FrameGraph effects are not ready.", rendered: false };
      this.scene.render(updateCameras);
      return { path: "classic", reason: "FrameGraph effects are not ready." };
    }
    const cameras = this.scene.activeCameras;
    const ubo = this.scene.getSceneUniformBuffer();
    const renderPass = engine.currentRenderPassId;
    const oit = this.scene._depthPeelingRenderer;
    const intermediate = this.scene._intermediateRendering;
    const shadowFlags = this.scene.lights.map(
      (light) => [light, light.shadowEnabled] as const,
    );
    try {
      this.renderingCamera = camera;
      this.scene.frameGraph = graph;
      this.scene.activeCamera = camera;
      const graphRender = this.scene.customRenderFunction!;
      // Scene.render already updates the selected camera. The pinned graph
      // function would update every scene camera a second time if passed true.
      this.scene.customRenderFunction = (_update, ignoreAnimations) =>
        graphRender.call(this.scene, false, ignoreAnimations);
      this.scene.render(updateCameras);
      return { path: "frameGraph" };
    } finally {
      this.scene.frameGraph = null;
      this.scene.activeCamera = camera;
      this.scene.activeCameras = cameras;
      this.scene.setSceneUniformBuffer(ubo);
      this.scene._depthPeelingRenderer = oit;
      this.scene._intermediateRendering = intermediate;
      engine.currentRenderPassId = renderPass;
      for (const [light, enabled] of shadowFlags) light.shadowEnabled = enabled;
      this.renderingCamera = undefined;
    }
  }

  /** Releases only this coordinator's tasks and graph, never the scene/Engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.postProcessOwner?.dispose(); }
    catch (error) { this.cleanupFailure = error; throw error; }
    this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.scene.onDisposeObservable.remove(this.onDispose);
    if (!this.pending) this.releaseGraph();
  }

  private unavailable(camera: Camera): string | undefined {
    if (this.disposed || this.scene.isDisposed)
      return "FrameGraph coordinator is disposed.";
    if (camera.getScene() !== this.scene || camera.isDisposed())
      return "Camera does not belong to this live scene.";
    if (camera.outputRenderTarget &&
      (camera.outputRenderTarget.getScene() !== this.scene ||
        !camera.outputRenderTarget.getInternalTexture()))
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
      return "Unmanaged clustered light masks require classic rendering.";
    if (scene.frameGraph || scene.customRenderFunction)
      return "Scene already has a render owner.";
    if (scene.activeCameras?.length || camera.cameraRigMode !== 0)
      return "Multiple and rig cameras require classic rendering.";
    // Native freezing retains a submesh/LOD render queue, not just mesh
    // membership. A new ObjectRenderer would re-filter it for the new camera.
    if (scene._activeMeshesFrozen)
      return "Frozen active-mesh queues require classic rendering.";
    // FrameGraph restores the default framebuffer around execution. Only take
    // a camera's explicit output from an otherwise unbound frame boundary.
    if (scene.getEngine()._currentRenderTarget)
      return "A caller-bound render target requires classic rendering.";
    const target = camera.outputRenderTarget;
    if (target && (target.isCube || target.is2DArray || target.samples !== 1 ||
      !target.depthStencilTexture))
      return "FrameGraph output requires a single-sample 2D color/depth texture.";
    const ownedPasses = this.postProcessOwner?.passes ?? [];
    if (camera._postProcesses.some((pass) => pass && !ownedPasses.includes(pass)) ||
      scene.postProcesses.some((pass) => !ownedPasses.includes(pass)))
      return "Scene post-processing requires classic rendering.";
    if (
      scene.customRenderTargets.length ||
      scene.environmentTexture?.isRenderTarget
    )
      return "Scene render targets require classic rendering.";
    if (this.postProcessOwner?.hasEnabledEntries)
      return "Scene-owned post-process graph preparation is required.";
    return unsupportedManagedShadows(scene);
  }

  private syncShadowAdmission(camera: Camera): void {
    const controller = findSceneShadowController(this.scene);
    withSceneReadinessState(this.scene, () => {
      this.scene.activeCamera = camera;
      controller?.sync();
      // Allocation/participation changes alter the material shadow layout.
      // Commit that layout before probing effects, so onBeforeRender cannot
      // invalidate the variants we just declared ready for the first frame.
      syncSceneLighting(this.scene);
    });
  }

  private async prepareGraph(camera: Camera, assertCurrent: () => void): Promise<ForwardSceneGraphResult> {
    const scene = this.scene;
    try {
      assertCurrent();
      const output = this.output(camera);
      if (this.shadows?.needsPreparation() || this.clustered?.needsPreparation(camera) ||
        this.outputColor !== output.color || this.outputDepth !== output.depth) this.releaseGraph();
      if (!this.graph) {
        this.graph = new FrameGraph(scene);
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
          // Babylon 9.20 retains imported color attachments for its wrappers,
          // but not depth. Each owned wrapper must retain borrowed depth too,
          // since wrapper.dispose releases both. Scope this to this graph only.
          textures.createRenderTarget = (...args) => {
            const target = createTarget(...args);
            if (target.renderTargetWrapper?.depthStencilTexture === borrowedDepth)
              borrowedDepth.incrementReferences();
            return target;
          };
        }
        this.clear = new FrameGraphClearTextureTask(
          "Forward clear",
          this.graph,
        );
        this.clear.targetTexture = color;
        this.clear.depthTexture = depth;
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
        this.shadows = new ManagedShadowsTask(this.graph, scene, this.objects);
        this.clustered = new FrameGraphClusteredLightsTask(
          this.graph,
          scene,
          this.objects,
        );
        this.graph.addTask(this.shadows);
        this.graph.addTask(this.clustered);
        this.graph.addTask(this.clear);
        this.graph.addTask(this.cull);
        this.graph.addTask(this.objects);
      }
      this.objects!.camera = camera;
      this.cull!.camera = camera;
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
        const tasks: FrameGraphTask[] = [this.shadows!, this.clear!, this.cull!, this.objects!];
        const restore = tasks.map((task) => {
          const record = task.record;
          const guarded = () => {
            if (this.disposed || scene.isDisposed) throw new Error("FrameGraph coordinator is disposed.");
            assertCurrent(); record.call(task); assertCurrent();
          };
          task.record = guarded;
          return () => { if (task.record === guarded) task.record = record; };
        });
        try { await this.graph.buildAsync(false); }
        finally { for (const action of restore) action(); }
        assertCurrent();
      }
      // Unlike Babylon whenReadyAsync cancellation, disposal settles our waiter.
      const deadline = performance.now() + 10_000;
      while (!this.disposed && !this.isReady()) {
        assertCurrent();
        if (performance.now() >= deadline)
          throw new Error("Forward FrameGraph readiness timed out.");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      if (this.disposed)
        return {
          path: "classic",
          reason: "FrameGraph coordinator is disposed.",
        };
      assertCurrent();
      this.preparedPostProcessRevision = this.postProcessRevision;
      this.preparedWidth = width;
      this.preparedHeight = height;
      this.failure = undefined;
      return { path: "frameGraph" };
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.releaseGraph();
      // Cancellation must reach the loading owner, never become a successful
      // classic fallback for a superseded scene/camera/output generation.
      assertCurrent();
      return { path: "classic", reason: this.failure };
    }
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

  private isReady(): boolean {
    const cameras = this.scene.activeCameras;
    const shadowFlags = this.scene.lights.map(
      (light) => [light, light.shadowEnabled] as const,
    );
    const objectList = this.objects!.objectList;
    try {
      // The previous frame's culled list may omit a newly visible mesh. Probe
      // all current candidates before presenting; culling itself never draws.
      this.objects!.objectList = this.cull!.objectList;
      return withSceneReadinessState(this.scene, () => {
        const camera = this.objects!.camera;
        // Keep scene-owned camera/material/pass readiness alongside the task's
        // own render-pass variants, without waiting on unrelated Engine effects.
        this.scene._activeCamera = camera;
        this.scene.getEngine().currentRenderPassId = camera.renderPassId;
        const cameraReady = isSceneFrameReady(this.scene);
        const graphReady = this.graph!.isReady();
        return cameraReady && graphReady;
      });
    } finally {
      this.objects!.objectList = objectList;
      // ObjectRenderer's shadow toggles also lack finally around readiness
      // hooks. The common guard owns camera/matrices/UBO/Engine state.
      this.scene.activeCameras = cameras;
      for (const [light, enabled] of shadowFlags) light.shadowEnabled = enabled;
    }
  }

  private syncSceneInputs(): void {
    this.clear!.color = this.scene.clearColor;
    this.clear!.clearColor = this.scene.autoClear;
    this.clear!.clearDepth = this.scene.autoClearDepthAndStencil;
    this.clear!.clearStencil = this.scene.autoClearDepthAndStencil;
    // Reference the live scene arrays; membership changes do not rebuild tasks.
    this.cull!.objectList = {
      meshes: this.scene.meshes,
      particleSystems: this.scene.particleSystems,
    };
    this.objects!.objectList = this.cull!.outputObjectList;
  }

  private releaseGraph(): void {
    try { this.releaseGraphResources(); }
    catch (error) { this.cleanupFailure = error; throw error; }
  }

  private releaseGraphResources(): void {
    // Babylon FrameGraph.clear/dispose reset tasks without disposing their
    // ObjectRenderer, OIT renderer and render-pass resources.
    this.objects?.dispose();
    this.shadows?.dispose();
    this.clustered?.dispose();
    this.clear?.dispose();
    this.cull?.dispose();
    this.graph?.dispose();
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
