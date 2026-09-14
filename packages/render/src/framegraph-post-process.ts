import type { Camera, Effect, NodeMaterial, Observer } from "@babylonjs/core";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import { normalizeMaterialParameterOverrides } from "@babylonslate/core";
import type {
  MaterialBuildPlan,
  MaterialDiagnostic,
  MaterialDocument,
} from "@babylonslate/shader-graph";
import { materialUnavailable, type MaterialLibrary } from "./material-library";
import { nodeMaterialTexturesSampleReady } from "./material-compiler";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import { LOGICAL_SCENE_SAMPLERS, type LogicalSceneBuffer } from "./logical-scene-texture-block";
import type {
  PostProcessStackDiagnostic,
  PostProcessStackEntry,
} from "./post-process-material";

const guardedEffects = new WeakSet<Effect>();

function guardDisposedEffectPolling(effect: Effect): void {
  if (guardedEffects.has(effect)) return;
  // Pinned Babylon 9.20: _checkIsReady probes _isReadyInternal BEFORE checking
  // _isDisposed. EffectWrapper.dispose(true) can already have deleted the GPU
  // program. Keep its native retry exit, receiver, result and live errors; only
  // the disposed owner's probe must avoid touching that deleted pipeline.
  const owned = effect as unknown as { _isReadyInternal(): boolean };
  const ready = owned._isReadyInternal;
  owned._isReadyInternal = function (this: Effect) {
    return this.isDisposed ? false : ready.call(this);
  };
  guardedEffects.add(effect);
}

/** Babylon 9.20's public PostProcess binding protocol, without activate()/RTTs. */
class GraphBoundPostProcess extends PostProcess {
  private disposed = false;
  private readonly shaderSources = new Map<string, string>();
  private retirement: OwnedEffectRetirement | null = null;

  get isReleased(): boolean { return this.retirement?.isReleased() ?? false; }
  whenDisposed(): Promise<void> { return this.retirement!.completion; }
  whenReleased(): Promise<void> { return this.retirement!.released; }

  get drawWrapper() {
    return this._effectWrapper.drawWrapper;
  }

  override updateEffect(
    ...args: Parameters<PostProcess["updateEffect"]>
  ): void {
    // NodeMaterial can enqueue updateEffect from its apply-time defines update.
    if (this.disposed) return;
    // createEffectForPostProcess registers these explicit names before calling
    // updateEffect. Each task has its own NodeMaterial/build id, so it owns them.
    // Babylon's camera-less PP and NodeMaterial disposal leave these strings.
    for (const [name, suffix] of [
      [args[6], "VertexShader"],
      [args[7], "PixelShader"],
    ]) {
      if (!name) continue;
      const key = name + suffix;
      const source = ShaderStore.GetShadersStore(this.shaderLanguage)[key];
      if (typeof source === "string") this.shaderSources.set(key, source);
    }
    super.updateEffect(...args);
    guardDisposedEffectPolling(this.getEffect());
  }

  override dispose(camera?: Camera): void {
    if (this.disposed) return;
    this.disposed = true;
    // These passes are camera-less. Engine.dispose drains this public list by
    // repeatedly disposing its first entry, so logical retirement must remove
    // the entry even while its Effect still waits for native compilation.
    const registered = this.getEngine().postProcesses;
    const index = registered.indexOf(this);
    if (index !== -1) registered.splice(index, 1);
    // Babylon returns early from camera-less disposal before clearing these.
    this.onApplyObservable.clear();
    this.onBeforeRenderObservable.clear();
    this.onAfterRenderObservable.clear();
    this.onActivateObservable.clear();
    this.onSizeChangedObservable.clear();
    this.onEffectCreatedObservable.clear();
    this.onDisposeObservable.clear();
    this.retirement = retireOwnedEffect(this.getEffect() ?? null, () => {
      super.dispose(camera);
      const store = ShaderStore.GetShadersStore(this.shaderLanguage);
      for (const [key, source] of this.shaderSources) {
        if (store[key] === source) delete store[key];
      }
      this.shaderSources.clear();
    });
  }
}

