import { environmentTextureContainer, readEnvironmentTextureInfo, type EnvironmentTextureInfo } from "./environment-texture";

const identities = new WeakMap<Blob, string>();
const headers = new WeakMap<Blob, Uint8Array>();
const environmentInfo = new WeakMap<Blob, EnvironmentTextureInfo>();
let nextBlobGeneration = 0;

/**
 * Immutable installed content. Mutable source arrays are copied before publication. `identity` is the content's
 * identity when the caller already holds one verified for exactly these bytes (an exported asset's catalog revision,
 * its SHA-256), so installation does not hash them again; otherwise the bytes are hashed (`assetContentHash`).
 */
export function installAssetBytes(bytes: Uint8Array | Blob, mime = "application/octet-stream", identity?: string): Blob {
  if (bytes instanceof Blob) return bytes;
  const copy = bytes.slice();
  const blob = new Blob([copy], { type: mime });
  identities.set(blob, identity ?? assetContentHash(copy));
  headers.set(blob, copy.slice(0, 64 * 1024));
  if (environmentTextureContainer(copy)) environmentInfo.set(blob, readEnvironmentTextureInfo(copy));
  return blob;
}

/** Bounded copied header for synchronous upload admission; never exposes mutable installed content. */
export function installedAssetHeader(blob: Blob): Uint8Array | undefined {
  return headers.get(blob)?.slice();
}

/** Validated full-source metadata; truncated headers cannot establish environment allocation. */
export function installedEnvironmentInfo(blob: Blob): EnvironmentTextureInfo | undefined {
  const info = environmentInfo.get(blob);
  return info ? { ...info } : undefined;
}

/**
 * A content identity for render caches: the byte length and a 128-bit MurmurHash3 (x86) of the bytes. It is not a
 * cryptographic digest; integrity is the catalog revision's job (SHA-256, checked with `crypto.subtle` when an
 * exported asset is read). It belongs at installation, never in a frame or texture lookup loop.
 */
export function assetContentHash(bytes: Uint8Array): string {
  const length = bytes.byteLength;
  const blocks = length >>> 4;
  let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  const c1 = 0x239b961b, c2 = 0xab0e9789, c3 = 0x38b34ae5, c4 = 0xa1e38b93;
  const word = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24);
  for (let block = 0; block < blocks; block++) {
    const at = block << 4;
    let k1 = word(at), k2 = word(at + 4), k3 = word(at + 8), k4 = word(at + 12);
    k1 = Math.imul(k1, c1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, c2); h1 ^= k1;
    h1 = (h1 << 19) | (h1 >>> 13); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(k2, c2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, c3); h2 ^= k2;
    h2 = (h2 << 17) | (h2 >>> 15); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(k3, c3); k3 = (k3 << 17) | (k3 >>> 15); k3 = Math.imul(k3, c4); h3 ^= k3;
    h3 = (h3 << 15) | (h3 >>> 17); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(k4, c4); k4 = (k4 << 18) | (k4 >>> 14); k4 = Math.imul(k4, c1); h4 ^= k4;
    h4 = (h4 << 13) | (h4 >>> 19); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
  }
  const tail = blocks << 4;
  const rest = length & 15;
  // The final 1-15 bytes, little-endian into up to four lanes (the reference's fall-through switch).
  const lane = (from: number, to: number) => {
    let k = 0;
    for (let i = Math.min(rest, to) - 1; i >= from; i--) k |= bytes[tail + i]! << ((i - from) << 3);
    return k;
  };
  if (rest > 12) { let k4 = lane(12, 16); k4 = Math.imul(k4, c4); k4 = (k4 << 18) | (k4 >>> 14); k4 = Math.imul(k4, c1); h4 ^= k4; }
  if (rest > 8) { let k3 = lane(8, 12); k3 = Math.imul(k3, c3); k3 = (k3 << 17) | (k3 >>> 15); k3 = Math.imul(k3, c4); h3 ^= k3; }
  if (rest > 4) { let k2 = lane(4, 8); k2 = Math.imul(k2, c2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, c3); h2 ^= k2; }
  if (rest > 0) { let k1 = lane(0, 4); k1 = Math.imul(k1, c1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, c2); h1 ^= k1; }
  h1 ^= length; h2 ^= length; h3 ^= length; h4 ^= length;
  h1 = (h1 + h2 + h3 + h4) | 0; h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
  h1 = fmix32(h1); h2 = fmix32(h2); h3 = fmix32(h3); h4 = fmix32(h4);
  h1 = (h1 + h2 + h3 + h4) | 0; h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
  return `${length}:${hex32(h1)}${hex32(h2)}${hex32(h3)}${hex32(h4)}`;
}

function fmix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
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
