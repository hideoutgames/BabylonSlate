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

/**
 * Longest wait for the view's native release before its Engine goes anyway.
 * Context loss or a hidden page can stop the frames that release needs, and
 * Engine disposal, the final native owner, then completes it.
 */
const VIEW_RELEASE_DEADLINE_MS = 5_000;

/** One private graphics context for this player, released after its runtime/views. */
export async function startPlayerWithBackend(
  options: Omit<PlayerBootOptions, "sharedEngine" | "content" | "onStopped"> & { signal?: AbortSignal; onStopped?: () => void },
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
  // Stop has already returned its diagnostics, so a late failure is posted on its own.
  const reportDeferredFailure = (error: unknown) => {
    const message = `Graphics backend cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[player] ${message}`);
    try { options.onDiagnostic?.([{ severity: "error", code: "player.cleanup.failed", message }]); }
    catch (reportError) { console.error("[player] Graphics backend cleanup could not be reported.", reportError); }
  };
  // The view releases its Scene on this Engine once native work settles; the
  // Engine goes after that release, confirmed or quarantined. WebGPU destroys
  // released textures and buffers only at the end of a frame, and the view
  // stopped the only render loop, so empty frames keep that drain going.
  const disposeAfterView = (viewReleased: Promise<void>) => {
    const { engine } = owner;
    const drain = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, VIEW_RELEASE_DEADLINE_MS); });
    void Promise.race([viewReleased.catch(() => {}), deadline])
      .then(() => {
        clearTimeout(timer);
        try { engine.stopRenderLoop(drain); } finally { owner.dispose(); }
      })
      .catch(reportDeferredFailure);
    engine.runRenderLoop(drain);
  };
  const releaseOwner = (viewReleased?: Promise<void>) => {
    if (released) return;
    released = true;
    const errors: unknown[] = [];
    if (viewReleased) {
      try { disposeAfterView(viewReleased); } catch (error) { errors.push(error); }
    } else {
      try { owner.dispose(); } catch (error) { errors.push(error); }
    }
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
    const failures: unknown[] = [error];
    try { releaseOwner(); }
    catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1)
      throw new AggregateError(failures, "Player startup cleanup failed.", { cause: error });
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
      // Player Stop already released the owner after its view; this covers a
      // Stop that failed before reaching that cleanup.
      try { releaseOwner(); } catch (error) { errors.push(error); }
      if (releaseFailure !== undefined && !errors.includes(releaseFailure)) errors.push(releaseFailure);
      if (errors.length) throw new AggregateError(errors, "Player shutdown failed.");
      return result;
    },
  };
}
