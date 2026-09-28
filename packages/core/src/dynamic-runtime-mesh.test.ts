import { describe, expect, it } from "vitest";
import { DynamicRuntimeMeshGeometry } from "./dynamic-runtime-mesh";

const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];

describe("runtime mesh geometry", () => {
  it("owns caller data, generates lighting normals, and rejects malformed edits atomically", () => {
    const geometry = new DynamicRuntimeMeshGeometry();
    const input = new Float32Array(triangle);
    expect(geometry.setGeometry(input, [0, 1, 2])).toBe(true);
    input.fill(30);
    expect([...geometry.positions]).toEqual(triangle);
    expect([...geometry.normals]).toEqual([0, 0, -1, 0, 0, -1, 0, 0, -1]);
    const revision = geometry.revision;
    expect(geometry.setGeometry(triangle, [0, 1, 3])).toBe(false);
    expect(geometry.setGeometry([0, NaN, 0], [0, 0, 0])).toBe(false);
    expect(geometry.setGeometry(triangle, [0, 1, 2], [0, 1])).toBe(false);
    expect(geometry.updateVertices(0, [5, 6, 7], [0, Infinity, 1])).toBe(false);
    expect(geometry.updateVertices(3, [1, 2, 3])).toBe(false);
    expect(geometry.updateVertices(-1, [1, 2, 3])).toBe(false);
    expect(geometry.revision).toBe(revision);
    expect([...geometry.positions]).toEqual(triangle);
  });

  it("coalesces vertex edits into owned transferable ranges and leaves topology and untouched channels alone", () => {
    const geometry = new DynamicRuntimeMeshGeometry();
    geometry.setGeometry(triangle, [0, 1, 2]);
    geometry.takeUpdate();
    const storage = geometry.positions, topology = geometry.indices;
    geometry.updateVertices(1, [2, 0, 0]);
    geometry.updateVertices(2, [0, 3, 0]);
    const update = geometry.takeUpdate();
    expect(update.reset).toBe(false);
    expect(update.positions?.offset).toBe(3);
    expect([...update.positions!.data]).toEqual([2, 0, 0, 0, 3, 0]);
    expect(update.normals).toBeUndefined(); expect(update.uvs).toBeUndefined(); expect(update.indices).toBeUndefined();
    structuredClone(update, { transfer: [update.positions!.data.buffer as ArrayBuffer] });
    expect([...geometry.positions]).toEqual([0, 0, 0, 2, 0, 0, 0, 3, 0]);
    expect(geometry.positions).toBe(storage); expect(geometry.indices).toBe(topology);
    const collisionRevision = geometry.collisionRevision;
    geometry.updateVertices(1, [], [0, 1, 0], [0.5, 1]);
    geometry.recalculateNormals();
    expect(geometry.collisionRevision).toBe(collisionRevision);
    geometry.setGeometry(triangle, [0, 2, 1]);
    expect(geometry.positions).toBe(storage); expect(geometry.indices).toBe(topology);
  });

  it("keeps edits conservatively inside bounds until explicitly tightened, then releases cleared geometry", () => {
    const geometry = new DynamicRuntimeMeshGeometry();
    geometry.setGeometry(triangle, [0, 1, 2]);
    geometry.updateVertices(1, [8, -4, 2]);
    expect(geometry.bounds).toEqual({ min: [0, -4, 0], max: [8, 1, 2] });
    geometry.updateVertices(1, [0.5, 0, 0]);
    expect(geometry.bounds.max[0]).toBe(8);
    geometry.recalculateBounds();
    expect(geometry.bounds).toEqual({ min: [0, 0, 0], max: [0.5, 1, 0] });
    geometry.clear();
    const update = geometry.takeUpdate();
    expect(update).toMatchObject({ reset: true, vertexCount: 0, indexCount: 0, bounds: { min: [0, 0, 0], max: [0, 0, 0] } });
    expect(geometry.positions.byteLength + geometry.normals.byteLength + geometry.uvs.byteLength + geometry.indices.byteLength).toBe(0);
  });

  it("preserves indices beyond 16-bit vertex limits", () => {
    const geometry = new DynamicRuntimeMeshGeometry();
    const positions = new Float32Array(65_537 * 3);
    positions.set([1, 0, 0, 0, 1, 0], 65_535 * 3);
    expect(geometry.setGeometry(positions, [0, 65_535, 65_536])).toBe(true);
    expect([...geometry.takeUpdate().indices!]).toEqual([0, 65_535, 65_536]);
    expect([...geometry.normals.subarray(65_536 * 3)]).toEqual([0, 0, -1]);
  });
});
