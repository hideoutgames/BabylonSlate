import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import { ThinFSR1SharpenPostProcess } from "@babylonjs/core/PostProcesses/thinFSR1SharpenPostProcess";
import { ThinFSR1UpscalePostProcess } from "@babylonjs/core/PostProcesses/thinFSR1UpscalePostProcess";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { fsr1UpscalePixelShader } from "@babylonjs/core/Shaders/fsr1Upscale.fragment";

/**
 * Babylon's EASU emulates FSR's gathers channel by channel: `FsrEasuRF`, `GF` and `BF` each fetch the same four texels
 * for one channel, 48 fetches a pixel. `easuSharedFetches` has each of the four footprints fetch its four texels once for
 * all three channels (16 fetches), building the same per-channel vectors, so every value and the image are the same.
 */
export function easuSharedFetches(source: string): string {
  const texel = (offset: string) => `texelFetch(textureSampler,clamp(base+ivec2(${offset}),ivec2(0),mx),0).rgb`;
  const helper = "void FsrEasuRGBF(vec2 p,out vec4 r,out vec4 g,out vec4 b) {ivec2 texSize=textureSize(textureSampler,0);" +
    "ivec2 mx=texSize-ivec2(1);ivec2 base=ivec2(floor(p*vec2(texSize)-0.5));" +
    `vec3 t0=${texel("0,1")};vec3 t1=${texel("1,1")};vec3 t2=${texel("1,0")};vec3 t3=${texel("0,0")};` +
    "r=vec4(t0.r,t1.r,t2.r,t3.r);g=vec4(t0.g,t1.g,t2.g,t3.g);b=vec4(t0.b,t1.b,t2.b,t3.b);}\n";
  let shared = source.replace("void FsrEasuTapF(", `${helper}void FsrEasuTapF(`);
  for (const [name, point] of [["bczz", "p0"], ["ijfe", "p1"], ["klhg", "p2"], ["zzon", "p3"]] as const) {
    shared = shared.replace(`vec4 ${name}R=FsrEasuRF(${point});vec4 ${name}G=FsrEasuGF(${point});vec4 ${name}B=FsrEasuBF(${point});`,
      `vec4 ${name}R;vec4 ${name}G;vec4 ${name}B;FsrEasuRGBF(${point},${name}R,${name}G,${name}B);`);
  }
  return shared;
}

// Registered over Babylon's own (which registers itself only where none is), before any EASU Effect compiles.
ShaderStore.ShadersStore[fsr1UpscalePixelShader.name] = easuSharedFetches(fsr1UpscalePixelShader.shader);

/** FSR 1 EASU: edge-adaptive upsampling from the source to the target size. */
export class FrameGraphFsr1UpscaleTask extends FrameGraphPostProcessTask {
  declare readonly postProcess: ThinFSR1UpscalePostProcess;

  constructor(name: string, frameGraph: FrameGraph) {
    super(name, frameGraph, new ThinFSR1UpscalePostProcess(name, frameGraph.engine));
  }

  override getClassName(): string { return "FrameGraphFsr1UpscaleTask"; }

  override record(
    skipCreationOfDisabledPasses = false,
    additionalExecute?: (context: FrameGraphRenderContext) => void,
    additionalBindings?: (context: FrameGraphRenderContext) => void,
  ): FrameGraphRenderPass {
    return super.record(skipCreationOfDisabledPasses, additionalExecute, (context) => {
      this.postProcess.updateConstants(this._postProcessDrawWrapper.effect!,
        this._sourceWidth, this._sourceHeight, this._sourceWidth, this._sourceHeight,
        this._outputWidth, this._outputHeight);
      additionalBindings?.(context);
    });
  }
}

/** FSR 1 RCAS: contrast-adaptive sharpening at the output size. */
export class FrameGraphFsr1SharpenTask extends FrameGraphPostProcessTask {
  declare readonly postProcess: ThinFSR1SharpenPostProcess;
  /** Attenuation in stops; 0 is the strongest sharpening. */
  sharpness = 0.2;

  constructor(name: string, frameGraph: FrameGraph) {
    super(name, frameGraph, new ThinFSR1SharpenPostProcess(name, frameGraph.engine));
  }

  override getClassName(): string { return "FrameGraphFsr1SharpenTask"; }

  override record(
    skipCreationOfDisabledPasses = false,
    additionalExecute?: (context: FrameGraphRenderContext) => void,
    additionalBindings?: (context: FrameGraphRenderContext) => void,
  ): FrameGraphRenderPass {
    return super.record(skipCreationOfDisabledPasses, additionalExecute, (context) => {
      this.postProcess.updateConstants(this._postProcessDrawWrapper.effect!, this.sharpness);
      additionalBindings?.(context);
    });
  }
}
