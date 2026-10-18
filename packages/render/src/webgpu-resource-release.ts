import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

type PipelineContextOwner = {
  _deletePipelineContext(context: unknown): void;
  _releaseEffect(effect: unknown): void;
};
type DisposablePipelineContext = { dispose?: () => void };
type EffectWithContext = { getPipelineContext?: () => unknown } | null | undefined;

/**
 * Release what Babylon 9.29 leaves behind when a WebGPU Effect is released or
 * its pipeline context replaced (Effect disposal, a recompiled Effect's
 * previous context, `releaseEffects`).
 *
 * `WebGPUEngine._deletePipelineContext` only calls `resetCachedPipeline`, which
 * does nothing without a WebGL context, so `WebGPUPipelineContext.dispose()`
 * never runs. And `_releaseEffect` deletes the context only for Effects in the
 * compiled-effect cache, so an Effect built directly (an `EffectWrapper`
 * without the shader store) never reaches it. Either way the context's
 * leftover-uniform `UniformBuffer` stays in `engine._uniformBuffers` with its
 * GPU buffers until the Engine is disposed. Babylon has released the Effect at
 * this point, so nothing can draw with the context again.
 */
export function releaseDeletedWebGpuPipelineContexts(engine: WebGPUEngine): void {
  const owner = engine as unknown as PipelineContextOwner;
  const deletePipelineContext = owner._deletePipelineContext;
  const releaseEffect = owner._releaseEffect;
  if (typeof deletePipelineContext !== "function" || typeof releaseEffect !== "function")
    throw new Error("Unsupported Babylon WebGPU pipeline-context layout: _deletePipelineContext or _releaseEffect is missing.");
  const released = new WeakSet<object>();
  owner._deletePipelineContext = function (this: unknown, context: unknown) {
    deletePipelineContext.call(this, context);
    if (!context || typeof context !== "object" || released.has(context)) return;
    released.add(context);
    (context as DisposablePipelineContext).dispose?.();
  };
  owner._releaseEffect = function (this: PipelineContextOwner, effect: unknown) {
    releaseEffect.call(this, effect);
    // Uncached Effects: Babylon skipped the context; a cached one is already released.
    const context = (effect as EffectWithContext)?.getPipelineContext?.();
    if (context) this._deletePipelineContext(context);
  };
}
