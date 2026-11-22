import { describe, expect, it } from "vitest";
import { accessorValues, buildBoxGlbFixture, extractGltfCollisionMesh, extractGltfPositions, GltfGeometryUnreadableError } from "./glb-geometry";
import { GLTF_MAX_NODE_DEPTH, ImportLimitError } from "./import-limits";
import { encodeGlbJsonBin, splitGlbJsonBin } from "./importers/glb-parse";
import { importModel } from "./importers/model";

/** One FLOAT VEC3 vertex in a 12-byte BIN, with the accessor and view fields the test sets. */
function oneVertexGlb(accessor: Record<string, unknown>, view: Record<string, unknown> = {}): Uint8Array {
  const bin = new Uint8Array(new Float32Array([1, 2, 3]).buffer);
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: 12 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12, ...view }],
      accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 1, ...accessor }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    },
    bin,
  );
}

function positionsOf(glb: Uint8Array): number[] {
  const { json, bin } = splitGlbJsonBin(glb)!;
  return accessorValues(json, bin, 0, 3);
}

describe("accessorValues", () => {
  it("reads a well-formed strided accessor", () => {
    // Two vertices 16 bytes apart: x, y, z and four bytes of another attribute.
    const bin = new Uint8Array(new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]).buffer);
    const json = {
      bufferViews: [{ buffer: 0, byteLength: 32, byteStride: 16 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 2 }],
    };
    expect(accessorValues(json, bin, 0, 3)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects a fractional stride before looping over its count", () => {
    // 1,000,000 elements 0.0001 bytes apart would all fit in 12 bytes and be read one by one.
    const glb = oneVertexGlb({ count: 1_000_000 }, { byteStride: 0.0001 });
    expect(() => positionsOf(glb)).toThrow(/byteStride must be a whole number of at least 12 bytes/);
  });

  it("rejects a count above the cap before reading, whatever the stride", () => {
    const glb = oneVertexGlb({ count: 1e9 }, { byteStride: 0.0001 });
    const started = performance.now();
    expect(() => extractGltfPositions(glb)).toThrow(ImportLimitError);
    expect(() => extractGltfPositions(glb)).toThrow(/1,000,000,000.*16,777,216/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects strides shorter than an element, counts past the view and views past the BIN", () => {
    expect(() => positionsOf(oneVertexGlb({ count: 2 }, { byteStride: 4 }))).toThrow(/byteStride/);
    expect(() => positionsOf(oneVertexGlb({ count: 2 }))).toThrow(/run past the end of glTF buffer view 0/);
    expect(() => positionsOf(oneVertexGlb({ byteOffset: 4 }))).toThrow(/run past the end/);
    expect(() => positionsOf(oneVertexGlb({}, { byteLength: 64 }))).toThrow(/past the end of the 12-byte binary buffer/);
  });

  it("rejects negative or fractional counts and offsets", () => {
    expect(() => positionsOf(oneVertexGlb({ count: -1 }))).toThrow(/count must be a whole number/);
    expect(() => positionsOf(oneVertexGlb({ count: 1.5 }))).toThrow(/count must be a whole number/);
    expect(() => positionsOf(oneVertexGlb({ byteOffset: -12 }))).toThrow(/byteOffset must be a whole number/);
    expect(() => positionsOf(oneVertexGlb({}, { byteOffset: 0.5 }))).toThrow(/byteOffset must be a whole number/);
  });

  it("caps a view-less accessor's count before allocating its zeros", () => {
    expect(positionsOf(oneVertexGlb({ bufferView: undefined, count: 2 }))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(() => positionsOf(oneVertexGlb({ bufferView: undefined, count: 1e9 }))).toThrow(ImportLimitError);
  });

  it("caps a sparse accessor's count and checks its views like any other", () => {
    const sparse = (count: number, indices: Record<string, unknown> = { bufferView: 0, componentType: 5125 }) =>
      oneVertexGlb({ bufferView: undefined, count: 1, sparse: { count, indices, values: { bufferView: 0 } } });
    expect(() => positionsOf(sparse(1e9))).toThrow(ImportLimitError);
    expect(() => positionsOf(sparse(1, { bufferView: 0, componentType: 5125, byteOffset: 0.5 }))).toThrow(GltfGeometryUnreadableError);
  });
});

describe("glTF node traversal", () => {
  function withNodes(nodes: Array<Record<string, unknown>>): Uint8Array {
    const { json, bin } = splitGlbJsonBin(buildBoxGlbFixture(2))!;
    json.nodes = nodes;
    json.scenes = [{ nodes: [0] }];
    return encodeGlbJsonBin(json, bin);
  }

  /** A chain `depth` nodes long with the box mesh on the last one. */
  function chain(depth: number): Array<Record<string, unknown>> {
    return Array.from({ length: depth }, (_, index) =>
      index === depth - 1 ? { mesh: 0 } : { children: [index + 1] });
  }

  it("collects a hierarchy at the depth limit", () => {
    expect(extractGltfPositions(withNodes(chain(GLTF_MAX_NODE_DEPTH)))).toHaveLength(8);
  });

  it("rejects a hierarchy deeper than the limit by name", () => {
    expect(() => extractGltfPositions(withNodes(chain(GLTF_MAX_NODE_DEPTH + 1)))).toThrow(ImportLimitError);
    expect(() => extractGltfPositions(withNodes(chain(100_000)))).toThrow(/more than 256 levels deep/);
  });

  it("visits each node of a cyclic graph once", () => {
    const glb = withNodes([{ mesh: 0, children: [1] }, { children: [0, 1] }]);
    expect(extractGltfCollisionMesh(glb)?.positions).toHaveLength(24);
  });
});

describe("importModel limits", () => {
  it("fails a model whose primitive declares more vertices than the cap", async () => {
    const glb = oneVertexGlb({ count: 20_000_000 });
    await expect(importModel(glb, { fileName: "huge.glb", existingGuids: new Set() })).rejects.toThrow(
      /vertex count of one part of mesh 0 is 20,000,000; the import limit is 16,777,216/,
    );
  });

  it("fails a model with an over-deep hierarchy instead of overflowing the stack", async () => {
    const { json, bin } = splitGlbJsonBin(buildBoxGlbFixture(1))!;
    json.nodes = Array.from({ length: 50_000 }, (_, index) => (index === 49_999 ? { mesh: 0 } : { children: [index + 1] }));
    json.scenes = [{ nodes: [0] }];
    await expect(importModel(encodeGlbJsonBin(json, bin), { fileName: "deep.glb", existingGuids: new Set() })).rejects.toThrow(ImportLimitError);
  });
});
