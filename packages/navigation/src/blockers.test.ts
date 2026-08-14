import { describe, expect, it } from "vitest";
import {
  recastWalkableQuadFromXy,
  recastWallsFromXyChains,
  solidBlockerMesh,
} from "./blockers";

describe("solidBlockerMesh", () => {
  it("emits a closed box that Recast can voxelise as a carve", () => {
    const mesh = solidBlockerMesh({
      kind: "box",
      pose: { x: 0, y: 1, z: 0 },
      size: { x: 2, y: 2, z: 2 },
    });
    expect(mesh.positions.length).toBeGreaterThanOrEqual(8 * 3);
    expect(mesh.indices.length).toBeGreaterThanOrEqual(12 * 3);
  });

  it("emits a cylinder prism for dynamic/static cylinder blockers", () => {
    const mesh = solidBlockerMesh({
      kind: "cylinder",
      pose: { x: 1, y: 0, z: 1 },
      size: { x: 0.5, y: 2, z: 0.5 },
    });
    expect(mesh.positions.length).toBeGreaterThan(9);
    expect(mesh.indices.length).toBeGreaterThan(3);
  });
});

describe("2D bake remap", () => {
  it("builds a Recast XZ walkable quad from an XY bounds", () => {
    const quad = recastWalkableQuadFromXy({ minX: -5, minY: -5, maxX: 5, maxY: 5 });
    expect(quad.indices).toEqual([0, 3, 2, 0, 2, 1]);
    expect(quad.positions[1]).toBe(0);
    expect(quad.positions[4]).toBe(0);
  });

  it("extrudes XY collision chains into Recast XZ walls", () => {
    const walls = recastWallsFromXyChains(
      [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }], loop: false }],
      2,
    );
    expect(walls.positions.length).toBeGreaterThan(9);
    expect(walls.indices.length).toBeGreaterThanOrEqual(6);
  });
});
