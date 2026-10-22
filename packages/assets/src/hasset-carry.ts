import type { ProjectStorageReader } from "@haptic/core";
import {
  DEFAULT_BLOB_THRESHOLD,
  readHassetHeader,
  type ChunkEntry,
  type EncodableChunk,
} from "./hasset";
import type { BlobStore } from "./blob-store";
import { sha256Hex, stableStringify } from "./bytes";
import { validateAssetSourceLocator, type AssetCatalogRead } from "./payload-loader";

export interface CarryStoredChunksOptions {
  /** Chunks the caller replaces or drops: neither read nor carried. */
  omit?: ReadonlySet<string>;
  /** Chunks whose bytes the caller needs: read and verified, returned as ordinary inputs. */
  load?: (entry: ChunkEntry) => boolean;
}

function inlineSpan(entry: ChunkEntry): { offset: number; length: number } | null {
  return "inline" in entry.locator ? entry.locator.inline : null;
}

/**
 * The stored chunks of a container, in table order, ready to write into its
 * replacement without decoding it: what a rewrite that only changes the header
 * or a few chunks needs, instead of reading, verifying and hashing every one.
 *
 * - An externalised chunk is carried as its table entry. Its blob is confirmed
 *   to exist with the recorded length, but is not read or hashed; a reader
 *   still verifies it against the unchanged sha256 on every load.
 * - An inline chunk is small (it is under the blob threshold), so its bytes
 *   come from one bounded range read and are checked against the table's
 *   sha256 before they are copied.
 * - Chunks selected by `load` are read and verified like `decodeHasset`
 *   does, for a caller that inspects them.
 *
 * Resolves null whenever carrying cannot be shown to be exactly what a full
 * decode and re-encode would write: a missing or short blob, a chunk that does
 * not match its digest, a chunk a re-encode would store the other way (an
 * inline one it would externalise, a blob it would inline), a bundled asset,
 * or a file that changed meanwhile. The caller then decodes the
 * whole file, which reports the real failure.
 */
export async function carryStoredChunks(
  storage: ProjectStorageReader,
  blobs: BlobStore,
  stored: AssetCatalogRead,
  options: CarryStoredChunksOptions = {},
): Promise<EncodableChunk[] | null> {
  const { header, locator } = stored;
  if (header.mode !== "thin") return null;
  const entries = header.chunks.filter((entry) => !options.omit?.has(entry.id));
  const wanted = (entry: ChunkEntry) => options.load?.(entry) === true;

  // A re-encode moves an inline chunk this large to the blob store and keeps a smaller externalised one inline, so neither is copied as it is.
  if (entries.some((entry) => !wanted(entry) && (inlineSpan(entry) ? entry.byteLength >= DEFAULT_BLOB_THRESHOLD : entry.byteLength < DEFAULT_BLOB_THRESHOLD))) return null;

  let region: Uint8Array = new Uint8Array(0);
  let regionStart = 0;
  const spans = entries.flatMap((entry) => {
    const span = inlineSpan(entry);
    return span ? [span] : [];
  });
  if (spans.length > 0) {
    regionStart = Math.min(...spans.map((span) => span.offset));
    const regionEnd = Math.max(...spans.map((span) => span.offset + span.length));
    if (regionEnd > regionStart) {
      const read = await storage.readBinaryRange(
        locator.path, locator.payloadOffset + regionStart, regionEnd - regionStart, locator.storageRevision,
      );
      if (read.revision !== locator.storageRevision || read.totalSize !== locator.totalSize ||
        read.bytes.byteLength !== regionEnd - regionStart) return null;
      region = read.bytes;
    }
  }

  const chunks: EncodableChunk[] = [];
  for (const entry of entries) {
    const { id, kind, mime, sha256, byteLength } = entry;
    const span = inlineSpan(entry);
    if (span) {
      const data = region.subarray(span.offset - regionStart, span.offset - regionStart + span.length);
      if (span.length !== byteLength || data.byteLength !== byteLength || await sha256Hex(data) !== sha256) return null;
      chunks.push(wanted(entry) ? { id, kind, mime, data } : { id, kind, mime, carried: { sha256, byteLength, bytes: data } });
      continue;
    }
    const blob = "blob" in entry.locator ? entry.locator.blob : "";
    // Blobs are named by their digest; a locator that disagrees is not one to trust.
    if (blob !== sha256 || !(await blobs.hasBlob(blob))) return null;
    if (blobs.blobByteLength && await blobs.blobByteLength(blob) !== byteLength) return null;
    if (wanted(entry)) {
      const data = await blobs.readBlob(blob);
      if (data.byteLength !== byteLength || await sha256Hex(data) !== sha256) return null;
      chunks.push({ id, kind, mime, data });
    } else {
      chunks.push({ id, kind, mime, carried: { sha256, byteLength, blob } });
    }
  }
  // The table carried above is still the file's.
  await validateAssetSourceLocator(storage, locator);
  return chunks;
}

