import type { ProjectStorage, ProjectStorageReader, StorageRangeRead, StorageReadOptions } from "@haptic/core";
import { SourceRevisionChangedError } from "@haptic/core";
import {
  HASSET_PREFIX_BYTES,
  readHassetHeader,
  readHassetHeaderLength,
  type HassetHeader,
  type ChunkEntry,
} from "./hasset";
import { concatBytes, sha256Hex } from "./bytes";
import { createVfsBlobStore, type BlobStore } from "./blob-store";

/** A file snapshot. A save invalidates this locator even if the path is unchanged. */
export interface AssetSourceLocator {
  path: string;
  /** Header digest plus the adapter token: safe for retained-resource cache keys. */
  revision: string;
  /** Adapter token used only for bounded storage reads. It may be metadata-derived. */
  storageRevision: string;
  totalSize: number;
  payloadOffset: number;
}

export interface AssetCatalogRead {
  header: HassetHeader;
  locator: AssetSourceLocator;
}

/**
 * Bytes a catalog read with a size hint asks for at once: the prefix, the
 * header and (for a header that fits) the start of the payload, in one range
 * read instead of two. Typical headers are about a kilobyte; on the Capacitor
 * bridge, which base64-encodes every read, 8 KiB is about 11 KB of transfer,
 * cheaper than a second bridge round trip.
 */
export const SPECULATIVE_CATALOG_READ_BYTES = 8192;

/**
 * Read only the bounded prefix and JSON header; never allocate an inline payload.
 * With `sizeHint` (the file size a directory listing reported) on storage
 * with `speculativeRangeReads`, the first read
 * asks for up to `SPECULATIVE_CATALOG_READ_BYTES` (never past the hinted end,
 * since a range read never reads past the end of a file), and a second read
 * fetches only what of the header that did not cover. A hint the file no
 * longer matches is harmless: a shorter file fails that read, which is then
 * made again as two reads without one.
 */
export async function readAssetCatalog(
  storage: ProjectStorageReader,
  path: string,
  options: StorageReadOptions = {},
  sizeHint?: number | null,
): Promise<AssetCatalogRead> {
  options.signal?.throwIfAborted();
  const speculative = storage.speculativeRangeReads === true && typeof sizeHint === "number" && Number.isSafeInteger(sizeHint)
    ? Math.min(sizeHint, SPECULATIVE_CATALOG_READ_BYTES)
    : 0;
  let prefix: StorageRangeRead | undefined;
  if (speculative > HASSET_PREFIX_BYTES) {
    try {
      prefix = await storage.readBinaryRange(path, 0, speculative, undefined, options);
    } catch (error) {
      // Not every bridge keeps the range error's class, so any failure is
      // retried as the exact reads below, which fail as they always have.
      options.signal?.throwIfAborted();
      if (error instanceof SourceRevisionChangedError) throw error;
    }
  }
  prefix ??= await storage.readBinaryRange(path, 0, HASSET_PREFIX_BYTES, undefined, options);
  options.signal?.throwIfAborted();
  const headerLength = readHassetHeaderLength(prefix.bytes);
  const payloadOffset = HASSET_PREFIX_BYTES + headerLength;
  if (payloadOffset > prefix.totalSize) throw new Error(`Truncated .hasset header: ${path}`);
  let headerBytes: Uint8Array;
  if (payloadOffset <= prefix.bytes.byteLength) {
    headerBytes = prefix.bytes.subarray(0, payloadOffset);
  } else {
    const have = prefix.bytes.byteLength;
    const body = await storage.readBinaryRange(path, have, payloadOffset - have, prefix.revision, options);
    options.signal?.throwIfAborted();
    if (body.totalSize !== prefix.totalSize || body.revision !== prefix.revision) throw new SourceRevisionChangedError(`Asset changed while reading its header: ${path}`);
    if (body.bytes.byteLength !== payloadOffset - have) throw new Error(`Truncated .hasset header: ${path}`);
    headerBytes = concatBytes([prefix.bytes, body.bytes]);
  }
  const header = readHassetHeader(headerBytes);
  // Strong-revision storage guarantees distinct storage revisions on every write, so
  // the adapter token itself uniquely identifies the catalog without hashing the header.
  const revision = storage.hasStrongSourceRevisions
    ? prefix.revision
    : JSON.stringify([prefix.revision, await sha256Hex(headerBytes)]);
  const locator = {
    path,
    revision,
    storageRevision: prefix.revision,
    totalSize: prefix.totalSize,
    payloadOffset,
  };
  options.signal?.throwIfAborted();
  for (const entry of header.chunks) validateChunkBounds(locator, entry);
  return { header, locator };
}

