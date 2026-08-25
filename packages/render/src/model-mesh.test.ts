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
  packedGltfBytes,
  gpuModelBytes,
} from "./model-mesh";
import { buildMinimalGlbFixture } from "@babylonslate/assets";

describe("packedGltfBytes", () => {
  it("returns the same bytes when the ArrayBuffer is already packed", () => {
    const glb = encodeTriangleGlb();
    expect(glb.byteOffset).toBe(0);
    expect(glb.buffer.byteLength).toBe(glb.byteLength);
    expect(packedGltfBytes(glb)).toBe(glb);
  });

  it("copies a nested view so LoadAssetContainerAsync sees a packed buffer", () => {
    const glb = encodeTriangleGlb();
    const padded = new Uint8Array(glb.byteLength + 32);
    padded.fill(0xab);
    padded.set(glb, 16);
    const view = padded.subarray(16, 16 + glb.byteLength);
    expect(view.byteOffset).toBe(16);
    const packed = packedGltfBytes(view);
    expect(packed).not.toBe(view);
    expect(packed.byteOffset).toBe(0);
    expect(packed.buffer.byteLength).toBe(packed.byteLength);
    expect(packed).toEqual(glb);
  });
});

describe("gpuModelBytes", () => {
  it("slims embedded rasters only when every material slot is bound", () => {
    const glb = buildMinimalGlbFixture({
      imageRgba: new Uint8Array(2048),
    });
    expect(gpuModelBytes(glb).byteLength).toBe(glb.byteLength);
    expect(
      gpuModelBytes(glb, {
        materialSlots: [{ index: 0, name: "HeroMat", materialGuid: "" }],
      }).byteLength,
    ).toBe(glb.byteLength);
    expect(
      gpuModelBytes(glb, {
        materialSlots: [{ index: 0, name: "HeroMat", materialGuid: "mat-1" }],
      }).byteLength,
    ).toBeLessThan(glb.byteLength);
  });
});

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
