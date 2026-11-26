import {
  documentKindForAssetType,
  isTimelineClipAssetType,
  normalizeTimelineClipAsset,
  stripTimelineClipAssetEditorData,
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import {
  AUDIO_DEFAULT_SOURCE_CHUNK,
  AUDIO_REVERB_CHUNK_ID,
  collectFoliageChunksForPlay,
  compactTilemapPayload,
  normalizeTilemapPayload,
  collectLandscapeChunksForPlay,
  currentAreaEmissionChunk,
  decodeAreaEmission,
  collectPackedAudioClipBlobs,
  createDefaultMigrationRegistry,
  DOCUMENT_CHUNK_ID,
  encodePackedAudioAsset,
  encodePackedModelAsset,
  withSkeletonSockets,
  FONT_FACETYPE_CHUNK_ID,
  FONT_MSDF_CHUNK_ID,
  FONT_MSDF_PNG_CHUNK_ID,
  isKtx2BlockAligned,
  foliageChunkIdsInHeader,
  landscapeChunkIdsInHeader,
  normalizeAudioPayload,
  normalizeModelPayload,
  normalizeSkeletonPayload,
  PARTICLE_ASSET_TYPES,
  selectTextureChunk,
  shouldCompressTexture,
  textureEncodeBlockAlign,
  type HassetHeader,
  type IndexedAsset,
  type SkeletonSocket,
} from "@haptic/assets";
import { NAVMESH_CHUNK_ID } from "@haptic/navigation/chunk";
import { AudioReverbBakeUnsavedError } from "../lib/audio-reverb-bake";

const JSON_TYPES = new Set<string>([
  "InputAction", "InputAxis", "SaveGame",
  "Scene",
  "Class",
  "AnimationGraph3D",
  "AnimationGraph2D",
  "BlendSpace",
  "SpriteBlendSpace",
  "BehaviourTree",
  "Blackboard",
  "Material",
  "MaterialFunction",
  "MaterialInstance",
  "RenderTarget",
  "RenderTargetTexture",
  "Sprite",
  "SpriteAnimation",
  "Tilemap",
  "Tileset",
  "Enum",
  "Structure",
  "DataDefinition",
  "DataTree",
  "FloatCurve",
  "VectorCurve",
  "ColorCurve",
  "GlobalParameterCollection",
  "ScriptInterface",
  "AudioMixer",
  "AudioChannel",
  "SoundAttenuation",
  "CameraShake",
  // Basic emitters, Particle Graphs and Particle Systems.
  ...PARTICLE_ASSET_TYPES,
  "Water",
  "Animation",
  "Skeleton",
  "SceneLayer",
  "TimelineClip2D",
  "TimelineClip3D",
]);

const encoder = new TextEncoder();
const assetFormats = createDefaultMigrationRegistry();

/** Maximum number of asset reads in flight simultaneously during export. */
export const EXPORT_LOAD_CONCURRENCY = 12;

/** Data catalog types whose payloads `collectAndExportGame` reads across the project for schemas. */
export const EXPORT_DATA_CATALOG_TYPES = new Set<string>([
  "DataDefinition",
  "DataTree",
  "Structure",
  "Enum",
]);

/** Asset types whose JSON document is loaded directly without heavy binary chunks. */
export function isLightweightExportJsonType(type: string): boolean {
  return JSON_TYPES.has(type) || type === "Class";
}

/** Runs `work` across `items` with at most `concurrency` promises in flight. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function chunkSha256(header: HassetHeader | undefined, chunkId: string | undefined): string | undefined {
  if (!header || !chunkId) return undefined;
  const sha = header.chunks.find((chunk) => chunk.id === chunkId)?.sha256;
  return typeof sha === "string" && SHA256_HEX_RE.test(sha) ? sha : undefined;
}

/** Scene chunks packed with the Scene JSON, so all three must come from one saved version. */
const SCENE_EXPORT_CHUNK_IDS = [NAVMESH_CHUNK_ID, AUDIO_REVERB_CHUNK_ID] as const;

/** Font chunks packed beside the Font source as their own assets. */
const FONT_SIDECAR_CHUNK_IDS = [FONT_FACETYPE_CHUNK_ID, FONT_MSDF_CHUNK_ID, FONT_MSDF_PNG_CHUNK_ID] as const;

/** Chunks to read with a document: fixed ids, or chosen from the header of the version being read. */
export type ExportChunkSelection = readonly string[] | ((header: HassetHeader) => readonly string[]);

/** A document with its header and selected chunks, all from one saved version. */
export type ExportDocumentSnapshot = {
  document: unknown;
  header: HassetHeader;
  chunks: ReadonlyMap<string, Uint8Array>;
};

export type ExportDocumentLoaders = {
  assets: readonly IndexedAsset[];
  /**
   * Full project asset list for auxiliary lookups (such as a reachable Model's
   * Skeleton) when `assets` is already filtered to reachable entries.
   */
  allAssets?: readonly IndexedAsset[];
  /**
   * Non-chunked JSON documents already read during reachability discovery, keyed
   * by asset guid, so Phase 2 skips redundant storage reads.
   */
  preloadedDocuments?: ReadonlyMap<string, unknown>;
  /** Bound on concurrent asset reads (defaults to `EXPORT_LOAD_CONCURRENCY`). */
  concurrency?: number;
  loadDocument: (kind: string, path: string) => Promise<unknown>;
  /**
   * A document, its header and the selected chunks its file holds, all from
   * one saved version (`ProjectService.loadDocumentWithChunks`). Every asset
   * that packs a document or header with chunks (Scene, Audio, Model, Font,
   * Texture) loads through it, so a Save landing between reads cannot pair one
   * version's data with another's.
   */
  loadDocumentWithChunks: (
    kind: string,
    path: string,
    chunks: ExportChunkSelection,
  ) => Promise<ExportDocumentSnapshot>;
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  /** When false, pack Texture `pixels` instead of KTX2. */
  transcoderAvailable?: boolean;
  /**
   * Scenes the audio reverb bake could not read, or whose fresh result it could
   * not save (`AudioReverbBakeUnsavedError`), by path: a reached one fails the
   * export unless its saved chunk already equals the fresh result.
   */
  audioReverbBakeFailures?: ReadonlyMap<string, unknown>;
};

export type LoadedExportDocuments = {
  sceneByGuid: (guid: string) => SerializedScene | null;
  graphByGuid: (guid: string) => SerializedGraph | null;
  payloadByGuid: (guid: string) => unknown | null;
  /** Throws the read error of an asset whose format is unsupported or whose document or packed bytes failed to load. */
  bytesByGuid: (guid: string) => Uint8Array | null;
  /** Verified SHA-256 hex digest from `.hasset` chunk headers when `bytesByGuid(guid)` is an unmodified chunk. */
  sha256ByGuid: (guid: string) => string | undefined;
  fontFacetypeBytesByGuid: (guid: string) => Uint8Array | null;
  areaEmissionBytesByGuid: (guid: string) => Uint8Array | null;
  fontMsdfJsonByGuid: (guid: string) => Uint8Array | null;
  fontMsdfPngByGuid: (guid: string) => Uint8Array | null;
  navmeshByGuid: (guid: string) => Uint8Array | null;
  /** Throws for a Scene the reverb bake could not read or save, so its chunk may be stale. */
  audioReverbByGuid: (guid: string) => Uint8Array | null;
  /** Raw binary Landscape (`HPLD`) and Foliage (`HPFG`) chunks owned by a Scene. */
  componentChunksByGuid: (guid: string) => ReadonlyArray<{ chunkId: string; bytes: Uint8Array; sha256?: string }>;
};

/** Audio clip chunks: the clip importer allocates only `source` and `source:N`. */
function isAudioClipChunkId(id: string): boolean {
  return id === AUDIO_DEFAULT_SOURCE_CHUNK || id.startsWith(`${AUDIO_DEFAULT_SOURCE_CHUNK}:`);
}

/** A Font's source (woff/ttf): its first chunk that is neither the document nor a sidecar. */
function fontSourceChunkId(header: HassetHeader): string | undefined {
  return header.chunks.find((chunk) => chunk.id !== DOCUMENT_CHUNK_ID &&
    !(FONT_SIDECAR_CHUNK_IDS as readonly string[]).includes(chunk.id))?.id;
}

/** Chunks packed with a type's document, or null for a type that packs its document alone. */
function exportChunkSelection(type: string): ExportChunkSelection | null {
  switch (type) {
    case "Scene": return (header) => [...SCENE_EXPORT_CHUNK_IDS, ...landscapeChunkIdsInHeader(header.chunks), ...foliageChunkIdsInHeader(header.chunks)];
    case "Audio": return (header) => header.chunks.map((chunk) => chunk.id).filter(isAudioClipChunkId);
    case "Model": return ["source"];
    case "Font": return (header) => [fontSourceChunkId(header), ...FONT_SIDECAR_CHUNK_IDS].filter((id) => id !== undefined);
    default: return null;
  }
}

function texturePixelsChunk(header: HassetHeader) {
  return header.chunks.find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
}

function textureUsage(header: HassetHeader): string {
  return String(header.payload.usage ?? "albedo");
}

/**
 * The selected variant, `pixels` where it replaces a KTX2 (always for an
 * uncompressed Usage; for a stale Particle KTX2 once `withPixels`), and the
 * current area emission.
 */
function textureChunkIds(header: HassetHeader, transcoderAvailable: boolean, withPixels: boolean): string[] {
  const selected = selectTextureChunk(header, { transcoderAvailable });
  const pixels = texturePixelsChunk(header);
  const ids = [selected.chunk.id];
  if (pixels && selected.kind === "ktx2" && (withPixels || !shouldCompressTexture(textureUsage(header)))) {
    ids.push(pixels.id);
  }
  const emission = currentAreaEmissionChunk(header);
  if (emission) ids.push(emission.id);
  return ids;
}

/** The Texture bytes and source chunk SHA-256 to pack, or undefined when a stale KTX2 needs `pixels` this snapshot did not read. */
function packedTextureBytes(
  { header, chunks }: ExportDocumentSnapshot,
  transcoderAvailable: boolean,
  withPixels: boolean,
): { bytes: Uint8Array | null; sha256?: string } | undefined {
  const selected = selectTextureChunk(header, { transcoderAvailable });
  const bytes = chunks.get(selected.chunk.id) ?? null;
  const usage = textureUsage(header);
  const blockAlign = textureEncodeBlockAlign(usage);
  if (
    selected.kind !== "ktx2" ||
    !bytes ||
    (shouldCompressTexture(usage) && (!blockAlign || isKtx2BlockAligned(bytes, blockAlign)))
  ) {
    return { bytes, sha256: chunkSha256(header, selected.chunk.id) };
  }
  // A KTX2 retained from an earlier Usage: uncompressed Usages keep exact
  // pixels, and Particle encodes block-aligned, so a misaligned Particle
  // KTX2 is stale (its re-encode pending or failed). Ship the source pixels.
  const pixels = texturePixelsChunk(header);
  if (!pixels) return { bytes, sha256: chunkSha256(header, selected.chunk.id) };
  if (!withPixels && shouldCompressTexture(usage)) return undefined;
  const pixelBytes = chunks.get(pixels.id);
  return pixelBytes
    ? { bytes: pixelBytes, sha256: chunkSha256(header, pixels.id) }
    : { bytes, sha256: chunkSha256(header, selected.chunk.id) };
}

/**
 * A Texture's header, packed bytes and area emission from one saved version.
 * Whether a Particle KTX2 is stale shows only in its bytes; then the whole
 * snapshot is read again with `pixels`, and that version decides.
 */
async function readTextureSnapshot(
  loaders: ExportDocumentLoaders,
  kind: string,
  path: string,
  transcoderAvailable: boolean,
): Promise<{ snapshot: ExportDocumentSnapshot; bytes: Uint8Array | null; sha256?: string }> {
  const read = (withPixels: boolean) => loaders.loadDocumentWithChunks(kind, path,
    (header) => textureChunkIds(header, transcoderAvailable, withPixels));
  const snapshot = await read(false);
  const packed = packedTextureBytes(snapshot, transcoderAvailable, false);
  if (packed !== undefined) return { snapshot, ...packed };
  const withPixels = await read(true);
  const fallback = packedTextureBytes(withPixels, transcoderAvailable, true);
  return { snapshot: withPixels, bytes: fallback?.bytes ?? null, sha256: fallback?.sha256 };
}

async function bytesForAsset(
  asset: IndexedAsset,
  document: unknown,
  snapshot: ExportDocumentSnapshot | null,
  readAssetChunk: ExportDocumentLoaders["readAssetChunk"],
  /** A Model's Skeleton's sockets, which the packed Model carries for the renderer. */
  skeletonSockets: (skeletonGuid: string | null) => Promise<SkeletonSocket[] | undefined>,
): Promise<{ bytes: Uint8Array | null; sha256?: string }> {
  // A Timeline Clip asset ships its keys, events and proxies; its Editor Preview never leaves the editor.
  if (isTimelineClipAssetType(asset.header.type) && document) {
    return { bytes: encoder.encode(JSON.stringify(stripTimelineClipAssetEditorData(normalizeTimelineClipAsset(document)))) };
  }
  // A Tilemap ships its chunks run-length encoded, as its .hasset stores them.
  if (asset.header.type === "Tilemap" && document) {
    return { bytes: encoder.encode(JSON.stringify(compactTilemapPayload(normalizeTilemapPayload(document)))) };
  }
  if (JSON_TYPES.has(asset.header.type) && document) {
    return { bytes: encoder.encode(JSON.stringify(document)) };
  }
  if (asset.header.type === "Audio" && snapshot) {
    const payload = normalizeAudioPayload(document ?? snapshot.header.payload);
    const blobs = await collectPackedAudioClipBlobs({
      payload,
      readChunk: async (chunkId) => snapshot.chunks.get(chunkId) ?? null,
    });
    if (!blobs) return { bytes: null };
    return {
      bytes: encodePackedAudioAsset(
        payload,
        blobs.length === 1 ? blobs[0]! : blobs,
      ),
    };
  }
  if (asset.header.type === "Model" && snapshot) {
    const source = snapshot.chunks.get("source");
    if (!source || source.byteLength === 0) return { bytes: null };
    const model = normalizeModelPayload(document ?? snapshot.header.payload);
    return { bytes: encodePackedModelAsset(withSkeletonSockets(model, await skeletonSockets(model.skeletonGuid)), source) };
  }
  if (asset.header.type === "Font" && snapshot) {
    const source = fontSourceChunkId(snapshot.header);
    return {
      bytes: source ? snapshot.chunks.get(source) ?? null : null,
      sha256: chunkSha256(snapshot.header, source),
    };
  }
  for (const chunk of asset.header.chunks) {
    if (chunk.id === "document" || chunk.id === FONT_FACETYPE_CHUNK_ID) continue;
    if (chunk.id === FONT_MSDF_CHUNK_ID || chunk.id === FONT_MSDF_PNG_CHUNK_ID) {
      continue;
    }
    const bytes = await readAssetChunk(asset.path, chunk.id);
    if (bytes) return { bytes, sha256: chunkSha256(asset.header, chunk.id) };
  }
  return { bytes: null };
}

/** A Font sidecar packs only when its snapshot holds non-empty bytes. */
function fontSidecarBytes(snapshot: ExportDocumentSnapshot | null, chunkId: string): Uint8Array | null {
  const bytes = snapshot?.chunks.get(chunkId);
  return bytes && bytes.byteLength > 0 ? bytes : null;
}

export async function loadExportDocuments(
  loaders: ExportDocumentLoaders,
): Promise<LoadedExportDocuments> {
  const scenes = new Map<string, SerializedScene>();
  const graphs = new Map<string, SerializedGraph>();
  const payloads = new Map<string, unknown>();
  const bytes = new Map<string, Uint8Array>();
  const sha256s = new Map<string, string>();
  const fontFacetypes = new Map<string, Uint8Array>();
  const byteErrors = new Map<string, unknown>();
  const areaEmissions = new Map<string, Uint8Array>();
  const areaEmissionErrors = new Map<string, unknown>();
  const fontMsdfJson = new Map<string, Uint8Array>();
  const fontMsdfPng = new Map<string, Uint8Array>();
  const navmeshes = new Map<string, Uint8Array>();
  const audioReverbs = new Map<string, Uint8Array>();
  const audioReverbErrors = new Map<string, unknown>();
  const landscapes = new Map<string, Array<{ chunkId: string; bytes: Uint8Array; sha256?: string }>>();
  const skeletonPool = loaders.allAssets ?? loaders.assets;
  const skeletonsByGuid = new Map<string, IndexedAsset>();
  for (const entry of skeletonPool) {
    if (entry.header.type === "Skeleton") skeletonsByGuid.set(entry.header.guid, entry);
  }
  // Each Skeleton read once, for the Models on it.
  const socketsBySkeleton = new Map<string, Promise<SkeletonSocket[] | undefined>>();
  const skeletonSockets = (skeletonGuid: string | null) => {
    if (!skeletonGuid) return Promise.resolve(undefined);
    let sockets = socketsBySkeleton.get(skeletonGuid);
    if (!sockets) {
      const skeleton = skeletonsByGuid.get(skeletonGuid);
      const kind = skeleton ? documentKindForAssetType("Skeleton") : null;
      const preloaded = loaders.preloadedDocuments?.get(skeletonGuid);
      sockets = preloaded !== undefined
        ? Promise.resolve(normalizeSkeletonPayload(preloaded).sockets)
        : skeleton && kind
          ? loaders.loadDocument(kind, skeleton.path).then((payload) => normalizeSkeletonPayload(payload).sockets)
          : Promise.resolve(undefined);
      socketsBySkeleton.set(skeletonGuid, sockets);
    }
    return sockets;
  };
  const concurrency = loaders.concurrency ?? EXPORT_LOAD_CONCURRENCY;
  await mapWithConcurrency(loaders.assets, concurrency, async (asset) => {
    // Payloads are packed without migration. An unsupported format fails the
    // export once the game reaches the asset; an unreached one does not.
    try {
      assetFormats.requireCurrent(asset.header.type, asset.header.version);
    } catch (error) {
      byteErrors.set(asset.header.guid, error);
      return;
    }
    const kind = documentKindForAssetType(asset.header.type);
    const transcoderAvailable = loaders.transcoderAvailable !== false;
    let document: unknown = null;
    // The document (or Texture header) with the chunks packed beside it, from one saved version.
    let snapshot: ExportDocumentSnapshot | null = null;
    let textureBytes: Uint8Array | null = null;
    let textureSha256: string | undefined;
    const selection = exportChunkSelection(asset.header.type);
    if (
      kind &&
      (JSON_TYPES.has(asset.header.type) ||
        asset.header.type === "Class" ||
        asset.header.type === "Texture" ||
        selection)
    ) {
      try {
        if (asset.header.type === "Texture") {
          ({ snapshot, bytes: textureBytes, sha256: textureSha256 } = await readTextureSnapshot(loaders, kind, asset.path, transcoderAvailable));
        } else if (selection) {
          snapshot = await loaders.loadDocumentWithChunks(kind, asset.path, selection);
          document = snapshot.document;
        } else if (loaders.preloadedDocuments?.has(asset.header.guid)) {
          document = loaders.preloadedDocuments.get(asset.header.guid);
        } else {
          document = await loaders.loadDocument(kind, asset.path);
        }
      } catch (error) {
        // A reached asset fails the export rather than shipping without it, or
        // with one version's settings and another's chunks.
        byteErrors.set(asset.header.guid, error);
        if (asset.header.type === "Texture") areaEmissionErrors.set(asset.header.guid, error);
      }
    }
    if (asset.header.type === "Scene" && document) {
      const landscape = collectLandscapeChunksForPlay(document as SerializedScene, snapshot?.chunks);
      const foliage = collectFoliageChunksForPlay(landscape.payload, snapshot?.chunks);
      document = foliage.payload;
      const collected = [...landscape.chunks, ...foliage.chunks];
      if (collected.length > 0) {
        landscapes.set(
          asset.header.guid,
          collected.map(([chunkId, chunkBytes]) => ({
            chunkId,
            bytes: chunkBytes,
            sha256: chunkSha256(snapshot?.header, chunkId),
          })),
        );
      }
      scenes.set(asset.header.guid, foliage.payload);
    }
    if (asset.header.type === "Texture") {
      // Texture settings live in the header read with its chunks.
      payloads.set(asset.header.guid, (snapshot?.header ?? asset.header).payload);
    } else if (document && typeof document === "object") {
      payloads.set(asset.header.guid, document);
    }
    if (asset.header.type === "Class" && document) {
      graphs.set(asset.header.guid, document as SerializedGraph);
    }
    if (!byteErrors.has(asset.header.guid)) {
      try {
        const packed = asset.header.type === "Texture"
          ? { bytes: textureBytes, sha256: textureSha256 }
          : await bytesForAsset(asset, document, snapshot, loaders.readAssetChunk, skeletonSockets);
        if (packed.bytes) {
          bytes.set(asset.header.guid, packed.bytes);
          if (packed.sha256) sha256s.set(asset.header.guid, packed.sha256);
        }
      } catch (error) {
        byteErrors.set(asset.header.guid, error);
      }
    }
    // Checked against the source hash of the header it was read with.
    const emissionChunk = snapshot && currentAreaEmissionChunk(snapshot.header);
    if (snapshot && emissionChunk) {
      try {
        const data = snapshot.chunks.get(emissionChunk.id);
        if (!data) throw new Error(`Prepared emission is missing for Texture ${asset.header.name}.`);
        await decodeAreaEmission(data, texturePixelsChunk(snapshot.header)?.sha256);
        areaEmissions.set(asset.header.guid, data);
      } catch (error) { areaEmissionErrors.set(asset.header.guid, error); }
    }
    if (asset.header.type === "Font") {
      const facetype = fontSidecarBytes(snapshot, FONT_FACETYPE_CHUNK_ID);
      if (facetype) fontFacetypes.set(asset.header.guid, facetype);
      const msdfJson = fontSidecarBytes(snapshot, FONT_MSDF_CHUNK_ID);
      if (msdfJson) fontMsdfJson.set(asset.header.guid, msdfJson);
      const msdfPng = fontSidecarBytes(snapshot, FONT_MSDF_PNG_CHUNK_ID);
      if (msdfPng) fontMsdfPng.set(asset.header.guid, msdfPng);
    }
    if (asset.header.type === "Scene") {
      const sceneChunks = snapshot?.chunks;
      // Read with the Scene JSON; a Scene whose read failed is already
      // recorded in byteErrors. Scene JSON still packs without either chunk.
      const nav = sceneChunks?.get(NAVMESH_CHUNK_ID);
      if (nav && nav.byteLength > 0) {
        navmeshes.set(asset.header.guid, nav);
      }
      const field = sceneChunks?.get(AUDIO_REVERB_CHUNK_ID) ?? null;
      // A chunk the bake could not refresh may be stale; never pack it, unless
      // it already equals the fresh result the bake could not save.
      if (loaders.audioReverbBakeFailures?.has(asset.path)) {
        const failure = loaders.audioReverbBakeFailures.get(asset.path);
        if (!(failure instanceof AudioReverbBakeUnsavedError && failure.matches(field))) {
          audioReverbErrors.set(asset.header.guid, failure);
          return;
        }
      }
      if (field && field.byteLength > 0) {
        audioReverbs.set(asset.header.guid, field);
      }
    }
  });
  return {
    sceneByGuid: (guid) => scenes.get(guid) ?? null,
    graphByGuid: (guid) => graphs.get(guid) ?? null,
    payloadByGuid: (guid) => payloads.get(guid) ?? null,
    bytesByGuid: (guid) => {
      if (byteErrors.has(guid)) throw byteErrors.get(guid);
      return bytes.get(guid) ?? null;
    },
    sha256ByGuid: (guid) => sha256s.get(guid),
    fontFacetypeBytesByGuid: (guid) => fontFacetypes.get(guid) ?? null,
    areaEmissionBytesByGuid: (guid) => {
      if (areaEmissionErrors.has(guid)) throw areaEmissionErrors.get(guid);
      return areaEmissions.get(guid) ?? null;
    },
    fontMsdfJsonByGuid: (guid) => fontMsdfJson.get(guid) ?? null,
    fontMsdfPngByGuid: (guid) => fontMsdfPng.get(guid) ?? null,
    navmeshByGuid: (guid) => navmeshes.get(guid) ?? null,
    audioReverbByGuid: (guid) => {
      if (audioReverbErrors.has(guid)) throw audioReverbErrors.get(guid);
      return audioReverbs.get(guid) ?? null;
    },
    componentChunksByGuid: (guid) => landscapes.get(guid) ?? [],
  };
}
