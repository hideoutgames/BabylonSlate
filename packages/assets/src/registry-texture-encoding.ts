import { SourceRevisionChangedError } from "@haptic/core";
import { sha256Hex } from "./bytes";
import type { EncodeJobGuard } from "./encode-queue";
import { isEnvironmentTexturePayload } from "./environment-texture";
import type { HassetHeader } from "./hasset";
import { sniffSourceImageSize, type ImageSize } from "./image-size";
import { sniffKtx2Size } from "./ktx2-info";
import type { IndexedAsset, RegistryHost } from "./registry-types";
import { isOnBlockGrid } from "./registry-texture-rewrite";
import { payloadPixelSize, textureEncodeSettingsFor } from "./resolve-gpu-texture";
import {
  clampDimension,
  effectiveTextureMaxDimension,
  shouldCompressTexture,
  textureEncodeChunkId,
  type TextureEncodeSettings,
} from "./texture-compression";

/**
 * A Texture created with an encode already committed (a `.hasset` import
 * or a Duplicate) is a new file, not an older one teammates may share:
 * align it now, as an image import pads its first encode, whatever the
 * editor's rule for re-encoding older Textures in the background.
 */
export async function alignCreatedTextures(host: RegistryHost, assets: readonly IndexedAsset[]): Promise<void> {
  const guids = assets
    .filter((asset) => asset.header.type === "Texture" && asset.header.payload.compressionState === "compressed")
    .map((asset) => asset.header.guid);
  if (guids.length > 0) await host.reconcileTextureAlignment({ guids });
}

/** See `AssetRegistry.retryTextureEncoding`. */
export async function retryTextureEncoding(
  host: RegistryHost,
  guid: string,
  options?: { maxDimension?: number; force?: boolean; usage?: string; guard?: EncodeJobGuard },
): Promise<boolean> {
  const asset = host.byGuid.get(guid);
  if (!asset || asset.header.type !== "Texture" || !host.encodeQueue()) {
    return false;
  }
  // A read-only root or plugin is never rewritten, not even to `pending`.
  const root = host.roots.get(asset.rootId);
  if (asset.placeholder || !root || root.readOnly) return false;
  const state = asset.header.payload.compressionState;
  const recoverable =
    state === "encode_failed" ||
    state === "fallback_uncompressed" ||
    state === "pending" ||
    state === "encoding";
  if (!recoverable && options?.force !== true) {
    return false;
  }
  const usage = options?.usage ?? String(asset.header.payload.usage ?? "albedo");
  if (isEnvironmentTexturePayload(asset.header.payload) || !shouldCompressTexture(usage)) return false;
  const latest = host.byGuid.get(guid) ?? asset;
  // A guarded job wrote no state, so a missing source leaves the Texture as it was.
  const source = options?.guard ? await loadSourcePixels(host, latest) : await encodeSource(host, latest);
  if (!source) return false;
  const settings = encodeSettingsFor(host, latest, usage, {
    sourceSize: sniffSourceImageSize(source.bytes),
    ...(options?.maxDimension
      ? { maxDimension: effectiveTextureMaxDimension(options.maxDimension, host.encodeSettings().maxDimension) }
      : {}),
  });
  const chunkId = await textureEncodeChunkId(settings, usage);
  const queue = host.encodeQueue();
  if (!queue) return false;
  const outcome = queue.enqueue({
    assetGuid: guid,
    source: source.bytes,
    mime: source.mime,
    settings,
    chunkId,
    usage,
    sourceSha256: source.sha256,
    ...(options?.guard ? { guard: options.guard } : {}),
  });
  if (outcome === "yielded") return false;
  // The queue chose the job synchronously above, so an older encode it
  // replaced can no longer commit over the pending mark written here (its
  // commit is refused, or already landed ahead of this write in the
  // Texture's write order). A request the Texture already has needs no mark
  // of its own: its job wrote it, or is about to commit past it.
  if (outcome !== "duplicate" && !options?.guard) {
    await host.setCompressionState(guid, "pending", {
      canWrite: (_guid, current) => current.payload.compressionState !== "pending",
    });
  }
  return true;
}

