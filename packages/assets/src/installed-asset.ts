import { sha256 } from "@noble/hashes/sha2.js";
import { environmentTextureContainer, readEnvironmentTextureInfo, type EnvironmentTextureInfo } from "./environment-texture";
import { isKtx2Bytes } from "./ktx2-identifier";

const identities = new WeakMap<Blob, string>();
const headers = new WeakMap<Blob, Uint8Array>();
const environmentInfo = new WeakMap<Blob, EnvironmentTextureInfo>();
let nextBlobGeneration = 0;

/**
 * Immutable installed content. A Blob copies its parts as it is built, so the
 * source array may change afterwards; everything here reads it before then.
 * `verifiedDigest` is the SHA-256 (lowercase hex) the host already checked for
 * exactly these bytes, such as an exported game's catalog revision; without it
 * the bytes are hashed here.
 */
export function installAssetBytes(bytes: Uint8Array | Blob, mime = "application/octet-stream", verifiedDigest?: string): Blob {
  if (bytes instanceof Blob) return bytes;
  // A shared buffer is no Blob part and could change while it is read: copy it first.
  const source = bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : bytes.slice();
  const blob = new Blob([source], { type: mime });
  identities.set(blob, verifiedDigest ?? assetBytesDigest(source));
  headers.set(blob, source.slice(0, 64 * 1024));
  if (environmentTextureContainer(source)) environmentInfo.set(blob, readEnvironmentTextureInfo(source));
  return blob;
}

/** The MIME type an installed Texture source carries, from its container. */
export function textureSourceMime(bytes: Uint8Array): string {
  const kind = environmentTextureContainer(bytes);
  return kind === "env" ? "application/vnd.babylon.env" : kind === "dds" ? "image/vnd-ms.dds"
    : isKtx2Bytes(bytes) ? "image/ktx2" : "application/octet-stream";
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
