import assimp from "assimpjs";
import wasmUrl from "assimpjs/dist/assimpjs.wasm?url";
import { convertFbxWithAssimp, type ModelImportFile } from "./fbx-conversion";

self.onmessage = async (
  event: MessageEvent<{ file: ModelImportFile; sidecars: ModelImportFile[] }>,
) => {
  try {
    const importer = await assimp({ locateFile: () => wasmUrl });
    const consumedSidecars = new Set<string>();
    const bytes = convertFbxWithAssimp(
      importer,
      event.data.file,
      event.data.sidecars,
      consumedSidecars,
    );
    self.postMessage({ bytes, consumedSidecars: [...consumedSidecars] });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
