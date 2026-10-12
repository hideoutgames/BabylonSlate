import {
  documentKindForAssetType,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  AUDIO_DEFAULT_SOURCE_CHUNK,
  AUDIO_REVERB_CHUNK_ID,
  currentAreaEmissionChunk,
  decodeAreaEmission,
  collectPackedAudioClipBlobs,
  createDefaultMigrationRegistry,
  DOCUMENT_CHUNK_ID,
  encodePackedAudioAsset,
  encodePackedModelAsset,
  FONT_FACETYPE_CHUNK_ID,
  FONT_MSDF_CHUNK_ID,
  FONT_MSDF_PNG_CHUNK_ID,
  isKtx2BlockAligned,
  normalizeAudioPayload,
  normalizeModelPayload,
  PARTICLE_ASSET_TYPES,
  selectTextureChunk,
  shouldCompressTexture,
  textureEncodeBlockAlign,
  type BabassetHeader,
  type IndexedAsset,
} from "@babylonslate/assets";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";
import { AudioReverbBakeUnsavedError } from "../lib/audio-reverb-bake";

const JSON_TYPES = new Set<string>([
  "InputAction", "InputAxis", "SaveGame",
  "Scene",
  "Class",
  "AnimationGraph",
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
  "ScriptInterface",
  "AudioMixer",
  "AudioChannel",
  "SoundAttenuation",
  // Basic emitters, Particle Graphs and Particle Systems.
  ...PARTICLE_ASSET_TYPES,
  "Water",
  "Animation",
  "Skeleton",
  "SceneLayer",
]);

const encoder = new TextEncoder();
const assetFormats = createDefaultMigrationRegistry();

/** Scene chunks packed with the Scene JSON, so all three must come from one saved version. */
const SCENE_EXPORT_CHUNK_IDS = [NAVMESH_CHUNK_ID, AUDIO_REVERB_CHUNK_ID] as const;

/** Font chunks packed beside the Font source as their own assets. */
const FONT_SIDECAR_CHUNK_IDS = [FONT_FACETYPE_CHUNK_ID, FONT_MSDF_CHUNK_ID, FONT_MSDF_PNG_CHUNK_ID] as const;

/** Chunks to read with a document: fixed ids, or chosen from the header of the version being read. */
export type ExportChunkSelection = readonly string[] | ((header: BabassetHeader) => readonly string[]);

/** A document with its header and selected chunks, all from one saved version. */
export type ExportDocumentSnapshot = {
  document: unknown;
  header: BabassetHeader;
  chunks: ReadonlyMap<string, Uint8Array>;
};

export type ExportDocumentLoaders = {
  assets: readonly IndexedAsset[];
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
  fontFacetypeBytesByGuid: (guid: string) => Uint8Array | null;
  areaEmissionBytesByGuid: (guid: string) => Uint8Array | null;
  fontMsdfJsonByGuid: (guid: string) => Uint8Array | null;
  fontMsdfPngByGuid: (guid: string) => Uint8Array | null;
  navmeshByGuid: (guid: string) => Uint8Array | null;
  /** Throws for a Scene the reverb bake could not read or save, so its chunk may be stale. */
  audioReverbByGuid: (guid: string) => Uint8Array | null;
};

/** Audio clip chunks: the clip importer allocates only `source` and `source:N`. */
function isAudioClipChunkId(id: string): boolean {
  return id === AUDIO_DEFAULT_SOURCE_CHUNK || id.startsWith(`${AUDIO_DEFAULT_SOURCE_CHUNK}:`);
}

/** A Font's source (woff/ttf): its first chunk that is neither the document nor a sidecar. */
function fontSourceChunkId(header: BabassetHeader): string | undefined {
  return header.chunks.find((chunk) => chunk.id !== DOCUMENT_CHUNK_ID &&
    !(FONT_SIDECAR_CHUNK_IDS as readonly string[]).includes(chunk.id))?.id;
}

/** Chunks packed with a type's document, or null for a type that packs its document alone. */
function exportChunkSelection(type: string): ExportChunkSelection | null {
  switch (type) {
    case "Scene": return SCENE_EXPORT_CHUNK_IDS;
    case "Audio": return (header) => header.chunks.map((chunk) => chunk.id).filter(isAudioClipChunkId);
    case "Model": return ["source"];
    case "Font": return (header) => [fontSourceChunkId(header), ...FONT_SIDECAR_CHUNK_IDS].filter((id) => id !== undefined);
    default: return null;
  }
}

function texturePixelsChunk(header: BabassetHeader) {
  return header.chunks.find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
}

function textureUsage(header: BabassetHeader): string {
  return String(header.payload.usage ?? "albedo");
}

/**
 * The selected variant, `pixels` where it replaces a KTX2 (always for an
 * uncompressed Usage; for a stale Particle KTX2 once `withPixels`), and the
 * current area emission.
 */
