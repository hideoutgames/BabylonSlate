import type { Camera, Observer, Scene } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
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

/**
 * Opt-in, backbuffer-only Forward proof. The caller retains its existing frame
 * scheduler and calls render instead of Scene.render, exactly once per frame.
 * prepare only builds/probes effects; it never presents or consumes a frame.
 */
export class ForwardSceneFrameGraph {
  private graph: FrameGraph | undefined;
  private objects: ManagedShadowObjectRendererTask | undefined;
  private shadows: ManagedShadowsTask | undefined;
  private clustered: FrameGraphClusteredLightsTask | undefined;
  private cull: FrameGraphCullObjectsTask | undefined;
  private clear: FrameGraphClearTextureTask | undefined;
  private preparedWidth = 0;
  private preparedHeight = 0;
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

  /** Build or resize the persistent tasks and await actual object/effect readiness. */
  prepare(camera: Camera): Promise<ForwardSceneGraphResult> {
    if (this.pending) return this.pending;
    if (!this.unavailable(camera)) this.syncShadowAdmission(camera);
    const reason = this.unsupported(camera);
    if (reason) return Promise.resolve({ path: "classic", reason });
    const work = this.prepareGraph(camera);
    this.pending = work;
    void work.finally(() => {
      this.pending = undefined;
      if (this.disposed) this.releaseGraph();
    });
    return work;
  }

  /** Render one scene frame, with an explicit, observable classic fallback. */
  render(camera: Camera, updateCameras = true): ForwardSceneGraphResult {
    const unavailable = this.unavailable(camera);
    if (unavailable) return { path: "classic", reason: unavailable };
    this.syncShadowAdmission(camera);
    const engine = this.scene.getEngine();
    const reason =
      this.unsupported(camera) ??
      this.failure ??
      (this.shadows?.needsPreparation() ||
      this.clustered?.needsPreparation(camera)
        ? "Lighting allocation changes require FrameGraph preparation."
        : undefined) ??
      (this.pending ||
      !this.graph ||
      this.preparedWidth !== engine.getRenderWidth(true) ||
      this.preparedHeight !== engine.getRenderHeight(true)
        ? "FrameGraph preparation is required."
        : undefined);
    this.scene.activeCamera = camera;
    if (reason) {
      if (!this.disposed && !this.scene.isDisposed)
        this.scene.render(updateCameras);
      return { path: "classic", reason };
    }

    const graph = this.graph!;
    this.objects!.camera = camera;
    this.cull!.camera = camera;
    this.syncSceneInputs();
    if (!this.isReady()) {
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
    this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.scene.onDisposeObservable.remove(this.onDispose);
    if (!this.pending) this.releaseGraph();
  }

  private unavailable(camera: Camera): string | undefined {
    if (this.disposed || this.scene.isDisposed)
      return "FrameGraph coordinator is disposed.";
    if (camera.getScene() !== this.scene || camera.isDisposed())
      return "Camera does not belong to this live scene.";
    return undefined;
  }

  private unsupported(camera: Camera): string | undefined {
    const scene = this.scene;
    const unavailable = this.unavailable(camera);
    if (unavailable) return unavailable;
    if (scene.getEngine().isWebGPU)
      return "Forward FrameGraph proof requires WebGL.";
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
    // Pinned Scene flag also used by the official culling task.
    if (scene._activeMeshesFrozen)
      return "Frozen active-mesh lists require classic rendering.";
    // Pinned AbstractEngine target state: graph.execute restores the default
    // framebuffer, so it cannot borrow a caller-owned shared-view RTT.
    if (camera.outputRenderTarget || scene.getEngine()._currentRenderTarget)
      return "Render-target views require classic rendering.";
    if (camera._postProcesses.some(Boolean) || scene.postProcesses.length)
      return "Scene post-processing requires classic rendering.";
    if (
      scene.customRenderTargets.length ||
      scene.environmentTexture?.isRenderTarget
    )
      return "Scene render targets require classic rendering.";
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

  private async prepareGraph(camera: Camera): Promise<ForwardSceneGraphResult> {
    const scene = this.scene;
    const engine = scene.getEngine();
    try {
      if (
        this.shadows?.needsPreparation() ||
        this.clustered?.needsPreparation(camera)
      )
        this.releaseGraph();
      if (!this.graph) {
        this.graph = new FrameGraph(scene);
        // Explicit owner: Scene.dispose must not race an asynchronous build.
        scene.removeFrameGraph(this.graph);
        this.clear = new FrameGraphClearTextureTask(
          "Forward clear",
          this.graph,
        );
        this.clear.targetTexture = backbufferColorTextureHandle;
        this.clear.depthTexture = backbufferDepthStencilTextureHandle;
        this.cull = new FrameGraphCullObjectsTask(
          "Forward cull",
          this.graph,
          scene,
        );
        this.objects = new ManagedShadowObjectRendererTask(
          "Forward objects",
          this.graph,
          scene,
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
      const width = engine.getRenderWidth(true);
      const height = engine.getRenderHeight(true);
      if (width !== this.preparedWidth || height !== this.preparedHeight) {
        // Babylon buildAsync preserves External entries, including the old
        // default-backbuffer dimensions. Refresh them through the public API
        // before tasks record their viewport dimensions for the resized frame.
        this.graph.textureManager.resetBackBufferTextures();
        await this.graph.buildAsync(false);
      }
      // Unlike Babylon whenReadyAsync cancellation, disposal settles our waiter.
      const deadline = performance.now() + 10_000;
      while (!this.disposed && !this.isReady()) {
        if (performance.now() >= deadline)
          throw new Error("Forward FrameGraph readiness timed out.");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      if (this.disposed)
        return {
          path: "classic",
          reason: "FrameGraph coordinator is disposed.",
        };
      this.preparedWidth = width;
      this.preparedHeight = height;
      this.failure = undefined;
      return { path: "frameGraph" };
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.releaseGraph();
      return { path: "classic", reason: this.failure };
    }
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
    this.preparedWidth = this.preparedHeight = 0;
  }
}
