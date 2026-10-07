import { describe, expect, it } from "vitest";
import { buildBoxGlbFixture } from "./glb-geometry";
import {
  complexCollisionMeshForMeshKind,
  complexCollisionModelGuids,
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
        autoLod: true,
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
    expect(box.positions).toHaveLength(8 * 3);
    expect(box.indices.length).toBeGreaterThan(0);
    expect(box.indices.length % 3).toBe(0);
  });
});

describe("complexCollisionModelGuids", () => {
  const mesh = (assetGuid: string, collisionMode?: string) => ({
    id: assetGuid, classId: "MeshComponent",
    properties: { assetGuid, ...(collisionMode ? { collisionMode } : {}) },
  });

  it("selects complex Models from Scene actors and Class prefab components only", () => {
    const scene = { actors: [{ id: "rock", components: [mesh("rock-model", "complex"), mesh("crate-model", "simple")] }] };
    const layer = { actors: [{ id: "sign", components: [mesh("sign-model", "none")] }] };
    const enemyClass = { components: [mesh("enemy-model", "complex"), { id: "c", classId: "ColliderComponent", properties: { collisionMode: "complex", assetGuid: "not-a-mesh" } }] };
    const legacy = { components: [mesh("legacy-model")] };
    const primitive = { components: [{ id: "p", classId: "MeshComponent", properties: { meshKind: "box", collisionMode: "complex" } }] };
    expect(complexCollisionModelGuids([scene, layer, enemyClass, legacy, primitive, null, "text"]))
      .toEqual(new Set(["rock-model", "enemy-model"]));
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
        autoLod: true,
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
        autoLod: true,
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
            autoLod: true,
          },
        ],
      ]),
    );
    const mesh = meshes.get("model-1");
    // The unit box fixture has 8 corners; Import Scale 2 bakes them to ±1.
    expect(mesh?.positions).toBeInstanceOf(Float32Array);
    expect(mesh?.indices).toBeInstanceOf(Uint16Array);
    expect(mesh?.positions).toHaveLength(8 * 3);
    expect(mesh?.indices).toHaveLength(36);
    expect(Math.max(...mesh!.positions)).toBe(1);
    expect(cookComplexCollisionMeshes(new Map([["model-1", buildBoxGlbFixture(1)]]), undefined, new Set())).toEqual(new Map());
  });
});


it("omits degenerate pole triangles while preserving complex sphere bounds", () => {
  const { positions, indices } = complexCollisionMeshForMeshKind("sphere");
  const vertices = Array.from({ length: positions.length / 3 }, (_, i) => ({
    x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]!,
  }));
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertices[indices[i]!]!, b = vertices[indices[i + 1]!]!, c = vertices[indices[i + 2]!]!;
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const twiceArea = Math.hypot(ab.y * ac.z - ab.z * ac.y, ab.z * ac.x - ab.x * ac.z, ab.x * ac.y - ab.y * ac.x);
    expect(twiceArea).toBeGreaterThan(1e-8);
    area += twiceArea / 2;
  }
  expect(area).toBeGreaterThan(6);
  expect(area).toBeLessThan(4 * Math.PI * 0.75 ** 2);
  expect(Math.max(...vertices.map(p => p.y))).toBeCloseTo(0.75);
  expect(Math.min(...vertices.map(p => p.y))).toBeCloseTo(-0.75);
});
