import { Constants, type Camera, type InternalTexture } from "@babylonjs/core";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import type { MaterialParameterValue } from "@babylonslate/core";
import { AuthoredPostProcessTask } from "./framegraph-post-process";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";
import type { MaterialLibrary } from "./material-library";
import type { PostProcessStackDiagnostic } from "./post-process-material";
import type {
  PreparedScenePostProcessEntry,
  ScenePostProcessPlan,
} from "./scene-post-process-plan";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderCategory,
  type ManagedRenderLease,
  type ManagedRenderResource,
} from "./managed-render-resources";
import {
  managedRenderTextureResource,
  renderTargetAllocationBytes,
} from "./render-target-resource-cost";

type Options = {
  frameGraph: FrameGraph;
  plan: ScenePostProcessPlan;
  library: MaterialLibrary;
  camera: Camera;
  width: number;
  height: number;
  resolutionScale?: number;
  /** Scene color storage: Scene Linear passes carry half-float HDR through
   * the authored stack; the default keeps display-encoded RGBA8. */
  sceneColorType?: number;
  onDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
};
type Recipe = {
  entries: PreparedScenePostProcessEntry[];
  sceneDepth: boolean;
  sceneNormal: boolean;
  depthType: number;
  scale: number;
  estimatedBytes: number;
};
export type ScenePostProcessGraphResult =
  | { ok: true; owner: ScenePostProcessGraph | null }
  | { ok: false; reason: string; owner?: ScenePostProcessGraph };

/** Allocates only declarations until the caller builds its graph. The caller
 * inserts geometryTasks before objects and postProcessTasks after objects. */
