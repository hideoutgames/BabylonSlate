import { describe, expect, it } from "vitest";
import { buildBoxGlbFixture } from "./glb-geometry";
import { extractGltfPositions } from "./glb-geometry";
import {
  cookGeneratedCollisionFromGltf,
  generateSimpleCollisionFromPoints,
  normalizeModelSimpleColliders,
  simpleColliderToPhysicsShape,
} from "./simple-collision";

describe("normalizeModelSimpleColliders", () => {
  it("treats missing or non-array values as an empty list", () => {
    expect(normalizeModelSimpleColliders(undefined)).toEqual([]);
    expect(normalizeModelSimpleColliders({})).toEqual([]);
  });

  it("fills identity TRS and default sizes for authored kinds", () => {
    const [box] = normalizeModelSimpleColliders([{ kind: "box", id: "a" }]);
    expect(box).toMatchObject({
      id: "a",
      kind: "box",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
    });
  });
});

describe("generateSimpleCollisionFromPoints", () => {
  it("cooks a generated hull from a cube, not an AABB box kind", () => {
    const collider = generateSimpleCollisionFromPoints([
      { x: -1, y: -1, z: -1 },
      { x: 1, y: -1, z: -1 },
      { x: 1, y: 1, z: -1 },
      { x: -1, y: 1, z: -1 },
      { x: -1, y: -1, z: 1 },
      { x: 1, y: -1, z: 1 },
      { x: 1, y: 1, z: 1 },
      { x: -1, y: 1, z: 1 },
    ]);
    expect(collider.kind).toBe("generated");
    expect(collider.points).toHaveLength(8);
  });

  it("falls back to a bounds box when the cloud has no volume", () => {
    const collider = generateSimpleCollisionFromPoints([
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ]);
    expect(collider.kind).toBe("box");
    expect(collider.halfExtents?.x).toBeCloseTo(1);
    expect(collider.name).toBe("Generated Collision");
  });
});

describe("cookGeneratedCollisionFromGltf", () => {
  it("extracts world-space cube corners from a unit box GLB", () => {
    const glb = buildBoxGlbFixture(2);
    const points = extractGltfPositions(glb);
    expect(points).toHaveLength(8);
    expect(
      points.some(
        (point) =>
          Math.abs(point.x - 1) < 1e-5 &&
          Math.abs(point.y - 1) < 1e-5 &&
          Math.abs(point.z - 1) < 1e-5,
      ),
    ).toBe(true);
    const cooked = cookGeneratedCollisionFromGltf(glb, { importScale: 2 });
    expect(cooked.kind).toBe("generated");
    expect(
      cooked.points?.some(
        (point) =>
          Math.abs(point.x - 2) < 1e-4 &&
          Math.abs(point.y - 2) < 1e-4 &&
          Math.abs(point.z - 2) < 1e-4,
      ),
    ).toBe(true);
  });
});

describe("simpleColliderToPhysicsShape", () => {
  it("bakes cone to a convex prism and keeps cylinder as a cylinder", () => {
    const cone = simpleColliderToPhysicsShape({
      id: "c",
      name: "Cone",
      kind: "cone",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      radius: 0.5,
      height: 1,
    });
    expect(cone.kind).toBe("convex");
    if (cone.kind === "convex") {
      expect(cone.points.length).toBeGreaterThan(4);
    }
    expect(
      simpleColliderToPhysicsShape({
        id: "y",
        name: "Cylinder",
        kind: "cylinder",
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        radius: 0.5,
        height: 1.5,
      }),
    ).toEqual({ kind: "cylinder", radius: 0.5, height: 1.5 });
  });
});
