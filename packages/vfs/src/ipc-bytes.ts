/**
 * The `ArrayBuffer` to hand Electron IPC for `bytes`. Structured clone copies
 * a view's whole underlying buffer, so a view that covers its buffer goes as
 * that buffer with no copy of ours; only a slice of a larger buffer (or one
 * over a SharedArrayBuffer, which IPC refuses) is copied down to its bytes
 * first. Dependency-free: the Electron main bundle imports it too.
 */
export function ipcArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer } = bytes;
  // By tag, not `instanceof`: bytes made in another realm (a preload, Node's TextEncoder under jsdom) are still plain buffers.
  if (Object.prototype.toString.call(buffer) === "[object ArrayBuffer]" && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer as ArrayBuffer;
  }
  return bytes.slice().buffer;
}