export function createScenePostProcessGraph(
  options: Options,
): ScenePostProcessGraphResult {
  const { frameGraph: graph, camera, width, height, library } = options;
  const scene = graph.scene;
  const engine = scene.getEngine();
  if (
    scene.isDisposed ||
    engine.isDisposed ||
    camera.isDisposed() ||
    camera.getScene() !== scene
  )
    return {
      ok: false,
      reason: "Post-process camera or Scene is unavailable.",
    };
  const entries = options.plan.entries
    .filter(({ entry }) => entry.enabled)
    .sort((a, b) => a.entry.order - b.entry.order);
  if (!entries.length) return { ok: true, owner: null };
  if (
    ![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    return { ok: false, reason: "Post-process target dimensions are invalid." };
  const caps = engine.getCaps();
  if (
    width > caps.maxTextureSize ||
    height > caps.maxTextureSize ||
    !caps.depthTextureExtension
  )
    return {
      ok: false,
      reason:
        "Post-process sampleable color/depth targets exceed device capabilities.",
    };
  const ids = new Set<string>();
  for (const { entry, document, plan } of entries) {
    if (!entry.id || ids.has(entry.id))
      return { ok: false, reason: "Post-process entry IDs must be unique." };
    ids.add(entry.id);
    const current = library.planFor(document);
    if (!current.ok || current.plan.hash !== plan.hash)
      return {
        ok: false,
        reason: "Post-process material plan changed during preparation.",
      };
  }
  const sceneDepth = entries.some(
    ({ plan }) => plan.bufferRequirements.sceneDepth,
  );
  const sceneNormal = entries.some(
    ({ plan }) => plan.bufferRequirements.sceneNormal,
  );
  const geometryCount = Number(sceneDepth) + Number(sceneNormal);
  if (
    geometryCount &&
    (!caps.drawBuffersExtension || (caps.maxDrawBuffers ?? 0) < geometryCount)
  )
    return {
      ok: false,
      reason:
        "Shared post-process geometry buffers exceed device capabilities.",
    };
  const depthType = caps.textureFloatRender
    ? Constants.TEXTURETYPE_FLOAT
    : caps.textureHalfFloatRender
      ? Constants.TEXTURETYPE_HALF_FLOAT
      : undefined;
  if (sceneDepth && depthType === undefined)
    return {
      ok: false,
      reason:
        "Normalized Scene Depth requires a renderable float or half-float target.",
    };
  const scale = Number.isFinite(options.resolutionScale)
    ? Math.min(1, Math.max(0.1, options.resolutionScale!))
    : 1;
  const cost = (
    format: number,
    type: number,
    targetWidth = width,
    targetHeight = height,
  ) =>
    renderTargetAllocationBytes({
      width: targetWidth,
      height: targetHeight,
      format,
      type,
      samples: 1,
    });
  const sceneColorType =
    options.sceneColorType ?? Constants.TEXTURETYPE_UNSIGNED_BYTE;
  let estimatedBytes =
    cost(Constants.TEXTUREFORMAT_RGBA, sceneColorType) +
    cost(Constants.TEXTUREFORMAT_DEPTH32_FLOAT, Constants.TEXTURETYPE_FLOAT);
  if (geometryCount)
    estimatedBytes += cost(
      Constants.TEXTUREFORMAT_DEPTH32_FLOAT,
      Constants.TEXTURETYPE_FLOAT,
    );
  if (sceneDepth)
    estimatedBytes += cost(Constants.TEXTUREFORMAT_RGBA, depthType!);
  if (sceneNormal)
    estimatedBytes += cost(
      Constants.TEXTUREFORMAT_RGBA,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
  for (const { entry } of entries) {
    const passScale = entry.scalable ? scale : 1;
    estimatedBytes += cost(
      Constants.TEXTUREFORMAT_RGBA,
      sceneColorType,
      Math.max(1, Math.round(width * passScale)),
      Math.max(1, Math.round(height * passScale)),
    );
  }
  const lease = beginManagedRenderAllocation(engine, estimatedBytes);
  if (!lease)
    return {
      ok: false,
      reason:
        "Post-process targets exceed the shared Engine resource reservation.",
    };
  const owner = new ScenePostProcessGraph(
    options,
    {
      entries,
      sceneDepth,
      sceneNormal,
      depthType: depthType ?? Constants.TEXTURETYPE_FLOAT,
      scale,
      estimatedBytes,
    },
    lease,
  );
  try {
    owner.initialize();
    return { ok: true, owner };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      owner,
    };
  }
}

/** One immutable scene/camera stack allocation. Graph texture ownership stays
 * with its caller; this object owns task services and the resource lease only. */
export class ScenePostProcessGraph {
  sceneColorTexture!: FrameGraphTextureHandle;
  depthTexture!: FrameGraphTextureHandle;
  outputTexture!: FrameGraphTextureHandle;
  geometryTask: LogicalGeometryTask | null = null;
  readonly geometryTasks: FrameGraphTask[] = [];
  readonly postProcessTasks: AuthoredPostProcessTask[] = [];
  private readonly entries = new Map<string, AuthoredPostProcessTask>();
  private readonly handles: Array<{
    handle: FrameGraphTextureHandle;
    category: ManagedRenderCategory;
  }> = [];
  private committed: ManagedRenderResource[] | null = null;
  private initialized = false;
  private tasksDisposed = false;
  private retirement: Promise<void> | null = null;
  private taskRelease: Promise<void> | null = null;
  private released: Promise<void> | null = null;
  get estimatedBytes(): number {
    return this.recipe.estimatedBytes;
  }

  private readonly options: Options;
  private readonly recipe: Recipe;
  private readonly lease: ManagedRenderLease;

  constructor(options: Options, recipe: Recipe, lease: ManagedRenderLease) {
    this.options = options;
    this.recipe = recipe;
    this.lease = lease;
  }

  /** Factory initialization is separate so allocation failure still returns an
   * owner which the caller can clean before retiring its partial graph. */
  initialize(): void {
    if (this.initialized || this.tasksDisposed)
      throw new Error(
        "Post-process graph allocation is already initialized or disposed.",
      );
    this.initialized = true;
    const { frameGraph: graph, camera, width, height } = this.options;
    const createTexture = (
      name: string,
      format: number,
      type: number,
      category: ManagedRenderCategory,
    ) => {
      const handle = graph.textureManager.createRenderTargetTexture(name, {
        size: { width, height },
        sizeIsPercentage: false,
        options: {
          createMipMaps: false,
          types: [type],
          formats: [format],
          samples: 1,
          useSRGBBuffers: [false],
        },
      });
      this.handles.push({ handle, category });
      return handle;
    };
    // Authored pass targets inherit this creation's type/format; Scene
    // Linear keeps them half-float so HDR survives to the display stage.
    this.sceneColorTexture = createTexture(
      "Post-process Scene Color",
      Constants.TEXTUREFORMAT_RGBA,
      this.options.sceneColorType ?? Constants.TEXTURETYPE_UNSIGNED_BYTE,
      "sceneColor",
    );
    this.depthTexture = createTexture(
      "Post-process Scene Z",
      Constants.TEXTUREFORMAT_DEPTH32_FLOAT,
      Constants.TEXTURETYPE_FLOAT,
      "depth",
    );
    const logicalBuffers: {
      sceneDepth?: FrameGraphTextureHandle;
      sceneNormal?: FrameGraphTextureHandle;
    } = {};
    if (this.recipe.sceneDepth || this.recipe.sceneNormal) {
      const geometryDepth = createTexture(
        "Post-process Geometry Z",
        Constants.TEXTUREFORMAT_DEPTH32_FLOAT,
        Constants.TEXTURETYPE_FLOAT,
        "depth",
      );
      const clear = new FrameGraphClearTextureTask(
        "Post-process Geometry Z Clear",
        graph,
      );
      this.geometryTasks.push(clear);
      clear.depthTexture = geometryDepth;
      clear.clearColor = false;
      clear.clearDepth = true;
      clear.clearStencil = false;
      const geometry = new LogicalGeometryTask(
        "Post-process Shared Geometry",
        graph,
        graph.scene,
        { doNotChangeAspectRatio: false },
      );
      this.geometryTask = geometry;
      this.geometryTasks.push(geometry);
      geometry.camera = camera;
      geometry.objectList = { meshes: [], particleSystems: [] };
      geometry.depthTexture = clear.outputDepthTexture;
      geometry.size = { width, height };
      geometry.sizeIsPercentage = false;
      geometry.samples = 1;
      if (this.recipe.sceneDepth) {
        geometry.textureDescriptions.push({
          type: Constants.PREPASS_NORMALIZED_VIEW_DEPTH_TEXTURE_TYPE,
          textureType: this.recipe.depthType,
          textureFormat: Constants.TEXTUREFORMAT_RGBA,
        });
        logicalBuffers.sceneDepth = geometry.geometryNormViewDepthTexture;
        this.handles.push({
          handle: logicalBuffers.sceneDepth,
          category: "geometry",
        });
      }
      if (this.recipe.sceneNormal) {
        geometry.textureDescriptions.push({
          type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE,
          textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
          textureFormat: Constants.TEXTUREFORMAT_RGBA,
        });
        logicalBuffers.sceneNormal = geometry.geometryWorldNormalTexture;
        this.handles.push({
          handle: logicalBuffers.sceneNormal,
          category: "geometry",
        });
      }
    }
    let sourceTexture = this.sceneColorTexture;
    for (const { entry, document } of this.recipe.entries) {
      const task = new AuthoredPostProcessTask(
        `Scene Post Process ${entry.id}`,
        {
          frameGraph: graph,
          library: this.options.library,
          materialGuid: entry.materialGuid,
          document,
          enabled: true,
          parameters: entry.parameters,
          sourceTexture,
          sceneColorTexture: this.sceneColorTexture,
          logicalBuffers,
          resolutionScale: entry.scalable ? this.recipe.scale : 1,
          onDiagnostic: this.options.onDiagnostic,
        },
      );
      this.postProcessTasks.push(task);
      this.entries.set(entry.id!, task);
      sourceTexture = task.outputTexture;
      this.handles.push({ handle: sourceTexture, category: "postprocess" });
    }
    this.outputTexture = sourceTexture;
  }

  /** After successful build, before publishing/drawing the replacement graph. */
  reconcile(): void {
    if (this.tasksDisposed)
      throw new Error("Post-process graph owner is disposed.");
    const resources = this.handles.map(({ handle, category }) => {
      const texture: InternalTexture | null =
        this.options.frameGraph.textureManager.getTextureFromHandle(handle);
      if (!texture)
        throw new Error("Post-process graph target has not been allocated.");
      return managedRenderTextureResource(texture, category, {
        samples: 1,
        allocatedMipLevels: 1,
      });
    });
    if (this.committed) {
      if (
        resources.some(
          (resource, index) =>
            resource.handle !== this.committed![index]!.handle ||
            resource.bytes !== this.committed![index]!.bytes,
        )
      )
        throw new Error(
          "Post-process graph storage changed; a replacement owner is required.",
        );
      return;
    }
    this.lease.commit(resources);
    this.committed = resources;
  }
  setParameter(
    entryId: string,
    name: string,
    value: MaterialParameterValue,
  ): boolean {
    return (
      !this.tasksDisposed &&
      (this.entries.get(entryId)?.setParameter(name, value) ?? false)
    );
  }
  getParameter(entryId: string, name: string): MaterialParameterValue | null {
    return this.tasksDisposed
      ? null
      : (this.entries.get(entryId)?.getParameter(name) ?? null);
  }
  resetParameter(entryId: string, name: string): boolean {
    return (
      !this.tasksDisposed &&
      (this.entries.get(entryId)?.resetParameter(name) ?? false)
    );
  }
  disposeTasks(): void {
    if (this.tasksDisposed) return;
    const errors: unknown[] = [];
    for (const task of [...this.postProcessTasks, ...this.geometryTasks]) {
      try {
        task.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Post-process task disposal failed; resource lease retained.",
      );
    this.tasksDisposed = true;
    this.entries.clear();
  }
  /** Bounded CPU/native cleanup result. A rejection is not proof of release. */
  whenDisposed(): Promise<void> {
    if (!this.tasksDisposed)
      return Promise.reject(
        new Error(
          "Dispose post-process tasks before awaiting their retirement.",
        ),
      );
    this.retirement ??= Promise.all(
      this.postProcessTasks.map((task) => task.whenDisposed()),
    ).then(() => {});
    return this.retirement;
  }
  /** Confirmed CPU/native release, including cleanup after a reported deadline.
   * A paused Engine need not drain GPU work before the caller retires its host. */
  whenReleased(): Promise<void> {
    if (!this.tasksDisposed)
      return Promise.reject(
        new Error("Dispose post-process tasks before awaiting their release."),
      );
    this.taskRelease ??= Promise.all(
      this.postProcessTasks.map((task) => task.whenReleased()),
    ).then(() => {});
    return this.taskRelease;
  }
  /** Caller must dispose its FrameGraph after disposeTasks and before this call.
   * Uncertain graph cleanup must retain the lease by not calling this method. */
  releaseAfterGraphDisposal(): Promise<void> {
    if (!this.tasksDisposed)
      throw new Error(
        "Dispose post-process tasks before releasing their graph lease.",
      );
    this.released ??= this.whenReleased().then(() =>
      releaseManagedRenderLeaseAfterDisposal(
        this.options.frameGraph.scene.getEngine(),
        this.lease,
      ),
    );
    return this.released;
  }
}
