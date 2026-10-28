import { describe, expect, it } from "vitest";
import { encodeTriangleGlb } from "./glb-test-fixtures";
import {
  packedGltfBytes,
} from "./model-mesh";

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