/** See `AssetRegistry.requeueUncompressedTextures`. */
export async function requeueUncompressedTextures(host: RegistryHost): Promise<number> {
  const queue = host.encodeQueue();
  if (!queue) return 0;
  let count = 0;
  for (const { header } of host.list({ type: "Texture" })) {
    const asset = await settledTexture(host, header.guid);
    if (!asset || queue.has(header.guid)) continue;
    const state = asset.header.payload.compressionState;
    if (
      state === "fallback_uncompressed" ||
      state === "pending" ||
      state === "encoding"
    ) {
      try {
        if (await host.retryTextureEncoding(header.guid)) count += 1;
      } catch (error) {
        // One Texture replaced on disk mid-pass must not stop the others;
        // the next rescan indexes the new file. Any other failure is real.
        if (!(error instanceof SourceRevisionChangedError)) throw error;
      }
    }
  }
  return count;
}

/** A Texture's index entry once its queued writes (such as a commit) have landed. */
async function settledTexture(host: RegistryHost, guid: string): Promise<IndexedAsset | undefined> {
  const writes = host.textureWriteChain.get(guid);
  if (writes) await writes;
  return host.byGuid.get(guid);
}

export async function maybeEnqueueTextureEncode(host: RegistryHost, asset: IndexedAsset): Promise<void> {
  if (asset.header.type !== "Texture" || !host.encodeQueue()) return;
  const usage = String(asset.header.payload.usage ?? "albedo");
  if (isEnvironmentTexturePayload(asset.header.payload) || !shouldCompressTexture(usage)) return;
  if (asset.header.payload.compressionState !== "pending") return;
  const source = await encodeSource(host, asset);
  if (!source) return;
  const settings = encodeSettingsFor(host, asset, usage, { sourceSize: sniffSourceImageSize(source.bytes) });
  const chunkId = await textureEncodeChunkId(settings, usage);
  host.encodeQueue()?.enqueue({
    assetGuid: asset.header.guid,
    source: source.bytes,
    mime: source.mime,
    settings,
    chunkId,
    usage,
    sourceSha256: source.sha256,
  });
}

/** Encode settings with the texture's current atlas status. */
function encodeSettingsFor(
  host: RegistryHost,
  asset: IndexedAsset,
  usage = String(asset.header.payload.usage ?? "albedo"),
  context: { sourceSize?: ImageSize | null; maxDimension?: number } = {},
): TextureEncodeSettings {
  return textureEncodeSettingsFor(asset.header.payload, host.encodeSettings(), usage, {
    ...context,
    atlas: host.isAtlasTexture(asset.header.guid),
  });
}

/** Options of `AssetRegistry.reconcileTextureAlignment`. */
export interface TextureAlignmentOptions {
  guids?: Iterable<string>;
  /**
   * Asked before the requeue, when the job starts, and before its commit
   * with the header of the file on disk it would replace (`EncodeJobGuard`).
   */
  canWrite?: (guid: string, current?: HassetHeader) => boolean;
  /**
   * Usage to check and re-encode with instead of the saved one: an open
   * Texture tab's, which an unsaved Details edit may have changed.
   */
  usageFor?: (guid: string) => string | undefined;
  /**
   * Sizes the pass read, kept across registry remounts: KTX2 base sizes by
   * chunk sha256, and sniffed source sizes by `source:` + chunk sha256.
   */
  ktx2SizeCache?: Map<string, ImageSize | null>;
}

