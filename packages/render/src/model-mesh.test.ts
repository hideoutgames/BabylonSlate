import { describe, expect, it } from "vitest";
import { encodeTriangleGlb } from "./glb-test-fixtures";
import {
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
  it("keeps embedded rasters unless every slot texture guid is packed", () => {
    const glb = buildMinimalGlbFixture({
      imageRgba: new Uint8Array(2048),
    });
    const bound = {
      materialSlots: [{ index: 0, name: "HeroMat", materialGuid: "mat-1" }],
    };
    expect(gpuModelBytes(glb).byteLength).toBe(glb.byteLength);
    expect(
      gpuModelBytes(glb, {
        materialSlots: [{ index: 0, name: "HeroMat", materialGuid: "" }],
      }).byteLength,
    ).toBe(glb.byteLength);
    expect(gpuModelBytes(glb, bound).byteLength).toBe(glb.byteLength);
    expect(
      gpuModelBytes(glb, bound, {
        packedTextureGuids: new Set(["tex-1"]),
        texturesByMaterialGuid: new Map([["mat-1", ["tex-1"]]]),
      }).byteLength,
    ).toBe(glb.byteLength);
    expect(
      gpuModelBytes(glb, bound, {
        packedTextureGuids: new Set(["tex-1"]),
        texturesByMaterialGuid: new Map([["mat-1", ["tex-1"]]]),
        compiledMaterialGuids: new Set(["mat-1"]),
      }).byteLength,
    ).toBeLessThan(glb.byteLength);
    expect(
      gpuModelBytes(glb, bound, {
        packedTextureGuids: new Set(),
        texturesByMaterialGuid: new Map([["mat-1", ["tex-1"]]]),
      }).byteLength,
    ).toBe(glb.byteLength);
  });
});
