import { Constants, type AbstractEngine, type InternalTexture } from "@babylonjs/core";

/** Approximate bytes per texel of a compressed format; formats with 8-byte 4×4 blocks are half a byte. */
const HALF_BYTE_COMPRESSED = new Set<number>([
  Constants.TEXTUREFORMAT_COMPRESSED_RGB_S3TC_DXT1,
  Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT1,
  Constants.TEXTUREFORMAT_COMPRESSED_SRGB_S3TC_DXT1_EXT,
  Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT,
  Constants.TEXTUREFORMAT_COMPRESSED_RGB_ETC1_WEBGL,
  Constants.TEXTUREFORMAT_COMPRESSED_RGB8_ETC2,
  Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ETC2,
  Constants.TEXTUREFORMAT_COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2,
  Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2,
]);

function channels(format: number): number {
  switch (format) {
    case Constants.TEXTUREFORMAT_ALPHA:
    case Constants.TEXTUREFORMAT_LUMINANCE:
    case Constants.TEXTUREFORMAT_R:
    case Constants.TEXTUREFORMAT_R_INTEGER:
      return 1;
    case Constants.TEXTUREFORMAT_LUMINANCE_ALPHA:
    case Constants.TEXTUREFORMAT_RG:
    case Constants.TEXTUREFORMAT_RG_INTEGER:
      return 2;
    default:
      // RGB is stored padded to four channels by most drivers.
      return 4;
  }
}

function bytesPerChannel(type: number): number {
  switch (type) {
    case Constants.TEXTURETYPE_FLOAT:
    case Constants.TEXTURETYPE_INT:
    case Constants.TEXTURETYPE_UNSIGNED_INTEGER:
      return 4;
    case Constants.TEXTURETYPE_HALF_FLOAT:
    case Constants.TEXTURETYPE_SHORT:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT:
      return 2;
    default:
      return 1;
  }
}

/** Bytes per texel of one uncompressed or compressed level-0 texel (an estimate for compressed formats). */
export function textureBytesPerTexel(format: number, type: number): number {
  switch (format) {
    case Constants.TEXTUREFORMAT_DEPTH16:
      return 2;
    case Constants.TEXTUREFORMAT_DEPTH24:
    case Constants.TEXTUREFORMAT_DEPTH24_STENCIL8:
    case Constants.TEXTUREFORMAT_DEPTH24UNORM_STENCIL8:
    case Constants.TEXTUREFORMAT_DEPTH32_FLOAT:
      return 4;
    case Constants.TEXTUREFORMAT_DEPTH32FLOAT_STENCIL8:
      return 8;
    case Constants.TEXTUREFORMAT_STENCIL8:
      return 1;
  }
  // Compressed formats are GL enums (0x83F0 and up); Babylon's own formats are small integers.
  if (format >= 0x8000) return HALF_BYTE_COMPRESSED.has(format) ? 0.5 : 1;
  switch (type) {
    case Constants.TEXTURETYPE_UNSIGNED_INT_2_10_10_10_REV:
    case Constants.TEXTURETYPE_UNSIGNED_INT_10F_11F_11F_REV:
    case Constants.TEXTURETYPE_UNSIGNED_INT_5_9_9_9_REV:
    case Constants.TEXTURETYPE_UNSIGNED_INT_24_8:
      return 4;
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_4_4_4_4:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_5_5_5_1:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_5_6_5:
      return 2;
  }
  return channels(format) * bytesPerChannel(type);
}

type TextureShape = Pick<InternalTexture, "width" | "height" | "depth" | "isCube" | "is3D" | "is2DArray" |
  "generateMipMaps" | "mipLevelCount" | "samples" | "format" | "type">;

/** Estimated GPU bytes of one texture: every layer or face, its mip chain, and an MSAA render buffer. */
export function estimateTextureBytes(texture: TextureShape): number {
  const layers = (texture.isCube ? 6 : 1) * (texture.is3D || texture.is2DArray ? Math.max(1, texture.depth) : 1);
  const level0 = Math.max(0, texture.width) * Math.max(0, texture.height) * layers *
    textureBytesPerTexel(texture.format, texture.type);
  const mips = texture.generateMipMaps || texture.mipLevelCount > 1 ? 4 / 3 : 1;
  const multisample = texture.samples > 1 ? level0 * texture.samples : 0;
  return Math.round(level0 * mips + multisample);
}

/**
 * Textures the Engine holds and their estimated GPU bytes. An estimate: drivers pad and align, and
 * render buffers Babylon allocates outside its texture cache (a plain depth buffer) are not counted.
 */
export function estimateTextureMemory(engine: AbstractEngine): { bytes: number; textures: number } {
  let bytes = 0;
  let textures = 0;
  for (const texture of engine.getLoadedTexturesCache()) {
    bytes += estimateTextureBytes(texture);
    textures += 1;
  }
  return { bytes, textures };
}
