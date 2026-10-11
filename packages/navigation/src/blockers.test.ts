import { describe, expect, it } from "vitest";
import {
  recastMeshesFromCollider2d,
  recastWalkableQuadFromXy,
  recastWallsFromXyChains,
  solidBlockerMesh,
  staticBlockerBakeParts,
  xyBoundsFromActors,
} from "./blockers";

/** Min/max of a flat xyz array on each axis. */
function extents(positions: ArrayLike<number>): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 1) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  return { min, max };
}

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

  it("emits a cylinder whose X/Z sizes are diameters", () => {
    const mesh = solidBlockerMesh({
      kind: "cylinder",
      pose: { x: 1, y: 0, z: 1 },
      size: { x: 2, y: 2, z: 4 },
    });
    const { min, max } = extents(mesh.positions);
    expect(min[0]).toBeCloseTo(0, 5);
    expect(max[0]).toBeCloseTo(2, 5);
    expect(max[2]! - min[2]!).toBeCloseTo(4, 5);
    expect(max[1]! - min[1]!).toBeCloseTo(2, 5);
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

  it("extrudes a diagonal edge along the edge, not as its bounding box", () => {
    const walls = recastWallsFromXyChains(
      [{ points: [{ x: 0, y: 0 }, { x: 4, y: 4 }], loop: false }],
      2,
    );
    for (let i = 0; i < walls.positions.length; i += 3) {
      // Recast (x, _, z) is world (x, y); every corner sits half a wall from y = x.
      const distance = Math.abs(walls.positions[i]! - walls.positions[i + 2]!) / Math.SQRT2;
      expect(distance).toBeCloseTo(0.4, 5);
    }
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

  it("bakes a parented blocker at its world pose", () => {
    const quarterTurn = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number];
    const parts = staticBlockerBakeParts(
      [
        { id: "door", parentId: "frame", transform: { position: [1, 0, 0] }, components: [
          { classId: "NavMeshBlockerComponent", properties: { kind: "box" } },
        ] },
        { id: "frame", parentId: null, transform: { position: [10, 0, 0], rotation: quarterTurn, scale: [2, 2, 2] },
          components: [] },
      ],
      "3d",
    );
    // The child's local X turns onto -Z and doubles: center (10, 0, -2), size 2.
    const { min, max } = extents(parts[0]!.positions);
    expect(min).toEqual([expect.closeTo(9, 5), expect.closeTo(-1, 5), expect.closeTo(-3, 5)]);
    expect(max).toEqual([expect.closeTo(11, 5), expect.closeTo(1, 5), expect.closeTo(-1, 5)]);
  });

  it("turns a 2D blocker with its Z rotation, not mirrored", () => {
    const angle = Math.PI / 6;
    const parts = staticBlockerBakeParts(
      [{
        transform: { position: [0, 0, 0], rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)], scale: [4, 1, 1] },
        components: [{ classId: "NavMeshBlockerComponent", properties: { kind: "box" } }],
      }],
      "2d",
    );
    const positions = parts[0]!.positions;
    let farthest = 0;
    for (let i = 3; i < positions.length; i += 3) {
      if (positions[i]! > positions[farthest]!) farthest = i;
    }
    // Local (2, -0.5) turned 30° counterclockwise lands at world (1.98, 0.57), Recast Z = world Y.
    expect(positions[farthest]).toBeCloseTo(2 * Math.cos(angle) + 0.5 * Math.sin(angle), 5);
    expect(positions[farthest + 2]).toBeCloseTo(2 * Math.sin(angle) - 0.5 * Math.cos(angle), 5);
    const { min, max } = extents(positions);
    expect(min[1]).toBeCloseTo(0, 5);
    expect(max[1]).toBeCloseTo(2, 5);
  });

  it("culls 2D blockers by XY only", () => {
    const parts = staticBlockerBakeParts(
      [blocker({ kind: "box" }, [0, 0, 50])],
      "2d",
      { min: { x: -5, y: -5, z: 5 }, max: { x: 5, y: 5, z: 10 } },
    );
    expect(parts).toHaveLength(1);
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

  it("covers the walls baked on the floor, not only actor origins", () => {
    // 0.8-thick walls from the origin to x = 30 and to y = -20.
    const wall = recastWallsFromXyChains([
      { points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], loop: false },
      { points: [{ x: 0, y: 0 }, { x: 0, y: -20 }], loop: false },
    ], 2);
    expect(xyBoundsFromActors([{ transform: { position: [0, 0, 0] }, components: [] }], 2, [wall])).toEqual({
      minX: expect.closeTo(-2.4, 5),
      minY: expect.closeTo(-22, 5),
      maxX: expect.closeTo(32, 5),
      maxY: expect.closeTo(2.4, 5),
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

  it("stands a circle on the walk plane at its radius", () => {
    const [circle] = recastMeshesFromCollider2d({ x: 3, y: 4 }, { kind: "circle", radius: 1.5 }, 2);
    const { min, max } = extents(circle!.positions);
    expect([min[0], min[1], max[1], max[2]]).toEqual([
      expect.closeTo(1.5, 5), expect.closeTo(0, 5), expect.closeTo(2, 5), expect.closeTo(5.5, 5),
    ]);
  });

  it("turns a box by the collider's planar angle", () => {
    const [box] = recastMeshesFromCollider2d(
      { x: 1, y: 0, angle: Math.PI / 2 },
      { kind: "box2d", halfExtents: { x: 2, y: 0.5 } },
    );
    const { min, max } = extents(box!.positions);
    expect([min[0], max[0], min[2], max[2]]).toEqual([
      expect.closeTo(0.5, 5), expect.closeTo(1.5, 5), expect.closeTo(-2, 5), expect.closeTo(2, 5),
    ]);
  });

  it("bakes a 2D capsule as a stadium along its Y axis", () => {
    const parts = recastMeshesFromCollider2d({ x: 0, y: 0 }, { kind: "capsule2d", radius: 0.25, halfHeight: 0.5 });
    const { min, max } = extents(parts.flatMap((part) => Array.from(part.positions)));
    expect(min[0]).toBeCloseTo(-0.25, 5);
    expect(max[0]).toBeCloseTo(0.25, 5);
    expect(min[2]).toBeCloseTo(-0.75, 5);
    expect(max[2]).toBeCloseTo(0.75, 5);
  });
});
