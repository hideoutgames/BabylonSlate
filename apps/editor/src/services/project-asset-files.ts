import type { ProjectStorage } from "@haptic/core";
import type { AssetDocument } from "@haptic/assets";
import {
  AccountedPayloadLoader,
  carryStoredChunks,
  decodeHasset,
  DOCUMENT_CHUNK_ID,
  extraChunksFromDecoded,
  readAssetCatalog,
  readAssetDocumentHeader,
  stableStringify,
  storedHassetMatches,
  validateAssetSourceLocator,
  verifyChunksBeforeWrite,
  type AssetCatalogRead,
  type AssetRegistry,
  type BlobStore,
  type EncodableChunk,
} from "@haptic/assets";

/**
 * Where a project path's file and blobs live: the registry root that indexes
 * it, a plugin folder, derived storage for traces, or the project itself.
 * Resolved again at each use, so a remount between reads is followed.
 */
export interface AssetFileAccess {
  storageFor(path: string): ProjectStorage;
  blobsFor(path: string): BlobStore;
}

export interface ExistingAssetMeta {
  type: string;
  name: string;
  parentClass: string | null;
  hasDocumentChunk: boolean;
  payload: Record<string, unknown>;
  /** The header and file snapshot these came from; null when only a whole-file read could parse it. */
  catalog: AssetCatalogRead | null;
}

export async function readExistingAssetMeta(files: AssetFileAccess, path: string): Promise<ExistingAssetMeta | null> {
  const storage = files.storageFor(path);
  if (!(await storage.exists(path))) return null;
  try {
    // The header is all a rewrite's metadata needs, so only it is read.
    let catalog: AssetCatalogRead | null = null;
    try {
      catalog = await readAssetCatalog(storage, path);
    } catch {
      // Parsed from the whole file below, which fails or succeeds on its own terms.
    }
    const header = catalog?.header ?? readAssetDocumentHeader(await storage.readBinary(path));
    return {
      type: header.type,
      name: header.name,
      parentClass: header.parentClass ?? null,
      hasDocumentChunk: header.chunks.some(
        (chunk) => chunk.id === DOCUMENT_CHUNK_ID,
      ),
      payload: header.payload,
      catalog,
    };
  } catch {
    return null;
  }
}

/**
 * The chunks a rewrite of `path` must keep. A file that exists but cannot
 * be read refuses the write rather than losing them.
 */
async function extraChunksFor(files: AssetFileAccess, path: string) {
  const storage = files.storageFor(path);
  const blobs = files.blobsFor(path);
  if (!(await storage.exists(path))) return [];
  try {
    const decoded = await decodeHasset(
      await storage.readBinary(path),
      (hash) => blobs.readBlob(hash),
    );
    return extraChunksFromDecoded(decoded);
  } catch (cause) {
    throw new Error(`${path} could not be read, so it was not overwritten.`, { cause });
  }
}

/**
 * The chunks a rewrite of `path` keeps, other than its document body and
 * `omit` (which the caller replaces). They are carried over from the chunk
 * table `stored` snapshots, so unchanged blobs are neither read nor hashed
 * again; when that cannot be shown safe (a missing blob, a changed file),
 * every chunk is read and verified instead, which refuses the write if the
 * file cannot be read.
 */
export async function keptChunksFor(
  files: AssetFileAccess,
  path: string,
  stored: AssetCatalogRead | null,
  omit?: ReadonlySet<string>,
): Promise<EncodableChunk[]> {
  if (stored) {
    try {
      const carried = await carryStoredChunks(files.storageFor(path), files.blobsFor(path), stored, {
        omit: new Set([DOCUMENT_CHUNK_ID, ...(omit ?? [])]),
      });
      if (carried) return carried;
    } catch {
      // Read in full below, which reports an unreadable file.
    }
  }
  const loaded = await extraChunksFor(files, path);
  return omit ? loaded.filter((chunk) => !omit.has(chunk.id)) : loaded;
}

/**
 * Replace `path` with `bytes`, unless it already holds exactly that (`stored`
 * is what it held): a save that changed nothing leaves the file, its mtime and
 * the registry's index alone, rather than invalidating everything keyed on the
 * registry's generation.
 *
 * `replaced` names the chunks whose bytes the caller supplied. Their stored
 * bytes are verified first (`verifyChunksBeforeWrite`): a damaged inline copy
 * is rewritten rather than skipped, and a damaged blob, which a write cannot
 * repair, or a blob the container names that has gone missing, refuses the
 * save as an unreadable asset always has, so the caller's copy stays dirty.
 */
export async function storeDocumentBytes(
  files: AssetFileAccess,
  path: string,
  stored: AssetCatalogRead | null,
  bytes: Uint8Array,
  registry: AssetRegistry | null,
  replaced: readonly string[] = [DOCUMENT_CHUNK_ID],
): Promise<void> {
  const storage = files.storageFor(path);
  if (stored) {
    let intact: boolean;
    try {
      intact = await verifyChunksBeforeWrite(storage, files.blobsFor(path), stored, bytes, replaced);
    } catch (cause) {
      throw new Error(`${path} could not be read, so it was not overwritten.`, { cause });
    }
    if (intact && await storedHassetMatches(storage, stored, bytes)) {
      const indexed = registry?.getByPath(path);
      if (!registry || (indexed && stableStringify(indexed.header) === stableStringify(stored.header))) return;
      await registry.reindexPath(path);
      return;
    }
  }
  await storage.writeBinary(path, bytes);
  await registry?.reindexPath(path);
}

export async function readUnindexedAssetDocument(files: AssetFileAccess, path: string, signal?: AbortSignal): Promise<AssetDocument> {
  const storage = files.storageFor(path);
  const blobs = files.blobsFor(path);
  const { header, locator } = await readAssetCatalog(storage, path, { signal });
  const body = header.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID);
  const payload = body
    ? JSON.parse(new TextDecoder().decode(await new AccountedPayloadLoader(storage, { blobs }).loadChunk(locator, body, blobs, storage, { signal }))) as Record<string, unknown>
    : header.payload;
  if (!body) await validateAssetSourceLocator(storage, locator, { signal });
  return { guid: header.guid, type: header.type, name: header.name, version: header.version, payload };
}
