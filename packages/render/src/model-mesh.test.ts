import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  createMeshFromModelBytes,
  encodeAnimatedTriangleGlb,
  encodeTranslatedTetrahedronGlb,
  encodeTriangleGlb,
  encodeUvHierarchyGlb,
  encodeYRotatedTriangleGlb,
  glbClipNames,
} from "./model-mesh";

describe("glbClipNames", () => {
  it("uses animation{index} when a clip has no name", () => {
    const bytes = encodeAnimatedTriangleGlb("");
    expect(glbClipNames(bytes)).toEqual(["animation0"]);
  });

  it("lists a named clip from a multi-mesh hierarchy GLB", () => {
    expect(glbClipNames(encodeUvHierarchyGlb({ clipName: "Walk" }))).toEqual([
      "Walk",
    ]);
    expect(
      glbClipNames(
        encodeUvHierarchyGlb({ clipName: "Run", laterMaterialFirst: true }),
      ),
    ).toEqual(["Run"]);
    expect(glbClipNames(encodeUvHierarchyGlb())).toEqual([]);
  });

  it("returns an empty list for truncated or non-GLB bytes", () => {
    expect(glbClipNames(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(glbClipNames(new Uint8Array(32).fill(0))).toEqual([]);
  });
});

describe("createMeshFromModelBytes", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("builds a triangle mesh from a valid GLB and rejects garbage", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createMeshFromModelBytes(
      handle.scene,
      "hero",
      encodeTriangleGlb(),
    );
    expect(mesh?.name).toBe("hero");
    expect(mesh?.getTotalVertices()).toBe(3);
    expect(
      createMeshFromModelBytes(handle.scene, "bad", new Uint8Array([0, 1, 2])),
    ).toBeNull();
  });

  it("bakes the first mesh node's translation into vertex positions", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createMeshFromModelBytes(
      handle.scene,
      "hero",
      encodeTranslatedTetrahedronGlb([4, 0, 0]),
    );
    expect(mesh?.getTotalVertices()).toBe(4);
    const center = mesh!.getBoundingInfo().boundingBox.center;
    expect(center.x).toBeCloseTo(4.25);
    expect(center.y).toBeCloseTo(0.25);
    expect(center.z).toBeCloseTo(0.25);
  });

  it("bakes the parent node's translation onto the first mesh", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createMeshFromModelBytes(
      handle.scene,
      "hero",
      encodeTranslatedTetrahedronGlb([0, 0, 0], [4, 0, 0]),
    );
    const center = mesh!.getBoundingInfo().boundingBox.center;
    expect(center.x).toBeCloseTo(4.25);
    expect(center.y).toBeCloseTo(0.25);
    expect(center.z).toBeCloseTo(0.25);
  });

  it("bakes the first mesh node's Y rotation into vertex positions", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createMeshFromModelBytes(
      handle.scene,
      "hero",
      encodeYRotatedTriangleGlb(),
    );
    const positions = mesh!.getVerticesData("position");
    expect(positions).not.toBeNull();
    expect(positions![0]).toBeCloseTo(0);
    expect(positions![1]).toBeCloseTo(0);
    expect(positions![2]).toBeCloseTo(-1);
  });
});
