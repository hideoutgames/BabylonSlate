import type { AbstractEngine } from "@babylonjs/core";
import { pruneWebGpuCachesNow } from "./webgpu-cache-pruning";

/**
 * End frames to run once the release settles: `DrawWrapper.dispose(false)`
 * disposes its Effect at the end frame after a SetImmediate, and the buffers
 * that disposal releases are destroyed at the following one.
 */
const SETTLE_FRAMES = 3;
/** A release that never settles (quarantine) leaves the rest to the next client's frames. */
const DRAIN_DEADLINE_MS = 5_000;
/**
 * Replaces the deadline once the release settles, so a release that settles
 * late still gets its settle frames. It stays a bound: a lost context makes
 * Babylon request frames that never end, and a hidden page delivers none.
 */
const SETTLE_DEADLINE_MS = 1_000;

/**
 * Keep empty frames coming after a client stops until its release settles,
 * then a few more. Babylon finishes deferred work only at an end frame: WebGPU
 * buffer and texture destruction, deferred Effect disposal and frame-gated
 * managed-lease releases. With no other client rendering, a closed Scene would
 * otherwise stay allocated until the next client's first frame, so switching
 * scenes would peak at the old and the new one together. The loop's own
 * function draws nothing, and it is the only loop this removes: a client that
 * starts mid-drain keeps its loop, and its frames count toward the end.
 */
export function drainEngineAfterRelease(engine: AbstractEngine, released: Promise<unknown>): void {
  if (engine.isDisposed) return;
  const frame = () => {};
  let settledFrames = -1;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(deadline);
    engine.onEndFrameObservable.remove(counter);
    engine.onDisposeObservable.remove(disposed);
    engine.stopRenderLoop(frame);
    if (!engine.isDisposed) pruneWebGpuCachesNow(engine);
  };
  // An Effect disposal queued through SetImmediate registers its own end-frame
  // observer after this counter, so in the last settle frame it can land after
  // the final prune; its ids wait for the next drain or the threshold prune.
  const counter = engine.onEndFrameObservable.add(() => {
    if (settledFrames >= 0 && ++settledFrames >= SETTLE_FRAMES) stop();
  });
  const disposed = engine.onDisposeObservable.addOnce(stop);
  let deadline = setTimeout(stop, DRAIN_DEADLINE_MS);
  void released.then(() => {
    if (stopped) return;
    settledFrames = 0;
    clearTimeout(deadline);
    deadline = setTimeout(stop, SETTLE_DEADLINE_MS);
  }, stop);
  engine.runRenderLoop(frame);
}
