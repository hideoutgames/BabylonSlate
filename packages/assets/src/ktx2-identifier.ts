/** KTX2 identifier (`«KTX 20»` plus the standard control bytes). */
const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isKtx2Bytes(bytes: Uint8Array): boolean {
  if (bytes.length < KTX2_IDENTIFIER.length) return false;
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) {
    if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  }
  return true;
}
