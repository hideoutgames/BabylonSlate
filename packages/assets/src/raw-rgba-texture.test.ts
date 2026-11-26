import { describe, expect, it } from "vitest";
import {
  isRawRgbaTextureBytes,
  packRawRgbaTexture,
  RAW_RGBA_TEXTURE_HEADER_BYTES,
  readRawRgbaTextureHeader,
} from "./raw-rgba-texture";

describe("raw RGBA texture binary format (HRGB)", () => {
  it("packs and reads width, height, and pixel payload", () => {
    const rgba = new Uint8Array(2 * 3 * 4);
    rgba.set([255, 128, 64, 255], 0);
    const packed = packRawRgbaTexture(2, 3, rgba);
    expect(packed.byteLength).toBe(RAW_RGBA_TEXTURE_HEADER_BYTES + 24);
    expect(isRawRgbaTextureBytes(packed)).toBe(true);
    expect(readRawRgbaTextureHeader(packed)).toEqual({ width: 2, height: 3 });
    expect(packed.subarray(RAW_RGBA_TEXTURE_HEADER_BYTES, RAW_RGBA_TEXTURE_HEADER_BYTES + 4)).toEqual(
      new Uint8Array([255, 128, 64, 255]),
    );
  });

  it("rejects truncated or non-HRGB bytes", () => {
    expect(isRawRgbaTextureBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(readRawRgbaTextureHeader(new Uint8Array([0x48, 0x52, 0x47, 0x42, 2, 0, 0, 0, 2, 0, 0, 0]))).toBeNull();
    expect(() => packRawRgbaTexture(2, 2, new Uint8Array(4))).toThrow(/Expected 16 RGBA bytes/);
  });
});