/** Weak timestamp/size tokens require a bounded header check before publication. */
export async function validateAssetSourceLocator(storage: ProjectStorageReader, asset: AssetSourceLocator, options: StorageReadOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if (storage.hasStrongSourceRevisions) {
    const current = await storage.readBinaryRange(asset.path, 0, 0, asset.storageRevision, options);
    options.signal?.throwIfAborted();
    if (current.revision === asset.storageRevision && current.totalSize === asset.totalSize) return;
  } else {
    const { locator } = await readAssetCatalog(storage, asset.path, options);
    if (locator.revision === asset.revision && locator.totalSize === asset.totalSize) return;
  }
  throw new SourceRevisionChangedError(`Asset changed during loading: ${asset.path}`);
}

function validateChunkBounds(asset: AssetSourceLocator, entry: ChunkEntry): void {
  if (!("inline" in entry.locator)) return;
  const { offset, length } = entry.locator.inline;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
    !Number.isSafeInteger(asset.payloadOffset + offset + length) ||
    asset.payloadOffset + offset + length > asset.totalSize ||
    entry.byteLength !== length) {
    throw new Error(`Invalid bounds for chunk ${entry.id} in ${asset.path}`);
  }
}

export interface AccountedPayloadLoaderOptions {
  blobs?: BlobStore;
}

export interface PayloadChunkRequest {
  id: number;
  path: string;
  chunkId: string;
  revision: string;
  status: "loading" | "succeeded" | "failed";
  requestedBytes: number;
  /** Bytes returned to this request, including bytes rejected by validation. */
  payloadBytes: number;
  error?: string;
}

export interface PayloadLoaderSnapshot {
  requests: number;
  succeeded: number;
  failed: number;
  pending: number;
  /** Successful bytes since resetAccounting; actual storage I/O is separate. */
  accountedPayloadBytes: number;
  /** At most 128 recent requests; contains no payload or decoded object references. */
  recentRequests: PayloadChunkRequest[];
}

/**
 * Reads one selected chunk from a catalog snapshot. This counter describes
 * successfully validated payload requests; actual I/O belongs to storage
 * diagnostics, and retained bytes belong to the session loading service.
 */
const MAX_VERIFIED_INLINE_CHUNKS = 4096;
const MAX_VERIFIED_BLOBS = 4096;

export class AccountedPayloadLoader {
  private readonly blobs: BlobStore;
  private readonly storage: ProjectStorage;
  private accounted = 0;
  private requests = 0;
  private succeeded = 0;
  private failed = 0;
  private readonly recentRequests: PayloadChunkRequest[] = [];
  /** Session-verified inline chunks keyed by `(path, storageRevision, chunkId, sha256)`. */
  private readonly verifiedInlineChunks = new Set<string>();
  /**
   * Session-verified externalized blobs per BlobStore, keyed by `(blobId, blobRevision, byteLength, sha256)`.
   * Bound to the blob file's strong storage revision so an in-place overwrite always re-verifies SHA-256.
   */
  private readonly verifiedBlobs = new WeakMap<BlobStore, Set<string>>();

  constructor(storage: ProjectStorage, options: AccountedPayloadLoaderOptions = {}) {
    this.storage = storage;
    this.blobs = options.blobs ?? createVfsBlobStore(storage);
  }

  /** Record a chunk already hashed by this session (e.g. just written) so immediate read-back skips re-hashing. */
  markInlineChunkVerified(path: string, storageRevision: string, chunkId: string, sha256: string): void {
    const key = `${path}\0${storageRevision}\0${chunkId}\0${sha256}`;
    if (this.verifiedInlineChunks.has(key)) return;
    if (this.verifiedInlineChunks.size >= MAX_VERIFIED_INLINE_CHUNKS) {
      const oldest = this.verifiedInlineChunks.values().next().value;
      if (oldest !== undefined) this.verifiedInlineChunks.delete(oldest);
    }
    this.verifiedInlineChunks.add(key);
  }

  private markBlobVerified(blobs: BlobStore, key: string): void {
    let table = this.verifiedBlobs.get(blobs);
    if (!table) this.verifiedBlobs.set(blobs, table = new Set());
    if (table.has(key)) return;
    if (table.size >= MAX_VERIFIED_BLOBS) {
      const oldest = table.values().next().value;
      if (oldest !== undefined) table.delete(oldest);
    }
    table.add(key);
  }

