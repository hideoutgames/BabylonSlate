import { convertRadianceHdrToEnvironmentDds } from "./hdr-environment";
import { importByExtension, type ImportOptions, type ImportResult } from "./importers";
import { extensionOf } from "./importers/util";

/**
 * Message protocol of the import worker (`import-worker.ts`). The editor runs
 * slow, pure-CPU importers there: HDR panorama conversion and glTF / GLB
 * parsing with collision cooking. Importers that need the DOM or a Babylon
 * Engine (OBJ and STL conversion, thumbnails) stay on the main thread; FBX
 * converts on its own worker; images, audio and fonts are only sniffed and
 * would spend more time crossing to a worker than importing.
 */

/** Import options that cross to the worker: everything but the signal and progress callback. */
export type WorkerImportOptions = Omit<ImportOptions, "signal" | "onProgress">;

export type ImportWorkerRequest =
  | { type: "import"; fileName: string; bytes: Uint8Array; options: WorkerImportOptions }
  | { type: "convertHdr"; bytes: Uint8Array; faceSize: number };

export type ImportWorkerReply =
  | { type: "progress"; fraction: number }
  | { type: "imported"; results: ImportResult[] }
  | { type: "converted"; bytes: Uint8Array }
  | { type: "error"; message: string };

const WORKER_IMPORT_EXTENSIONS = new Set(["hdr", "glb", "gltf"]);

/** Whether the editor imports this file on the import worker. */
export function importRunsInWorker(fileName: string): boolean {
  return WORKER_IMPORT_EXTENSIONS.has(extensionOf(fileName));
}

export function workerImportOptions(options: ImportOptions): WorkerImportOptions {
  const { signal, onProgress, ...rest } = options;
  void signal;
  void onProgress;
  return rest;
}

/**
 * Each distinct buffer behind the results' chunks, once: several chunks may
 * view one buffer (a GLB's embedded images), and a buffer listed twice cannot
 * be transferred.
 */
export function importResultTransferList(results: readonly ImportResult[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const result of results)
    for (const chunk of result.chunks)
      if (chunk.data.buffer instanceof ArrayBuffer) buffers.add(chunk.data.buffer);
  return [...buffers];
}

/** Progress messages at most this often, so a fast conversion does not flood the editor. */
const PROGRESS_INTERVAL_MS = 50;

/** Worker side: run one request and post its progress, then its result or error. */
export async function runImportWorkerRequest(
  request: ImportWorkerRequest,
  post: (reply: ImportWorkerReply, transfer?: Transferable[]) => void,
): Promise<void> {
  let lastProgress = -Infinity;
  const onProgress = (fraction: number) => {
    const now = performance.now();
    if (now - lastProgress < PROGRESS_INTERVAL_MS && fraction < 1) return;
    lastProgress = now;
    post({ type: "progress", fraction });
  };
  try {
    if (request.type === "convertHdr") {
      const bytes = await convertRadianceHdrToEnvironmentDds(request.bytes, { faceSize: request.faceSize, onProgress });
      post({ type: "converted", bytes }, [bytes.buffer]);
      return;
    }
    const results = await importByExtension(request.fileName, request.bytes, { ...request.options, onProgress });
    post({ type: "imported", results }, importResultTransferList(results));
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
