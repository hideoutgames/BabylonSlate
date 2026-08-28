import { describe, expect, it } from "vitest";
import { overlayTextureWorldSize } from "./overlay-texture-quad";

function pngIhdr(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("overlayTextureWorldSize", () => {
  it("uses authored Texture pixels, not LOD GPU bytes", () => {
    const size = overlayTextureWorldSize(
      "tex-1",
      new Map([["tex-1", pngIhdr(512, 256)]]),
      100,
      new Map([["tex-1", { width: 1024, height: 512 }]]),
    );
    expect(size).toEqual({ width: 10.24, height: 5.12 });
  });

  it("falls back to sniffed GPU bytes only when authored size is missing", () => {
    const size = overlayTextureWorldSize(
      "tex-1",
      new Map([["tex-1", pngIhdr(64, 32)]]),
      100,
    );
    expect(size).toEqual({ width: 0.64, height: 0.32 });
  });
});
