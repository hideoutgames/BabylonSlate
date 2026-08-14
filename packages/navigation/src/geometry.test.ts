import { describe, expect, it } from "vitest";
import { mergeNavBakeMeshes } from "./geometry";

describe("mergeNavBakeMeshes", () => {
  it("concatenates world-space triangles and offsets indices", () => {
    const merged = mergeNavBakeMeshes([
      {
        positions: [0, 0, 0, 1, 0, 0, 1, 0, 1],
        indices: [0, 1, 2],
      },
      {
        positions: [2, 0, 0, 3, 0, 0, 3, 0, 1],
        indices: [0, 1, 2],
      },
    ]);
    expect(Array.from(merged.positions)).toEqual([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 2, 0, 0, 3, 0, 0, 3, 0, 1,
    ]);
    expect(Array.from(merged.indices)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("applies a per-mesh transform before merging", () => {
    const merged = mergeNavBakeMeshes([
      {
        positions: [0, 0, 0],
        indices: [0],
        transform: (x, y, z) => ({ x: x + 10, y, z }),
      },
    ]);
    expect(merged.positions[0]).toBe(10);
  });
});