function textureChunkIds(header: BabassetHeader, transcoderAvailable: boolean, withPixels: boolean): string[] {
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

/** The Texture bytes to pack, or undefined when a stale KTX2 needs `pixels` this snapshot did not read. */
function packedTextureBytes(
  { header, chunks }: ExportDocumentSnapshot,
  transcoderAvailable: boolean,
  withPixels: boolean,
): Uint8Array | null | undefined {
  const selected = selectTextureChunk(header, { transcoderAvailable });
  const bytes = chunks.get(selected.chunk.id) ?? null;
  const usage = textureUsage(header);
  const blockAlign = textureEncodeBlockAlign(usage);
  if (
    selected.kind !== "ktx2" ||
    !bytes ||
    (shouldCompressTexture(usage) && (!blockAlign || isKtx2BlockAligned(bytes, blockAlign)))
  ) {
    return bytes;
  }
  // A KTX2 retained from an earlier Usage: uncompressed Usages keep exact
  // pixels, and Particle encodes block-aligned, so a misaligned Particle
  // KTX2 is stale (its re-encode pending or failed). Ship the source pixels.
  const pixels = texturePixelsChunk(header);
  if (!pixels) return bytes;
  if (!withPixels && shouldCompressTexture(usage)) return undefined;
  return chunks.get(pixels.id) ?? bytes;
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
): Promise<{ snapshot: ExportDocumentSnapshot; bytes: Uint8Array | null }> {
  const read = (withPixels: boolean) => loaders.loadDocumentWithChunks(kind, path,
    (header) => textureChunkIds(header, transcoderAvailable, withPixels));
  const snapshot = await read(false);
  const bytes = packedTextureBytes(snapshot, transcoderAvailable, false);
  if (bytes !== undefined) return { snapshot, bytes };
  const withPixels = await read(true);
  return { snapshot: withPixels, bytes: packedTextureBytes(withPixels, transcoderAvailable, true) ?? null };
}

async function bytesForAsset(
  asset: IndexedAsset,
  document: unknown,
  snapshot: ExportDocumentSnapshot | null,
  readAssetChunk: ExportDocumentLoaders["readAssetChunk"],
): Promise<Uint8Array | null> {
  if (JSON_TYPES.has(asset.header.type) && document) {
    return encoder.encode(JSON.stringify(document));
  }
  if (asset.header.type === "Audio" && snapshot) {
    const payload = normalizeAudioPayload(document ?? snapshot.header.payload);
    const blobs = await collectPackedAudioClipBlobs({
      payload,
      readChunk: async (chunkId) => snapshot.chunks.get(chunkId) ?? null,
    });
    if (!blobs) return null;
    return encodePackedAudioAsset(
      payload,
      blobs.length === 1 ? blobs[0]! : blobs,
    );
  }
  if (asset.header.type === "Model" && snapshot) {
    const source = snapshot.chunks.get("source");
    if (!source || source.byteLength === 0) return null;
    return encodePackedModelAsset(
      normalizeModelPayload(document ?? snapshot.header.payload),
      source,
    );
  }
  if (asset.header.type === "Font" && snapshot) {
    const source = fontSourceChunkId(snapshot.header);
    return source ? snapshot.chunks.get(source) ?? null : null;
  }
  for (const chunk of asset.header.chunks) {
    if (chunk.id === "document" || chunk.id === FONT_FACETYPE_CHUNK_ID) continue;
    if (chunk.id === FONT_MSDF_CHUNK_ID || chunk.id === FONT_MSDF_PNG_CHUNK_ID) {
      continue;
    }
    const bytes = await readAssetChunk(asset.path, chunk.id);
    if (bytes) return bytes;
  }
  return null;
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
  const fontFacetypes = new Map<string, Uint8Array>();
  const byteErrors = new Map<string, unknown>();
  const areaEmissions = new Map<string, Uint8Array>();
  const areaEmissionErrors = new Map<string, unknown>();
  const fontMsdfJson = new Map<string, Uint8Array>();
  const fontMsdfPng = new Map<string, Uint8Array>();
  const navmeshes = new Map<string, Uint8Array>();
  const audioReverbs = new Map<string, Uint8Array>();
  const audioReverbErrors = new Map<string, unknown>();
  for (const asset of loaders.assets) {
    // Payloads are packed without migration. An unsupported format fails the
    // export once the game reaches the asset; an unreached one does not.
    try {
      assetFormats.requireCurrent(asset.header.type, asset.header.version);
    } catch (error) {
      byteErrors.set(asset.header.guid, error);
      continue;
    }
    const kind = documentKindForAssetType(asset.header.type);
    const transcoderAvailable = loaders.transcoderAvailable !== false;
    let document: unknown = null;
    // The document (or Texture header) with the chunks packed beside it, from one saved version.
    let snapshot: ExportDocumentSnapshot | null = null;
    let textureBytes: Uint8Array | null = null;
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
          ({ snapshot, bytes: textureBytes } = await readTextureSnapshot(loaders, kind, asset.path, transcoderAvailable));
        } else if (selection) {
          snapshot = await loaders.loadDocumentWithChunks(kind, asset.path, selection);
          document = snapshot.document;
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
    if (asset.header.type === "Texture") {
      // Texture settings live in the header read with its chunks.
      payloads.set(asset.header.guid, (snapshot?.header ?? asset.header).payload);
    } else if (document && typeof document === "object") {
      payloads.set(asset.header.guid, document);
    }
    if (asset.header.type === "Scene" && document) {
      scenes.set(asset.header.guid, document as SerializedScene);
    }
    if (asset.header.type === "Class" && document) {
      graphs.set(asset.header.guid, document as SerializedGraph);
    }
    if (!byteErrors.has(asset.header.guid)) {
      try {
        const payload = asset.header.type === "Texture"
          ? textureBytes
          : await bytesForAsset(asset, document, snapshot, loaders.readAssetChunk);
        if (payload) bytes.set(asset.header.guid, payload);
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
          continue;
        }
      }
      if (field && field.byteLength > 0) {
        audioReverbs.set(asset.header.guid, field);
      }
    }
  }
  return {
    sceneByGuid: (guid) => scenes.get(guid) ?? null,
    graphByGuid: (guid) => graphs.get(guid) ?? null,
    payloadByGuid: (guid) => payloads.get(guid) ?? null,
    bytesByGuid: (guid) => {
      if (byteErrors.has(guid)) throw byteErrors.get(guid);
      return bytes.get(guid) ?? null;
    },
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
  };
}
