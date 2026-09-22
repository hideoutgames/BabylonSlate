import { sha256 } from "@noble/hashes/sha2.js";

const identities = new WeakMap<Blob, string>();
const headers = new WeakMap<Blob, Uint8Array>();
let nextBlobGeneration = 0;

/** Immutable installed content. Mutable source arrays are copied before publication. */
export function installAssetBytes(bytes: Uint8Array | Blob, mime = "application/octet-stream"): Blob {
  if (bytes instanceof Blob) return bytes;
  const copy = bytes.slice();
  const blob = new Blob([copy], { type: mime });
  identities.set(blob, assetBytesDigest(copy));
  headers.set(blob, copy.slice(0, 64 * 1024));
  return blob;
}

/** Bounded copied header for synchronous upload admission; never exposes mutable installed content. */
export function installedAssetHeader(blob: Blob): Uint8Array | undefined {
  return headers.get(blob)?.slice();
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
