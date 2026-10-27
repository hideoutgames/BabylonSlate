import { Constants } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { estimateTextureBytes } from "./texture-memory-estimate";

const flat = { depth: 1, isCube: false, is3D: false, is2DArray: false, generateMipMaps: false, mipLevelCount: 1, samples: 1 };

describe("estimateTextureBytes", () => {
  it.each([
    ["an RGBA8 texture", { ...flat, width: 512, height: 512, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE }, 1_048_576],
    ["its mip chain", { ...flat, width: 512, height: 512, generateMipMaps: true, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE }, 1_398_101],
    // A FeatureTest probe cube: six 1024 RGBA16F faces.
    ["an RGBA16F cube", { ...flat, width: 1024, height: 1024, isCube: true, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_HALF_FLOAT }, 50_331_648],
    // Four 2048 shadow cascades in one depth array.
    ["a 32-bit depth array", { ...flat, width: 2048, height: 2048, depth: 4, is2DArray: true, format: Constants.TEXTUREFORMAT_DEPTH32_FLOAT, type: Constants.TEXTURETYPE_FLOAT }, 67_108_864],
    ["an R16F array", { ...flat, width: 2048, height: 2048, depth: 4, is2DArray: true, format: Constants.TEXTUREFORMAT_R, type: Constants.TEXTURETYPE_HALF_FLOAT }, 33_554_432],
    ["a 4× MSAA target with its resolve texture", { ...flat, width: 100, height: 100, samples: 4, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE }, 200_000],
    ["BC1, half a byte per texel", { ...flat, width: 1024, height: 1024, format: Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT1, type: Constants.TEXTURETYPE_UNSIGNED_BYTE }, 524_288],
    ["ASTC or BC7, a byte per texel", { ...flat, width: 1024, height: 1024, format: Constants.TEXTUREFORMAT_COMPRESSED_RGBA_BPTC_UNORM, type: Constants.TEXTURETYPE_UNSIGNED_BYTE }, 1_048_576],
  ])("estimates %s", (_name, texture, bytes) => {
    expect(estimateTextureBytes(texture)).toBe(bytes);
  });
});
