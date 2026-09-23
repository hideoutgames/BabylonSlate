import { setEngineBackendStatus } from "./backend-status";
import type { AbstractEngine } from "@babylonjs/core";
import type { GpuBackend } from "@babylonslate/core";
import { createAppEngine, type CreateEngineOptions } from "./create-engine";
import { releaseResourceCacheForEngine } from "./resource-cache";
import { createAppWebGpuEngine } from "./webgpu-engine";

export interface BackendEngineSession {
  engine: AbstractEngine;
  requestedBackend: GpuBackend;
  effectiveBackend: "webgl2" | "webgpu";
  fallbackReason?: string;
  dispose(): void;
}

export interface BackendEngineSessionOptions {
  requestedBackend: GpuBackend;
  /** A different graphics context requires a fresh constructor canvas. */
  createCanvas(): HTMLCanvasElement;
  releaseCanvas(canvas: HTMLCanvasElement): void;
  decoders?: Pick<CreateEngineOptions, "ktx2BasePath" | "dracoBasePath" | "meshoptBasePath">;
  /** An actionable incompatibility discovered from the project's material inputs. */
  webGpuCompatibilityReason?: string;
  signal?: AbortSignal;
}

/** One owned Engine, with bounded sequential fallback and an unchanged authored request. */
export async function createBackendEngineSession(
  options: BackendEngineSessionOptions,
): Promise<BackendEngineSession> {
  const { requestedBackend, signal } = options;
  signal?.throwIfAborted();
  let fallbackReason = requestedBackend === "auto"
    ? "Auto currently selects WebGL2; WebGPU requires an explicit selection."
    : requestedBackend === "webgpu" ? options.webGpuCompatibilityReason : undefined;

  async function attempt(backend: "webgl2" | "webgpu"): Promise<BackendEngineSession> {
    signal?.throwIfAborted();
    const canvas = options.createCanvas();
    let engine: AbstractEngine | undefined;
    try {
      engine = backend === "webgpu"
        ? await createAppWebGpuEngine(canvas, options.decoders, signal)
        : createAppEngine(canvas, options.decoders);
      signal?.throwIfAborted();
      if (backend === "webgl2" && "webGLVersion" in engine && engine.webGLVersion !== 2) {
        throw new Error("WebGL2 is required but unavailable in this browser.");
      }
      const ownedEngine = engine;
      setEngineBackendStatus(ownedEngine, { requestedBackend, effectiveBackend: backend, fallbackReason });
      let disposed = false;
      return {
        engine: ownedEngine,
        requestedBackend,
        effectiveBackend: backend,
        ...(fallbackReason ? { fallbackReason } : {}),
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
        throw new AggregateError([error, ...cleanupErrors], "Backend initialization cleanup failed.", { cause: error });
      throw error;
    }
  }

  if (requestedBackend === "webgpu" && !fallbackReason) {
    try {
      return await attempt("webgpu");
    } catch (error) {
      // A cleanup failure cannot authorize another allocation with uncertain ownership.
      if (error instanceof AggregateError) throw error;
      signal?.throwIfAborted();
      fallbackReason = `WebGPU initialization failed: ${error instanceof Error ? error.message : String(error)} Using WebGL2.`;
    }
  }
  return attempt("webgl2");
}
