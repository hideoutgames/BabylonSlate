import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import { geometryDepthTextureType, LogicalGeometryTask } from "./framegraph-logical-buffers";
import { createGeometryDepthSeed } from "./geometry-depth-seed";
import { GeometryRepeatProbeTask } from "./geometry-repeat-probe";
import { geometryRepeat } from "./world-debug";
import { registerSpatialGeometryPass, unregisterSpatialGeometryPass } from "./spatial-geometry-passes";
// Unlit Standard surfaces write no reflectivity: installed before any reflectivity geometry pass compiles.
import {
  createSpatialStages,
  spatialEffectsUnsupported,
  type SpatialStage,
} from "./spatial-effects";
import type { SceneEffectsPlan } from "./scene-effects";
import { ScreenShadowsGraph } from "./screen-shadows";
import {
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderCategory,
  type ManagedRenderLease,
} from "./managed-render-resources";
import { managedRenderTextureResource } from "./render-target-resource-cost";
import { EffectCompileFailure } from "./effect-compile-failure";
import {
  retireOwnedEffect,
  type OwnedEffectRetirement,
} from "./owned-effect-retirement";

class SpatialTask extends FrameGraphPostProcessTask {
  private retirement: OwnedEffectRetirement | undefined;
  readonly stage: SpatialStage;
  private readonly buffers: Record<string, FrameGraphTextureHandle>;
  /** Earlier stages' outputs it samples, by sampler name. */
  private readonly reads: Record<string, FrameGraphTextureHandle>;
  constructor(
    graph: FrameGraph,
    stage: SpatialStage,
    buffers: Record<string, FrameGraphTextureHandle>,
    reads: Record<string, FrameGraphTextureHandle>,
  ) {
    super(stage.wrapper.name, graph, stage.wrapper);
    this.stage = stage;
    this.buffers = buffers;
    this.reads = reads;
    this.depthTest = false;
  }
  override record() {
    // Babylon's own disabled pass copies the source, which only a colour stage passes through.
    const idleCapable = this.stage.idle !== undefined;
    const pass = super.record(idleCapable, undefined, (context) => {
      const effect = this.drawWrapper.effect!;
      if (this.stage.geometry)
        for (const [name, handle] of Object.entries(this.buffers)) {
          context.setTextureSamplingMode(
            handle,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
          );
          context.bindTextureHandle(effect, name, handle);
        }
      for (const [name, handle] of Object.entries(this.reads)) {
        context.setTextureSamplingMode(handle, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
        context.bindTextureHandle(effect, name, handle);
      }
      this.stage.bind(effect);
    });
    if (this.stage.geometry) pass.addDependencies(Object.values(this.buffers));
    pass.addDependencies(Object.values(this.reads));
    if (idleCapable) {
      const skipped = this._frameGraph.addRenderPass(`${this.name}_disabled`, true);
      skipped.setRenderTarget(this.outputTexture);
      const source = this.sourceTexture;
      if (!this.stage.color || source === undefined) skipped.setExecuteFunc(() => {});
      else {
        skipped.addDependencies(source);
        skipped.setExecuteFunc((context) => context.copyTexture(source));
      }
    }
    return pass;
  }
  override dispose(): void {
    this.retirement ??= retireOwnedEffect(this.postProcess.effect, () =>
      super.dispose(),
    );
  }
  whenDisposed(): Promise<void> {
    return this.retirement?.completion ?? Promise.resolve();
  }
  whenReleased(): Promise<void> {
    return this.retirement?.released ?? Promise.resolve();
  }
}

/** Demand-driven geometry and spatial effects owned by the enclosing view graph. */
export class SpatialEffectsGraph {
  /** Set once any spatial stage shader fails to compile. */
  readonly compileFailure = new EffectCompileFailure();
  private readonly graph: FrameGraph;
  readonly geometry: LogicalGeometryTask;
  /**
   * `worlddebug geometryonce off` (or `geometryoncescissor off`): a second geometry pass the owner adds right before
   * `geometry`, drawing its object list into scratch targets nothing reads (`GeometryRepeatProbeTask`); absent otherwise.
   */
  readonly geometryProbe?: GeometryRepeatProbeTask;
  readonly tasks: SpatialTask[] = [];
  readonly output: FrameGraphTextureHandle;
  /** Screen-Space Shadows: a pass after the geometry pass that the owner adds before its objects (`screen-shadows.ts`). */
  readonly screenShadows?: ScreenShadowsGraph;
  /**
   * The geometry pass starts from the scene's depth (`sceneDepth`): every stage reads the view depth alone (no ambient
   * occlusion, reflections or Screen-Space Shadows, whose normals, reflectivity and caster marks only the meshes'
   * own draws give), so the pass draws only the meshes that depth lacks. The owner then adds the geometry tasks after
   * its object pass and gives the pass that narrower list.
   */
  readonly seeded: boolean = false;
  private seedRetirement: OwnedEffectRetirement | undefined;
  private readonly lease: ManagedRenderLease;
  private readonly handles: {
    handle: FrameGraphTextureHandle;
    category: ManagedRenderCategory;
    /** Multisampled storage beside the resolved texture (the enclosing view's scene targets under MSAA). */
    samples?: number;
  }[] = [];
  private disposed = false;
  private committed = false;
  private released: Promise<void> | undefined;

