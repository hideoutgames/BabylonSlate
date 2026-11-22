import { Constants } from "@babylonjs/core/Engines/constants";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraphTextureCreationOptions, FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphBlurTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/blurTask";
import { FrameGraphExtractHighlightsTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/extractHighlightsTask";
import { ThinBlurPostProcess } from "@babylonjs/core/PostProcesses/thinBlurPostProcess";
import { ThinExtractHighlightsPostProcess } from "@babylonjs/core/PostProcesses/thinExtractHighlightsPostProcess";
import { postProcessCover, type FullTargetTask } from "./full-target-clear";

export interface BloomBlurSettings {
  /** Luminance below which a pixel adds no bloom. */
  threshold: number;
  /** Blur kernel relative to the source size; the blurs run at `kernel · scale` texels of their own targets. */
  kernel: number;
  /** The blur targets' size as a fraction of the source's. */
  scale: number;
  /** Linear HDR input: the blur targets are half-float (float, then bytes, where the device cannot render those). */
  hdr: boolean;
}

/**
 * Bloom's highlights, blurred: the downscale (highlight extraction), blur X and blur Y stages of Babylon's
 * `FrameGraphBloomTask`, with its thin post processes, parameters and targets (`bloom.scale` of the source's size, of
 * one texture type for all three), but without its merge. `outputTexture` holds the blurred highlights for the stage that
 * adds them to the image (`FrameGraphDisplayColorTask`), so the merge needs no full-size pass and target of its own.
 *
 * Each blur compiles once, at its final kernel: constructed at it rather than at Babylon's default kernel first.
 */
export class FrameGraphBloomBlurTask extends FrameGraphTask implements FullTargetTask {
  sourceTexture: FrameGraphTextureHandle | undefined;
  /** The blur Y target: the blurred highlights at `scale` of the source's size. */
  readonly outputTexture: FrameGraphTextureHandle;
  readonly scale: number;
  private readonly downscale: FrameGraphExtractHighlightsTask;
  private readonly blurX: FrameGraphBlurTask;
  private readonly blurY: FrameGraphBlurTask;
  private readonly textureType: number;

  constructor(name: string, frameGraph: FrameGraph, settings: BloomBlurSettings) {
    super(name, frameGraph);
    const engine = frameGraph.engine;
    this.scale = settings.scale;
    // Babylon's bloom task's choice of its pipeline texture type.
    const caps = engine.getCaps();
    this.textureType = !settings.hdr ? Constants.TEXTURETYPE_UNSIGNED_BYTE
      : caps.textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT
        : caps.textureFloatRender ? Constants.TEXTURETYPE_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    const extract = new ThinExtractHighlightsPostProcess(`${name}_downscale`, engine);
    extract.threshold = settings.threshold;
    const kernel = settings.kernel * settings.scale;
    this.downscale = new FrameGraphExtractHighlightsTask(`${name} Downscale`, frameGraph, extract);
    this.blurX = new FrameGraphBlurTask(`${name} Blur X`, frameGraph,
      new ThinBlurPostProcess(`${name}_blurX`, engine, new Vector2(1, 0), kernel));
    this.blurY = new FrameGraphBlurTask(`${name} Blur Y`, frameGraph,
      new ThinBlurPostProcess(`${name}_blurY`, engine, new Vector2(0, 1), kernel));
    this.outputTexture = frameGraph.textureManager.createDanglingHandle();
  }

  /** The three stages, in draw order. */
  get stages(): readonly [FrameGraphExtractHighlightsTask, FrameGraphBlurTask, FrameGraphBlurTask] {
    return [this.downscale, this.blurX, this.blurY];
  }

  /** The Effects the stages draw with. */
  get effects(): Array<Effect | null> {
    return this.stages.map((stage) => stage.drawWrapper.effect);
  }

  override isReady(): boolean {
    return this.stages.every((stage) => stage.isReady());
  }

  override getClassName(): string { return "FrameGraphBloomBlurTask"; }

  /** Each stage draws one full-screen pass into its own offscreen target. */
  coversOutput(context: FrameGraphRenderContext): boolean {
    return this.stages.every((stage) => postProcessCover(stage)(context));
  }

  override record(): void {
    if (this.sourceTexture === undefined) throw new Error(`FrameGraphBloomBlurTask "${this.name}": sourceTexture is required`);
    const textures = this._frameGraph.textureManager;
    const source = textures.getTextureDescription(this.sourceTexture);
    const options: FrameGraphTextureCreationOptions = {
      size: {
        width: Math.floor(source.size.width * this.scale) || 1,
        height: Math.floor(source.size.height * this.scale) || 1,
      },
      options: {
        createMipMaps: false,
        types: [this.textureType],
        formats: [Constants.TEXTUREFORMAT_RGBA],
        samples: 1,
        useSRGBBuffers: [false],
        labels: [""],
      },
      sizeIsPercentage: false,
    };
    const downscaled = textures.createRenderTargetTexture(this.downscale.name, options);
    this.downscale.sourceTexture = this.sourceTexture;
    this.downscale.sourceSamplingMode = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
    this.downscale.targetTexture = downscaled;
    this.downscale.record(true);
    const blurredX = textures.createRenderTargetTexture(this.blurX.name, options);
    this.blurX.sourceTexture = downscaled;
    this.blurX.sourceSamplingMode = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
    this.blurX.targetTexture = blurredX;
    this.blurX.record(true);
    textures.resolveDanglingHandle(this.outputTexture, undefined, this.blurY.name, options);
    this.blurY.sourceTexture = blurredX;
    this.blurY.sourceSamplingMode = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
    this.blurY.targetTexture = this.outputTexture;
    this.blurY.record(true);
  }

  override dispose(): void {
    for (const stage of this.stages) stage.dispose();
    super.dispose();
  }
}
