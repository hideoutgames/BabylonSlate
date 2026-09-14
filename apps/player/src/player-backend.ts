import { normalizeRenderingPipeline } from "@babylonslate/core";
import {
  createBackendEngineSession,
  webGpuMaterialCompatibilityReason,
  type BackendEngineSession,
} from "@babylonslate/render";
import { startPlayer, type PlayerBootHandle, type PlayerBootOptions } from "./boot";
import { packedContentFromGame } from "./hydrate";

export type PlayerBackendHandle = PlayerBootHandle & {
  backend: Pick<BackendEngineSession, "requestedBackend" | "effectiveBackend" | "fallbackReason">;
};

/** One private graphics context for this player, released after its runtime/views. */
export async function startPlayerWithBackend(
  options: Omit<PlayerBootOptions, "sharedEngine" | "content"> & { signal?: AbortSignal },
): Promise<PlayerBackendHandle> {
  options.signal?.throwIfAborted();
  const content = packedContentFromGame(options.game);
  const requestedBackend = normalizeRenderingPipeline(options.game.manifest.render).gpuBackend;
  const owner = await createBackendEngineSession({
    requestedBackend,
    webGpuCompatibilityReason: requestedBackend === "webgpu"
      ? webGpuMaterialCompatibilityReason(content.materialDocuments, content.materialFunctions)
      : undefined,
    signal: options.signal,
    createCanvas: () => {
      const canvas = document.createElement("canvas");
      canvas.width = options.canvas.width;
      canvas.height = options.canvas.height;
      return canvas;
    },
    releaseCanvas: (canvas) => { canvas.remove(); },
    decoders: {
      ktx2BasePath: new URL("./ktx2/", document.baseURI).href,
      dracoBasePath: new URL("./draco/", document.baseURI).href,
      meshoptBasePath: new URL("./meshopt/", document.baseURI).href,
    },
  });
  let released = false;
  let releaseFailure: unknown;
  const releaseOwner = () => {
    if (released) return;
    released = true;
    const errors: unknown[] = [];
    try { owner.dispose(); } catch (error) { errors.push(error); }
    try { options.onStopped?.(); } catch (error) { errors.push(error); }
    if (errors.length) {
      releaseFailure = errors.length === 1 ? errors[0] : new AggregateError(errors, "Player backend cleanup failed.");
      throw releaseFailure;
    }
  };
  let player: PlayerBootHandle;
  try {
    options.signal?.throwIfAborted();
    if (owner.fallbackReason) options.onDiagnostic?.([{
      severity: "warning",
      code: "render.backend.fallback",
      message: owner.fallbackReason,
    }]);
    options.signal?.throwIfAborted();
    owner.engine.inputElement = options.canvas;
    player = startPlayer({ ...options, content, sharedEngine: owner.engine, onStopped: releaseOwner });
  } catch (error) {
    try { releaseOwner(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Player startup cleanup failed.", { cause: error });
    }
    throw error;
  }
  let stopped = false;
  let result: ReturnType<PlayerBootHandle["stop"]> = { diagnostics: [] };
  return {
    ...player,
    backend: {
      requestedBackend: owner.requestedBackend,
      effectiveBackend: owner.effectiveBackend,
      ...(owner.fallbackReason ? { fallbackReason: owner.fallbackReason } : {}),
    },
    stop() {
      if (stopped) return result;
      stopped = true;
      const errors: unknown[] = [];
      try { result = player.stop(); } catch (error) { errors.push(error); }
      try { releaseOwner(); } catch (error) { errors.push(error); }
      if (releaseFailure !== undefined && !errors.includes(releaseFailure)) errors.push(releaseFailure);
      if (errors.length) throw new AggregateError(errors, "Player shutdown failed.");
      return result;
    },
  };
}
