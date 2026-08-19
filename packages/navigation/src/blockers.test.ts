import { describe, expect, it } from "vitest";
import {
  recastMeshesFromCollider2d,
  recastWalkableQuadFromXy,
  recastWallsFromXyChains,
  solidBlockerMesh,
  staticBlockerBakeParts,
  xyBoundsFromActors,
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

describe("staticBlockerBakeParts", () => {
  const blocker = (
    properties: Record<string, unknown>,
    position: [number, number, number] = [1, 2, 3],
    scale?: [number, number, number],
  ) => ({
    transform: { position, ...(scale ? { scale } : {}) },
    components: [{ classId: "NavMeshBlockerComponent", properties }],
  });

  it("skips dynamic and cost-area blockers", () => {
    expect(
      staticBlockerBakeParts(
        [
          blocker({ dynamic: true, kind: "box" }),
          blocker({ area: "cost", kind: "box" }),
        ],
        "3d",
      ),
    ).toEqual([]);
  });

  it("drops static blockers whose AABB misses bake bounds", () => {
    const parts = staticBlockerBakeParts(
      [
        blocker({ kind: "box" }, [0, 1, 0], [2, 2, 2]),
        blocker({ kind: "box" }, [40, 1, 0], [2, 2, 2]),
      ],
      "3d",
      {
        min: { x: -2, y: -2, z: -2 },
        max: { x: 2, y: 4, z: 2 },
      },
    );
    expect(parts).toHaveLength(1);
  });

  it("remaps 2D blocker pose onto Recast XZ with fixed height", () => {
    const parts = staticBlockerBakeParts(
      [blocker({ kind: "cylinder" }, [4, 6, 9], [2, 3, 5])],
      "2d",
    );
    expect(parts).toHaveLength(1);
    // worldToRecast maps XY → XZ; Y becomes wall mid-height (1).
    expect(parts[0]!.positions.length).toBeGreaterThan(9);
  });

  it("keeps 3D blocker pose and scale axes", () => {
    const parts = staticBlockerBakeParts(
      [blocker({ kind: "box" }, [1, 2, 3], [4, 5, 6])],
      "3d",
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]!.positions.length).toBeGreaterThanOrEqual(8 * 3);
  });

  it("rotates 3D bake verts by the actor quaternion", () => {
    const identity = staticBlockerBakeParts(
      [blocker({ kind: "box" }, [0, 0, 0], [4, 2, 2])],
      "3d",
    );
    const rotated = staticBlockerBakeParts(
      [
        {
          transform: {
            position: [0, 0, 0],
            rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
            scale: [4, 2, 2],
          },
          components: [{ classId: "NavMeshBlockerComponent", properties: { kind: "box" } }],
        },
      ],
      "3d",
    );
    expect(rotated).toHaveLength(1);
    const maxAbs = (positions: ArrayLike<number>, axis: 0 | 1 | 2) => {
      let max = 0;
      for (let i = axis; i < positions.length; i += 3) {
        max = Math.max(max, Math.abs(positions[i]!));
      }
      return max;
    };
    expect(maxAbs(identity[0]!.positions, 0)).toBeCloseTo(2, 5);
    expect(maxAbs(identity[0]!.positions, 2)).toBeCloseTo(1, 5);
    expect(maxAbs(rotated[0]!.positions, 0)).toBeCloseTo(1, 5);
    expect(maxAbs(rotated[0]!.positions, 2)).toBeCloseTo(2, 5);
  });
});

describe("xyBoundsFromActors", () => {
  it("pads empty actor lists to a centered default bounds", () => {
    expect(xyBoundsFromActors([], 5)).toEqual({
      minX: -5,
      minY: -5,
      maxX: 5,
      maxY: 5,
    });
  });

  it("pads actor positions", () => {
    expect(
      xyBoundsFromActors(
        [
          {
            transform: { position: [0, 0, 0] },
            components: [],
          },
          {
            transform: { position: [10, 4, 0] },
            components: [],
          },
        ],
        2,
      ),
    ).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 6 });
  });
});

describe("recastMeshesFromCollider2d", () => {
  it("returns empty for missing shape or undersized polylines", () => {
    expect(recastMeshesFromCollider2d({ x: 0, y: 0 }, undefined)).toEqual([]);
    expect(
      recastMeshesFromCollider2d(
        { x: 0, y: 0 },
        { kind: "chain", points: [{ x: 1, y: 1 }] },
      ),
    ).toEqual([]);
  });

  it("builds walls for chain/polygon and solids for circle/box2d", () => {
    const chain = recastMeshesFromCollider2d(
      { x: 1, y: 2 },
      {
        kind: "chain",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      },
    );
    expect(chain).toHaveLength(1);
    expect(chain[0]!.positions.length).toBeGreaterThan(9);

    const polygon = recastMeshesFromCollider2d(
      { x: 0, y: 0 },
      {
        kind: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
      },
    );
    expect(polygon).toHaveLength(1);

    const circle = recastMeshesFromCollider2d(
      { x: 3, y: 4 },
      { kind: "circle", radius: 1.5 },
    );
    expect(circle).toHaveLength(1);

    const box = recastMeshesFromCollider2d(
      { x: 0, y: 0 },
      { kind: "box2d", halfExtents: { x: 2, y: 1 } },
    );
    expect(box).toHaveLength(1);
  });
});