interface AuthoredPostProcessOptions {
  /** Caller-owned normalized view depth and encoded world normal, shared across entries. */
  logicalBuffers?: Partial<Record<LogicalSceneBuffer, FrameGraphTextureHandle>>;
  frameGraph: FrameGraph;
  library: MaterialLibrary;
  materialGuid: string;
  document: MaterialDocument | null;
  enabled?: boolean;
  parameters?: Record<string, MaterialParameterValue>;
  sourceTexture: FrameGraphTextureHandle;
  /** Unscaled scene color determines pass resolution, independent of order. */
  sceneColorTexture: FrameGraphTextureHandle;
  resolutionScale?: number;
  onDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
}

let nextInstance = 0;

/**
 * Opt-in adapter proof. It does not attach a camera pass or select a renderer.
 * The task owns its material instance; the graph owns all output textures.
 */
export class AuthoredPostProcessTask extends FrameGraphTask {
  readonly outputTexture: FrameGraphTextureHandle;
  private readonly instanceKey = `framegraph-post-process:${nextInstance++}`;
  private postProcess: GraphBoundPostProcess | null = null;
  private material: NodeMaterial | null = null;
  private buildObserver: Observer<NodeMaterial> | null = null;
  private acquired = false;
  private disposed = false;
  private failed = false;
  private generation = 0;
  private pending: Promise<void>;
  private document: MaterialDocument | null;
  private readonly options: AuthoredPostProcessOptions;
  private readonly parameters = new Map<string, MaterialParameterValue>();
  private readonly authoredParameters: Record<string, MaterialParameterValue>;
  private readonly requiredBuffers = new Set<LogicalSceneBuffer>();
  private readonly ownedPasses = new Set<GraphBoundPostProcess>();
  private readonly pendingWork = new Set<Promise<void>>();
  private readonly cleanupErrors: unknown[] = [];
  private resolveDisposal!: () => void;
  private rejectDisposal!: (error: unknown) => void;
  private readonly disposal = new Promise<void>((resolve, reject) => {
    this.resolveDisposal = resolve;
    this.rejectDisposal = reject;
  });
  private get acquireOptions() { return { instanceKey: `${this.instanceKey}:${this.generation}`, logicalSceneBuffers: true }; }

  constructor(name: string, options: AuthoredPostProcessOptions) {
    super(name, options.frameGraph);
    void this.disposal.catch(() => {});
    this.options = { ...options,
      logicalBuffers: options.logicalBuffers ? { ...options.logicalBuffers } : undefined };
    this.document = options.document;
    super.disabled = options.enabled === false;
    this.outputTexture =
      options.frameGraph.textureManager.createDanglingHandle();
    this.authoredParameters = normalizeMaterialParameterOverrides(options.parameters);
    for (const [name, value] of Object.entries(this.authoredParameters))
      this.parameters.set(name, value);
    this.pending = this.replaceDocument(options.document);
  }

  override initAsync(): Promise<void> {
    return this.pending;
  }

  override get disabled(): boolean {
    return super.disabled;
  }

  override set disabled(value: boolean) {
    if (value === super.disabled) return;
    super.disabled = value;
    if (this.disposed) return;
    // Disabling detaches this generation. Pending native Effects retire safely.
    // A re-enabled pass compiles again with its replayable authored overrides.
    this.pending = this.replaceDocument(this.document);
  }

  /** Replace a graph/function revision without changing logical output handles. */
  replaceDocument(document: MaterialDocument | null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.document = document;
    this.releaseMaterial();
    const generation = ++this.generation;
    this.failed = false;
    this.pending = this.disabled
      ? Promise.resolve()
      : this.prepare(document, generation);
    this.trackCleanup(this.pending);
    return this.pending;
  }

