import { beforeAll, describe, expect, it } from "vitest";
import { generateNavMesh } from "./bake";
import { initNavigation } from "./recast-backend";
import { navMeshDebugPrimitives } from "./debug-primitives";
import { trackRecastHandles } from "./recast-test-handles";

function groundPrism(): { positions: number[]; indices: number[] } {
  const half = 10;
  return {
    positions: [
      -half, 0, -half,
      half, 0, -half,
      half, 0, half,
      -half, 0, half,
    ],
    indices: [0, 3, 2, 0, 2, 1],
  };
}

describe("navMeshDebugPrimitives", () => {
  let bytes: Uint8Array;

  beforeAll(async () => {
    await initNavigation();
    bytes = await generateNavMesh(groundPrism());
  });

  it("returns Recast triangle primitives from baked bytes", () => {
    const primitives = navMeshDebugPrimitives(bytes);
    expect(primitives.some((primitive) => primitive.type === "tris")).toBe(true);
    const tris = primitives.find((primitive) => primitive.type === "tris");
    expect(tris?.vertices.length).toBeGreaterThan(2);
  });

  it("draws HPNT tile-cache navmeshes repeatedly when dynamic obstacles are enabled", async () => {
    const handles = trackRecastHandles(["NavMeshExport"]);
    try {
      const tiled = await generateNavMesh({ ...groundPrism(), settings: { supportDynamicObstacles: true } });
      for (let i = 0; i < 3; i += 1) {
        const primitives = navMeshDebugPrimitives(tiled);
        const tris = primitives.find((primitive) => primitive.type === "tris");
        expect(tris?.vertices.length).toBeGreaterThan(2);
      }
      // The bake and each decode free what they made: the import request, and the tile cache with its wrapper.
      expect(handles.made()).toEqual({ NavMeshExport: 3 });
      expect(handles.live()).toEqual({ NavMeshExport: 0 });
      expect(handles.tileCachesFreed()).toBe(4);
      expect(handles.tileCacheWrappersLeft()).toBe(0);
    } finally {
      handles.restore();
    }
  });
});
