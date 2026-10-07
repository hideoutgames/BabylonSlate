import { convertFbxToGlb, type ModelImportFile } from "./fbx-conversion";

self.onmessage = async (
  event: MessageEvent<{ file: ModelImportFile; sidecars: ModelImportFile[] }>,
) => {
  try {
    const consumedSidecars = new Set<string>();
    const bytes = await convertFbxToGlb(
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
