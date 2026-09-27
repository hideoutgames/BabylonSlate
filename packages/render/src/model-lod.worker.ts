import { MeshoptSimplifier } from "meshoptimizer/simplifier";
import { simplifyLevels, type LodLevelIndices, type LodSimplifyInput } from "./model-lod-simplify";

export type ModelLodWorkerRequest = { meshes: LodSimplifyInput[] };
export type ModelLodWorkerReply = { levels: LodLevelIndices[][] } | { error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ModelLodWorkerRequest>) => void) | null;
  postMessage(message: ModelLodWorkerReply, transfer?: Transferable[]): void;
};

scope.onmessage = async (event) => {
  try {
    if (!MeshoptSimplifier.supported) throw new Error("WebAssembly is unavailable");
    await MeshoptSimplifier.ready;
    const levels = event.data.meshes.map((mesh) => {
      // One malformed mesh keeps full detail without failing the whole model.
      try {
        return simplifyLevels(MeshoptSimplifier, mesh);
      } catch {
        return [];
      }
    });
    // An empty submesh range is carried forward unchanged, so buffers repeat.
    const transfer = new Set(levels.flatMap((mesh) => mesh.flatMap((level) => level.ranges.map((range) => range.buffer))));
    scope.postMessage({ levels }, [...transfer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
