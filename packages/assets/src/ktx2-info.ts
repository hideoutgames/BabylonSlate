import type { ImageSize } from "./image-size";
import { isKtx2Bytes } from "./texture-loader";

function readU32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

/** KTX2 pixelWidth / pixelHeight (little-endian after the 12-byte identifier). */
export function sniffKtx2Size(bytes: Uint8Array): ImageSize | null {
  if (!isKtx2Bytes(bytes) || bytes.length < 28) return null;
  const width = readU32le(bytes, 20);
  const height = readU32le(bytes, 24);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

/**
 * True when a KTX2's base size is a whole number of `align`-texel blocks, the
 * WebGPU requirement for ASTC 4x4 / BC7 uploads. Unreadable headers are false.
 */
export function isKtx2BlockAligned(bytes: Uint8Array, align: number): boolean {
  const size = sniffKtx2Size(bytes);
  return size !== null && size.width % align === 0 && size.height % align === 0;
}
