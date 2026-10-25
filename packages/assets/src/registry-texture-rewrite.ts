import type { ProjectStorage } from "@haptic/core";
import { AREA_EMISSION_CHUNK_KIND, areaEmissionChunkId, currentAreaEmissionChunk, decodeAreaEmission, type AreaEmissionProgress } from "./area-emission";
import type { BlobStore } from "./blob-store";
import { sha256Hex } from "./bytes";
import { encodeJobMayWrite, type EncodeJobResult } from "./encode-queue";
import { isEnvironmentTexturePayload, readEnvironmentTextureInfo } from "./environment-texture";
import {
  decodeHasset,
  encodeHasset,
  isCarriedChunk,
  readHassetHeader,
  type ChunkEntry,
  type EncodableChunk,
  type HassetHeader,
} from "./hasset";
import { carryStoredChunks } from "./hasset-carry";
import {
  HDR_SOURCE_CHUNK_ID,
  normalizeHdrEnvironmentFaceSize,
  type HdrEnvironmentConverter,
} from "./hdr-environment";
import type { ImageSize } from "./image-size";
import { sniffKtx2Size } from "./ktx2-info";
import { readAssetCatalog } from "./payload-loader";
import type { AreaEmissionProcessor, AssetImportControl, RegistryHost } from "./registry-types";
import { encodeSettingsHash, ktx2ChunkId, TEXTURE_BLOCK_EDGE, type TextureCompressionState } from "./texture-compression";

/** A Texture file edit: the header and chunks to write back, or null to write nothing. */
type TextureRewrite = (
  header: Omit<HassetHeader, "chunks">,
  chunks: Map<string, EncodableChunk>,
  /** The header as read from disk, chunk sha256s included. */
  current: HassetHeader,
) => Promise<{
  header: Omit<HassetHeader, "chunks">;
  chunks: Map<string, EncodableChunk>;
} | null>;

/** See `AssetRegistry.reconvertHdrEnvironment`. */
export async function reconvertHdrEnvironment(
  host: RegistryHost,
  guid: string,
  faceSize: number,
  convert: HdrEnvironmentConverter,
  control: AssetImportControl = {},
): Promise<boolean> {
  const { signal, onProgress } = control;
  signal?.throwIfAborted();
  const asset = host.byGuid.get(guid);
  if (!asset || asset.placeholder || asset.header.type !== "Texture" || !isEnvironmentTexturePayload(asset.header.payload)) {
    throw new Error("Face Size applies only to environment cube Textures.");
  }
  host.assertWritable(host.getRootOrThrow(asset.rootId));
  const sourceEntry = asset.header.chunks.find((chunk) => chunk.id === HDR_SOURCE_CHUNK_ID);
  if (!sourceEntry) throw new Error("This Texture does not keep its .hdr file. Import the .hdr again to change its Face Size.");
  const size = normalizeHdrEnvironmentFaceSize(faceSize);
  const source = await host.readChunk(guid, sourceEntry.id, undefined, { signal });
  const dds = await convert(source, { faceSize: size, signal, onProgress });
  signal?.throwIfAborted();
  const info = readEnvironmentTextureInfo(dds);
  const sourceMime = asset.header.chunks.find((chunk) => chunk.id === "source")?.mime ?? "image/vnd-ms.dds";
  return host.withAssetWrite(guid, () => rewriteTexture(host, guid, async (header, chunks, current) => {
    // Converted from this `.hdr` only: a newer import or copy over the file keeps its own cube.
    if (current.chunks.find((chunk) => chunk.id === HDR_SOURCE_CHUNK_ID)?.sha256 !== sourceEntry.sha256) return null;
    chunks.set("source", { id: "source", kind: "source", mime: sourceMime, data: dds });
    header.payload = { ...header.payload, ...info, hdrFaceSize: size };
    return { header, chunks };
  }, () => signal?.throwIfAborted(), () => false));
}

/** See `AssetRegistry.setCompressionState`. */
export async function setCompressionState(
  host: RegistryHost,
  guid: string,
  state: TextureCompressionState,
  options?: { error?: string; canWrite?: (guid: string, current: HassetHeader) => boolean },
): Promise<void> {
  await enqueueTextureWrite(host, guid, async () => {
    // Header only: the chunk table is reused as it is, so the source pixels
    // and encodes are neither read nor decoded for a state change.
    await rewriteTexture(host, guid, async (header, chunks, current) => {
      if (options?.canWrite && !options.canWrite(guid, current)) return null;
      const payload: Record<string, unknown> = {
        ...header.payload,
        compressionState: state,
      };
      if (state === "encode_failed") {
        if (options?.error) payload.encodeError = options.error;
      } else {
        delete payload.encodeError;
      }
      header.payload = payload;
      return { header, chunks };
    }, undefined, () => false);
  });
}

