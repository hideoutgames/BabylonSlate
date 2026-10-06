import type { ProjectStorage, ProjectStorageReader } from "@babylonslate/core";
import {
  BABASSET_PREFIX_BYTES,
  readBabassetHeader,
  readBabassetHeaderLength,
  type BabassetHeader,
  type ChunkEntry,
} from "./babasset";
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
  header: BabassetHeader;
  locator: AssetSourceLocator;
}

/** Read only the bounded prefix and JSON header; never allocate an inline payload. */
export async function readAssetCatalog(storage: ProjectStorageReader, path: string): Promise<AssetCatalogRead> {
  const prefix = await storage.readBinaryRange(path, 0, BABASSET_PREFIX_BYTES);
  const headerLength = readBabassetHeaderLength(prefix.bytes);
  const payloadOffset = BABASSET_PREFIX_BYTES + headerLength;
  if (payloadOffset > prefix.totalSize) throw new Error(`Truncated .babasset header: ${path}`);
  const body = await storage.readBinaryRange(path, BABASSET_PREFIX_BYTES, headerLength, prefix.revision);
  if (body.totalSize !== prefix.totalSize || body.revision !== prefix.revision || body.bytes.byteLength !== headerLength) {
    throw new Error(`Asset changed while reading its header: ${path}`);
  }
  const headerBytes = concatBytes([prefix.bytes, body.bytes]);
  const header = readBabassetHeader(headerBytes);
  const locator = {
    path,
    revision: JSON.stringify([prefix.revision, await sha256Hex(headerBytes)]),
    storageRevision: prefix.revision,
    totalSize: prefix.totalSize,
    payloadOffset,
  };
  for (const entry of header.chunks) validateChunkBounds(locator, entry);
  return { header, locator };
}

/** Weak timestamp/size tokens require a bounded header check before publication. */
export async function validateAssetSourceLocator(storage: ProjectStorageReader, asset: AssetSourceLocator): Promise<void> {
  if (storage.hasStrongSourceRevisions) {
    const current = await storage.readBinaryRange(asset.path, 0, 0, asset.storageRevision);
    if (current.revision === asset.storageRevision && current.totalSize === asset.totalSize) return;
  } else {
    const { locator } = await readAssetCatalog(storage, asset.path);
    if (locator.revision === asset.revision && locator.totalSize === asset.totalSize) return;
  }
  throw new Error(`Asset changed during loading: ${asset.path}`);
}

function validateChunkBounds(asset: AssetSourceLocator, entry: ChunkEntry): void {
  if (!("inline" in entry.locator)) return;
  const { offset, length } = entry.locator.inline;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
    !Number.isSafeInteger(asset.payloadOffset + offset + length) ||
    asset.payloadOffset + offset + length > asset.totalSize ||
    (entry.byteLength !== undefined && entry.byteLength !== length)) {
    throw new Error(`Invalid bounds for chunk ${entry.id} in ${asset.path}`);
  }
}

export interface AccountedPayloadLoaderOptions {
  blobs?: BlobStore;
}

/**
 * Reads one selected chunk from a catalog snapshot. This counter describes
 * successfully validated payload requests; actual I/O belongs to storage
 * diagnostics, and retained bytes belong to the session loading service.
 */
export class AccountedPayloadLoader {
  private readonly blobs: BlobStore;
  private readonly storage: ProjectStorage;
  private accounted = 0;

  constructor(storage: ProjectStorage, options: AccountedPayloadLoaderOptions = {}) {
    this.storage = storage;
    this.blobs = options.blobs ?? createVfsBlobStore(storage);
  }

  async loadChunk(
    asset: AssetSourceLocator,
    entry: ChunkEntry,
    blobs: BlobStore = this.blobs,
    storage: ProjectStorageReader = this.storage,
  ): Promise<Uint8Array> {
    validateChunkBounds(asset, entry);
    let data: Uint8Array;
    if ("inline" in entry.locator) {
      const { offset, length } = entry.locator.inline;
      const result = await storage.readBinaryRange(asset.path, asset.payloadOffset + offset, length, asset.storageRevision);
      if (result.totalSize !== asset.totalSize || result.revision !== asset.storageRevision || result.bytes.byteLength !== length) {
        throw new Error(`Asset changed while reading chunk ${entry.id}: ${asset.path}`);
      }
      data = result.bytes;
    } else {
      await validateAssetSourceLocator(storage, asset);
      if (entry.byteLength !== undefined && blobs.blobByteLength &&
        await blobs.blobByteLength(entry.locator.blob) !== entry.byteLength) {
        throw new Error(`Length mismatch for chunk ${entry.id} in ${asset.path}`);
      }
      data = await blobs.readBlob(entry.locator.blob);
    }
    if (entry.byteLength !== undefined && data.byteLength !== entry.byteLength) {
      throw new Error(`Length mismatch for chunk ${entry.id} in ${asset.path}`);
    }
    if (await sha256Hex(data) !== entry.sha256) {
      throw new Error(`Hash mismatch for chunk ${entry.id} in ${asset.path}`);
    }
    await validateAssetSourceLocator(storage, asset);
    this.accounted += data.byteLength;
    return data;
  }

  get accountedPayloadBytes(): number {
    return this.accounted;
  }

  resetAccounting(): void {
    this.accounted = 0;
  }
}
