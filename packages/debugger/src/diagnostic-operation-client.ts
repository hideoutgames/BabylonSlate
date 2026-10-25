import type { DiagnosticOperation, DiagnosticOperationRequest, DiagnosticOperationResult } from "@haptic/bridge";
import type { DiagnosticOperationOutcome } from "./session-diagnostics";

/** Shared by editor Play and the packaged player; never an uncorrelated FIFO. */
export function createDiagnosticOperationClient(options: {
  sessionGeneration: number;
  send: (request: DiagnosticOperationRequest) => void | Promise<void>;
}) {
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, { recordingId: string;
    resolve: (result: DiagnosticOperationOutcome) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    request(operation: DiagnosticOperation): Promise<DiagnosticOperationOutcome> {
      if (closed || pending.size >= 4) return Promise.resolve({ success: false, reason: closed ? "Game session stopped." : "Too many pending diagnostic requests." });
      const requestId = ++sequence;
      return new Promise((resolve) => {
        const fail = (reason: string) => {
          const entry = pending.get(requestId);
          if (!entry) return;
          clearTimeout(entry.timer); pending.delete(requestId); resolve({ success: false, reason });
        };
        const timer = setTimeout(() => fail("Game runtime did not acknowledge the diagnostic operation."), 2500);
        pending.set(requestId, { recordingId: operation.recordingId, resolve, timer });
        try {
          void Promise.resolve(options.send({ sessionGeneration: options.sessionGeneration, requestId, operation }))
            .catch((error: unknown) => fail(String(error)));
        } catch (error) { fail(String(error)); }
      });
    },
    receive(result: DiagnosticOperationResult): boolean {
      if (closed || result.sessionGeneration !== options.sessionGeneration) return false;
      const entry = pending.get(result.requestId);
      if (!entry || result.recordingId !== entry.recordingId || typeof result.success !== "boolean") return false;
      pending.delete(result.requestId); clearTimeout(entry.timer);
      entry.resolve({ success: result.success, ...(result.reason ? { reason: result.reason } : {}) });
      return true;
    },
    dispose(): void {
      closed = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ success: false, reason: "Game session stopped." }); }
      pending.clear();
    },
  };
}
