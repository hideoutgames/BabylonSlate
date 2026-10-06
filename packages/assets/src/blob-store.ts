import type { ProjectStorage, StorageReadOptions } from "@babylonslate/core";
import { BLOBS_DIR } from "./babproject";

export interface BlobStore {
  writeBlob(sha256: string, data: Uint8Array): Promise<void>;
  readBlob(sha256: string, options?: StorageReadOptions): Promise<Uint8Array>;
  hasBlob(sha256: string): Promise<boolean>;
  /** Metadata-only size lookup for budgeting a legacy chunk without byteLength. */
  blobByteLength?(sha256: string, options?: StorageReadOptions): Promise<number>;
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
    async readBlob(sha256, options) {
      options?.signal?.throwIfAborted();
      const data = await storage.readBinary(pathFor(sha256), options);
      options?.signal?.throwIfAborted();
      return data;
    },
    async hasBlob(sha256) {
      return storage.exists(pathFor(sha256));
    },
    async blobByteLength(sha256, options) {
      options?.signal?.throwIfAborted();
      const stat = await storage.stat(pathFor(sha256));
      options?.signal?.throwIfAborted();
      if (stat.isDir || stat.size === null) throw new Error(`Blob size is unavailable: ${sha256}`);
      return stat.size;
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
    async readBlob(sha256, options) {
      options?.signal?.throwIfAborted();
      const data = blobs.get(sha256);
      if (!data) throw new Error(`Blob not found: ${sha256}`);
      return data;
    },
    async hasBlob(sha256) {
      return blobs.has(sha256);
    },
    async blobByteLength(sha256, options) {
      options?.signal?.throwIfAborted();
      const data = blobs.get(sha256);
      if (!data) throw new Error(`Blob not found: ${sha256}`);
      return data.byteLength;
    },
  };
}
