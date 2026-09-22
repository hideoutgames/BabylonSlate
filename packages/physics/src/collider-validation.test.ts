import { expect, it } from "vitest";
import { bakeColliderLocal, rotateQuatVec } from "./collider-bake";
import { copyColliderDesc, normalizedPhysicsPose } from "./collider-validation";

it("preserves scaled asymmetric vertices and one local pose while rejecting non-rigid or degenerate input", () => {
  const shape = {
    kind: "convex" as const,
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 3 },
    ],
  };
  const local = {
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 2 },
    scale: { x: -2, y: 1, z: 0.5 },
  };
  expect(bakeColliderLocal(shape, local, { x: 2, y: 3, z: 4 })).toEqual({
    shape: {
      kind: "convex",
      points: [
        { x: -0, y: 0, z: 0 },
        { x: -8, y: 0, z: 0 },
        { x: -0, y: 3, z: 0 },
        { x: -0, y: 0, z: 6 },
      ],
    },
    translation: { x: 2, y: 6, z: 12 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  expect(() =>
    bakeColliderLocal(
      shape,
      {
        ...local,
        rotation: {
          x: 0,
          y: Math.sin(Math.PI / 8),
          z: 0,
          w: Math.cos(Math.PI / 8),
        },
      },
      { x: 2, y: 1, z: 1 },
    ),
  ).toThrow("shear");
  expect(() => bakeColliderLocal(shape, local, { x: 0, y: 1, z: 1 })).toThrow(
    "nonzero",
  );
  expect(() =>
    normalizedPhysicsPose({
      position: { x: NaN, y: 0, z: 0 },
      rotation: local.rotation,
    }),
  ).toThrow("finite");
  expect(() =>
    normalizedPhysicsPose({
      position: local.position,
      rotation: { x: 0, y: 0, z: 0, w: 0 },
    }),
  ).toThrow("quaternion");
  expect(() =>
    copyColliderDesc({
      id: "bad",
      bodyId: "body",
      shape: { kind: "mesh", vertices: shape.points, indices: [0, 0, 1] },
      friction: 0,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 1,
    }),
  ).toThrow("Degenerate");
});

it("keeps reflected and quarter-turned hulls aligned under nonuniform parent scale", () => {
  const shape = { kind: "convex" as const, points: [{ x: 1, y: 2, z: 3 }] };
  const rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
  const local = {
    position: { x: 1, y: 0, z: 0 },
    rotation,
    scale: { x: 2, y: 3, z: 4 },
  };
  for (const parent of [
    { x: 2, y: 3, z: 4 },
    { x: -2, y: 3, z: 4 },
  ]) {
    const baked = bakeColliderLocal(shape, local, parent);
    expect(baked.shape.kind).toBe("convex");
    if (baked.shape.kind !== "convex") throw new Error("Expected hull");
    const actual = rotateQuatVec(baked.rotation, baked.shape.points[0]!);
    const original = rotateQuatVec(rotation, { x: 2, y: 6, z: 12 });
    expect(actual.x + baked.translation.x).toBeCloseTo(
      original.x * parent.x + parent.x,
    );
    expect(actual.y).toBeCloseTo(original.y * parent.y);
    expect(actual.z).toBeCloseTo(original.z * parent.z);
  }
});
