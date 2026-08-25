import { describe, expect, it } from "vitest";
import { sniffImageSize } from "./image-size";
import { isKtx2Bytes } from "./texture-loader";
import { sniffKtx2Size } from "./ktx2-info";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function ktx2(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(28);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

describe("sniffImageSize", () => {
  it("reads PNG IHDR width and height", () => {
    expect(sniffImageSize(png(4096, 2048))).toEqual({ width: 4096, height: 2048 });
  });

  it("returns null for unknown bytes", () => {
    expect(sniffImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("sniffKtx2Size", () => {
  it("reads KTX2 pixelWidth and pixelHeight", () => {
    const bytes = ktx2(1024, 512);
    expect(isKtx2Bytes(bytes)).toBe(true);
    expect(sniffKtx2Size(bytes)).toEqual({ width: 1024, height: 512 });
  });
});
