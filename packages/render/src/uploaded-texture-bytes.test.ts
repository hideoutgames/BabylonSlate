import { expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { uploadedTextureBytes } from "./uploaded-texture-bytes";

const rgba = {
  isReady: true,
  width: 8,
  height: 4,
  depth: 1,
  isCube: false,
  is3D: false,
  is2DArray: false,
  format: Constants.TEXTUREFORMAT_RGBA,
  type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
  generateMipMaps: true,
};

it.each([
  [
    "RGBA8",
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    172,
  ],
  [
    "RGBA half float",
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_HALF_FLOAT,
    344,
  ],
  [
    "RGB packed 565",
    Constants.TEXTUREFORMAT_RGB,
    Constants.TEXTURETYPE_UNSIGNED_SHORT_5_6_5,
    86,
  ],
  [
    "BC7",
    Constants.TEXTUREFORMAT_COMPRESSED_RGBA_BPTC_UNORM,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    80,
  ],
  [
    "ETC2 RGB",
    Constants.TEXTUREFORMAT_COMPRESSED_RGB8_ETC2,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    40,
  ],
  [
    "ASTC 4x4",
    Constants.TEXTUREFORMAT_COMPRESSED_RGBA_ASTC_4x4,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    80,
  ],
  [
    "ASTC 8x8 sRGB",
    Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    64,
  ],
])(
  "counts each uploaded %s mip, including minimum compressed blocks",
  (_, format, type, expected) => {
    expect(uploadedTextureBytes({ ...rgba, format, type })).toBe(expected);
  },
);

it("counts partial mip chains and container base dimensions after RGBA fallback", () => {
  expect(uploadedTextureBytes(rgba, 2)).toBe(160);
  expect(
    uploadedTextureBytes({ ...rgba, width: 1, height: 1 }, 4, {
      width: 8,
      height: 4,
    }),
  ).toBe(172);
});

it("counts six cube faces, fixed array layers and shrinking 3D mip depth", () => {
  expect(uploadedTextureBytes({ ...rgba, isCube: true })).toBe(1032);
  expect(uploadedTextureBytes({ ...rgba, is2DArray: true, depth: 3 })).toBe(
    516,
  );
  expect(uploadedTextureBytes({ ...rgba, is3D: true, depth: 4 })).toBe(588);
  expect(uploadedTextureBytes({ ...rgba, generateMipMaps: false })).toBe(128);
});

it("keeps pending uploads unmeasured and rejects invalid dimensions", () => {
  expect(uploadedTextureBytes({ ...rgba, isReady: false })).toBeNull();
  expect(uploadedTextureBytes({ ...rgba, width: 0 })).toBeNull();
  expect(uploadedTextureBytes({ ...rgba, height: NaN })).toBeNull();
});