  async loadChunk(
    asset: AssetSourceLocator,
    entry: ChunkEntry,
    blobs: BlobStore = this.blobs,
    storage: ProjectStorageReader = this.storage,
    options: StorageReadOptions = {},
  ): Promise<Uint8Array> {
    const request: PayloadChunkRequest = {
      id: ++this.requests,
      path: asset.path,
      chunkId: entry.id,
      revision: asset.revision,
      status: "loading",
      requestedBytes: entry.byteLength,
      payloadBytes: 0,
    };
    this.recentRequests.push(request);
    if (this.recentRequests.length > 128) this.recentRequests.shift();
    try {
      const data = await this.loadValidatedChunk(asset, entry, blobs, storage, request, options);
      request.status = "succeeded";
      this.succeeded += 1;
      return data;
    } catch (cause) {
      request.status = "failed";
      request.error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 512);
      this.failed += 1;
      throw cause;
    }
  }

  private async loadValidatedChunk(
    asset: AssetSourceLocator,
    entry: ChunkEntry,
    blobs: BlobStore,
    storage: ProjectStorageReader,
    request: PayloadChunkRequest,
    options: StorageReadOptions,
  ): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    validateChunkBounds(asset, entry);
    let data: Uint8Array;
    let blobCacheKey: string | null = null;
    if ("inline" in entry.locator) {
      const { offset, length } = entry.locator.inline;
      const result = await storage.readBinaryRange(asset.path, asset.payloadOffset + offset, length, asset.storageRevision, options);
      request.payloadBytes = result.bytes.byteLength;
      options.signal?.throwIfAborted();
      if (result.totalSize !== asset.totalSize || result.revision !== asset.storageRevision) throw new SourceRevisionChangedError(`Asset changed while reading chunk ${entry.id}: ${asset.path}`);
      if (result.bytes.byteLength !== length) throw new Error(`Length mismatch for chunk ${entry.id} in ${asset.path}`);
      data = result.bytes;
    } else {
      if (blobs.blobRevision && storage.hasStrongSourceRevisions === true) {
        const meta = await blobs.blobRevision(entry.locator.blob, options);
        if (meta.byteLength !== entry.byteLength) {
          throw new Error(`Length mismatch for chunk ${entry.id} in ${asset.path}`);
        }
        blobCacheKey = `${entry.locator.blob}\0${meta.revision}\0${entry.byteLength}\0${entry.sha256}`;
      } else if (blobs.blobByteLength &&
        await blobs.blobByteLength(entry.locator.blob, options) !== entry.byteLength) {
        throw new Error(`Length mismatch for chunk ${entry.id} in ${asset.path}`);
      }
      options.signal?.throwIfAborted();
      data = await blobs.readBlob(entry.locator.blob, options);
    }
    request.payloadBytes = data.byteLength;
    options.signal?.throwIfAborted();
    if (data.byteLength !== entry.byteLength) {
      throw new Error(`Length mismatch for chunk ${entry.id} in ${asset.path}`);
    }
    const isInline = "inline" in entry.locator;
    const strongInline = isInline && storage.hasStrongSourceRevisions === true;
    const inlineCacheKey = strongInline ? `${asset.path}\0${asset.storageRevision}\0${entry.id}\0${entry.sha256}` : null;
    const alreadyVerified = inlineCacheKey
      ? this.verifiedInlineChunks.has(inlineCacheKey)
      : blobCacheKey !== null && (this.verifiedBlobs.get(blobs)?.has(blobCacheKey) ?? false);
    if (!alreadyVerified) {
      const hash = await sha256Hex(data);
      options.signal?.throwIfAborted();
      if (hash !== entry.sha256) {
        throw new Error(`Hash mismatch for chunk ${entry.id} in ${asset.path}`);
      }
      if (inlineCacheKey) this.markInlineChunkVerified(asset.path, asset.storageRevision, entry.id, entry.sha256);
      else if (blobCacheKey) this.markBlobVerified(blobs, blobCacheKey);
    }
    // For inline chunks on strong-revision storage, readBinaryRange already asserted
    // result.revision === asset.storageRevision && result.totalSize === asset.totalSize atomically.
    // Blobs and weak-revision storage still validate the locator after the read.
    if (!strongInline) {
      await validateAssetSourceLocator(storage, asset, options);
    }
    this.accounted += data.byteLength;
    return data;
  }

  get accountedPayloadBytes(): number {
    return this.accounted;
  }

  snapshot(): PayloadLoaderSnapshot {
    return {
      requests: this.requests,
      succeeded: this.succeeded,
      failed: this.failed,
      pending: this.requests - this.succeeded - this.failed,
      accountedPayloadBytes: this.accounted,
      recentRequests: this.recentRequests.map((request) => ({ ...request })),
    };
  }

  resetAccounting(): void {
    this.accounted = 0;
  }
}
