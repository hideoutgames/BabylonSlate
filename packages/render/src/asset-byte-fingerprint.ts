import { assetBytesDigest, installedAssetIdentity } from "@babylonslate/assets";

/** Installed texture Blobs carry immutable content and an ingestion-time identity. */
export function assetByteFingerprint(bytes: Uint8Array | Blob): string {
  return bytes instanceof Blob ? installedAssetIdentity(bytes) : assetBytesDigest(bytes);
}

// Raw model/font arrays remain mutable until their own installation boundary.
// Never cache a digest by mutable array identity.
export const snapshotByteFingerprint = assetByteFingerprint;