/** See `AssetRegistry.reconcileTextureAlignment`. */
export async function reconcileTextureAlignment(host: RegistryHost, options: TextureAlignmentOptions = {}): Promise<string[]> {
  if (!host.encodeQueue()) return [];
  const guids = options.guids
    ? [...new Set(options.guids)]
    : host.list({ type: "Texture" }).map((asset) => asset.header.guid);
  const canWrite = options.canWrite ?? (() => true);
  const guard: EncodeJobGuard = { canWrite };
  const queue = host.encodeQueue()!;
  const requeued: string[] = [];
  for (const guid of guids) {
    const asset = await settledTexture(host, guid);
    // Already queued (an earlier pass, or a remount's): one job is enough.
    if (queue.has(guid) || host.alignmentRequeues.has(guid) || !asset) continue;
    const usage = options.usageFor?.(guid) ?? String(asset.header.payload.usage ?? "albedo");
    if (!isAlignmentCandidate(host, asset, usage) || !canWrite(guid)) continue;
    host.alignmentRequeues.add(guid);
    try {
      if (!(await isAlignmentStale(host, asset, usage, options.ktx2SizeCache))) continue;
      // Asked again after the (possibly reading) staleness check, just
      // before the requeue, so a refusal meanwhile still stops it.
      if (!canWrite(guid) || queue.has(guid)) continue;
      if (await host.retryTextureEncoding(guid, { force: true, usage, guard })) requeued.push(guid);
    } catch {
      // One unreadable texture must not stop the pass.
    } finally {
      host.alignmentRequeues.delete(guid);
    }
  }
  return requeued;
}

/** See `AssetRegistry.isTextureAlignmentStale`. */
export async function isTextureAlignmentStale(
  host: RegistryHost,
  guid: string,
  options: { usage?: string; ktx2SizeCache?: Map<string, ImageSize | null> } = {},
): Promise<boolean> {
  const queue = host.encodeQueue();
  if (!queue) return false;
  const asset = await settledTexture(host, guid);
  if (!asset || queue.has(guid) || host.alignmentRequeues.has(guid)) return false;
  const usage = options.usage ?? String(asset.header.payload.usage ?? "albedo");
  if (!isAlignmentCandidate(host, asset, usage)) return false;
  try {
    return await isAlignmentStale(host, asset, usage, options.ktx2SizeCache);
  } catch {
    return false;
  }
}

/**
 * A writable `compressed` Texture of a compressed Usage with source pixels
 * to re-encode from: one the alignment pass checks.
 */
function isAlignmentCandidate(host: RegistryHost, asset: IndexedAsset, usage: string): boolean {
  const payload = asset.header.payload;
  if (asset.placeholder || asset.header.type !== "Texture") return false;
  if (payload.compressionState !== "compressed") return false;
  if (isEnvironmentTexturePayload(payload) || !shouldCompressTexture(usage)) return false;
  // Without source pixels a forced retry would strand it `pending`.
  if (!asset.header.chunks.some((chunk) => chunk.kind === "pixels")) return false;
  return !host.roots.get(asset.rootId)?.readOnly;
}

async function isAlignmentStale(
  host: RegistryHost,
  asset: IndexedAsset,
  usage: string,
  cache?: Map<string, ImageSize | null>,
): Promise<boolean> {
  // Particle keys its alignment into the chunk id: always on the grid.
  if (usage === "particle") return false;
  const padded = (committedEncodeRecord(asset.header)?.blockAlign ?? 0) > 1;
  if (host.isAtlasTexture(asset.header.guid)) return padded;
  if (padded) return false;
  const size = await committedKtx2Size(host, asset, usage, cache);
  if (size === null || isOnBlockGrid(size)) return false;
  // Requeue only if the re-encode can differ: padded, or under other
  // settings. Otherwise (a payload or sniffed size that disagrees with the
  // decoded source) it would land off the grid again and repeat after every
  // commit. Built as the requeue builds them: without a payload size, the
  // sniffed source decides the padding.
  const sourceSize = payloadPixelSize(asset.header.payload)
    ? undefined
    : await sniffedSourceSize(host, asset, cache);
  const settings = encodeSettingsFor(host, asset, usage, { sourceSize });
  if (settings.blockAlign !== undefined) return true;
  return asset.header.payload.ktx2ChunkId !== (await textureEncodeChunkId(settings, usage));
}

