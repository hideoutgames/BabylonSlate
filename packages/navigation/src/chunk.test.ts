import { describe, expect, it } from "vitest";
import {
  NAVMESH_CHUNK_ID,
  extraChunksWithNavmesh,
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

  it("replaces an existing navmesh extra chunk", () => {
    const first = extraChunksWithNavmesh(
      [{ id: "pixels", kind: "pixels", mime: "image/png", data: new Uint8Array([1]) }],
      new Uint8Array([2, 3]),
    );
    const second = extraChunksWithNavmesh(first, new Uint8Array([9]));
    const navmesh = second.filter((chunk) => chunk.id === NAVMESH_CHUNK_ID);
    expect(navmesh).toHaveLength(1);
    expect(navmesh[0]?.data).toEqual(new Uint8Array([9]));
    expect(second.some((chunk) => chunk.id === "pixels")).toBe(true);
  });
});
