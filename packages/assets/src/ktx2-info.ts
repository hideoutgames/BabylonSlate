import type { ImageSize } from "./image-size";

const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function readU32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function hasKtx2Identifier(bytes: Uint8Array): boolean {
  if (bytes.length < KTX2_IDENTIFIER.length) return false;
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) {
    if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  }
  return true;
}

/** KTX2 pixelWidth / pixelHeight (little-endian after the 12-byte identifier). */
export function sniffKtx2Size(bytes: Uint8Array): ImageSize | null {
  if (!hasKtx2Identifier(bytes) || bytes.length < 28) return null;
  const width = readU32le(bytes, 20);
  const height = readU32le(bytes, 24);
  if (width > 0 && height > 0) return { width, height };
  return null;
}
