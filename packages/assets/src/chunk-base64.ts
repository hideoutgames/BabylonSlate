/** Node's `Buffer` where the host has one. Browser hosts do not, so it is read from `globalThis`, never assumed. */
const nodeBuffer = (
  globalThis as {
    Buffer?: { from(buffer: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: "base64"): string } };
  }
).Buffer;

/** Base64 of a landscape or foliage chunk's bytes: Node's native encoder where it exists, else `btoa` over binary chunks. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (nodeBuffer) {
    return nodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}
