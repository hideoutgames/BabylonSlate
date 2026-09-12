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
