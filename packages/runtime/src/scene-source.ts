import type { SerializedScene } from "@babylonslate/core";
import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";

/** Required source dependencies must be prepared before returning the document. */
export interface RuntimeSceneSource {
  scene: SerializedScene;
  release(): void;
}

export type AcquireRuntimeScene = (assetGuid: string, options: {
  consumer: string;
  signal: AbortSignal;
  stream?: { actorGuid: string; streamLoadId: number };
}) => Promise<RuntimeSceneSource>;

// Never reuse request identities on worker project switches.
let nextRequestId = 0;

/** The worker owns leases; the main thread owns platform storage and source data. */
export function createSceneSourceClient(send: (command: CommandMessage) => void) {
  const pending = new Map<number, {
    resolve: (source: RuntimeSceneSource) => void;
    reject: (error: unknown) => void;
    release: () => void;
    prepared: () => void;
  }>();
  const owned = new Map<number, () => void>();
  let disposed = false;
  const acquireScene: AcquireRuntimeScene = (assetGuid, { consumer, signal, stream }) => {
    if (disposed || signal.aborted) return Promise.reject(signal.reason ?? new Error("Scene source client is closed."));
    return new Promise((resolve, reject) => {
      const requestId = ++nextRequestId;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", abort);
        pending.delete(requestId);
        owned.delete(requestId);
        send({ type: "sceneSourceReleased", requestId });
      };
      const abort = () => { release(); reject(signal.reason ?? new Error("Scene source loading was cancelled.")); };
      pending.set(requestId, { resolve, reject, release, prepared: () => signal.removeEventListener("abort", abort) });
      owned.set(requestId, release);
      signal.addEventListener("abort", abort, { once: true });
      send({ type: "sceneSourceRequested", requestId, assetGuid, consumer,
        ...(stream ? { streamActorGuid: stream.actorGuid, streamLoadId: stream.streamLoadId } : {}) });
    });
  };
  return {
    acquireScene,
    receive(message: Extract<ControlMessage, { type: "sceneSourceResponse" }>): void {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.error !== undefined || !message.scene) {
        request.release();
        request.reject(new Error(message.error ?? "The host returned no Scene document."));
      } else {
        request.prepared();
        request.resolve({ scene: message.scene, release: request.release });
      }
    },
    dispose(): void {
      disposed = true;
      for (const request of pending.values()) request.reject(new Error("Scene source client was disposed."));
      for (const release of owned.values()) release();
      pending.clear();
      owned.clear();
    },
  };
}

/** Shared by Play and packaged players; also handles providers ignoring cancellation. */
export function createSceneSourceHost(options: {
  acquireScene: AcquireRuntimeScene;
  send: (control: ControlMessage) => void;
}) {
  const requests = new Map<number, { controller: AbortController; source?: RuntimeSceneSource }>();
  let disposed = false;
  const release = (requestId: number) => {
    const request = requests.get(requestId);
    if (!request) return;
    requests.delete(requestId);
    request.controller.abort(new Error("The Scene consumer released its source data."));
    request.source?.release();
  };
  return {
    receive(command: CommandMessage): boolean {
      if (command.type === "sceneSourceReleased") { release(command.requestId); return true; }
      if (command.type !== "sceneSourceRequested") return false;
      if (disposed) return true;
      const { requestId, assetGuid, consumer } = command;
      if (requests.has(requestId)) return true;
      const request: { controller: AbortController; source?: RuntimeSceneSource } = { controller: new AbortController() };
      requests.set(requestId, request);
      void Promise.resolve().then(() => {
        request.controller.signal.throwIfAborted();
        return options.acquireScene(assetGuid, { consumer, signal: request.controller.signal,
          ...(command.streamActorGuid !== undefined && command.streamLoadId !== undefined
            ? { stream: { actorGuid: command.streamActorGuid, streamLoadId: command.streamLoadId } } : {}) });
      }).then((source) => {
        if (disposed || requests.get(requestId) !== request) { source.release(); return; }
        request.source = source;
        options.send({ type: "sceneSourceResponse", requestId, scene: source.scene });
      }).catch((error: unknown) => {
        if (disposed || requests.get(requestId) !== request) return;
        release(requestId);
        options.send({ type: "sceneSourceResponse", requestId,
          error: `Scene ${assetGuid} requested by ${consumer}: ${error instanceof Error ? error.message : String(error)}` });
      });
      return true;
    },
    dispose(): void {
      disposed = true;
      for (const requestId of requests.keys()) release(requestId);
    },
  };
}