/** See `AssetRegistry.commitCompressedTexture`. */
export function commitCompressedTexture(host: RegistryHost, result: EncodeJobResult): Promise<boolean> {
  // Entered at once: a pass that awaits this Texture's writes reads the commit.
  return host.withAssetWrite(result.assetGuid, async () => {
    const chunkId =
      result.chunkId ?? ktx2ChunkId(await encodeSettingsHash(result.settings));
    const size = sniffKtx2Size(result.ktx2);
    const blockAlign = result.settings.blockAlign;
    const sha256 = await sha256Hex(result.ktx2);
    const dropsOffGrid = isOnBlockGrid(size) && !host.isAtlasTexture(result.assetGuid);
    const isRetainedKtx2 = (chunk: { id: string; kind: string }) =>
      chunk.id !== chunkId && (chunk.kind === "ktx2" || chunk.id.startsWith("ktx2:"));
    // Only the older encodes are read, and only to size them; the source
    // pixels and every other chunk are carried over from the chunk table.
    return rewriteTexture(host, result.assetGuid, async (header, chunks, current) => {
      // A background job commits only while its guard still allows it for
      // the file it replaces, and only onto the source it encoded.
      if (!encodeJobMayWrite(result, current)) return null;
      if (dropsOffGrid) {
        for (const [id, chunk] of chunks) {
          if (!isRetainedKtx2(chunk) || isCarriedChunk(chunk)) continue;
          const retained = sniffKtx2Size(chunk.data);
          if (retained && !isOnBlockGrid(retained)) chunks.delete(id);
        }
      }
      chunks.set(chunkId, {
        id: chunkId,
        kind: "ktx2",
        mime: "image/ktx2",
        data: result.ktx2,
      });
      const payload: Record<string, unknown> = {
        ...header.payload,
        compressionState: "compressed",
        encodeWallMs: result.wallMs,
        ktx2ChunkId: chunkId,
      };
      delete payload.encodeError;
      delete payload.ktx2Width;
      delete payload.ktx2Height;
      delete payload.ktx2BlockAlign;
      if (size) {
        payload.ktx2Width = size.width;
        payload.ktx2Height = size.height;
      }
      if (blockAlign && blockAlign > 1) payload.ktx2BlockAlign = blockAlign;
      payload.ktx2Sha256 = sha256;
      header.payload = payload;
      return { header, chunks };
    }, undefined, (entry) => dropsOffGrid && isRetainedKtx2(entry));
  });
}

/** See `AssetRegistry.prepareAreaEmission`. */
export async function prepareAreaEmission(host: RegistryHost, guid: string, process: AreaEmissionProcessor, options: { signal?: AbortSignal; onProgress?: (value: AreaEmissionProgress) => void } = {}): Promise<Uint8Array> {
  if (!host.encodeQueue()) throw new Error("Texture processing queue is unavailable.");
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: "queued", progress: 0 });
  return host.encodeQueue()!.enqueueDerived(async (signal) => {
    const asset = host.byGuid.get(guid);
    if (!asset || asset.header.type !== "Texture" || isEnvironmentTexturePayload(asset.header.payload)) throw new Error("Area emission requires a raster Texture asset.");
    const locator = await host.getAssetLocator(guid, { signal });
    const header = host.byGuid.get(guid)!.header;
    const sourceEntry = header.chunks.find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
    if (!sourceEntry) throw new Error("The Texture has no retained source pixels.");
    const cached = currentAreaEmissionChunk(header);
    if (cached) {
      try {
        const bytes = await host.loader.loadChunk(locator, cached, host.blobsForAsset(asset), host.storageForAsset(asset), { signal });
        if (bytes) {
          await decodeAreaEmission(bytes, sourceEntry.sha256);
          signal.throwIfAborted();
          return bytes;
        }
      } catch {
        // This is an explicit processing request. Rebuild a corrupt derived
        // representation from the retained source, never in gameplay.
        signal.throwIfAborted();
      }
    }
    host.assertWritable(host.getRootOrThrow(asset.rootId));
    const source = await host.loader.loadChunk(locator, sourceEntry, host.blobsForAsset(asset), host.storageForAsset(asset), { signal });
    if (!source || await sha256Hex(source) !== sourceEntry.sha256) throw new Error("The emission source is missing or corrupt.");
    const bytes = await process({ source, sourceHash: sourceEntry.sha256, mime: sourceEntry.mime }, signal, options.onProgress);
    signal.throwIfAborted();
    await decodeAreaEmission(bytes, sourceEntry.sha256);
    options.onProgress?.({ phase: "saving", progress: 1 });
    await enqueueTextureWrite(host, guid, async () => {
      if (!host.byGuid.has(guid)) throw new Error("The Texture was removed during emission processing.");
      await rewriteTexture(host, guid, async (current, chunks) => {
        signal.throwIfAborted();
        const pixels = [...chunks.values()].find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
        // Every chunk is decoded here (no `load`), so none is carried without its bytes.
        if (!pixels || isCarriedChunk(pixels) || await sha256Hex(pixels.data) !== sourceEntry.sha256) throw new Error("The Texture changed during emission processing; stale results were discarded.");
        for (const [id, chunk] of chunks) if (chunk.kind === AREA_EMISSION_CHUNK_KIND) chunks.delete(id);
        const id = areaEmissionChunkId(sourceEntry.sha256);
        chunks.set(id, { id, kind: AREA_EMISSION_CHUNK_KIND, mime: "application/x-haptic-area-emission", data: bytes });
        return { header: current, chunks };
      }, () => signal.throwIfAborted());
    });
    return bytes;
  }, options.signal);
}

