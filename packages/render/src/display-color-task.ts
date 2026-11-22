import { Constants } from "@babylonjs/core/Engines/constants";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import { EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { Observer } from "@babylonjs/core/Misc/observable";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import "@babylonjs/core/Shaders/ShadersInclude/imageProcessingDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/imageProcessingFunctions";
import "@babylonjs/core/Shaders/postprocess.vertex";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";

export const DISPLAY_COLOR_SHADER = "hapticDisplayColor";

/**
 * One full-screen pass, its stages in the order the separate passes they replace ran, each behind its define:
 * - `BLOOM`: Babylon's bloom merge (`bloomMerge.fragment`), the blurred highlights added at `bloomWeight`, then rounded
 *   as the merge pass's own target (of the source's type) stored it: clamped to [0, 1] and rounded half to even in 1/255
 *   steps for RGBA8 (`BLOOM_UNORM8`), to half floats for half-float (`BLOOM_HALF_FLOAT`). Later stages thus read what
 *   they read after a separate merge pass: a Display Space vignette still darkens bloom clipped at white, not above it.
 * - `DISPLAY_COLOR`: Babylon's image processing (`imageProcessing.fragment`) with its own includes and defines.
 * The result is written last, so a stage that follows image processing goes before that write.
 */
ShaderStore.ShadersStore[`${DISPLAY_COLOR_SHADER}PixelShader`] = `
varying vec2 vUV;
uniform sampler2D textureSampler;
#ifdef BLOOM
uniform sampler2D bloomBlur;
uniform float bloomWeight;
#endif
#ifdef DISPLAY_COLOR
#include<imageProcessingDeclaration>
#include<helperFunctions>
#include<imageProcessingFunctions>
#endif
void main(void) {
  vec4 result = texture2D(textureSampler, vUV);
#ifdef BLOOM
  vec3 blurred = texture2D(bloomBlur, vUV).rgb;
  result.rgb = result.rgb + (blurred.rgb * bloomWeight);
#ifdef BLOOM_UNORM8
  result = roundEven(clamp(result, 0.0, 1.0) * 255.0) / 255.0;
#endif
#ifdef BLOOM_HALF_FLOAT
  result = vec4(unpackHalf2x16(packHalf2x16(result.rg)), unpackHalf2x16(packHalf2x16(result.ba)));
#endif
#endif
#ifdef DISPLAY_COLOR
  result.rgb = max(result.rgb, vec3(0.));
#ifdef IMAGEPROCESSING
#ifndef FROMLINEARSPACE
  result.rgb = toLinearSpace(result.rgb);
#endif
  result = applyImageProcessing(result);
#else
#ifdef FROMLINEARSPACE
  result = applyImageProcessing(result);
#endif
#endif
#endif
  gl_FragColor = result;
}
`;

/** The stages a Display Color pass runs; at least one. */
export interface DisplayColorStages {
  /** Bloom's merge, adding the task's `bloomTexture` at `weight`. */
  bloom: { weight: number } | null;
  /**
   * Babylon's image processing from a configuration the pass owns: it sets `applyByPostProcess` on it, and resets it
   * when disposed, as Babylon's image-processing post process does. `fromLinearSpace` is that post process's option.
   */
  imageProcessing: { configuration: ImageProcessingConfiguration; fromLinearSpace: boolean } | null;
}

/**
 * The effect of a Display Color pass. Its defines, uniforms and samplers for image processing are those of Babylon's
 * `ThinImageProcessingPostProcess` (the same define set, written the same way, prepared and bound by the configuration
 * itself), so the processing is that pass's. Unlike that post process, which compiles a default variant as it is built
 * and another for each option set after, it compiles once, as its task records (where the source's type is known), and
 * again only when a configuration change changes its defines; each Effect it replaces is retired, never orphaned.
 */
export class ThinDisplayColorPostProcess extends EffectWrapper {
  readonly bloom: DisplayColorStages["bloom"];
  readonly imageProcessing: DisplayColorStages["imageProcessing"];
  /** Effects replaced by a define change, each released once its compile settles. */
  readonly retirements: OwnedEffectRetirement[] = [];
  /** Babylon's image-processing define set, in its order. */
  private readonly imageDefines = {
    IMAGEPROCESSING: false, WHITEBALANCE: false, VIGNETTE: false, VIGNETTEBLENDMODEMULTIPLY: false,
    VIGNETTEBLENDMODEOPAQUE: false, TONEMAPPING: 0, CONTRAST: false, COLORCURVES: false, COLORGRADING: false,
    COLORGRADING3D: false, FROMLINEARSPACE: false, SAMPLER3DGREENDEPTH: false, SAMPLER3DBGRMAP: false, DITHER: false,
    IMAGEPROCESSINGPOSTPROCESS: false, EXPOSURE: false, SKIPFINALCOLORCLAMP: false,
  };
  private readonly configurationObserver: Observer<ImageProcessingConfiguration> | null = null;
  /** Unknown until the task first records. */
  private sourceType: number | undefined;
  private compiledDefines: string | undefined;

  constructor(name: string, engine: AbstractEngine, stages: DisplayColorStages) {
    if (!stages.bloom && !stages.imageProcessing) throw new Error("A Display Color pass needs bloom or image processing.");
    super({
      name, engine, useShaderStore: true, useAsPostProcess: true, fragmentShader: DISPLAY_COLOR_SHADER,
      shaderLanguage: ShaderLanguage.GLSL,
      // Compiled by `compileFor` once the source is known.
      blockCompilation: true,
    });
    this.bloom = stages.bloom;
    this.imageProcessing = stages.imageProcessing;
    const configuration = stages.imageProcessing?.configuration;
    if (configuration) {
      // Its defines are prepared for a post process only while it says it is applied by one.
      configuration.applyByPostProcess = true;
      this.configurationObserver = configuration.onUpdateParameters.add(() => this.compile());
    }
  }

  /** Compiles for a source of `type` (a `TEXTURETYPE_*`), unless the effect it holds already is. */
  compileFor(type: number): void {
    this.sourceType = type;
    this.compile();
  }

  private compile(): void {
    if (this.sourceType === undefined) return;
    let defines = "";
    const uniforms = ["scale"];
    const samplers = ["textureSampler"];
    if (this.bloom) {
      defines += "#define BLOOM\n";
      if (this.sourceType === Constants.TEXTURETYPE_UNSIGNED_BYTE) defines += "#define BLOOM_UNORM8\n";
      else if (this.sourceType === Constants.TEXTURETYPE_HALF_FLOAT) defines += "#define BLOOM_HALF_FLOAT\n";
      uniforms.push("bloomWeight");
      samplers.push("bloomBlur");
    }
    const image = this.imageProcessing;
    if (image) {
      defines += "#define DISPLAY_COLOR\n";
      this.imageDefines.FROMLINEARSPACE = image.fromLinearSpace;
      image.configuration.prepareDefines(this.imageDefines, true);
      // Written as `ThinImageProcessingPostProcess._updateParameters` writes them.
      for (const [name, value] of Object.entries(this.imageDefines)) {
        if (typeof value === "number") defines += `#define ${name} ${value};\n`;
        else if (value) defines += `#define ${name};\n`;
      }
      ImageProcessingConfiguration.PrepareSamplers(samplers, this.imageDefines);
      ImageProcessingConfiguration.PrepareUniforms(uniforms, this.imageDefines);
    }
    if (defines === this.compiledDefines) return;
    const previous = this.effect;
    this.compiledDefines = defines;
    this.updateEffect(defines, uniforms, samplers);
    if (previous && previous !== this.effect) this.retirements.push(retireOwnedEffect(previous, () => previous.dispose()));
  }

  override bind(noDefaultBindings = false): void {
    super.bind(noDefaultBindings);
    const effect = this.effect;
    if (this.bloom) effect.setFloat("bloomWeight", this.bloom.weight);
    this.imageProcessing?.configuration.bind(effect);
  }

  override dispose(): void {
    super.dispose();
    const configuration = this.imageProcessing?.configuration;
    if (configuration) {
      configuration.onUpdateParameters.remove(this.configurationObserver);
      configuration.applyByPostProcess = false;
    }
  }
}

/**
 * The chain's Display Color stage as one full-resolution pass: bloom's merge of `bloomTexture` (a
 * `FrameGraphBloomBlurTask`'s output) into the source, then image processing, each when its stage is planned. It writes
 * what the separate merge and image-processing passes wrote, colour and alpha (neither stage changes alpha), into a
 * target of the source's type (single-sample), or into the target it is given.
 */
export class FrameGraphDisplayColorTask extends FrameGraphPostProcessTask {
  declare readonly postProcess: ThinDisplayColorPostProcess;
  /** The blurred highlights the bloom stage adds; required with that stage. */
  bloomTexture: FrameGraphTextureHandle | undefined;

  constructor(name: string, frameGraph: FrameGraph, stages: DisplayColorStages) {
    super(name, frameGraph, new ThinDisplayColorPostProcess(name, frameGraph.engine, stages));
  }

  override getClassName(): string { return "FrameGraphDisplayColorTask"; }

  override record(
    skipCreationOfDisabledPasses = false,
    additionalExecute?: (context: FrameGraphRenderContext) => void,
    additionalBindings?: (context: FrameGraphRenderContext) => void,
  ): FrameGraphRenderPass {
    if (this.sourceTexture === undefined) throw new Error(`FrameGraphDisplayColorTask "${this.name}": sourceTexture is required`);
    const bloom = this.postProcess.bloom ? this.bloomTexture : undefined;
    if (this.postProcess.bloom && bloom === undefined)
      throw new Error(`FrameGraphDisplayColorTask "${this.name}": bloomTexture is required with bloom`);
    const textures = this._frameGraph.textureManager;
    this.postProcess.compileFor(textures.getTextureCreationOptions(this.sourceTexture).options.types?.[0] ??
      Constants.TEXTURETYPE_UNSIGNED_BYTE);
    const pass = super.record(skipCreationOfDisabledPasses, (context) => {
      // Bilinear, as the blurs sample: a new graph target starts with nearest sampling, and the blur target may alias
      // another target whose last reader chose otherwise.
      if (bloom !== undefined) context.setTextureSamplingMode(bloom, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
      additionalExecute?.(context);
    }, (context) => {
      if (bloom !== undefined) context.bindTextureHandle(this._postProcessDrawWrapper.effect!, "bloomBlur", bloom);
      additionalBindings?.(context);
    });
    if (bloom !== undefined) pass.addDependencies(bloom);
    // The vignette and dithering read the output's size (`vInverseScreenSize`), as Babylon's image-processing task sets it.
    const configuration = this.postProcess.imageProcessing?.configuration;
    if (configuration) {
      configuration.outputTextureWidth = this._outputWidth;
      configuration.outputTextureHeight = this._outputHeight;
    }
    return pass;
  }
}
