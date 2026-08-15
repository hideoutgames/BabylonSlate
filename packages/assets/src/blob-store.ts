import type { ProjectStorage } from "@babylonslate/core";
import { BLOBS_DIR } from "./babproject";

export interface BlobStore {
  writeBlob(sha256: string, data: Uint8Array): Promise<void>;
  readBlob(sha256: string): Promise<Uint8Array>;
  hasBlob(sha256: string): Promise<boolean>;
}

/**
 * Content-addressed blob store at `assets/.blobs/<sha256>`.
 * Blobs are immutable: an existing hash is never rewritten, so re-saving an
 * asset whose large chunks did not change costs no bytes.
 */
export function createVfsBlobStore(
  storage: ProjectStorage,
  blobDir = BLOBS_DIR,
): BlobStore {
  const pathFor = (sha256: string) => `${blobDir}/${sha256}`;

  return {
    async writeBlob(sha256, data) {
      if (await storage.exists(pathFor(sha256))) return;
      await storage.mkdir(blobDir, true);
      await storage.writeBinary(pathFor(sha256), data);
    },
    async readBlob(sha256) {
      return storage.readBinary(pathFor(sha256));
    },
    async hasBlob(sha256) {
      return storage.exists(pathFor(sha256));
    },
  };
}

/** In-memory blob store for tests and headless tooling. */
export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async writeBlob(sha256, data) {
      if (!blobs.has(sha256)) blobs.set(sha256, data);
    },
    async readBlob(sha256) {
      const data = blobs.get(sha256);
      if (!data) throw new Error(`Blob not found: ${sha256}`);
      return data;
    },
    async hasBlob(sha256) {
      return blobs.has(sha256);
    },
  };
}
