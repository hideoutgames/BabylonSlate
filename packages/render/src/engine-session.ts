import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { createAppEngine, type CreateEngineOptions } from "./create-engine";
import { allowDirectViewPresentation } from "./direct-view-presentation";
import { releaseResourceCacheForEngine } from "./resource-cache";

export interface EngineSession {
  engine: AbstractEngine;
  dispose(): void;
}

export interface EngineSessionOptions {
  /** A graphics context requires a fresh constructor canvas. */
  createCanvas(): HTMLCanvasElement;
  releaseCanvas(canvas: HTMLCanvasElement): void;
  decoders?: Pick<CreateEngineOptions, "ktx2BasePath" | "dracoBasePath" | "meshoptBasePath">;
  /** Views of this Engine may show its canvas directly while one is on screen (the editor's project Engine, the player's); absent: they copy. */
  presentViewsDirectly?: boolean;
  /** The project's Large World Rendering (`largeWorldEngineOptions`), fixed for the Engine's life; absent: off. */
  largeWorldRendering?: boolean;
  signal?: AbortSignal;
}

/** One owned WebGL2 Engine on its own canvas, released together. */
export async function createEngineSession(options: EngineSessionOptions): Promise<EngineSession> {
  const { signal } = options;
  signal?.throwIfAborted();
  const canvas = options.createCanvas();
  let engine: AbstractEngine | undefined;
  try {
    engine = createAppEngine(canvas, options.decoders, options.largeWorldRendering === true);
    signal?.throwIfAborted();
    if ("webGLVersion" in engine && engine.webGLVersion !== 2) {
      throw new Error("WebGL2 is required but unavailable in this browser.");
    }
    const ownedEngine = engine;
    if (options.presentViewsDirectly) allowDirectViewPresentation(ownedEngine);
    let disposed = false;
    return {
      engine: ownedEngine,
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          if (!ownedEngine.isDisposed) {
            try {
              releaseResourceCacheForEngine(ownedEngine);
            } finally {
              ownedEngine.dispose();
            }
          }
        } finally {
          options.releaseCanvas(canvas);
        }
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      if (engine && !engine.isDisposed) engine.dispose();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      options.releaseCanvas(canvas);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length)
      throw new AggregateError([error, ...cleanupErrors], "Engine initialization cleanup failed.", { cause: error });
    throw error;
  }
}