  setParameter(name: string, value: MaterialParameterValue): boolean {
    if (
      this.disposed ||
      !this.document ||
      !this.options.library.acceptsParameter(this.document, name, value)
    )
      return false;
    if (
      this.acquired &&
      !this.options.library.setParameter(
        this._frameGraph.scene,
        this.options.materialGuid,
        name,
        value,
        this.acquireOptions,
      )
    )
      return false;
    this.parameters.set(name, value.kind === "color" ? { kind: "color", value: [...value.value] } : { ...value });
    return true;
  }

  getParameter(name: string): MaterialParameterValue | null {
    if (this.disposed) return null;
    if (this.acquired) return this.options.library.getParameter(
      this._frameGraph.scene, this.options.materialGuid, name, this.acquireOptions,
    );
    const value = this.parameters.get(name);
    return value ? value.kind === "color" ? { kind: "color", value: [...value.value] } : { ...value } : null;
  }

  resetParameter(name: string): boolean {
    if (this.disposed || !this.document?.nodes.some((node) =>
      /^(param.float|param.color|param.texture)$/.test(node.type) &&
      typeof node.properties.name === "string" && node.properties.name.trim() === name)) return false;
    const authored = this.authoredParameters[name];
    if (authored && this.setParameter(name, authored)) return true;
    if (this.acquired && !this.options.library.resetParameter(
      this._frameGraph.scene, this.options.materialGuid, name, this.acquireOptions,
    )) return false;
    this.parameters.delete(name);
    return true;
  }

  override isReady(): boolean {
    if (this.disposed || this.disabled || this.failed) return true;
    for (const block of this.material?.getTextureBlocks() ?? []) {
      if (block.texture?.loadingError) {
        this.fail(
          `Post-process texture "${block.texture.name}" failed to load`,
        );
        return true;
      }
    }
    const effect = this.postProcess?.getEffect();
    const error = effect?.getCompilationError();
    if (error) {
      this.fail(error);
      return true;
    }
    return Boolean(
      this.material &&
      this.postProcess?.isReady() &&
      nodeMaterialTexturesSampleReady(this.material),
    );
  }

  override record(skipCreationOfDisabledPasses = false): void {
    const manager = this._frameGraph.textureManager;
    const creation = manager.getTextureCreationOptions(
      this.options.sceneColorTexture,
    );
    const size = manager.getTextureAbsoluteDimensions(creation);
    const scale = Math.min(1, Math.max(0.1, this.options.resolutionScale ?? 1));
    creation.size = {
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    };
    creation.sizeIsPercentage = false;
    creation.options.samples = 1;
    manager.resolveDanglingHandle(
      this.outputTexture,
      undefined,
      this.name,
      creation,
    );
    const pass = this._frameGraph.addRenderPass(this.name);
    pass.addDependencies(this.options.sourceTexture);
    // The supplied set is stable for this task's lifetime. A hot replacement
    // or re-enabled entry may start reading any of these already-owned handles
    // without rebuilding the graph, so retain them before native aliasing runs.
    for (const handle of Object.values(this.options.logicalBuffers ?? {}))
      if (handle !== undefined) pass.addDependencies(handle);
    pass.setRenderTarget(this.outputTexture);
    pass.setExecuteFunc((context) => this.executePostProcess(context));
    if (!skipCreationOfDisabledPasses) {
      const disabled = this._frameGraph.addRenderPass(
        `${this.name}_disabled`,
        true,
      );
      disabled.addDependencies(this.options.sourceTexture);
      disabled.setRenderTarget(this.outputTexture);
      disabled.setExecuteFunc((context) =>
        context.copyTexture(this.options.sourceTexture),
      );
    }
  }

