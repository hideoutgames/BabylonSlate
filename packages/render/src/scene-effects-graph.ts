import { Constants, type Camera } from "@babylonjs/core";
import { SpatialEffectsGraph } from "./spatial-effects-graph";
import { reserveSpatialEffects, spatialEffectsUnsupported } from "./spatial-effects";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask";
import { FrameGraphFXAATask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/fxaaTask";
import { FrameGraphImageProcessingTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/imageProcessingTask";
import { ThinImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/thinImageProcessingPostProcess";
import type { RenderEffectsSettings } from "@babylonslate/core";
import {
  retireOwnedEffect,
  type OwnedEffectRetirement,
} from "./owned-effect-retirement";
import {
  sceneEffectsImageProcessingConfiguration,
  type SceneEffectsPlan,
} from "./scene-effects";

export interface SceneEffectsGraphOptions {
  frameGraph: FrameGraph;
  plan: SceneEffectsPlan;
  effects: RenderEffectsSettings;
  camera?: Camera;
  /** Authored-stack output feeding the chain. Absent when the object
   * renderer draws this chain's own scene color instead. */
  authoredOutputTexture?: FrameGraphTextureHandle;
  /** Caller-owned display-space composition, after tone mapping and before
   * FXAA. The caller retires the injected task with the enclosing graph. */
  beforeAntialiasing?: (source: FrameGraphTextureHandle) => {
    task: FrameGraphTask;
    outputTexture: FrameGraphTextureHandle;
  };
  width: number;
  height: number;
}

/**
 * Settings-driven Display Color stage and display-space effects as FrameGraph
 * tasks: [authored stack output | own scene color] → bloom → image
 * processing → FXAA → the caller's single output copy. Babylon tasks own
 * their internal targets through graph disposal; this object owns the
 * optional scene-color declaration and any image-processing compile
 * generation orphaned by the display-space recompile.
 */
export class SceneEffectsGraph {
  /** Declared only without an authored stack; the object renderer draws it. */
  readonly sceneColorTexture: FrameGraphTextureHandle | null = null;
  /** Declared together with the scene color; an offscreen scene color cannot
   * borrow the backbuffer depth. */
  readonly depthTexture: FrameGraphTextureHandle | null = null;
  /** The last chain output; the caller's output copy is its only consumer. */
  readonly outputTexture: FrameGraphTextureHandle;
  readonly tasks: FrameGraphTask[] = [];
  readonly spatial?: SpatialEffectsGraph;
  private readonly retirements: OwnedEffectRetirement[] = [];
  private readonly externalTasks = new Set<FrameGraphTask>();
  private tasksDisposed = false;
  private disposed: Promise<void> | null = null;
  private released: Promise<void> | null = null;

  constructor(options: SceneEffectsGraphOptions) {
    const { frameGraph: graph, plan } = options;
    try {
      let source: FrameGraphTextureHandle;
      if (options.authoredOutputTexture !== undefined) {
        source = options.authoredOutputTexture;
      } else {
        // Linear HDR keeps float intermediates until the display stage;
        // Legacy Display and CEL keep the established byte pipeline.
        this.sceneColorTexture =
          graph.textureManager.createRenderTargetTexture(
            "Scene Effects Scene Color",
            {
              size: { width: options.width, height: options.height },
              sizeIsPercentage: false,
              options: {
                createMipMaps: false,
                types: [
                  plan.sceneLinear
                    ? Constants.TEXTURETYPE_HALF_FLOAT
                    : Constants.TEXTURETYPE_UNSIGNED_BYTE,
                ],
                formats: [Constants.TEXTUREFORMAT_RGBA],
                samples: 1,
                useSRGBBuffers: [false],
              },
            },
          );
        this.depthTexture = graph.textureManager.createRenderTargetTexture(
          "Scene Effects Scene Z",
          {
            size: { width: options.width, height: options.height },
            sizeIsPercentage: false,
            options: {
              createMipMaps: false,
              types: [Constants.TEXTURETYPE_FLOAT],
              formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
              samples: 1,
              useSRGBBuffers: [false],
            },
          },
        );
        source = this.sceneColorTexture;
      }
      if ((plan.reflections || plan.volumetricLighting) && !spatialEffectsUnsupported(graph.scene)) {
        const camera = options.camera ?? graph.scene.activeCamera;
        if (!camera) throw new Error("Spatial effects require a camera.");
        const lease = reserveSpatialEffects(graph.scene, plan, options.width, options.height, false);
        if (lease) {
          this.spatial = new SpatialEffectsGraph(graph, camera, plan, source, options.width, options.height, lease,
            this.sceneColorTexture !== null && this.depthTexture !== null ? [
              { handle: this.sceneColorTexture, category: "sceneColor" },
              { handle: this.depthTexture, category: "depth" },
            ] : []);
          for (const task of this.spatial.tasks) {
            this.tasks.push(task);
            this.externalTasks.add(task);
          }
          source = this.spatial.output;
        } else {
          console.warn("Spatial effects disabled: shared Engine render-target budget is exhausted.");
        }
      }
      if (plan.bloom) {
        // `kernel` is relative to final output size on both paths; the task
        // scales its internal targets through `bloom.scale` itself.
        const bloom = new FrameGraphBloomTask(
          "Scene Effects Bloom",
          graph,
          plan.bloom.weight,
          plan.bloom.kernel,
          plan.bloom.threshold,
          plan.sceneLinear,
          plan.bloom.scale,
        );
        bloom.sourceTexture = source;
        this.tasks.push(bloom);
        source = bloom.outputTexture;
      }
      if (plan.imageProcessing) {
        // A dedicated configuration is required: the thin pass sets
        // applyByPostProcess on whatever configuration it receives, so the
        // Scene's shared one must never be handed over.
        const thin = new ThinImageProcessingPostProcess(
          "Scene Effects Display Color",
          graph.engine,
          {
            imageProcessingConfiguration:
              sceneEffectsImageProcessingConfiguration(
                options.effects,
                plan.imageProcessing,
              ),
          },
        );
        // The constructor compiles its linear default first; switching a
        // display-space plan recompiles and orphans the first Effect, whose
        // program must settle before release.
        const previous = thin.effect;
        thin.fromLinearSpace = plan.imageProcessing.sceneLinear;
        const current = thin.effect;
        if (previous && previous !== current) {
          this.retirements.push(
            retireOwnedEffect(previous, () => previous.dispose()),
          );
        }
        const image = new FrameGraphImageProcessingTask(
          "Scene Effects Display Color",
          graph,
          thin,
        );
        image.sourceTexture = source;
        this.tasks.push(image);
        source = image.outputTexture;
      }
      if (options.beforeAntialiasing) {
        const composition = options.beforeAntialiasing(source);
        this.tasks.push(composition.task);
        this.externalTasks.add(composition.task);
        source = composition.outputTexture;
      }
      if (plan.fxaa) {
        const fxaa = new FrameGraphFXAATask("Scene Effects FXAA", graph);
        fxaa.sourceTexture = source;
        this.tasks.push(fxaa);
        source = fxaa.outputTexture;
      }
      this.outputTexture = source;
    } catch (error) {
      this.disposeTasks();
      throw error;
    }
  }

  /** FrameGraph.clear() resets tasks without disposing them; callers do so. */
  disposeTasks(): void {
    if (this.tasksDisposed) return;
    const errors: unknown[] = [];
    try { this.spatial?.disposeTasks(); } catch (error) { errors.push(error); }
    for (const task of this.tasks.splice(0)) {
      if (this.externalTasks.has(task)) continue;
      try {
        task.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.externalTasks.clear();
    this.tasksDisposed = true;
    if (errors.length)
      throw new AggregateError(
        errors,
        "Scene effects task disposal failed.",
      );
  }

  /** Bounded CPU/native cleanup result; a rejection is not proof of release. */
  whenDisposed(): Promise<void> {
    if (!this.tasksDisposed)
      return Promise.reject(
        new Error(
          "Dispose scene effects tasks before awaiting their retirement.",
        ),
      );
    this.disposed ??= Promise.all(
      [...this.retirements.map((retirement) => retirement.completion), this.spatial?.whenDisposed()],
    ).then(() => {});
    return this.disposed;
  }

  /** Confirmed CPU/native release after every orphaned compile generation. */
  whenReleased(): Promise<void> {
    if (!this.tasksDisposed)
      return Promise.reject(
        new Error(
          "Dispose scene effects tasks before awaiting their release.",
        ),
      );
    this.released ??= Promise.all(
      [...this.retirements.map((retirement) => retirement.released), this.spatial?.whenReleased()],
    ).then(() => {});
    return this.released;
  }
}