/**
 * True when writing `bytes` over the stored file would change nothing: the
 * same header, so the same identity, metadata, chunk digests, lengths and inline
 * layout, and the file is still the snapshot compared against. Call
 * {@link verifyChunksBeforeWrite} first: it covers the blobs the container
 * names and the stored bytes of the chunks the caller supplied. Any failure to
 * confirm the snapshot (the file changed, was deleted, or cannot be read) is
 * "does not match", so the caller writes.
 */
export async function storedHassetMatches(
  storage: ProjectStorageReader,
  stored: AssetCatalogRead,
  bytes: Uint8Array,
): Promise<boolean> {
  if (stableStringify(stored.header) !== stableStringify(readHassetHeader(bytes))) return false;
  try {
    await validateAssetSourceLocator(storage, stored.locator);
    return true;
  } catch {
    return false;
  }
}

/** Whether a stored chunk still has its recorded length and sha256 (a read that fails is not intact). */
async function storedChunkIntact(
  storage: ProjectStorageReader,
  blobs: BlobStore,
  stored: AssetCatalogRead,
  entry: ChunkEntry,
): Promise<boolean> {
  try {
    const span = inlineSpan(entry);
    let data: Uint8Array;
    if (span) {
      const { locator } = stored;
      data = (await storage.readBinaryRange(locator.path, locator.payloadOffset + span.offset, span.length, locator.storageRevision)).bytes;
    } else {
      const blob = "blob" in entry.locator ? entry.locator.blob : "";
      if (blobs.blobByteLength && await blobs.blobByteLength(blob) !== entry.byteLength) return false;
      data = await blobs.readBlob(blob);
    }
    return data.byteLength === entry.byteLength && await sha256Hex(data) === entry.sha256;
  } catch {
    return false;
  }
}

/**
 * Checks `bytes`, the container about to replace the stored file, just before
 * it is written (or skipped as a no-op):
 *
 * - Every blob it names must exist. {@link carryStoredChunks} confirmed the
 *   carried ones earlier, and one deleted since would leave the asset
 *   unreadable. Throws when one is missing. A blob deleted after this check
 *   is not repaired.
 * - `replaced` lists chunks whose bytes the caller supplied itself (the
 *   document being saved, a fresh bake). When one keeps the digest the file
 *   already stores, the stored bytes are kept in effect, not replaced: an
 *   inline copy is rewritten from the supplied bytes, but a blob of the right
 *   length with other bytes is never rewritten (a blob store keeps an existing
 *   blob whose size matches), so a save would report success while the only
 *   good copy lives in memory. Their stored bytes are verified: a damaged
 *   stored blob throws, and a damaged or unreadable inline copy returns false.
 *
 * Resolves true when nothing stored needs repair, so leaving the file alone
 * loses nothing; false when a write is needed to repair an inline copy.
 */
export async function verifyChunksBeforeWrite(
  storage: ProjectStorageReader,
  blobs: BlobStore,
  stored: AssetCatalogRead,
  bytes: Uint8Array,
  replaced: readonly string[],
): Promise<boolean> {
  const next = readHassetHeader(bytes);
  for (const entry of next.chunks) {
    if ("blob" in entry.locator && !(await blobs.hasBlob(entry.locator.blob))) {
      throw new Error(`Blob ${entry.locator.blob} of chunk ${entry.id} is missing`);
    }
  }
  let intact = true;
  for (const id of replaced) {
    const now = next.chunks.find((entry) => entry.id === id);
    const before = stored.header.chunks.find((entry) => entry.id === id);
    if (!now || !before || now.sha256 !== before.sha256) continue;
    if (await storedChunkIntact(storage, blobs, stored, before)) continue;
    if ("blob" in before.locator && "blob" in now.locator && before.locator.blob === now.locator.blob) {
      throw new Error(`Stored blob of chunk ${id} is damaged and would be kept as it is`);
    }
    intact = false;
  }
  return intact;
}