  private executePostProcess(context: FrameGraphRenderContext): void {
    const postProcess = this.postProcess;
    if (!this.isReady() || this.failed || !postProcess) {
      context.copyTexture(this.options.sourceTexture);
      return;
    }
    const size = this._frameGraph.textureManager.getTextureDescription(
      this.outputTexture,
    ).size;
    postProcess.width = size.width;
    postProcess.height = size.height;
    let bindingError: unknown;
    let bindingFailed = false;
    const applied = context.applyFullScreenEffect(
      postProcess.drawWrapper,
      () => {
        // Babylon's full-screen helper restores Engine state after this callback,
        // but not when it throws. Catch here, then overwrite this output below.
        try {
          const effect = postProcess.apply();
          if (!effect)
            throw new Error("Post-process effect became unavailable");
          context.bindTextureHandle(
            effect,
            "textureSampler",
            this.options.sourceTexture,
          );
          for (const resource of this.requiredBuffers)
            context.bindTextureHandle(effect, LOGICAL_SCENE_SAMPLERS[resource], this.options.logicalBuffers![resource]!);
        } catch (error) {
          bindingFailed = true;
          bindingError = error;
        }
      },
    );
    if (bindingFailed) this.fail(String(bindingError));
    if (!applied || this.failed)
      context.copyTexture(this.options.sourceTexture);
  }

  private async prepare(
    document: MaterialDocument | null,
    generation: number,
  ): Promise<void> {
    if (!document || document.domain !== "postProcess") {
      this.fail(
        document
          ? "Material is not a Post Process material"
          : "Post-process material is missing",
      );
      return;
    }
    try {
      const compiled = this.options.library.acquire(
        this._frameGraph.scene,
        this.options.materialGuid,
        document,
        {
          ...this.acquireOptions,
          validatePlan: (plan) => unsupportedLogicalBuffers(plan, this.options.logicalBuffers),
        },
      );
      if (materialUnavailable(compiled)) {
        this.fail(
          compiled.diagnostics[0]?.message ?? "Material compilation failed",
          compiled.diagnostics[0],
        );
        return;
      }
      this.acquired = true;
      for (const resource of ["sceneDepth", "sceneNormal"] as const)
        if (compiled.plan.bufferRequirements[resource]) this.requiredBuffers.add(resource);
      this.material = compiled.material;
      const diagnostics = await compiled.ready;
      if (this.disposed || this.generation !== generation) return;
      if (diagnostics.length) {
        this.fail(diagnostics[0]!.message, diagnostics[0]);
        return;
      }
      for (const [name, value] of this.parameters) {
        if (!this.setParameter(name, value))
          this.options.onDiagnostic?.({ materialGuid: this.options.materialGuid, code: "material.parameter",
            message: `Post-process parameter "${name}" is unavailable or has an incompatible value` });
      }
      this.createPostProcess(compiled.material);
      this.buildObserver = compiled.material.onBuildObservable.add(() => {
        if (!this.disposed && this.generation === generation)
          this.createPostProcess(compiled.material);
      });
    } catch (error) {
      if (!this.disposed && this.generation === generation)
        this.fail(String(error));
    }
  }

  private createPostProcess(material: NodeMaterial): void {
    this.failed = false;
    this.postProcess?.dispose();
    this.postProcess = new GraphBoundPostProcess(this.name, "", {
      engine: this._frameGraph.engine,
      blockCompilation: true,
      shaderLanguage: material.shaderLanguage,
    });
    this.postProcess.externalTextureSamplerBinding = true;
    this.ownedPasses.add(this.postProcess);
    material.createEffectForPostProcess(this.postProcess);
  }

