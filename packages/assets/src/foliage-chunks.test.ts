import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, decodeFoliageChunk, serializeFoliageProperties, type SerializedScene } from "@haptic/core";
import {
  collectFoliageChunksForPlay,
  extractFoliageChunks,
  foliageChunkIdsInHeader,
  hydrateFoliageChunksToEditor,
} from "./foliage-chunks";
import { unreadableComponentChunks } from "./landscape-chunks";

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
  it("moves base64 data into a raw chunk named by actor and component, and restores it for the editor", () => {
    const scene = sceneWith({ ...props });
    const { payload, chunks } = extractFoliageChunks(scene);
    expect(chunks.map((chunk) => [chunk.id, chunk.kind, chunk.mime])).toEqual([["foliage:a/trees", "foliage", "application/octet-stream"]]);
    expect(Array.from(decodeFoliageChunk(chunks[0]!.data)[0]!)).toEqual([1, 2, 3, 0, 0, 0, 1, 1, 1, 1]);
    expect(foliageOf(payload)).toEqual({ groupId: "g", batches: props.batches, chunkId: "foliage:a/trees" });
    // Other components keep their identity.
    expect(payload.actors[0]!.components[1]).toBe(scene.actors[0]!.components[1]);
    expect(foliageChunkIdsInHeader([{ id: "document" }, { id: "foliage:a/trees" }, { id: "landscape:x" }])).toEqual(["foliage:a/trees"]);
    const restored = hydrateFoliageChunksToEditor(payload, new Map(chunks.map((chunk) => [chunk.id, chunk.data])));
    expect(foliageOf(restored)).toEqual({ groupId: "g", batches: props.batches, data: props.data });
  });

  it("gives two instances of one Prefab in a Scene, which share component ids, their own chunks", () => {
    const other = serializeFoliageProperties({ groupId: "g", batches: [
      { modelGuid: "oak", materialGuid: null, cullDistance: 1, fadeRange: 1, shadowDistance: 1, transforms: new Float32Array([9, 9, 9, 0, 0, 0, 1, 1, 1, 1]) },
    ] });
    const scene = { ...createDefaultScene(), actors: [
      createActor("first", "First", { prefabGuid: "grove", components: [{ id: "trees", classId: "FoliageComponent", properties: { ...props } }] }),
      createActor("second", "Second", { prefabGuid: "grove", components: [{ id: "trees", classId: "FoliageComponent", properties: { ...other } }] }),
    ] };
    const { payload, chunks } = extractFoliageChunks(scene);
    expect(chunks.map((chunk) => chunk.id)).toEqual(["foliage:first/trees", "foliage:second/trees"]);
    const restored = hydrateFoliageChunksToEditor(payload, new Map(chunks.map((chunk) => [chunk.id, chunk.data])));
    expect(restored.actors.map((actor) => actor.components[0]!.properties.data)).toEqual([props.data, other.data]);
    const played = collectFoliageChunksForPlay(scene, undefined);
    expect([...played.chunks.keys()]).toEqual(["foliage:first/trees", "foliage:second/trees"]);
  });

  it("keeps unreadable data inline and reports it instead of dropping it", () => {
    const { payload, chunks } = extractFoliageChunks(sceneWith({ groupId: "g", batches: props.batches, data: "AAAA" }));
    expect(chunks).toEqual([]);
    expect(foliageOf(payload)).toEqual({ groupId: "g", batches: props.batches, data: "AAAA" });
    expect(unreadableComponentChunks(payload)).toEqual([{ actorName: "Trees", componentId: "trees", kind: "Foliage" }]);
    const empty = extractFoliageChunks(sceneWith({ groupId: "g", batches: [], data: null }));
    expect([empty.chunks, foliageOf(empty.payload), unreadableComponentChunks(empty.payload)]).toEqual([[], { groupId: "g", batches: [] }, []]);
  });

  it("keeps a chunkId whose chunk is missing or does not match, reporting it, rather than inventing instances", () => {
    const stored = sceneWith({ groupId: "g", batches: [...props.batches, ...props.batches], chunkId: "foliage:a/trees" });
    const chunk = extractFoliageChunks(sceneWith({ ...props })).chunks[0]!.data;
    const mismatched = hydrateFoliageChunksToEditor(stored, new Map([["foliage:a/trees", chunk]]));
    expect(foliageOf(mismatched)).toMatchObject({ chunkId: "foliage:a/trees" });
    expect(unreadableComponentChunks(mismatched)).toEqual([{ actorName: "Trees", componentId: "trees", kind: "Foliage" }]);
    expect(unreadableComponentChunks(hydrateFoliageChunksToEditor(stored, new Map()))).toHaveLength(1);
    expect(collectFoliageChunksForPlay(stored, new Map([["foliage:a/trees", chunk]])).chunks.size).toBe(0);
  });

  it("prepares Play from unsaved data and from stored chunks without base64, naming the owner", () => {
    const unsaved = collectFoliageChunksForPlay(sceneWith({ ...props }), undefined);
    expect([...unsaved.chunks.keys()]).toEqual(["foliage:a/trees"]);
    expect(foliageOf(unsaved.payload)).toEqual({ groupId: "g", batches: props.batches, chunkId: "foliage:a/trees" });
    const bytes = unsaved.chunks.get("foliage:a/trees")!;
    const stored = collectFoliageChunksForPlay(extractFoliageChunks(sceneWith({ ...props })).payload, new Map([["foliage:a/trees", bytes]]));
    expect(foliageOf(stored.payload)).toEqual(foliageOf(unsaved.payload));
    expect(stored.chunks.get("foliage:a/trees")).toBe(bytes);
  });
});
