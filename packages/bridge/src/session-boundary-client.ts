import type { SessionBoundaryRequest, SessionBoundaryResult } from "./channels";

/** Correlated, bounded control traffic. World snapshots never satisfy a boundary. */
export function createSessionBoundaryClient(
  generation: number,
  send: (request: SessionBoundaryRequest) => void,
  timeoutMs = 10_000,
) {
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, {
    resolve: (value: SessionBoundaryResult) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  return {
    request(action: SessionBoundaryRequest["action"]): Promise<SessionBoundaryResult> {
      if (closed) return Promise.reject(new Error("Game session stopped"));
      if (pending.size >= 64) return Promise.reject(new Error("Too many pending game boundary requests"));
      const requestId = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("The game runtime did not acknowledge its simulation boundary"));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try { send({ sessionGeneration: generation, requestId, action }); }
        catch (error) {
          clearTimeout(timer); pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    receive(result: SessionBoundaryResult) {
      if (closed || result.sessionGeneration !== generation) return;
      const request = pending.get(result.requestId);
      if (!request) return;
      pending.delete(result.requestId);
      clearTimeout(request.timer);
      request.resolve(result);
    },
    dispose() {
      closed = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Game session stopped before its boundary completed"));
      }
      pending.clear();
    },
  };
}
