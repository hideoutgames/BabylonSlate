import { beforeAll, describe, expect, it } from "vitest";
import { generateNavMesh, initNavigation } from "./recast-backend";
import { navMeshDebugPrimitives } from "./debug-primitives";

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
});
