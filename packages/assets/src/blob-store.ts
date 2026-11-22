import type { ProjectStorage, StorageReadOptions } from "@haptic/core";
import { BLOBS_DIR } from "./hproject";
import { sha256Hex } from "./bytes";

/**
 * When this process last asked for each blob (`writeBlob`, by hash), whether
 * it wrote it or found it stored. A write that finds the blob stored leaves
 * its mtime old, and its asset is written after: `sweepOrphanedBlobs` keeps
 * any blob asked for within its grace window (or since the sweep started),
 * so it never removes one an asset is about to name. Entries older than the
 * longest grace window are dropped as new ones arrive.
 */
const blobRequests = new Map<string, number>();
const BLOB_REQUEST_MEMORY_MS = 10 * 60_000;

/** Whether this process asked for the blob (`writeBlob`) at or after `since` (ms since the epoch). */
export function blobRequestedSince(sha256: string, since: number): boolean {
  const at = blobRequests.get(sha256);
  return at !== undefined && at >= since;
}

function noteBlobRequest(sha256: string): void {
  const now = Date.now();
  blobRequests.delete(sha256);
  blobRequests.set(sha256, now);
  // Oldest first (re-inserted on each request): stop at the first one still remembered.
  for (const [hash, at] of blobRequests) {
    if (now - at < BLOB_REQUEST_MEMORY_MS) break;
    blobRequests.delete(hash);
  }
}

export interface BlobStore {
  writeBlob(sha256: string, data: Uint8Array): Promise<void>;
  readBlob(sha256: string, options?: StorageReadOptions): Promise<Uint8Array>;
  hasBlob(sha256: string): Promise<boolean>;
  /** Metadata-only size lookup: a blob whose size differs from its chunk's recorded byteLength is rejected before it is read. */
  blobByteLength?(sha256: string, options?: StorageReadOptions): Promise<number>;
}

/**
 * Content-addressed blob store at `assets/.blobs/<sha256>`.
 * Blobs are immutable: a complete existing hash is never rewritten, so
 * re-saving an asset whose large chunks did not change costs no bytes. A blob
 * whose size differs from bytes that do hash to its name is a torn earlier
 * write (storage writes truncate in place), so it is written again.
 *
 * Every write asks the storage for one (the folder is made first), even when
 * the blob is already stored, so a write guard refuses it as it refuses a new
 * blob: Remove Unused Files removes blobs as the project's only writer, and
 * an asset must not name a blob it found stored while that removal ran.
 */
export function createVfsBlobStore(
  storage: ProjectStorage,
  blobDir = BLOBS_DIR,
): BlobStore {
  const pathFor = (sha256: string) => `${blobDir}/${sha256}`;

  return {
    async writeBlob(sha256, data) {
      noteBlobRequest(sha256);
      await storage.mkdir(blobDir, true);
      if (await storage.exists(pathFor(sha256))) {
        const stat = await storage.stat(pathFor(sha256));
        if (!stat.isDir && stat.size === data.byteLength) return;
        // Replace the stored blob only with the bytes its hash names.
        if (await sha256Hex(data) !== sha256) return;
      }
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
