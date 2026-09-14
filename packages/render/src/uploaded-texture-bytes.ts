import { Constants } from "@babylonjs/core/Engines/constants";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";

type UploadedTexture = Pick<
  InternalTexture,
  | "isReady"
  | "width"
  | "height"
  | "depth"
  | "isCube"
  | "is3D"
  | "is2DArray"
  | "format"
  | "type"
  | "generateMipMaps"
>;

const ASTC_BLOCKS = [
  [4, 4],
  [5, 4],
  [5, 5],
  [6, 5],
  [6, 6],
  [8, 5],
  [8, 6],
  [8, 8],
  [10, 5],
  [10, 6],
  [10, 8],
  [10, 10],
  [12, 10],
  [12, 12],
] as const;

function blockLayout(format: number): readonly [number, number, number] | null {
  const astc =
    ASTC_BLOCKS[format - Constants.TEXTUREFORMAT_COMPRESSED_RGBA_ASTC_4x4] ??
    ASTC_BLOCKS[
      format - Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR
    ];
  if (astc) return [astc[0], astc[1], 16];
  switch (format) {
    case Constants.TEXTUREFORMAT_COMPRESSED_RGBA_BPTC_UNORM:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_BPTC_UNORM:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGB_BPTC_SIGNED_FLOAT:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT3:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT5:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGBA8_ETC2_EAC:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:
      return [4, 4, 16];
    case Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT1:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGB_S3TC_DXT1:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB_S3TC_DXT1_EXT:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGB_ETC1_WEBGL:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGB8_ETC2:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_ETC2:
    case Constants.TEXTUREFORMAT_COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2:
    case Constants.TEXTUREFORMAT_COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2:
      return [4, 4, 8];
    default:
      return null;
  }
}

function bytesPerPixel(format: number, type: number): number {
  let channels: number;
  switch (format) {
    case Constants.TEXTUREFORMAT_ALPHA:
    case Constants.TEXTUREFORMAT_LUMINANCE:
    case Constants.TEXTUREFORMAT_RED:
    case Constants.TEXTUREFORMAT_RED_INTEGER:
      channels = 1;
      break;
    case Constants.TEXTUREFORMAT_LUMINANCE_ALPHA:
    case Constants.TEXTUREFORMAT_RG:
    case Constants.TEXTUREFORMAT_RG_INTEGER:
      channels = 2;
      break;
    case Constants.TEXTUREFORMAT_RGB:
    case Constants.TEXTUREFORMAT_RGB_INTEGER:
      channels = 3;
      break;
    case Constants.TEXTUREFORMAT_RGBA:
    case Constants.TEXTUREFORMAT_RGBA_INTEGER:
      channels = 4;
      break;
    // Unknown upload formats are conservatively accounted as RGBA float.
    default:
      return 16;
  }
  switch (type) {
    case Constants.TEXTURETYPE_UNSIGNED_BYTE:
    case Constants.TEXTURETYPE_BYTE:
      return channels;
    case Constants.TEXTURETYPE_HALF_FLOAT:
    case Constants.TEXTURETYPE_SHORT:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT:
      return channels * 2;
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_4_4_4_4:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_5_5_5_1:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_5_6_5:
      return 2;
    case Constants.TEXTURETYPE_UNSIGNED_INT_2_10_10_10_REV:
    case Constants.TEXTURETYPE_UNSIGNED_INT_10F_11F_11F_REV:
    case Constants.TEXTURETYPE_UNSIGNED_INT_5_9_9_9_REV:
      return 4;
    default:
      return channels * 4;
  }
}

/** Estimated GPU storage from the uploaded representation, excluding driver
 * alignment/metadata. Explicit container mip counts include partial chains. */
export function uploadedTextureBytes(
  texture: UploadedTexture | null,
  mipLevels?: number,
  baseSize?: { width: number; height: number },
): number | null {
  const size = baseSize ?? texture;
  if (
    !texture?.isReady ||
    !size ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  )
    return null;
  let width = Math.floor(size.width);
  let height = Math.floor(size.height);
  let depth =
    texture.is3D || texture.is2DArray ? Math.max(1, texture.depth) : 1;
  if (!Number.isFinite(depth)) return null;
  depth = Math.floor(depth);
  const fullChain =
    1 +
    Math.floor(Math.log2(Math.max(width, height, texture.is3D ? depth : 1)));
  const levels =
    mipLevels !== undefined && Number.isFinite(mipLevels)
      ? Math.max(1, Math.min(fullChain, Math.floor(mipLevels)))
      : texture.generateMipMaps
        ? fullChain
        : 1;
  const block = blockLayout(texture.format);
  const pixelBytes = block ? 0 : bytesPerPixel(texture.format, texture.type);
  const faces = texture.isCube ? 6 : 1;
  let bytes = 0;
  for (let level = 0; level < levels; level++) {
    const planeBytes = block
      ? Math.ceil(width / block[0]) * Math.ceil(height / block[1]) * block[2]
      : width * height * pixelBytes;
    bytes += planeBytes * depth * faces;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    if (texture.is3D) depth = Math.max(1, Math.floor(depth / 2));
  }
  return bytes;
}
