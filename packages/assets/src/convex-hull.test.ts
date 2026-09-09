import { describe, expect, it } from "vitest";
import {
  convexHull3d,
  convexHullMesh,
  GENERATED_COLLISION_MAX_POINTS,
} from "./convex-hull";

function cubeCorners(): Array<{ x: number; y: number; z: number }> {
  const h = 0.5;
  return [
    { x: -h, y: -h, z: -h },
    { x: h, y: -h, z: -h },
    { x: h, y: h, z: -h },
    { x: -h, y: h, z: -h },
    { x: -h, y: -h, z: h },
    { x: h, y: -h, z: h },
    { x: h, y: h, z: h },
    { x: -h, y: h, z: h },
  ];
}

describe("convexHull3d", () => {
  it("exports closed outward triangle geometry for collision queries", () => {
    const { vertices, indices } = convexHullMesh([
      ...cubeCorners(),
      { x: 0, y: 0, z: 0 },
    ]);
    let volume = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const a = vertices[indices[i]!]!;
      const b = vertices[indices[i + 1]!]!;
      const c = vertices[indices[i + 2]!]!;
      volume +=
        (a.x * (b.y * c.z - b.z * c.y) +
          a.y * (b.z * c.x - b.x * c.z) +
          a.z * (b.x * c.y - b.y * c.x)) /
        6;
    }
    expect(volume).toBeCloseTo(1);
    expect(convexHullMesh([{ x: 0, y: 0, z: 0 }]).indices).toEqual([]);
  });
  it("keeps the eight cube corners and drops interior points", () => {
    const hull = convexHull3d([
      ...cubeCorners(),
      { x: 0, y: 0, z: 0 },
      { x: 0.1, y: 0.1, z: 0.1 },
    ]);
    expect(hull).toHaveLength(8);
    for (const corner of cubeCorners()) {
      expect(
        hull.some(
          (point) =>
            Math.abs(point.x - corner.x) < 1e-6 &&
            Math.abs(point.y - corner.y) < 1e-6 &&
            Math.abs(point.z - corner.z) < 1e-6,
        ),
      ).toBe(true);
    }
  });

  it("returns an empty hull for collinear or coplanar clouds", () => {
    expect(
      convexHull3d([
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
      ]),
    ).toEqual([]);
    expect(
      convexHull3d([
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
      ]),
    ).toEqual([]);
  });

  it("caps hull vertices at the generated-collision budget", () => {
    const cloud: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 40; i++) {
      const theta = (i / 40) * Math.PI * 2;
      for (let j = 0; j < 8; j++) {
        const phi = (j / 7) * Math.PI;
        cloud.push({
          x: Math.sin(phi) * Math.cos(theta),
          y: Math.cos(phi),
          z: Math.sin(phi) * Math.sin(theta),
        });
      }
    }
    expect(convexHull3d(cloud).length).toBeLessThanOrEqual(
      GENERATED_COLLISION_MAX_POINTS,
    );
  });
});
