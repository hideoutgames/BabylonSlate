import type { ModelImportFile } from "./fbx-conversion";

/** Cancellation and per-file phase reporting for the Content Browser's model conversions. */
export interface ModelBatchConversionOptions {
  /** Stops before the next file; an FBX conversion in progress stops at once. */
  signal?: AbortSignal;
  /** Called with each model file's name as its conversion starts. */
  onFile?: (name: string) => void;
}

type FbxConversion = { bytes: Uint8Array; consumedSidecars: string[] };
type FbxWorkerReply = {
  bytes?: Uint8Array;
  error?: string;
  consumedSidecars?: string[];
};

/** The buffer of a file whose bytes span all of it, which can move to the worker instead of being cloned. */
function movableBuffer(bytes: Uint8Array): ArrayBuffer[] {
  const { buffer } = bytes;
  return buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
    ? [buffer]
    : [];
}

/**
 * Convert on a worker so large FBX parses cannot stall the editor. One worker
 * serves the whole batch, so each sidecar image crosses to it once rather than
 * once per FBX. A worker that crashes is replaced by the next file's.
 */
function createFbxConverter(sidecars: readonly ModelImportFile[], signal?: AbortSignal) {
  let worker: Worker | null = null;
  const dispose = () => {
    worker?.terminate();
    worker = null;
  };
  const start = (): Worker => {
    const started = new Worker(
      new URL("./fbx-import.worker.ts", import.meta.url),
      { type: "module" },
    );
    if (sidecars.length > 0) started.postMessage({ type: "sidecars", sidecars });
    return started;
  };
  return {
    dispose,
    convert: (file: ModelImportFile) =>
      new Promise<FbxConversion>((resolve, reject) => {
        signal?.throwIfAborted();
        const active = (worker ??= start());
        // Terminating the worker is the only way to stop a conversion in progress.
        const cancel = () => {
          dispose();
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", cancel, { once: true });
        const settle = () => signal?.removeEventListener("abort", cancel);
        active.onmessage = (event: MessageEvent<FbxWorkerReply>) => {
          settle();
          if (event.data.bytes)
            resolve({
              bytes: event.data.bytes,
              consumedSidecars: event.data.consumedSidecars ?? [],
            });
          else reject(new Error(event.data.error ?? "FBX conversion failed."));
        };
        active.onerror = (event) => {
          settle();
          dispose();
          reject(new Error(event.message || "Unable to start the FBX importer."));
        };
        active.postMessage({ type: "convert", file }, movableBuffer(file.bytes));
      }),
  };
}

/**
 * Converted models enter the existing canonical GLB asset importer. An FBX
 * file's bytes move to the converter when nothing else views their buffer, so
 * callers must not read them afterwards.
 */
export async function convertFbxImportBatch(
  files: ModelImportFile[],
  options: ModelBatchConversionOptions = {},
): Promise<{
  files: ModelImportFile[];
  errors: string[];
  consumedSidecars: string[];
}> {
  const sidecars = files.filter(
    (file) => !/\.(fbx|glb|gltf|obj)$/i.test(file.name),
  );
  const converted: ModelImportFile[] = [];
  const errors: string[] = [];
  const consumedSidecars = new Set<string>();
  const converter = createFbxConverter(sidecars, options.signal);
  try {
    for (const file of files) {
      if (!/\.fbx$/i.test(file.name)) {
        converted.push(file);
        continue;
      }
      options.signal?.throwIfAborted();
      options.onFile?.(file.name);
      try {
        const result = await converter.convert(file);
        for (const name of result.consumedSidecars) consumedSidecars.add(name);
        converted.push({
          name: file.name.replace(/\.fbx$/i, ".glb"),
          bytes: result.bytes,
        });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        errors.push(
          `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    converter.dispose();
  }
  // Keep sidecars available for mixed OBJ/glTF picks until all models have embedded them.
  return { files: converted, errors, consumedSidecars: [...consumedSidecars] };
}
