import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

type PipelineContextDeleter = { _deletePipelineContext(context: unknown): void };
type DisposablePipelineContext = { dispose?: () => void };

/**
 * Release what Babylon 9.29 leaves behind when it deletes a WebGPU pipeline
 * context (Effect disposal, a recompiled Effect's previous context,
 * `releaseEffects`).
 *
 * `WebGPUEngine._deletePipelineContext` only calls `resetCachedPipeline`, which
 * does nothing without a WebGL context, so `WebGPUPipelineContext.dispose()`
 * never runs. The context's leftover-uniform `UniformBuffer` then stays in
 * `engine._uniformBuffers` with its GPU buffers until the Engine is disposed:
 * one leak per disposed Effect with leftover uniforms. Babylon has released the
 * Effect at this point, so nothing can draw with the context again.
 */
export function releaseDeletedWebGpuPipelineContexts(engine: WebGPUEngine): void {
  const deleter = engine as unknown as PipelineContextDeleter;
  const deletePipelineContext = deleter._deletePipelineContext;
  if (typeof deletePipelineContext !== "function")
    throw new Error("Unsupported Babylon WebGPU pipeline-context layout: _deletePipelineContext is missing.");
  const released = new WeakSet<object>();
  deleter._deletePipelineContext = function (this: unknown, context: unknown) {
    deletePipelineContext.call(this, context);
    if (!context || typeof context !== "object" || released.has(context)) return;
    released.add(context);
    (context as DisposablePipelineContext).dispose?.();
  };
}
