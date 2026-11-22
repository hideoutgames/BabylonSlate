import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, decodeFoliageChunk, serializeFoliageProperties, type SerializedScene } from "@haptic/core";
import {
  collectFoliageChunksForPlay,
  extractFoliageChunks,
  foliageChunkIdsInHeader,
  hydrateFoliageChunksToEditor,
} from "./foliage-chunks";

const props = serializeFoliageProperties({ groupId: "g", batches: [
  { modelGuid: "oak", materialGuid: null, cullDistance: 1, fadeRange: 1, shadowDistance: 1, transforms: new Float32Array([1, 2, 3, 0, 0, 0, 1, 1, 1, 1]) },
] });

function sceneWith(properties: Record<string, unknown>): SerializedScene {
  return { ...createDefaultScene(), actors: [createActor("a", "Trees", { components: [
    { id: "trees", classId: "FoliageComponent", properties },
    { id: "mesh", classId: "MeshComponent", properties: {} },
  ] })] };
}
const foliageOf = (scene: SerializedScene) => scene.actors[0]!.components[0]!.properties;

describe("foliage chunks", () => {
  it("moves base64 data into a raw chunk named by chunkId and restores it for the editor", () => {
    const scene = sceneWith({ ...props });
    const { payload, chunks } = extractFoliageChunks(scene);
    expect(chunks.map((chunk) => [chunk.id, chunk.kind, chunk.mime])).toEqual([["foliage:trees", "foliage", "application/octet-stream"]]);
    expect(Array.from(decodeFoliageChunk(chunks[0]!.data)[0]!)).toEqual([1, 2, 3, 0, 0, 0, 1, 1, 1, 1]);
    expect(foliageOf(payload)).toEqual({ groupId: "g", batches: props.batches, chunkId: "foliage:trees" });
    // Other components keep their identity.
    expect(payload.actors[0]!.components[1]).toBe(scene.actors[0]!.components[1]);
    expect(foliageChunkIdsInHeader([{ id: "document" }, { id: "foliage:trees" }, { id: "landscape:x" }])).toEqual(["foliage:trees"]);
    const restored = hydrateFoliageChunksToEditor(payload, new Map(chunks.map((chunk) => [chunk.id, chunk.data])));
    expect(foliageOf(restored)).toEqual({ groupId: "g", batches: props.batches, data: props.data });
  });

  it("drops unreadable data and writes no chunk for an empty component", () => {
    const { payload, chunks } = extractFoliageChunks(sceneWith({ groupId: "g", batches: props.batches, data: "AAAA" }));
    expect(chunks).toEqual([]);
    expect(foliageOf(payload)).toEqual({ groupId: "g", batches: props.batches });
    expect(extractFoliageChunks(sceneWith({ groupId: "g", batches: [], data: null })).chunks).toEqual([]);
  });

  it("keeps a chunkId whose chunk is missing or does not match, rather than inventing instances", () => {
    const stored = sceneWith({ groupId: "g", batches: [...props.batches, ...props.batches], chunkId: "foliage:trees" });
    const chunk = extractFoliageChunks(sceneWith({ ...props })).chunks[0]!.data;
    expect(foliageOf(hydrateFoliageChunksToEditor(stored, new Map([["foliage:trees", chunk]])))).toMatchObject({ chunkId: "foliage:trees" });
    expect(collectFoliageChunksForPlay(stored, new Map([["foliage:trees", chunk]])).chunks.size).toBe(0);
  });

  it("prepares Play from unsaved data and from stored chunks without base64", () => {
    const unsaved = collectFoliageChunksForPlay(sceneWith({ ...props }));
    expect([...unsaved.chunks.keys()]).toEqual(["foliage:trees"]);
    expect(foliageOf(unsaved.payload)).toEqual({ groupId: "g", batches: props.batches, chunkId: "foliage:trees" });
    const bytes = unsaved.chunks.get("foliage:trees")!;
    const stored = collectFoliageChunksForPlay(unsaved.payload, new Map([["foliage:trees", bytes]]));
    expect(stored.payload).toBe(unsaved.payload);
    expect(stored.chunks.get("foliage:trees")).toBe(bytes);
  });
});
