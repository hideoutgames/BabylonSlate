import type { ModelImportFile } from "./fbx-conversion";

/** Convert on a disposable worker so large FBX parses cannot stall the editor. */
async function convertFbxFile(
  file: ModelImportFile,
  sidecars: ModelImportFile[] = [],
): Promise<{ bytes: Uint8Array; consumedSidecars: string[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./fbx-import.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (
      event: MessageEvent<{
        bytes?: Uint8Array;
        error?: string;
        consumedSidecars?: string[];
      }>,
    ) => {
      worker.terminate();
      if (event.data.bytes)
        resolve({
          bytes: event.data.bytes,
          consumedSidecars: event.data.consumedSidecars ?? [],
        });
      else reject(new Error(event.data.error ?? "FBX conversion failed."));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Unable to start the FBX importer."));
    };
    worker.postMessage({ file, sidecars });
  });
}

export async function convertFbxToGlb(
  file: ModelImportFile,
  sidecars: ModelImportFile[] = [],
): Promise<Uint8Array> {
  return (await convertFbxFile(file, sidecars)).bytes;
}

/** Converted models enter the existing canonical GLB asset importer. */
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
  for (const file of files) {
    if (!/\.fbx$/i.test(file.name)) {
      converted.push(file);
      continue;
    }
    try {
      const result = await convertFbxFile(file, sidecars);
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
  // Keep sidecars available for mixed OBJ/glTF picks until all models have embedded them.
  return { files: converted, errors, consumedSidecars: [...consumedSidecars] };
}
