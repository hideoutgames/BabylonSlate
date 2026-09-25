import { Constants, type Camera, type InternalTexture } from "@babylonjs/core";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";
import { createSpatialStages, spatialEffectsUnsupported, type SpatialStage } from "./spatial-effects";
import type { SceneEffectsPlan } from "./scene-effects";
import { releaseManagedRenderLeaseAfterDisposal, type ManagedRenderCategory, type ManagedRenderLease } from "./managed-render-resources";
import { managedRenderTextureResource } from "./render-target-resource-cost";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";

class SpatialTask extends FrameGraphPostProcessTask {
  private retirement: OwnedEffectRetirement | undefined;
  readonly stage: SpatialStage;
  private readonly buffers: Record<string, FrameGraphTextureHandle>;
  private readonly main?: FrameGraphTextureHandle;
  constructor(graph: FrameGraph, stage: SpatialStage, buffers: Record<string, FrameGraphTextureHandle>, main?: FrameGraphTextureHandle) {
    super(stage.wrapper.name, graph, stage.wrapper);
    this.stage = stage;
    this.buffers = buffers;
    this.main = main;
    this.depthTest = false;
  }
  override record() {
    const pass = super.record(false, undefined, (context) => {
      const effect = this.drawWrapper.effect!;
      if (this.stage.geometry) for (const [name, handle] of Object.entries(this.buffers)) {
        context.setTextureSamplingMode(handle, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
        context.bindTextureHandle(effect, name, handle);
      }
      if (this.main !== undefined) context.bindTextureHandle(effect, "mainSampler", this.main);
      this.stage.bind(effect);
    });
    if (this.stage.geometry) pass.addDependencies(Object.values(this.buffers));
    if (this.main !== undefined) pass.addDependencies(this.main);
    return pass;
  }
  override dispose(): void {
    this.retirement ??= retireOwnedEffect(this.postProcess.effect, () => super.dispose());
  }
  whenDisposed(): Promise<void> { return this.retirement?.completion ?? Promise.resolve(); }
  whenReleased(): Promise<void> { return this.retirement?.released ?? Promise.resolve(); }
}

/** Demand-driven geometry and spatial effects owned by the enclosing view graph. */
export class SpatialEffectsGraph {
  private readonly graph: FrameGraph;
  readonly clear: FrameGraphClearTextureTask;
  readonly geometry: LogicalGeometryTask;
  readonly tasks: SpatialTask[] = [];
  readonly output: FrameGraphTextureHandle;
  private readonly lease: ManagedRenderLease;
  private readonly handles: { handle: FrameGraphTextureHandle; category: ManagedRenderCategory }[] = [];
  private disposed = false;
  private committed = false;
  private released: Promise<void> | undefined;

  constructor(graph: FrameGraph, camera: Camera, plan: SceneEffectsPlan, source: FrameGraphTextureHandle, width: number, height: number, lease: ManagedRenderLease, sceneTargets: { handle: FrameGraphTextureHandle; category: ManagedRenderCategory }[] = []) {
    this.graph = graph;
    const reason = spatialEffectsUnsupported(graph.scene);
    if (reason) throw new Error(reason);
    this.lease = lease;
    this.handles.push(...sceneTargets);
    const unattached = new Set<SpatialStage>();
    try {
    const target = (name: string, scale = 1, depth = false) => {
      const handle = graph.textureManager.createRenderTargetTexture(name, {
        size: { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }, sizeIsPercentage: false,
        options: { createMipMaps: false, samples: 1,
          types: [depth ? Constants.TEXTURETYPE_FLOAT : Constants.TEXTURETYPE_HALF_FLOAT],
          formats: [depth ? Constants.TEXTUREFORMAT_DEPTH32_FLOAT : Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false] },
      });
      this.handles.push({ handle, category: depth ? "depth" : "postprocess" });
      return handle;
    };
    this.clear = new FrameGraphClearTextureTask("Spatial Geometry Clear", graph);
    this.clear.clearColor = false;
    this.clear.clearDepth = true;
    this.clear.clearStencil = false;
    this.clear.depthTexture = target("Spatial Geometry Z", 1, true);
    this.geometry = new LogicalGeometryTask("Spatial Geometry", graph, graph.scene, { doNotChangeAspectRatio: false });
    this.geometry.camera = camera;
    this.geometry.objectList = { meshes: [], particleSystems: [] };
    this.geometry.depthTexture = this.clear.outputDepthTexture;
    this.geometry.size = { width, height };
    this.geometry.sizeIsPercentage = false;
    this.geometry.textureDescriptions = [{ type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_FLOAT, textureFormat: Constants.TEXTUREFORMAT_R }];
    const buffers: Record<string, FrameGraphTextureHandle> = { depthSampler: this.geometry.geometryViewDepthTexture };
    if (plan.reflections) {
      this.geometry.textureDescriptions.push(
        { type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
      );
      buffers.normalSampler = this.geometry.geometryWorldNormalTexture;
      buffers.reflectivitySampler = this.geometry.geometryReflectivityTexture;
    }
    for (const handle of Object.values(buffers)) this.handles.push({ handle, category: "geometry" });
      const stages = createSpatialStages(graph.scene, camera, plan, width, height);
      for (const stage of stages) unattached.add(stage);
      const inputs: FrameGraphTextureHandle[] = [];
      for (const stage of stages) {
        inputs.push(source);
        const task = new SpatialTask(graph, stage, buffers, stage.mainInput === undefined ? undefined : inputs[stage.mainInput]);
        this.tasks.push(task);
        unattached.delete(stage);
        task.sourceTexture = source;
        task.targetTexture = target(stage.wrapper.name, stage.scale);
        source = task.outputTexture;
      }
      this.output = source;
    } catch (error) {
      for (const stage of unattached) retireOwnedEffect(stage.wrapper.effect, () => stage.wrapper.dispose());
      this.disposeTasks();
      // Declarations allocate no targets until graph.build. The caller still
      // owns and retires that graph after a failed construction.
      void this.whenReleased().then(() => releaseManagedRenderLeaseAfterDisposal(graph.engine, lease));
      throw error;
    }
  }
  reconcile(): void {
    if (this.committed) return;
    this.lease.commit(this.handles.map(({ handle, category }) => {
      const texture: InternalTexture | null = this.graph.textureManager.getTextureFromHandle(handle);
      if (!texture) throw new Error("Spatial effects target is not allocated.");
      return managedRenderTextureResource(texture, category, { samples: 1, allocatedMipLevels: 1 });
    }));
    this.committed = true;
  }
  disposeTasks(): void {
    if (this.disposed) return;
    for (const task of this.tasks) task.dispose();
    this.geometry?.dispose();
    this.clear?.dispose();
    this.disposed = true;
  }
  whenDisposed(): Promise<void> { return Promise.all(this.tasks.map((task) => task.whenDisposed())).then(() => {}); }
  whenReleased(): Promise<void> { return Promise.all(this.tasks.map((task) => task.whenReleased())).then(() => {}); }
  releaseAfterGraphDisposal(): Promise<void> {
    if (!this.disposed) throw new Error("Dispose spatial tasks before releasing their graph lease.");
    return this.released ??= this.whenReleased().then(() => releaseManagedRenderLeaseAfterDisposal(this.graph.engine, this.lease));
  }
}
