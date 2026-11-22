import { describe, expect, it } from "vitest";
import { buildBoxGlbFixture } from "./glb-geometry";
import { encodeGlbJsonBin } from "./importers/glb-parse";
import {
  complexCollisionMeshForMeshKind,
  complexCollisionModelGuids,
  cookComplexCollision,
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

const FLOAT = 5126, BYTE = 5120, UNSIGNED_BYTE = 5121, SHORT = 5122, UNSIGNED_SHORT = 5123;
const DRACO = "KHR_draco_mesh_compression";

/** The parts' bytes end to end; each part is a multiple of four bytes, so every view stays aligned. */
function binOf(...parts: ArrayBufferView[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at);
    at += part.byteLength;
  }
  return out;
}

/** A GLB whose scene is node 0; `json` adds or overrides the rest. */
function glbOf(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  return encodeGlbJsonBin({
    asset: { version: "2.0" }, buffers: [{ byteLength: bin.byteLength }], scenes: [{ nodes: [0] }], scene: 0, ...json,
  }, bin);
}

/** One triangle mesh on node 0 from a POSITION accessor 0 (and an index accessor when given). */
function singlePrimitive(node: Record<string, unknown>, primitive: Record<string, unknown> = {}) {
  return { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...primitive }] }], nodes: [{ mesh: 0, ...node }] };
}

function cooked(source: Uint8Array) {
  const { mesh, problem } = cookComplexCollision(source, { materialSlots: [], skeletonGuid: null, importScale: 1, simpleColliders: [], autoLod: true });
  return { positions: mesh && Array.from(mesh.positions), indices: mesh && Array.from(mesh.indices), problem };
}

