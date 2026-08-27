import { describe, expect, it } from "vitest";
import { buildBoxGlbFixture } from "./glb-geometry";
import {
  complexCollisionMeshForMeshKind,
  cookComplexCollisionMeshes,
  meshCollisionFingerprint,
  parseMeshCollisionMode,
  resolveMeshCollisions,
  resolveMeshSimpleColliders,
  simpleCollidersForMeshKind,
} from "./mesh-collision";

describe("parseMeshCollisionMode", () => {
  it("treats a missing field as Use Simple Collision", () => {
    expect(parseMeshCollisionMode(undefined)).toBe("simple");
    expect(parseMeshCollisionMode("complex")).toBe("complex");
    expect(parseMeshCollisionMode("none")).toBe("none");
  });
});

describe("simpleCollidersForMeshKind", () => {
  it("matches createPrimitiveMesh sizes", () => {
    expect(simpleCollidersForMeshKind("box")[0]).toMatchObject({
      kind: "box",
      halfExtents: { x: 0.75, y: 0.75, z: 0.75 },
    });
    expect(simpleCollidersForMeshKind("sphere")[0]).toMatchObject({
      kind: "sphere",
      radius: 0.75,
    });
    expect(simpleCollidersForMeshKind("cylinder")[0]).toMatchObject({
      kind: "cylinder",
      radius: 0.5,
      height: 1.5,
    });
    expect(simpleCollidersForMeshKind("plane")[0]).toMatchObject({
      kind: "box",
      halfExtents: { x: 0.75, y: 0.75, z: 0.01 },
    });
    expect(simpleCollidersForMeshKind("ground")[0]).toMatchObject({
      kind: "box",
      halfExtents: { x: 5, y: 0.01, z: 5 },
    });
  });
});

describe("resolveMeshSimpleColliders", () => {
  it("uses Model payload colliders when a guid is bound", () => {
    const colliders = resolveMeshSimpleColliders(
      { collisionMode: "simple", assetGuid: "model-1" },
      {
        materialSlots: [],
        clipNames: [],
        skeletonGuid: null,
        importScale: 1,
        simpleColliders: [
          {
            id: "hull",
            name: "Generated Collision",
            kind: "generated",
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            points: [{ x: 0, y: 0, z: 0 }],
          },
        ],
      },
    );
    expect(colliders).toHaveLength(1);
    expect(colliders[0]!.id).toBe("hull");
  });

  it("uses primitive built-ins when there is no Model guid", () => {
    expect(
      resolveMeshSimpleColliders({ meshKind: "sphere" })[0]?.kind,
    ).toBe("sphere");
  });

  it("emits nothing for complex or none", () => {
    expect(
      resolveMeshSimpleColliders({ collisionMode: "none", meshKind: "box" }),
    ).toEqual([]);
    expect(
      resolveMeshSimpleColliders({ collisionMode: "complex", meshKind: "box" }),
    ).toEqual([]);
  });
});

describe("resolveMeshCollisions", () => {
  it("emits a primitive box for simple mode without a Model", () => {
    const shapes = resolveMeshCollisions({ meshKind: "box" });
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.shape).toEqual({
      kind: "box",
      halfExtents: { x: 0.75, y: 0.75, z: 0.75 },
    });
  });

  it("emits a triangle mesh for complex primitives", () => {
    const shapes = resolveMeshCollisions({
      collisionMode: "complex",
      meshKind: "box",
    });
    expect(shapes[0]!.shape.kind).toBe("mesh");
  });

  it("emits nothing when mode is none", () => {
    expect(resolveMeshCollisions({ collisionMode: "none", meshKind: "box" })).toEqual(
      [],
    );
  });
});

describe("complexCollisionMeshForMeshKind", () => {
  it("tessellates primitives into a triangle soup", () => {
    const box = complexCollisionMeshForMeshKind("box");
    expect(box.vertices).toHaveLength(8);
    expect(box.indices.length).toBeGreaterThan(0);
    expect(box.indices.length % 3).toBe(0);
  });
});

describe("meshCollisionFingerprint", () => {
  it("changes when collision mode or Model hulls change", () => {
    expect(meshCollisionFingerprint({ meshKind: "box" })).toBe("simple:box");
    expect(meshCollisionFingerprint({ collisionMode: "none", meshKind: "box" })).toBe(
      "none",
    );
    const before = meshCollisionFingerprint(
      { collisionMode: "simple", assetGuid: "model-1" },
      {
        materialSlots: [],
        clipNames: [],
        skeletonGuid: null,
        importScale: 1,
        simpleColliders: [],
      },
    );
    const after = meshCollisionFingerprint(
      { collisionMode: "simple", assetGuid: "model-1" },
      {
        materialSlots: [],
        clipNames: [],
        skeletonGuid: null,
        importScale: 1,
        simpleColliders: [
          {
            id: "hull",
            name: "Generated Collision",
            kind: "generated",
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            points: [{ x: 1, y: 0, z: 0 }],
          },
        ],
      },
    );
    expect(after).not.toBe(before);
  });
});

describe("cookComplexCollisionMeshes", () => {
  it("cooks triangle soup from GLB bytes on the host", () => {
    const meshes = cookComplexCollisionMeshes(
      new Map([["model-1", buildBoxGlbFixture(1)]]),
      new Map([
        [
          "model-1",
          {
            materialSlots: [],
            clipNames: [],
            skeletonGuid: null,
            importScale: 2,
            simpleColliders: [],
          },
        ],
      ]),
    );
    const mesh = meshes.get("model-1");
    expect(mesh?.vertices.length).toBeGreaterThanOrEqual(3);
    expect(mesh?.indices.length).toBeGreaterThan(0);
    expect(mesh?.vertices.some((point) => Math.abs(point.x) > 0.9)).toBe(true);
  });
});
