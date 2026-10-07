import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import { ThinFSR1SharpenPostProcess } from "@babylonjs/core/PostProcesses/thinFSR1SharpenPostProcess";
import { ThinFSR1UpscalePostProcess } from "@babylonjs/core/PostProcesses/thinFSR1UpscalePostProcess";

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
