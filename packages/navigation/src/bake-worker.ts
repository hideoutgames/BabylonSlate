/**
 * Dedicated navmesh bake worker. Hosts post generate input; this thread runs
 * Recast `generateSoloNavMesh` and returns `exportNavMesh` bytes.
 */
import { runNavBakeJob } from "./bake-job";
import type { NavMeshGenerateInput } from "./types";

type BakeRequest = {
  id: number;
  input: NavMeshGenerateInput;
};

type BakeResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<BakeRequest>) => {
  const msg = event.data;
  void runNavBakeJob(msg.input)
    .then((bytes) => {
      const copy = bytes.slice();
      const response: BakeResponse = { id: msg.id, ok: true, bytes: copy };
      (self as DedicatedWorkerGlobalScope).postMessage(response, [copy.buffer]);
    })
    .catch((error: unknown) => {
      const response: BakeResponse = {
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      (self as DedicatedWorkerGlobalScope).postMessage(response);
    });
};
