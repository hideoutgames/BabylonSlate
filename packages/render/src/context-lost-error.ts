import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

/**
 * A scene or SceneLayer load that the graphics context's loss ended. A mobile browser drops the context under memory
 * pressure; Play reports it as `scene.loading.contextLost`, which the Feature Test Check retries once.
 */
export class RenderingContextLostError extends Error {
  override readonly name = "RenderingContextLostError";
}

/** Whether `error`, or an error it wraps, is a load the graphics context's loss ended. */
export function isRenderingContextLostError(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth += 1) {
    if (current instanceof RenderingContextLostError) return true;
  }
  return false;
}

/**
 * Whether `engine`'s graphics context is lost now. Pinned Babylon 9.29 sets `_contextWasLost` while a context is lost; a
 * lost WebGPU Engine (`doNotHandleContextLost`) draws no further frame and is never restored.
 */
export function isEngineContextLost(engine: AbstractEngine): boolean {
  return (engine as unknown as { _contextWasLost?: boolean })._contextWasLost === true;
}