  private fail(message: string, diagnostic?: MaterialDiagnostic): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.options.onDiagnostic?.({
      message,
      code: diagnostic?.code ?? "material.framegraph",
      nodeId: diagnostic?.nodeId,
      materialGuid: this.options.materialGuid,
    });
  }

  private releaseMaterial(): void {
    this.requiredBuffers.clear();
    if (this.buildObserver)
      this.material?.onBuildObservable.remove(this.buildObserver);
    this.buildObserver = null;
    this.postProcess?.dispose();
    this.postProcess = null;
    this.material = null;
    const passes = [...this.ownedPasses];
    this.ownedPasses.clear();
    if (this.acquired) {
      this.acquired = false;
      // A replacement uses a distinct library key: a late old release must not
      // decrement the replacement or let library publication dispose this owner.
      const acquireOptions = this.acquireOptions;
      const release = () => this.options.library.release(
        this._frameGraph.scene,
        this.options.materialGuid,
        acquireOptions,
      );
      let released: Promise<void>;
      if (passes.every((pass) => pass.isReleased)) {
        try { release(); released = Promise.resolve(); }
        catch (error) { released = Promise.reject(error); }
      } else {
        released = Promise.all(passes.map((pass) => pass.whenReleased())).then(release);
      }
      // Even if a deadline reports uncertain cleanup, retain the library owner
      // until actual release. Do not leave its later failure unobserved.
      void released.catch(() => {});
      const cleanup = Promise.all(passes.map((pass) => pass.whenDisposed())).then(() => released);
      void cleanup.catch(() => {});
      this.trackCleanup(cleanup);
    }
  }

  private trackCleanup(work: Promise<void>): void {
    this.pendingWork.add(work);
    void work.then(
      () => { this.pendingWork.delete(work); },
      (error) => { this.pendingWork.delete(work); this.cleanupErrors.push(error); },
    );
  }

  /** CPU/native ownership only; a managed GPU lease drains separately afterward. */
  whenDisposed(): Promise<void> { return this.disposal; }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.releaseMaterial(); } catch (error) { this.cleanupErrors.push(error); }
    this.generation++;
    try { super.dispose(); } catch (error) { this.cleanupErrors.push(error); }
    void Promise.allSettled(this.pendingWork).then(() => {
      if (this.cleanupErrors.length) this.rejectDisposal(new AggregateError(this.cleanupErrors, "Authored post-process cleanup failed"));
      else this.resolveDisposal();
    });
  }
}

function unsupportedLogicalBuffers(
  plan: MaterialBuildPlan,
  buffers?: AuthoredPostProcessOptions["logicalBuffers"],
): MaterialDiagnostic | undefined {
  const resource = plan.bufferRequirements.sceneDepth && buffers?.sceneDepth === undefined
    ? "sceneDepth"
    : plan.bufferRequirements.sceneNormal && buffers?.sceneNormal === undefined
      ? "sceneNormal"
      : null;
  if (!resource) return undefined;
  return {
    severity: "error",
    code: "material.framegraph.buffer",
    message: `The authored FrameGraph adapter requires a shared ${resource === "sceneDepth" ? "Scene Depth" : "Scene Normal"} buffer`,
    nodeId: plan.operations.find(
      (operation) => operation.nodeType === `input.${resource}`,
    )?.id,
  };
}

export function addAuthoredPostProcessTasks(options: {
  logicalBuffers?: AuthoredPostProcessOptions["logicalBuffers"];
  frameGraph: FrameGraph;
  library: MaterialLibrary;
  sourceTexture: FrameGraphTextureHandle;
  stack: readonly PostProcessStackEntry[];
  documentFor: (guid: string) => MaterialDocument | null;
  resolutionScale?: number;
  onDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
}): {
  tasks: AuthoredPostProcessTask[];
  outputTexture: FrameGraphTextureHandle;
  dispose: () => void;
  whenDisposed: () => Promise<void>;
} {
  const tasks: AuthoredPostProcessTask[] = [];
  let sourceTexture = options.sourceTexture;
  for (const entry of [...options.stack].sort((a, b) => a.order - b.order)) {
    const task = new AuthoredPostProcessTask(
      `Authored Post Process ${tasks.length}`,
      {
        ...options,
        materialGuid: entry.materialGuid,
        document: options.documentFor(entry.materialGuid),
        enabled: entry.enabled,
        parameters: entry.parameters,
        sourceTexture,
        sceneColorTexture: options.sourceTexture,
        resolutionScale: entry.scalable ? options.resolutionScale : 1,
      },
    );
    options.frameGraph.addTask(task);
    tasks.push(task);
    sourceTexture = task.outputTexture;
  }
  // FrameGraph.clear()/dispose() reset tasks without disposing them. The stack
  // owner releases these references before retiring or clearing its graph.
  return {
    tasks,
    outputTexture: sourceTexture,
    dispose: () => {
      for (const task of tasks) task.dispose();
    },
    whenDisposed: () => Promise.all(tasks.map((task) => task.whenDisposed())).then(() => {}),
  };
}
