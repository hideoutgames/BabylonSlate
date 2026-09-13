import type { Camera, NodeMaterial, Observer } from "@babylonjs/core";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import type {
  MaterialBuildPlan,
  MaterialDiagnostic,
  MaterialDocument,
} from "@babylonslate/shader-graph";
import { materialUnavailable, type MaterialLibrary } from "./material-library";
import { nodeMaterialTexturesSampleReady } from "./material-compiler";
import type {
  PostProcessStackDiagnostic,
  PostProcessStackEntry,
} from "./post-process-material";

/** Babylon 9.20's public PostProcess binding protocol, without activate()/RTTs. */
class GraphBoundPostProcess extends PostProcess {
  private disposed = false;

  get drawWrapper() {
    return this._effectWrapper.drawWrapper;
  }

  override updateEffect(
    ...args: Parameters<PostProcess["updateEffect"]>
  ): void {
    // NodeMaterial can enqueue updateEffect from its apply-time defines update.
    if (!this.disposed) super.updateEffect(...args);
  }

  override dispose(camera?: Camera): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose(camera);
    // Babylon returns early from camera-less disposal before clearing these.
    this.onApplyObservable.clear();
    this.onBeforeRenderObservable.clear();
    this.onAfterRenderObservable.clear();
    this.onActivateObservable.clear();
    this.onSizeChangedObservable.clear();
    this.onEffectCreatedObservable.clear();
    this.onDisposeObservable.clear();
  }
}

interface AuthoredPostProcessOptions {
  frameGraph: FrameGraph;
  library: MaterialLibrary;
  materialGuid: string;
  document: MaterialDocument | null;
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
  private readonly parameters = new Map<string, MaterialParameterValue>();

  constructor(
    name: string,
    private readonly options: AuthoredPostProcessOptions,
  ) {
    super(name, options.frameGraph);
    this.outputTexture =
      options.frameGraph.textureManager.createDanglingHandle();
    this.pending = this.replaceDocument(options.document);
  }

  override initAsync(): Promise<void> {
    return this.pending;
  }

  /** Replace a graph/function revision without changing logical output handles. */
  replaceDocument(document: MaterialDocument | null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = ++this.generation;
    this.releaseMaterial();
    this.failed = false;
    this.pending = this.prepare(document, generation);
    return this.pending;
  }

  setParameter(name: string, value: MaterialParameterValue): boolean {
    if (
      this.disposed ||
      !this.options.library.setParameter(
        this._frameGraph.scene,
        this.options.materialGuid,
        name,
        value,
        { instanceKey: this.instanceKey },
      )
    )
      return false;
    this.parameters.set(name, value);
    return true;
  }

  override isReady(): boolean {
    if (this.disposed || this.disabled || this.failed) return true;
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
        } catch (error) {
          bindingError = error;
        }
      },
    );
    if (bindingError !== undefined) this.fail(String(bindingError));
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
    if (this._frameGraph.engine.isWebGPU) {
      this.fail(
        "The authored FrameGraph adapter currently requires the GLSL WebGL backend",
      );
      return;
    }
    try {
      const compiled = this.options.library.acquire(
        this._frameGraph.scene,
        this.options.materialGuid,
        document,
        {
          instanceKey: this.instanceKey,
          validatePlan: unsupportedLogicalBuffers,
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
      this.material = compiled.material;
      const diagnostics = await compiled.ready;
      if (this.disposed || this.generation !== generation) return;
      if (diagnostics.length) {
        this.fail(diagnostics[0]!.message, diagnostics[0]);
        return;
      }
      for (const [name, value] of this.parameters)
        this.setParameter(name, value);
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
    this.postProcess?.dispose();
    this.postProcess = new GraphBoundPostProcess(this.name, "", {
      engine: this._frameGraph.engine,
      blockCompilation: true,
      shaderLanguage: ShaderLanguage.GLSL,
    });
    this.postProcess.externalTextureSamplerBinding = true;
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
    if (this.buildObserver)
      this.material?.onBuildObservable.remove(this.buildObserver);
    this.buildObserver = null;
    this.postProcess?.dispose();
    this.postProcess = null;
    this.material = null;
    if (this.acquired) {
      this.acquired = false;
      this.options.library.release(
        this._frameGraph.scene,
        this.options.materialGuid,
        { instanceKey: this.instanceKey },
      );
    }
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.releaseMaterial();
    super.dispose();
  }
}

function unsupportedLogicalBuffers(
  plan: MaterialBuildPlan,
): MaterialDiagnostic | undefined {
  const resource = plan.bufferRequirements.sceneDepth
    ? "sceneDepth"
    : plan.bufferRequirements.sceneNormal
      ? "sceneNormal"
      : null;
  if (!resource) return undefined;
  return {
    severity: "error",
    code: "material.framegraph.buffer",
    message: `The authored FrameGraph adapter has no logical ${resource === "sceneDepth" ? "Scene Depth" : "Scene Normal"} injection yet`,
    nodeId: plan.operations.find(
      (operation) => operation.nodeType === `input.${resource}`,
    )?.id,
  };
}

export function addAuthoredPostProcessTasks(options: {
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
        sourceTexture,
        sceneColorTexture: options.sourceTexture,
        resolutionScale: entry.scalable ? options.resolutionScale : 1,
      },
    );
    task.disabled = !entry.enabled;
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
  };
}
