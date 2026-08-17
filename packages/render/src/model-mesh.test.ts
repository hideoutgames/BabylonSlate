import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  createMeshFromModelBytes,
  encodeAnimatedTriangleGlb,
  encodeTriangleGlb,
  glbClipNames,
} from "./model-mesh";

describe("glbClipNames", () => {
  it("uses animation{index} when a clip has no name", () => {
    const bytes = encodeAnimatedTriangleGlb("");
    expect(glbClipNames(bytes)).toEqual(["animation0"]);
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
});
