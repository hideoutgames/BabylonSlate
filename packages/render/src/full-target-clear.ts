import { Constants } from "@babylonjs/core/Engines/constants";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { foldsBackbufferDepthStencil, noteFoldedBackbufferClear } from "./backbuffer-depth-tracker";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphCopyToTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToTextureTask";

/**
 * Full-screen passes start with a clear of their colour target instead of a load. A GPU render pass that begins with a
 * draw must first load its attachments from memory on a tile-based GPU (ANGLE on Metal on iOS), while one that begins
 * with a full clear need not; a clear (not an invalidate) keeps the target's content defined on every platform, so a
 * pass that did not overwrite every pixel would change the picture everywhere, where a proof sees it.
 *
 * A pass starts with the clear only in frames where its draw writes every pixel and channel of its whole target
 * (`fullTargetCover`): the effect is ready (a full-screen draw of an effect that is not draws nothing, and the target
 * kept its content), blending off, colour writes on, no stencil, a full viewport, no depth test against a depth buffer,
 * and no `discard` in the fragment shader. No full-screen shader can read the target it writes.
 */

/** Whether this frame's run of a pass writes every pixel and channel of its colour target, asked as it starts. */
export type FullTargetCover = (context: FrameGraphRenderContext) => boolean;

/** A Haptic task whose render passes are each one full-screen draw (or a full copy standing in for it). */
export interface FullTargetTask {
  coversOutput(context: FrameGraphRenderContext): boolean;
}

const FULL_VIEWPORT = { x: 0, y: 0, width: 1, height: 1 };
const CLEAR_COLOR = new Color4(0, 0, 0, 0);

/** The clear itself. A member, so a proof's reference run can put the load back. */
export const fullTargetClear = {
  /**
   * Binds the pass's target and clears its colour at its full viewport (the viewport only names the cleared rect). On
   * the backbuffer, in a frame whose Scene Layers draw straight over it (`foldsBackbufferDepthStencil`), the same clear
   * also clears depth and stencil, which a full-screen pass neither tests nor writes, so the first layer's own
   * depth-stencil clear finds them cleared and is left out (`backbuffer-depth-tracker.ts`).
   */
  clear(context: FrameGraphRenderContext): void {
    context._applyRenderTarget();
    context.setViewport(FULL_VIEWPORT);
    const engine = (context as unknown as { _engine: AbstractEngine })._engine;
    if (engine._currentRenderTarget === null && foldsBackbufferDepthStencil(engine)) {
      // A depth clear honours the depth write mask, as the layer's own clear sets it.
      const depthWrites = engine.getDepthWrite();
      engine.setDepthWrite(true);
      context.clear(CLEAR_COLOR, true, true, true);
      engine.setDepthWrite(depthWrites);
      noteFoldedBackbufferClear(engine);
      return;
    }
    context.clear(CLEAR_COLOR, true, false, false);
  },
};

const discarding = new WeakMap<Effect, boolean>();

/** Whether a compiled fragment shader may discard; unknown (not yet processed) counts as yes. */
export function fragmentDiscards(effect: Effect | null | undefined): boolean {
  if (!effect) return true;
  const known = discarding.get(effect);
  if (known !== undefined) return known;
  const source = (effect as unknown as { _fragmentSourceCode?: string })._fragmentSourceCode;
  if (!source) return true;
  const discards = /\bdiscard\b/.test(source);
  discarding.set(effect, discards);
  return discards;
}

function postProcessCover(task: FrameGraphPostProcessTask): FullTargetCover {
  return (context) => task.isReady() && task.alphaMode === Constants.ALPHA_DISABLE && task.viewport === undefined &&
    task.stencilState === undefined && !task.disableColorWrite &&
    (!task.depthTest || (task.depthAttachmentTexture === undefined && !context.isBackbuffer(task.outputTexture))) &&
    !fragmentDiscards(task.drawWrapper.effect);
}

/** Babylon's bloom: four full-screen passes (downscale, two blurs, merge) into offscreen targets of their own. */
function bloomCover(task: FrameGraphBloomTask): FullTargetCover {
  const { _downscale, _blurX, _blurY, _merge } = task.bloom;
  return () => task.isReady() && task.alphaMode === Constants.ALPHA_DISABLE &&
    [_downscale, _blurX, _blurY, _merge].every((stage) => !fragmentDiscards(stage.drawWrapper.effect));
}

/**
 * The cover of a task whose enabled render passes are each one full-screen draw, or null for any other task. The
 * graph's copy effects are ready whenever it draws (`ForwardSceneFrameGraph.graphReady`).
 */
export function fullTargetCover(task: FrameGraphTask): FullTargetCover | null {
  if (task instanceof FrameGraphBloomTask) return bloomCover(task);
  if (task instanceof FrameGraphPostProcessTask) return postProcessCover(task);
  if (task instanceof FrameGraphCopyToBackbufferColorTask) {
    // It copies nothing from the backbuffer itself.
    return (context) => task.sourceTexture !== undefined && !context.isBackbuffer(task.sourceTexture);
  }
  if (task instanceof FrameGraphCopyToTextureTask) {
    return () => task.viewport === undefined;
  }
  if (typeof (task as Partial<FullTargetTask>).coversOutput === "function") {
    const own = task as unknown as FullTargetTask;
    return (context) => own.coversOutput(context);
  }
  return null;
}

const started = new WeakSet<FrameGraphRenderPass>();

/**
 * After each graph build: every enabled render pass of a full-screen task starts with `fullTargetClear` in the frames
 * its draw covers the target. Disabled passes (a skipped stage's copy, an idle task's empty pass) are left as they are.
 */
export function startFullScreenPassesWithClear(tasks: readonly FrameGraphTask[]): void {
  for (const task of tasks) {
    const cover = fullTargetCover(task);
    if (!cover) continue;
    for (const pass of task.passes) {
      if (!(pass instanceof FrameGraphRenderPass) || started.has(pass)) continue;
      const run = (pass as unknown as { _executeFunc?: (context: FrameGraphRenderContext) => void })._executeFunc;
      if (!run) continue;
      started.add(pass);
      pass.setExecuteFunc((context) => {
        if (cover(context)) fullTargetClear.clear(context);
        run(context);
      });
    }
  }
}
