import { describe, expect, it } from "vitest";
import {
  NAVMESH_CHUNK_ID,
  extraChunksWithNavmesh,
  navmeshBytesFromChunks,
  navmeshChunk,
} from "./chunk";

describe("navmesh scene chunk", () => {
  it("wraps bake bytes as a navmesh extra chunk", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(navmeshChunk(data)).toEqual({
      id: NAVMESH_CHUNK_ID,
      kind: "navmesh",
      mime: "application/octet-stream",
      data,
    });
  });

  it("reads bake bytes back from extra chunks", () => {
    const data = new Uint8Array([9, 8, 7]);
    expect(navmeshBytesFromChunks([navmeshChunk(data)])).toEqual(data);
  });

  it("returns null when the scene has no navmesh chunk", () => {
    expect(
      navmeshBytesFromChunks([{ id: "document", data: new Uint8Array([1]) }]),
    ).toBeNull();
  });

  it("replaces an existing navmesh extra chunk", () => {
    const first = extraChunksWithNavmesh(
      [{ id: "pixels", kind: "pixels", mime: "image/png", data: new Uint8Array([1]) }],
      new Uint8Array([2, 3]),
    );
    const second = extraChunksWithNavmesh(first, new Uint8Array([9]));
    expect(second.filter((chunk) => chunk.id === NAVMESH_CHUNK_ID)).toHaveLength(1);
    expect(navmeshBytesFromChunks(second)).toEqual(new Uint8Array([9]));
    expect(second.some((chunk) => chunk.id === "pixels")).toBe(true);
  });
});
