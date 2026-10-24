import { convertRadianceHdrToEnvironmentDds, type HdrEnvironmentConverter } from "./hdr-environment";
import { importByExtension, type ImportOptions, type ImportResult, type ImportRunner } from "./importers";
import {
  importRunsInWorker,
  workerImportOptions,
  type ImportWorkerReply,
  type ImportWorkerRequest,
} from "./import-worker-protocol";

/** The worker surface the client uses, so tests can stand in for a real Worker. */
export type ImportWorkerHandle = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;

function createModuleWorker(): ImportWorkerHandle {
  return new Worker(new URL("./import-worker.ts", import.meta.url), { type: "module" });
}

/**
 * Runs one request on its own worker. Abort terminates the worker at once, so
 * a cancelled conversion stops using the CPU and nothing it made is returned.
 */
function runOnWorker(
  createWorker: () => ImportWorkerHandle,
  request: ImportWorkerRequest,
  { signal, onProgress }: Pick<ImportOptions, "signal" | "onProgress">,
): Promise<Extract<ImportWorkerReply, { type: "imported" | "converted" }>> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
    const finish = () => {
      settled = true;
      worker.terminate();
      signal?.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      finish();
      reject(error);
    };
    const cancel = () => fail(signal?.reason ?? new DOMException("Import cancelled.", "AbortError"));
    signal?.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event: MessageEvent<ImportWorkerReply>) => {
      if (settled) return;
      const reply = event.data;
      if (reply.type === "progress") {
        try { onProgress?.(reply.fraction); } catch (error) { fail(error); }
      } else if (reply.type === "error") fail(new Error(reply.message));
      else {
        finish();
        resolve(reply);
      }
    };
    worker.onerror = (event) => fail(new Error(event.message || "The import worker failed."));
    worker.onmessageerror = () => fail(new Error("The import worker returned an invalid message."));
    // A copy moves to the worker, so the caller's bytes stay readable.
    const bytes = request.bytes.slice();
    try { worker.postMessage({ ...request, bytes }, [bytes.buffer]); }
    catch (error) { fail(error); }
  });
}

export function createImportWorkerClient(createWorker: () => ImportWorkerHandle = createModuleWorker): {
  runImport: ImportRunner;
  convertHdrEnvironment: HdrEnvironmentConverter;
} {
  return {
    runImport: async (fileName, bytes, options): Promise<ImportResult[]> => {
      if (!importRunsInWorker(fileName)) return importByExtension(fileName, bytes, options);
      const reply = await runOnWorker(createWorker, {
        type: "import",
        fileName,
        bytes,
        options: workerImportOptions(options),
      }, options);
      return reply.type === "imported" ? reply.results : [];
    },
    convertHdrEnvironment: async (bytes, options) => {
      const reply = await runOnWorker(createWorker, { type: "convertHdr", bytes, faceSize: options.faceSize }, options);
      if (reply.type !== "converted") throw new Error("The import worker returned no cube.");
      return reply.bytes;
    },
  };
}

let defaultClient: ReturnType<typeof createImportWorkerClient> | undefined;
/** Without Web Workers (Node tests, old hosts) every import runs in-process. */
function workerClient() {
  if (typeof Worker === "undefined") return null;
  return (defaultClient ??= createImportWorkerClient());
}

/** The editor's import runner: slow pure-CPU importers on a worker, the rest in-process. */
export const runImportOffMainThread: ImportRunner = (fileName, bytes, options) =>
  workerClient()?.runImport(fileName, bytes, options) ?? importByExtension(fileName, bytes, options);

export const convertHdrEnvironmentOffMainThread: HdrEnvironmentConverter = (bytes, options) =>
  workerClient()?.convertHdrEnvironment(bytes, options) ?? convertRadianceHdrToEnvironmentDds(bytes, options);
