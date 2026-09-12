import type { ModelImportFile } from "./fbx-conversion";

/** Convert on a disposable worker so large FBX parses cannot stall the editor. */
export function convertFbxToGlb(file: ModelImportFile, sidecars: ModelImportFile[] = []): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fbx-import.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array; error?: string }>) => {
      worker.terminate();
      if (event.data.bytes) resolve(event.data.bytes);
      else reject(new Error(event.data.error ?? "FBX conversion failed."));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Unable to start the FBX importer."));
    };
    worker.postMessage({ file, sidecars });
  });
}

/** Converted models enter the existing canonical GLB asset importer. */
export async function convertFbxImportBatch(files: ModelImportFile[]): Promise<{ files: ModelImportFile[]; errors: string[] }> {
  const sidecars = files.filter((file) => !/\.(fbx|glb|gltf|obj)$/i.test(file.name));
  const converted: ModelImportFile[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (!/\.fbx$/i.test(file.name)) { converted.push(file); continue; }
    try {
      converted.push({ name: file.name.replace(/\.fbx$/i, ".glb"), bytes: await convertFbxToGlb(file, sidecars) });
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files: converted, errors };
}
