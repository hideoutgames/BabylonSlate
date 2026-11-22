import {
  runDesktopPackage,
  type DesktopPackageReply,
  type DesktopPackageRequest,
  type DesktopPackageResult,
} from "./desktop-package-protocol";

export type { DesktopPackageKind, DesktopPackageResult } from "./desktop-package-protocol";

/** The worker surface the client uses, so tests can stand in for a real Worker. */
export type DesktopPackageWorkerHandle = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;

function createModuleWorker(): DesktopPackageWorkerHandle {
  return new Worker(new URL("./desktop-package.worker.ts", import.meta.url), { type: "module" });
}

/** A buffer that only these bytes view, which can move to the worker instead of being copied. */
function movableBuffer(bytes: Uint8Array): ArrayBuffer[] {
  const { buffer } = bytes;
  return buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength ? [buffer] : [];
}

/**
 * Makes a Windows or Linux package on a worker of its own, so writing the
 * ZIP or `.deb` (hundreds of megabytes) and rewriting the Windows executable
 * never freeze the editor. The runtime's bytes move to the worker when
 * nothing else views their buffer, so callers must not read them afterwards;
 * the game's files are copied. Hosts without `Worker` (Node tests) package
 * in-process.
 */
export function packageDesktopGameInBackground(
  request: DesktopPackageRequest,
  createWorker: (() => DesktopPackageWorkerHandle) | null = typeof Worker === "undefined" ? null : createModuleWorker,
): Promise<DesktopPackageResult> {
  if (!createWorker) return runDesktopPackage(request);
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
    const settle = () => {
      settled = true;
      worker.terminate();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settle();
      reject(error);
    };
    worker.onmessage = (event: MessageEvent<DesktopPackageReply>) => {
      if (settled) return;
      const reply = event.data;
      settle();
      if (reply.ok) resolve({ fileName: reply.fileName, bytes: reply.bytes });
      else reject(new Error(reply.error));
    };
    // A worker that fails to load or crashes never replies.
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      fail(new Error(event.message ? `Packaging failed: ${event.message}` : "Packaging failed: the packaging worker stopped."));
    };
    worker.onmessageerror = () => fail(new Error("Packaging failed: the package could not be read back from the packaging worker."));
    worker.postMessage(request, movableBuffer(request.input.runtime));
  });
}
