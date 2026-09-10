const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 0;
const snapshotHashes = new WeakMap<Uint8Array | Blob, string>();

/** Scene snapshots replace asset byte objects; transform edits reuse them. */
export function snapshotByteFingerprint(bytes: Uint8Array | Blob): string {
  let hash = snapshotHashes.get(bytes);
  if (hash === undefined) { hash = assetByteFingerprint(bytes); snapshotHashes.set(bytes, hash); }
  return hash;
}

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