/** `sniffSourceImageSize` of the source pixels, cached by chunk sha256 under `source:`. */
async function sniffedSourceSize(
  host: RegistryHost,
  asset: IndexedAsset,
  cache?: Map<string, ImageSize | null>,
): Promise<ImageSize | null> {
  const pixels = asset.header.chunks.find((chunk) => chunk.kind === "pixels");
  if (!pixels) return null;
  const key = `source:${pixels.sha256}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  const source = await loadSourcePixels(host, asset);
  const size = source ? sniffSourceImageSize(source.bytes) : null;
  cache?.set(key, size);
  return size;
}

/**
 * Base size of the committed KTX2: the recorded size; else, for an encode
 * committed under today's id without a record, the clamped source size when
 * it is on the grid (padding then changes nothing); else the chunk's KTX2
 * header, which also tells a padded encode whose record was dropped (by an
 * editor that predates it) from an unpadded one.
 */
async function committedKtx2Size(
  host: RegistryHost,
  asset: IndexedAsset,
  usage: string,
  cache?: Map<string, ImageSize | null>,
): Promise<ImageSize | null> {
  const payload = asset.header.payload;
  const recorded = committedEncodeRecord(asset.header)?.size;
  if (recorded) return recorded;
  const committed = payload.ktx2ChunkId;
  if (typeof committed !== "string") return null;
  const source = payloadPixelSize(payload);
  if (source) {
    const settings = encodeSettingsFor(host, asset, usage);
    if (committed === (await textureEncodeChunkId(settings, usage))) {
      const clamped = clampDimension(source.width, source.height, settings.maxDimension);
      if (isOnBlockGrid(clamped)) return { width: clamped.width, height: clamped.height };
    }
  }
  const entry = asset.header.chunks.find((chunk) => chunk.id === committed);
  if (!entry) return null;
  const cached = cache?.get(entry.sha256);
  if (cached !== undefined) return cached;
  const bytes = await host.readChunk(asset.header.guid, entry.id);
  const size = bytes ? sniffKtx2Size(bytes) : null;
  cache?.set(entry.sha256, size);
  return size;
}

/**
 * Source pixels for an encode job the Texture's `pending` state announced.
 * When it has no pixels chunk, or the chunk cannot be read, the Texture is
 * marked `encode_failed` with the reason rather than left `pending` with no
 * job to finish it.
 */
async function encodeSource(host: RegistryHost, asset: IndexedAsset): Promise<{ bytes: Uint8Array; mime?: string; sha256: string } | null> {
  let error = "The Texture has no source pixels to encode.";
  try {
    const source = await loadSourcePixels(host, asset);
    if (source) return source;
  } catch (cause) {
    // Replaced on disk meanwhile: the next rescan indexes the new file.
    if (cause instanceof SourceRevisionChangedError) throw cause;
    error = `The Texture's source pixels could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  await host.setCompressionState(asset.header.guid, "encode_failed", { error });
  return null;
}

/** Source pixels with their sha256, which an encode job's commit checks the file against. */
async function loadSourcePixels(
  host: RegistryHost,
  asset: IndexedAsset,
): Promise<{ bytes: Uint8Array; mime?: string; sha256: string } | null> {
  // Encode callbacks can queue a state rewrite while a retry is obtaining its
  // source. Share their write fence so the snapshot remains valid through the
  // asynchronous hash/revision checks, without relaxing stale-read rejection.
  return host.withAssetWrite(asset.header.guid, async () => {
    const current = host.byGuid.get(asset.header.guid);
    const pixels = current?.header.chunks.find((chunk) => chunk.kind === "pixels");
    if (!pixels) return null;
    const bytes = await host.readChunk(asset.header.guid, pixels.id);
    return { bytes, mime: pixels.mime, sha256: await sha256Hex(bytes) };
  });
}

/**
 * What a commit recorded about the committed encode, while `ktx2Sha256` still
 * matches the committed chunk. A writer that replaced the encode but kept the
 * fields (an editor from before they existed) leaves them describing other
 * bytes, so they are ignored.
 */
function committedEncodeRecord(
  header: HassetHeader,
): { size: ImageSize | null; blockAlign: number | null } | null {
  const payload = header.payload;
  const committed = header.chunks.find((chunk) => chunk.id === payload.ktx2ChunkId);
  if (!committed || typeof payload.ktx2Sha256 !== "string" || committed.sha256 !== payload.ktx2Sha256) {
    return null;
  }
  const { ktx2Width: width, ktx2Height: height, ktx2BlockAlign: blockAlign } = payload;
  return {
    size: typeof width === "number" && typeof height === "number" ? { width, height } : null,
    blockAlign: typeof blockAlign === "number" ? blockAlign : null,
  };
}
