const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 0;

/** Bytes are content-addressed; immutable Blobs use identity, never size alone. */
export function assetByteFingerprint(bytes: Uint8Array | Blob): string {
  if (bytes instanceof Blob) {
    let id = blobIds.get(bytes);
    if (id === undefined) { id = ++nextBlobId; blobIds.set(bytes, id); }
    return `blob:${id}:${bytes.size}`;
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `${bytes.byteLength}:${hash >>> 0}`;
}
