import { afterEach, expect, it, vi } from "vitest";
import { VertexData } from "@babylonjs/core";
import type { LodSimplifyInput } from "./model-lod-simplify";
import type { ModelLodWorkerReply, ModelLodWorkerRequest } from "./model-lod.worker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("replies with transferable levels per mesh and keeps a failing mesh at full detail", async () => {
  const replies: ModelLodWorkerReply[] = [];
  const scope = {
    onmessage: null as ((event: { data: ModelLodWorkerRequest }) => Promise<void>) | null,
    // Real structured cloning rejects a duplicated or detached transfer list.
    postMessage: (message: ModelLodWorkerReply, transfer?: Transferable[]) =>
      replies.push(structuredClone(message, { transfer })),
  };
  vi.stubGlobal("self", scope);
  await import("./model-lod.worker");
  const sphere = VertexData.CreateSphere({ segments: 48 });
  const indices = Uint32Array.from(sphere.indices!);
  const dense: LodSimplifyInput = {
    positions: Float32Array.from(sphere.positions!),
    normals: Float32Array.from(sphere.normals!),
    uvs: Float32Array.from(sphere.uvs!),
    // An empty submesh carries forward into every level.
    ranges: [indices, new Uint32Array(0)],
    deforming: false,
  };
  const malformed: LodSimplifyInput = { ...dense, positions: new Float32Array(10), ranges: [indices.slice()] };
  await scope.onmessage!({ data: { meshes: [dense, malformed] } });
  expect(replies).toHaveLength(1);
  const reply = replies[0]!;
  if (!("levels" in reply)) throw new Error(reply.error);
  const [levels, failed] = reply.levels;
  expect(levels!.length).toBeGreaterThan(1);
  expect(levels![0]!.triangles).toBeLessThan(indices.length / 3);
  expect(failed).toEqual([]);
});