describe("cookComplexCollision reads glTF geometry as the spec defines it", () => {
  it("dequantizes KHR_mesh_quantization positions: normalized integers, then the node transform", () => {
    // Unsigned shorts padded to 8-byte elements map to [0, 1]; the node's scale and translation span [-1, 1].
    const unsignedShort = glbOf({
      ...singlePrimitive({ translation: [-1, 0, 0], scale: [2, 2, 2] }),
      extensionsRequired: ["KHR_mesh_quantization"],
      bufferViews: [{ buffer: 0, byteLength: 24, byteStride: 8 }],
      accessors: [{ bufferView: 0, componentType: UNSIGNED_SHORT, normalized: true, count: 3, type: "VEC3" }],
    }, binOf(new Uint16Array([0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535, 0, 0])));
    expect(cooked(unsignedShort)).toEqual({ positions: [-1, 0, 0, 1, 0, 0, -1, 2, 0], indices: [0, 1, 2], problem: null });
    // Signed bytes map to [-1, 1] with -128 clamped to -1; a node matrix scales them by 10.
    const signedByte = glbOf({
      ...singlePrimitive({ matrix: [10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 1] }),
      bufferViews: [{ buffer: 0, byteLength: 12, byteStride: 4 }],
      accessors: [{ bufferView: 0, componentType: BYTE, normalized: true, count: 3, type: "VEC3" }],
    }, binOf(new Int8Array([-127, 0, 127, 0, 127, -128, 0, 0, 0, 127, -127, 0])));
    expect(cooked(signedByte).positions).toEqual([-10, 0, 10, 10, -10, 0, 0, 10, -10]);
    // Integer positions that are not normalized are read as they are, and byte indices index them.
    const plainShort = glbOf({
      ...singlePrimitive({ scale: [0.5, 0.5, 0.5] }, { indices: 1 }),
      bufferViews: [{ buffer: 0, byteLength: 24, byteStride: 8 }, { buffer: 0, byteOffset: 24, byteLength: 6 }],
      accessors: [
        { bufferView: 0, componentType: SHORT, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: UNSIGNED_BYTE, count: 6, type: "SCALAR" },
      ],
    }, binOf(new Int16Array([100, 0, 0, 0, 0, 200, 0, 0, 0, 0, -300, 0]), new Uint8Array([0, 1, 2, 2, 1, 0, 0, 0])));
    expect(cooked(plainShort)).toEqual({ positions: [50, 0, 0, 0, 100, 0, 0, 0, -150], indices: [0, 1, 2, 2, 1, 0], problem: null });
  });

  it("applies sparse substitutions over zeros when an accessor has no buffer view", () => {
    const sparse = glbOf({
      ...singlePrimitive({}),
      bufferViews: [{ buffer: 0, byteLength: 4 }, { buffer: 0, byteOffset: 4, byteLength: 24 }],
      accessors: [{
        componentType: FLOAT, count: 3, type: "VEC3",
        sparse: { count: 2, indices: { bufferView: 0, componentType: UNSIGNED_SHORT }, values: { bufferView: 1 } },
      }],
    }, binOf(new Uint16Array([1, 2]), new Float32Array([1, 0, 0, 0, 1, 0])));
    expect(cooked(sparse)).toEqual({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], problem: null });
  });

  it("turns strips and fans into triangle lists and skips lines", () => {
    const modes = glbOf({
      meshes: [{ primitives: [
        { attributes: { POSITION: 0 }, mode: 5 },
        { attributes: { POSITION: 0 }, mode: 1 },
        { attributes: { POSITION: 0 }, mode: 6, indices: 1 },
      ] }],
      nodes: [{ mesh: 0 }],
      bufferViews: [{ buffer: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 8 }],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 4, type: "VEC3" },
        { bufferView: 1, componentType: UNSIGNED_SHORT, count: 4, type: "SCALAR" },
      ],
    }, binOf(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), new Uint16Array([0, 1, 3, 2])));
    const { positions, indices } = cooked(modes);
    expect(positions).toHaveLength(8 * 3);
    // Strip over vertices 0-3, then the fan over its copy at 4-7.
    expect(indices).toEqual([0, 1, 2, 1, 3, 2, 5, 7, 4, 7, 6, 4]);
  });

  // The compressed payload is never valid float data: a reader that ignores the extension cooks garbage or reads
  // past the binary chunk.
  const compressed = binOf(new Uint8Array(40).fill(0xab));
  const fallbackPositions = binOf(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  it.each([
    ["Draco, required", glbOf({
      ...singlePrimitive({}, { extensions: { [DRACO]: { bufferView: 0, attributes: { POSITION: 0 } } } }),
      extensionsUsed: [DRACO], extensionsRequired: [DRACO],
      bufferViews: [{ buffer: 0, byteLength: 40 }],
      accessors: [{ componentType: FLOAT, count: 3, type: "VEC3" }],
    }, compressed), /Draco-compressed/],
    ["Draco, optional without uncompressed data", glbOf({
      ...singlePrimitive({}, { extensions: { [DRACO]: { bufferView: 0, attributes: { POSITION: 0 } } } }),
      extensionsUsed: [DRACO],
      bufferViews: [{ buffer: 0, byteLength: 40 }],
      accessors: [{ componentType: FLOAT, count: 3, type: "VEC3" }],
    }, compressed), /Draco-compressed/],
    ["an accessor past the end of its buffer", glbOf({
      ...singlePrimitive({}),
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 30, type: "VEC3" }],
    }, fallbackPositions), /malformed/],
  ] as const)("refuses %s with a reason instead of cooking or throwing", (_name, source, problem) => {
    const result = cooked(source);
    expect(result.positions).toBeNull();
    expect(result.problem).toMatch(problem);
  });

  it("cooks the uncompressed data a file ships beside optional Draco", () => {
    const withFallback = glbOf({
      ...singlePrimitive({}, { extensions: { [DRACO]: { bufferView: 1, attributes: { POSITION: 0 } } } }),
      extensionsUsed: [DRACO],
      bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 40 }],
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3" }],
    }, binOf(fallbackPositions, compressed));
    expect(cooked(withFallback)).toEqual({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], problem: null });
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