function enqueueTextureWrite(
  host: RegistryHost,
  guid: string,
  work: () => Promise<void>,
): Promise<void> {
  return host.withAssetWrite(guid, work);
}

/**
 * Read-modify-write of a Texture file. By default every chunk is decoded
 * and verified. With `load`, only the chunks it selects are read; the others
 * (the source pixels and older encodes, which a state or metadata change
 * cannot affect) are carried over from the chunk table and reach `mutate`
 * as carried entries without `data`. Anything that cannot be carried safely
 * (a missing or short blob, a changed file) is decoded in full instead.
 */
async function rewriteTexture(
  host: RegistryHost,
  guid: string,
  mutate: TextureRewrite,
  assertCurrent: () => void = () => {},
  load?: (entry: ChunkEntry) => boolean,
): Promise<boolean> {
  const asset = host.byGuid.get(guid);
  // Encode state and derived chunks are never written into a read-only root.
  const root = asset ? host.roots.get(asset.rootId) : undefined;
  if (!asset || asset.placeholder || !root || root.readOnly) return false;
  const storage = host.storageForAsset(asset);
  const blobs = host.blobsForAsset(asset);
  const previousMtime = await host.statMtime(storage, asset.path);
  const { header: stored, chunks: chunksById } = await readForRewrite(storage, blobs, asset.path, load);
  const { chunks, ...headerRest } = stored;
  void chunks;
  const next = await mutate({ ...headerRest }, chunksById, stored);
  // Nothing to write (a refused guard).
  if (!next) return false;
  const bytes = await encodeHasset({
    header: next.header,
    chunks: [...next.chunks.values()],
    writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
  });
  assertCurrent();
  await storage.writeBinary(asset.path, bytes);
  const mtime = await host.statMtime(storage, asset.path);
  const header = readHassetHeader(bytes);
  host.indexHeader(asset.rootId, asset.path, header, false, mtime);
  host.reportOwnWrite({ path: asset.path, previousMtime, mtime });
  return true;
}

/** The stored header and chunks of a file about to be rewritten; see `rewriteTexture`. */
async function readForRewrite(
  storage: ProjectStorage,
  blobs: BlobStore,
  path: string,
  load?: (entry: ChunkEntry) => boolean,
): Promise<{ header: HassetHeader; chunks: Map<string, EncodableChunk> }> {
  if (load) {
    try {
      const stored = await readAssetCatalog(storage, path);
      const carried = await carryStoredChunks(storage, blobs, stored, { load });
      if (carried) return { header: stored.header, chunks: new Map(carried.map((chunk) => [chunk.id, chunk])) };
    } catch {
      // Decoded in full below, which reports an unreadable file as it always has.
    }
  }
  const decoded = await decodeHasset(await storage.readBinary(path), (sha256) => blobs.readBlob(sha256));
  const chunks = new Map<string, EncodableChunk>();
  for (const entry of decoded.header.chunks) {
    const data = decoded.chunks.get(entry.id);
    if (data) chunks.set(entry.id, { id: entry.id, kind: entry.kind, mime: entry.mime, data });
  }
  return { header: decoded.header, chunks };
}

export function isOnBlockGrid(size: ImageSize | null): boolean {
  return size !== null && size.width % TEXTURE_BLOCK_EDGE === 0 && size.height % TEXTURE_BLOCK_EDGE === 0;
}
