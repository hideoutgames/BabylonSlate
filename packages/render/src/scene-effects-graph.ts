import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { SpatialEffectsGraph } from "./spatial-effects-graph";
import { hasSpatialEffects, reserveSpatialEffects, spatialEffectsUnsupported } from "./spatial-effects";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { FrameGraphFXAATask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/fxaaTask";
import { FrameGraphFsr1SharpenTask, FrameGraphFsr1UpscaleTask } from "./fsr1-tasks";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import type { RenderEffectsSettings } from "@haptic/core";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { disposeKeepingLinkingEffects } from "./owned-effect-retirement";
import { FrameGraphBloomBlurTask } from "./bloom-blur-task";
import { FrameGraphDisplayColorTask } from "./display-color-task";
import type { FrameGraphSharedOutlineTask } from "./shared-outline-task";
import {
  sceneEffectsImageProcessingConfiguration,
  type SceneEffectsPlan,
} from "./scene-effects";

/** The Effects a chain task draws with: a post-process task's own, and those of the bloom blur's three stages. */
function chainTaskEffects(task: FrameGraphTask): Array<Effect | null> {
  if (task instanceof FrameGraphBloomBlurTask) return task.effects;
  return task instanceof FrameGraphPostProcessTask ? [task.drawWrapper.effect] : [];
}

export interface SceneEffectsGraphOptions {
  frameGraph: FrameGraph;
  plan: SceneEffectsPlan;
  effects: RenderEffectsSettings;
  camera?: Camera;
  /** Authored-stack output feeding the chain. Absent when the object
   * renderer draws this chain's own scene color instead. */
  authoredOutputTexture?: FrameGraphTextureHandle;
  /**
   * The view's shared outlines, drawn over the display image after image processing and before FXAA. Called once, with
   * whether the task's composition is external (`FrameGraphSharedOutlineTask.externalCompose`); the caller creates the
   * task in that mode with its camera set, and owns it: it disposes it with the enclosing graph. The chain sets its
   * `targetTexture`. One rule: when the chain has a Display Color pass, the stage right before the outlines, that pass
   * composites the stroke as its last stage and the task draws only the masks, before it (one full-screen pass fewer).
   * Otherwise the task blends in place onto the image the stage before it wrote; with no FXAA or FSR after it, that
   * stage writes the view's output when it can (`rendersToOutput`), so the outlines blend onto the output.
   */
  outlines?: (externalCompose: boolean) => FrameGraphSharedOutlineTask;
  /** Internal render size: the output size scaled by `plan.upscale`. */
  width: number;
  height: number;
  /** View output size the FSR 1 tail restores; defaults to the render size. */
  outputWidth?: number;
  outputHeight?: number;
  /** Samples per pixel of the own scene colour and depth (MSAA); 1 when omitted. */
  samples?: number;
  /**
   * A game's world view: a geometry pass that only feeds the view depth starts from the scene's depth
   * (`SpatialEffectsGraph.seeded`), the graph's own or, with an authored stack, that chain's (`authoredDepthTexture`).
   */
  geometryOverSceneDepth?: { authoredDepthTexture?: FrameGraphTextureHandle };
  /** The view's output colour. When the chain's last own stage is one of its post processes at the output size,
   * followed by nothing or only the outlines' in-place composition, that stage renders straight into it
   * (`rendersToOutput`), so the caller needs no output copy. */
  outputTarget?: FrameGraphTextureHandle;
}

/**
 * Settings-driven Display Color stage and display-space effects as FrameGraph
 * tasks: [authored stack output | own scene color] → spatial effects → bloom's
 * blurs → [outline masks] → Display Color (bloom's merge, then image processing,
 * then the outline stroke, in one pass) → [the outlines' own composition, without
 * a Display Color pass] → FXAA → FSR 1 upscale and sharpen → the view's output,
 * written by the last own stage itself when it can, else by the caller's single
 * output copy. Every stage before the upscale runs at the internal render size.
 * Tasks own their internal targets through graph disposal; this object owns the
 * optional scene-color declaration and waits for the Display Color effects a
 * configuration change replaced.
 */
export class SceneEffectsGraph {
  /** Declared only without an authored stack; the object renderer draws it. */
  readonly sceneColorTexture: FrameGraphTextureHandle | null = null;
  /** Declared together with the scene color; an offscreen scene color cannot
   * borrow the backbuffer depth. */
  readonly depthTexture: FrameGraphTextureHandle | null = null;
  /** The last chain output: the view's output when `rendersToOutput`, else the caller's output copy reads it. */
  readonly outputTexture: FrameGraphTextureHandle;
  /** An own stage renders into `outputTarget` (`outputWriter`): a full-screen copy fewer per frame. */
  readonly rendersToOutput: boolean = false;
  /** The stage that writes the view's output when `rendersToOutput`; the outlines' own composition may blend onto it after. */
  readonly outputWriter: FrameGraphPostProcessTask | undefined;
  readonly tasks: FrameGraphTask[] = [];
  readonly spatial?: SpatialEffectsGraph;
  private displayColor: FrameGraphDisplayColorTask | undefined;
  /** The outline task, when the chain draws the view's outlines; composed by the Display Color pass where there is one. */
  readonly outlines: FrameGraphSharedOutlineTask | undefined;
  private readonly externalTasks = new Set<FrameGraphTask>();
  private tasksDisposed = false;
  private disposed: Promise<void> | null = null;
  private released: Promise<void> | null = null;

  constructor(options: SceneEffectsGraphOptions) {
    const { frameGraph: graph, plan } = options;
    const samples = options.samples ?? 1;
    try {
      let source: FrameGraphTextureHandle;
      if (options.authoredOutputTexture !== undefined) {
        source = options.authoredOutputTexture;
      } else {
        // Linear HDR keeps float intermediates until the display stage;
        // Display Space and CEL keep the established byte pipeline.
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
                samples,
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
              samples,
              useSRGBBuffers: [false],
            },
          },
        );
        source = this.sceneColorTexture;
      }
      if (hasSpatialEffects(plan) && !spatialEffectsUnsupported(graph.scene)) {
        const camera = options.camera ?? graph.scene.activeCamera;
        if (!camera) throw new Error("Spatial effects require a camera.");
        const lease = reserveSpatialEffects(graph.scene, plan, options.width, options.height,
          this.sceneColorTexture !== null ? samples : 1);
        if (lease) {
          this.spatial = new SpatialEffectsGraph(graph, camera, plan, source, options.width, options.height, lease,
            this.sceneColorTexture !== null && this.depthTexture !== null ? [
              { handle: this.sceneColorTexture, category: "sceneColor", samples },
              { handle: this.depthTexture, category: "depth", samples },
            ] : [],
            options.geometryOverSceneDepth ? this.depthTexture ?? options.geometryOverSceneDepth.authoredDepthTexture : undefined);
          for (const task of this.spatial.tasks) {
            this.tasks.push(task);
            this.externalTasks.add(task);
          }
          source = this.spatial.output;
        } else {
          console.warn("Spatial effects disabled: shared Engine render-target budget is exhausted.");
        }
      }
      let bloom: FrameGraphBloomBlurTask | undefined;
      if (plan.bloom) {
        // `kernel` is relative to the source size; the task scales its targets and kernel through `scale` itself.
        bloom = new FrameGraphBloomBlurTask("Scene Effects Bloom", graph, {
          threshold: plan.bloom.threshold, kernel: plan.bloom.kernel, scale: plan.bloom.scale, hdr: plan.sceneLinear,
        });
        bloom.sourceTexture = source;
        this.tasks.push(bloom);
      }
      // The Display Color pass, where there is one, is the stage right before the outlines: it composites their stroke.
      const display = plan.bloom || plan.imageProcessing;
      if (display && options.outlines) {
        // The masks draw before the pass that reads them.
        this.outlines = options.outlines(true);
        this.tasks.push(this.outlines);
        this.externalTasks.add(this.outlines);
      }
      if (display) {
        // Bloom's merge and image processing in one full-size pass, which compiles once: no merge target between them.
        // Its target takes the source's type, single-sample over the multisampled scene colour. A dedicated image
        // processing configuration is required: the pass sets applyByPostProcess on it and resets it when disposed, so
        // the Scene's shared one must never be handed over. Without image processing (a Display Space plan's bloom) the
        // pass is bloom's merge alone.
        const stage = new FrameGraphDisplayColorTask(
          plan.imageProcessing ? "Scene Effects Display Color" : "Scene Effects Bloom Merge",
          graph,
          {
            bloom: plan.bloom ? { weight: plan.bloom.weight } : null,
            imageProcessing: plan.imageProcessing ? {
              configuration: sceneEffectsImageProcessingConfiguration(options.effects, plan.imageProcessing),
              fromLinearSpace: plan.imageProcessing.sceneLinear,
            } : null,
            outline: this.outlines !== undefined,
          },
        );
        stage.sourceTexture = source;
        stage.bloomTexture = bloom?.outputTexture;
        stage.outlines = this.outlines;
        this.displayColor = stage;
        this.tasks.push(stage);
        source = stage.outputTexture;
      }
      const outputWidth = options.outputWidth ?? options.width;
      const outputHeight = options.outputHeight ?? options.height;
      const fsr = plan.upscale && (outputWidth !== options.width || outputHeight !== options.height) ? plan.upscale : null;
      const outputSized = fsr !== null || (options.width === outputWidth && options.height === outputHeight);
      /**
       * Has the last stage so far render into the output when it is this chain's own post process drawing the output's
       * size: its output handle then resolves to the target. Returns that stage, or undefined when it cannot.
       */
      const intoOutput = (): FrameGraphPostProcessTask | undefined => {
        const stage = this.tasks.at(-1);
        if (options.outputTarget === undefined || !(stage instanceof FrameGraphPostProcessTask) ||
          this.externalTasks.has(stage) || !outputSized || stage.outputTexture !== source) return undefined;
        stage.targetTexture = options.outputTarget;
        // Babylon's post processes depth-test by default, which an intermediate target without depth never notices.
        // The backbuffer has depth, and another pass (a view drawn without a chain) may have left it there: the
        // stage must cover every pixel.
        stage.depthTest = false;
        return stage;
      };
      let writer: FrameGraphPostProcessTask | undefined;
      if (options.outlines && !this.outlines) {
        // The composition only blends onto the image before it and samples none of it (it reads its masks, styles and
        // mask depth), so with nothing after it that image may be the output itself.
        if (!plan.fxaa && !fsr) writer = intoOutput();
        const outlines = options.outlines(false);
        outlines.targetTexture = source;
        this.outlines = outlines;
        this.tasks.push(outlines);
        this.externalTasks.add(outlines);
        source = outlines.outputTexture;
      }
      if (plan.fxaa) {
        const fxaa = new FrameGraphFXAATask("Scene Effects FXAA", graph);
        fxaa.sourceTexture = source;
        this.tasks.push(fxaa);
        source = fxaa.outputTexture;
      }
      if (fsr) {
        // EASU expects display-referred input, so it follows the Display Color
        // stage and antialiasing; RCAS then sharpens at the output size.
        const upscaled = graph.textureManager.createRenderTargetTexture("Scene Effects FSR Upscale", {
          size: { width: outputWidth, height: outputHeight },
          sizeIsPercentage: false,
          options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
          },
        });
        const upscale = new FrameGraphFsr1UpscaleTask("Scene Effects FSR Upscale", graph);
        upscale.sourceTexture = source;
        upscale.targetTexture = upscaled;
        this.tasks.push(upscale);
        const sharpen = new FrameGraphFsr1SharpenTask("Scene Effects FSR Sharpen", graph);
        sharpen.sharpness = fsr.sharpness;
        sharpen.sourceTexture = upscale.outputTexture;
        this.tasks.push(sharpen);
        source = sharpen.outputTexture;
      }
      // Otherwise the last stage writes the output itself when it can. The spatial effects, the outlines' own composition
      // over a stage that could not, and a chain drawn at a scale of the output without FSR keep the copy.
      writer ??= intoOutput();
      // The masks are drawn at the size of the pass that composites their stroke: the target it was given (the
      // output) or else its own, which takes its source's size.
      if (this.outlines?.externalCompose) this.outlines.targetTexture = this.displayColor!.targetTexture ?? this.displayColor!.sourceTexture!;
      this.outputWriter = writer;
      this.rendersToOutput = writer !== undefined;
      this.outputTexture = source;
    } catch (error) {
      this.disposeTasks();
      throw error;
    }
  }

  /** The Display Color pass's current Effect; null without that pass. */
  get displayColorEffect(): Effect | null {
    return this.displayColor?.drawWrapper.effect ?? null;
  }

  /** The Display Color pass's compile failure, once one of its Effects fails (its outline stage's included). */
  get compileFailure(): string | undefined {
    return this.displayColor?.postProcess.compileFailure.message;
  }

  /** FrameGraph.clear() resets tasks without disposing them; callers do so. */
  disposeTasks(): void {
    if (this.tasksDisposed) return;
    const errors: unknown[] = [];
    try { this.spatial?.disposeTasks(); } catch (error) { errors.push(error); }
    for (const task of this.tasks.splice(0)) {
      if (this.externalTasks.has(task)) continue;
      try {
        disposeKeepingLinkingEffects(chainTaskEffects(task), () => task.dispose());
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
    const retirements = this.displayColor?.postProcess.retirements ?? [];
    this.disposed ??= Promise.all(
      [...retirements.map((retirement) => retirement.completion), this.spatial?.whenDisposed()],
    ).then(() => {});
    return this.disposed;
  }

  /** Confirmed CPU/native release after every Display Color effect a configuration change replaced. */
  whenReleased(): Promise<void> {
    if (!this.tasksDisposed)
      return Promise.reject(
        new Error(
          "Dispose scene effects tasks before awaiting their release.",
        ),
      );
    const retirements = this.displayColor?.postProcess.retirements ?? [];
    this.released ??= Promise.all(
      [...retirements.map((retirement) => retirement.released), this.spatial?.whenReleased()],
    ).then(() => {});
    return this.released;
  }
}
