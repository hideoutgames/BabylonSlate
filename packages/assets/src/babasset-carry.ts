import type { ProjectStorageReader } from "@babylonslate/core";
import { SourceRevisionChangedError } from "@babylonslate/core";
import {
  DEFAULT_BLOB_THRESHOLD,
  readBabassetHeader,
  type ChunkEntry,
  type EncodableChunk,
} from "./babasset";
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
 * - Chunks selected by `load` are read and verified like `decodeBabasset`
 *   does, for a caller that inspects them.
 *
 * Resolves null whenever carrying cannot be shown to be exactly what a full
 * decode and re-encode would write: a missing or short blob, a chunk that does
 * not match its digest, an inline chunk a re-encode would externalise, a
 * bundled asset, or a file that changed meanwhile. The caller then decodes the
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

  // A re-encode moves an inline chunk this large to the blob store, so it cannot be copied as it is.
  if (entries.some((entry) => inlineSpan(entry) && !wanted(entry) && entry.byteLength >= DEFAULT_BLOB_THRESHOLD)) return null;

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
 * layout, and the file is still the snapshot compared against. Every chunk
 * the new container names exists by then (an encode writes its blobs first), so
 * leaving the file alone is the same as rewriting it.
 */
export async function storedBabassetMatches(
  storage: ProjectStorageReader,
  stored: AssetCatalogRead,
  bytes: Uint8Array,
): Promise<boolean> {
  if (stableStringify(stored.header) !== stableStringify(readBabassetHeader(bytes))) return false;
  try {
    await validateAssetSourceLocator(storage, stored.locator);
    return true;
  } catch (error) {
    if (error instanceof SourceRevisionChangedError) return false;
    throw error;
  }
}
