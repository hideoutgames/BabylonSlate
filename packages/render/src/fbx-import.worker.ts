import { convertFbxToGlb, type ModelImportFile } from "./fbx-conversion";

export type FbxImportRequest =
  | { type: "sidecars"; sidecars: ModelImportFile[] }
  | { type: "convert"; file: ModelImportFile };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FbxImportRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "error",
    listener: (event: Pick<ErrorEvent, "message" | "preventDefault">) => void,
  ): void;
};

// A batch sends its sidecar images once; every FBX that follows reads them here.
let sidecars: ModelImportFile[] = [];
let converting = false;

// Babylon can leave a callback behind that throws after its conversion replied. The editor
// may already be waiting on the next FBX by then, and would reject that file for an error
// that is not its own, with its bytes already moved here. Only an error that arrives while
// a conversion runs reaches the editor, which must hear about it or wait for a reply forever.
scope.addEventListener("error", (event) => {
  if (converting) return;
  event.preventDefault();
  console.warn(`FBX importer ignored an error raised after its conversion finished: ${event.message}`);
});

scope.onmessage = async (event) => {
  const request = event.data;
  if (request.type === "sidecars") {
    sidecars = request.sidecars;
    return;
  }
  converting = true;
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
  } finally {
    converting = false;
  }
};
