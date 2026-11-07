import { assetBytesDigest, installedAssetIdentity } from "@haptic/assets";

/**
 * Installed texture Blobs carry immutable content and an ingestion-time identity. Raw model and font arrays stay
 * mutable until their own installation boundary, so never cache a digest by mutable array identity.
 */
export function assetByteFingerprint(bytes: Uint8Array | Blob): string {
  return bytes instanceof Blob ? installedAssetIdentity(bytes) : assetBytesDigest(bytes);
}
