import { sha256 } from "@noble/hashes/sha2.js";

const identities = new WeakMap<Blob, string>();
let nextBlobGeneration = 0;

/** Immutable installed content. Mutable source arrays are copied before publication. */
export function installAssetBytes(bytes: Uint8Array | Blob, mime = "application/octet-stream"): Blob {
  if (bytes instanceof Blob) return bytes;
  const copy = bytes.slice();
  const blob = new Blob([copy], { type: mime });
  identities.set(blob, assetBytesDigest(copy));
  return blob;
}

/** SHA-256 belongs at installation, never in a frame or texture lookup loop. */
export function assetBytesDigest(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Blob contents cannot mutate; externally supplied Blobs receive an installation generation. */
export function installedAssetIdentity(bytes: Blob): string {
  let identity = identities.get(bytes);
  if (!identity) {
    identity = `blob:${++nextBlobGeneration}`;
    identities.set(bytes, identity);
  }
  return identity;
}
