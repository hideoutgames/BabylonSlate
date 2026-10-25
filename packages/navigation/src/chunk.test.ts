import { describe, expect, it } from "vitest";
import {
  NAVMESH_CHUNK_ID,
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
});
