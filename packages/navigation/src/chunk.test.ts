import { describe, expect, it } from "vitest";
import {
  NAVMESH_CHUNK_ID,
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
});
