import type { GpuBackend } from "@babylonslate/core";
import { createBackendEngineSession, type BackendEngineSession } from "@babylonslate/render";
import { editorDracoPublicBase, editorKtx2PublicBase, editorMeshoptPublicBase } from "./public-engine-assets";
import { isUsableEngine } from "./shared-engine-generation";

export type ProjectEngineSession = BackendEngineSession;
export type ProjectEngineState = {
  phase: "idle" | "preparing" | "initializing" | "ready" | "failed";
  session: ProjectEngineSession | null;
  error?: unknown;
  retryable?: boolean;
};
export type ProjectEngineRequest = {
  projectGuid: string;
  backend: GpuBackend;
  /** Paint blocking UI, detach old clients, then inspect backend compatibility. */
  prepare(signal: AbortSignal): Promise<string | undefined>;
};
export type ProjectEngineController = {
  getSnapshot(): ProjectEngineState;
  subscribe(listener: () => void): () => void;
  sync(request: ProjectEngineRequest | null, retry?: boolean): Promise<void>;
  dispose(): void;
};

/** Hidden constructor canvas + initialized Engine for one open project. */
export async function createProjectEngineSession(
  backend: GpuBackend,
  signal: AbortSignal,
  webGpuCompatibilityReason?: string,
): Promise<ProjectEngineSession> {
  let constructorCanvas: HTMLCanvasElement | undefined;
  const session = await createBackendEngineSession({
    requestedBackend: backend,
    signal,
    webGpuCompatibilityReason,
    decoders: {
      ktx2BasePath: editorKtx2PublicBase(),
      dracoBasePath: editorDracoPublicBase(),
      meshoptBasePath: editorMeshoptPublicBase(),
    },
    createCanvas() {
      const canvas = document.createElement("canvas");
      constructorCanvas = canvas;
      canvas.width = canvas.height = 8;
      canvas.style.display = "none";
      canvas.setAttribute("aria-hidden", "true");
      canvas.setAttribute("data-testid", "project-engine-canvas");
      document.body.appendChild(canvas);
      return canvas;
    },
    releaseCanvas: (canvas) => canvas.remove(),
  });
  if (constructorCanvas) constructorCanvas.style.display = "none";
  return session;
}

/** Serial ownership: a superseded device request settles before another Engine starts. */
export function createProjectEngineController(): ProjectEngineController {
  let state: ProjectEngineState = { phase: "idle", session: null };
  let owned: ProjectEngineSession | null = null;
  let key: string | null = null;
  let abort: AbortController | null = null;
  let tail = Promise.resolve();
  let cleanupFailure: Error | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ProjectEngineState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const quarantine = (cause: unknown) => {
    cleanupFailure ??= new Error("Rendering cleanup failed. Close this message, save your work, and reload the editor before trying again.", { cause });
    return cleanupFailure;
  };
  const drop = () => {
    if (cleanupFailure) throw cleanupFailure;
    const outgoing = owned;
    try {
      outgoing?.dispose();
    } catch (cause) {
      // A partially disposed Engine cannot authorize a replacement allocation.
      throw quarantine(cause);
    }
    owned = null;
  };
  const controller: ProjectEngineController = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    sync(request, retry = false) {
      const nextKey = request ? JSON.stringify([request.projectGuid, request.backend]) : null;
      if (!retry && key === nextKey &&
        (state.phase !== "ready" || isUsableEngine(state.session?.engine))) return tail;
      key = nextKey;
      abort?.abort(new Error("Rendering transition superseded."));
      const transition = new AbortController();
      abort = transition;
      const { signal } = transition;
      publish({ phase: request ? "preparing" : "idle", session: null });
      tail = tail.then(async () => {
        if (signal.aborted) return;
        try {
          if (cleanupFailure) throw cleanupFailure;
          const reason = request ? await request.prepare(signal) : undefined;
          signal.throwIfAborted();
          drop();
          if (!request) return;
          publish({ phase: "initializing", session: null });
          const session = await createProjectEngineSession(request.backend, signal, reason);
          owned = session;
          if (signal.aborted) {
            drop();
            return;
          }
          publish({ phase: "ready", session });
        } catch (error) {
          if (error instanceof AggregateError) quarantine(error);
          if (!signal.aborted) publish({ phase: "failed", session: null,
            error: cleanupFailure ?? error,
            ...(cleanupFailure ? { retryable: false } : {}),
          });
        }
      });
      return tail;
    },
    dispose() {
      void controller.sync(null, true);
    },
  };
  return controller;
}
