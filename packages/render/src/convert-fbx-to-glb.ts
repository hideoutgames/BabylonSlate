import type { ModelImportFile } from "./fbx-conversion";

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
function createFbxConverter(sidecars: readonly ModelImportFile[]) {
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
        const active = (worker ??= start());
        active.onmessage = (event: MessageEvent<FbxWorkerReply>) => {
          if (event.data.bytes)
            resolve({
              bytes: event.data.bytes,
              consumedSidecars: event.data.consumedSidecars ?? [],
            });
          else reject(new Error(event.data.error ?? "FBX conversion failed."));
        };
        active.onerror = (event) => {
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
  const converter = createFbxConverter(sidecars);
  try {
    for (const file of files) {
      if (!/\.fbx$/i.test(file.name)) {
        converted.push(file);
        continue;
      }
      try {
        const result = await converter.convert(file);
        for (const name of result.consumedSidecars) consumedSidecars.add(name);
        converted.push({
          name: file.name.replace(/\.fbx$/i, ".glb"),
          bytes: result.bytes,
        });
      } catch (error) {
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