  constructor(
    graph: FrameGraph,
    camera: Camera,
    plan: SceneEffectsPlan,
    source: FrameGraphTextureHandle,
    width: number,
    height: number,
    lease: ManagedRenderLease,
    sceneTargets: {
      handle: FrameGraphTextureHandle;
      category: ManagedRenderCategory;
      samples?: number;
    }[] = [],
    /** The view's scene depth, single-sample once its object pass has run; undefined keeps the pass's own draws. */
    sceneDepth?: FrameGraphTextureHandle,
  ) {
    this.graph = graph;
    const reason = spatialEffectsUnsupported(graph.scene);
    if (reason) throw new Error(reason);
    this.lease = lease;
    this.handles.push(...sceneTargets);
    const unattached = new Set<SpatialStage>();
    try {
      const target = (name: string, scale = 1, depth = false, format = Constants.TEXTUREFORMAT_RGBA) => {
        const handle = graph.textureManager.createRenderTargetTexture(name, {
          size: {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
          },
          sizeIsPercentage: false,
          options: {
            createMipMaps: false,
            samples: 1,
            types: [
              depth
                ? Constants.TEXTURETYPE_FLOAT
                : Constants.TEXTURETYPE_HALF_FLOAT,
            ],
            formats: [depth ? Constants.TEXTUREFORMAT_DEPTH32_FLOAT : format],
            useSRGBBuffers: [false],
          },
        });
        this.handles.push({
          handle,
          category: depth ? "depth" : "postprocess",
        });
        return handle;
      };
      this.geometry = new LogicalGeometryTask(
        "Spatial Geometry",
        graph,
        graph.scene,
        { doNotChangeAspectRatio: false },
      );
      registerSpatialGeometryPass(graph.scene, this.geometry.objectRenderer.renderPassId);
      this.geometry.camera = camera;
      this.geometry.objectList = { meshes: [], particleSystems: [] };
      // The pass clears its depth itself (`clearsDepth`): a clear task would be a render pass of its own.
      this.geometry.depthTexture = target("Spatial Geometry Z", 1, true);
      this.geometry.clearsDepth = true;
      this.geometry.size = { width, height };
      this.geometry.sizeIsPercentage = false;
      this.geometry.textureDescriptions = [
        {
          type: Constants.PREPASS_DEPTH_TEXTURE_TYPE,
          // Spatial support already requires float and half-float rendering.
          textureType: geometryDepthTextureType(graph.scene.getEngine().getCaps())!,
          // Screen-Space Shadows read the caster mark beside the depth (`GeometrySurfaceOutputBlock`).
          textureFormat: plan.screenShadows ? Constants.TEXTUREFORMAT_RG : Constants.TEXTUREFORMAT_R,
        },
      ];
      const buffers: Record<string, FrameGraphTextureHandle> = {
        depthSampler: this.geometry.geometryViewDepthTexture,
      };
      if (plan.reflections || plan.ambientOcclusion) {
        this.geometry.textureDescriptions.push({
          type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE,
          textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
          textureFormat: Constants.TEXTUREFORMAT_RGBA,
        });
        buffers.normalSampler = this.geometry.geometryWorldNormalTexture;
      }
      if (plan.reflections) {
        this.geometry.textureDescriptions.push({
          type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE,
          textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
          textureFormat: Constants.TEXTUREFORMAT_RGBA,
        });
        buffers.reflectivitySampler = this.geometry.geometryReflectivityTexture;
      }
      for (const handle of Object.values(buffers))
        this.handles.push({ handle, category: "geometry" });
      const repeat = geometryRepeat(graph.scene);
      if (repeat !== "none") {
        // `worlddebug geometryonce off`: the same pass once more first, into scratch targets nothing reads.
        const probe = new GeometryRepeatProbeTask("Spatial Geometry Probe", graph, graph.scene, repeat === "scissor");
        registerSpatialGeometryPass(graph.scene, probe.objectRenderer.renderPassId);
        probe.camera = camera;
        probe.objectList = this.geometry.objectList;
        probe.depthTexture = target("Spatial Geometry Probe Z", 1, true);
        probe.clearsDepth = true;
        probe.size = { width, height };
        probe.sizeIsPercentage = false;
        probe.textureDescriptions = this.geometry.textureDescriptions.map((description) => ({ ...description }));
        this.handles.push({ handle: probe.geometryViewDepthTexture, category: "geometry" });
        if (plan.reflections || plan.ambientOcclusion) this.handles.push({ handle: probe.geometryWorldNormalTexture, category: "geometry" });
        if (plan.reflections) this.handles.push({ handle: probe.geometryReflectivityTexture, category: "geometry" });
        this.geometryProbe = probe;
      }
      if (sceneDepth !== undefined && !plan.ambientOcclusion && !plan.reflections && !plan.screenShadows) {
        this.geometry.seed = createGeometryDepthSeed(graph.engine, "Spatial Geometry Depth Seed", sceneDepth,
          this.compileFailure.for("Spatial Geometry Depth Seed"));
        this.seeded = true;
      }
      const stages = createSpatialStages(
        graph.scene,
        camera,
        plan,
        width,
        height,
        this.compileFailure,
      );
      for (const stage of stages) unattached.add(stage);
      if (plan.screenShadows) {
        this.screenShadows = new ScreenShadowsGraph(graph, camera, plan.screenShadows, this.geometry.geometryViewDepthTexture,
          width, height, this.compileFailure);
        this.handles.push({ handle: this.screenShadows.output, category: "geometry" });
      }
      const sceneColor = source;
      for (const stage of stages) {
        const reads: Record<string, FrameGraphTextureHandle> = {};
        for (const [name, index] of Object.entries(stage.reads ?? {})) reads[name] = this.tasks[index]!.outputTexture;
        const task = new SpatialTask(graph, stage, buffers, reads);
        this.tasks.push(task);
        unattached.delete(stage);
        task.sourceTexture = stage.source === "scene" ? sceneColor : source;
        task.targetTexture = target(stage.wrapper.name, stage.scale, false, stage.format);
        source = task.outputTexture;
      }
      this.output = source;
    } catch (error) {
      for (const stage of unattached)
        retireOwnedEffect(stage.wrapper.effect, () => stage.wrapper.dispose());
      this.disposeTasks();
      // Declarations allocate no targets until graph.build. The caller still
      // owns and retires that graph after a failed construction.
      void this.whenReleased().then(() =>
        releaseManagedRenderLeaseAfterDisposal(graph.engine, lease),
      );
      throw error;
    }
  }
  /**
   * Run before each frame's graph execution. Skips the stages that would change
   * nothing for this camera, Screen-Space Shadows without a shadowed sun or with an
   * orthographic camera, and the geometry passes once nothing running reads
   * them (the stages flagged `geometry` and the march; no other pass samples
   * these buffers); toggling flags never rebuilds the graph.
   */
  syncIdle(): void {
    let geometryRead = false;
    // The fog march and compose share one condition, and evaluating it scans
    // the Fog Volumes: evaluate each distinct function once.
    let evaluated: (() => boolean) | undefined;
    let skipped = false;
    for (const task of this.tasks) {
      const idle = task.stage.idle;
      if (idle && idle !== evaluated) {
        evaluated = idle;
        skipped = idle();
      }
      task.disabled = idle !== undefined && skipped;
      if (!task.disabled && task.stage.geometry) geometryRead = true;
    }
    // Screen-Space Shadows read the depth (and the caster mark) while they march: a shadowed sun and a perspective view.
    if (this.screenShadows?.sync()) geometryRead = true;
    this.geometry.disabled = !geometryRead;
    if (this.geometryProbe) {
      // The repeat draws what the real pass draws this frame, as it draws it.
      this.geometryProbe.objectList = this.geometry.objectList;
      this.geometryProbe.camera = this.geometry.camera;
      this.geometryProbe.disabled = this.geometry.disabled;
    }
  }
  reconcile(): void {
    this.screenShadows?.reconcile(this.graph);
    if (this.committed) return;
    this.lease.commit(
      this.handles.map(({ handle, category, samples }) => {
        const texture: InternalTexture | null =
          this.graph.textureManager.getTextureFromHandle(handle);
        if (!texture)
          throw new Error("Spatial effects target is not allocated.");
        return managedRenderTextureResource(texture, category, {
          samples: samples ?? 1,
          allocatedMipLevels: 1,
        });
      }),
    );
    this.committed = true;
  }
  disposeTasks(): void {
    if (this.disposed) return;
    for (const task of this.tasks) task.dispose();
    this.screenShadows?.dispose();
    const seed = this.geometry?.seed?.wrapper;
    if (seed) this.seedRetirement = retireOwnedEffect(seed.effect, () => seed.dispose());
    if (this.geometry) unregisterSpatialGeometryPass(this.graph.scene, this.geometry.objectRenderer.renderPassId);
    this.geometry?.dispose();
    if (this.geometryProbe) unregisterSpatialGeometryPass(this.graph.scene, this.geometryProbe.objectRenderer.renderPassId);
    this.geometryProbe?.dispose();
    this.disposed = true;
  }
  whenDisposed(): Promise<void> {
    return Promise.all([...this.tasks.map((task) => task.whenDisposed()), this.screenShadows?.whenDisposed(),
      this.seedRetirement?.completion]).then(() => {});
  }
  whenReleased(): Promise<void> {
    return Promise.all([...this.tasks.map((task) => task.whenReleased()), this.screenShadows?.whenReleased(),
      this.seedRetirement?.released]).then(() => {});
  }
  releaseAfterGraphDisposal(): Promise<void> {
    if (!this.disposed)
      throw new Error(
        "Dispose spatial tasks before releasing their graph lease.",
      );
    return (this.released ??= this.whenReleased().then(() =>
      releaseManagedRenderLeaseAfterDisposal(this.graph.engine, this.lease),
    ));
  }
}
