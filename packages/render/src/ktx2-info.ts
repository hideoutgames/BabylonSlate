/**
 * Minimal KTX2 container header reader for GPU-memory accounting.
 * Layout: identifier(12) vkFormat(u32le@12) typeSize(@16)
 *         pixelWidth(u32le@20) pixelHeight(u32le@24) ...
 */
const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isKtx2Container(bytes: Uint8Array): boolean {
  if (bytes.length < KTX2_IDENTIFIER.length) return false;
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) {
    if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  }
  return true;
}

/** Dimensions from a KTX2 header, or null when not KTX2 / malformed. */
export function readKtx2Size(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (!isKtx2Container(bytes) || bytes.length < 28) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
