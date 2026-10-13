import { convertFbxToGlb, type ModelImportFile } from "./fbx-conversion";

export type FbxImportRequest =
  | { type: "sidecars"; sidecars: ModelImportFile[] }
  | { type: "convert"; file: ModelImportFile };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FbxImportRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

// A batch sends its sidecar images once; every FBX that follows reads them here.
let sidecars: ModelImportFile[] = [];

scope.onmessage = async (event) => {
  const request = event.data;
  if (request.type === "sidecars") {
    sidecars = request.sidecars;
    return;
  }
  try {
    const consumedSidecars = new Set<string>();
    const bytes = await convertFbxToGlb(request.file, sidecars, consumedSidecars);
    // Nothing else in this worker keeps these bytes, so they move to the editor.
    scope.postMessage({ bytes, consumedSidecars: [...consumedSidecars] }, [
      bytes.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    scope.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
