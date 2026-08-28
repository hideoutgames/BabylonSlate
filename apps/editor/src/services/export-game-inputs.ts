import {
  documentKindForAssetType,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  AUDIO_REVERB_CHUNK_ID,
  collectPackedAudioClipBlobs,
  encodePackedAudioAsset,
  encodePackedModelAsset,
  FONT_FACETYPE_CHUNK_ID,
  FONT_MSDF_CHUNK_ID,
  FONT_MSDF_PNG_CHUNK_ID,
  normalizeAudioPayload,
  normalizeModelPayload,
  selectTextureChunk,
  type IndexedAsset,
} from "@babylonslate/assets";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";

const JSON_TYPES = new Set([
  "Scene",
  "Class",
  "Graph",
  "AnimationGraph",
  "BehaviourTree",
  "Blackboard",
  "Material",
  "MaterialFunction",
  "Sprite",
  "SpriteAnimation",
  "Tilemap",
  "Tileset",
  "Enum",
  "Structure",
  "ScriptInterface",
  "AudioMixer",
  "AudioChannel",
  "SoundAttenuation",
  "ParticleEmitter",
  "ParticleSystem",
  "Animation",
  "SceneLayer",
]);

const encoder = new TextEncoder();

export type ExportDocumentLoaders = {
  assets: readonly IndexedAsset[];
  loadDocument: (kind: string, path: string) => Promise<unknown>;
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  /** When false, pack Texture `pixels` instead of KTX2. */
  transcoderAvailable?: boolean;
};

export type LoadedExportDocuments = {
  sceneByGuid: (guid: string) => SerializedScene | null;
  graphByGuid: (guid: string) => SerializedGraph | null;
  payloadByGuid: (guid: string) => unknown | null;
  bytesByGuid: (guid: string) => Uint8Array | null;
  fontFacetypeBytesByGuid: (guid: string) => Uint8Array | null;
  fontMsdfJsonByGuid: (guid: string) => Uint8Array | null;
  fontMsdfPngByGuid: (guid: string) => Uint8Array | null;
  navmeshByGuid: (guid: string) => Uint8Array | null;
  audioReverbByGuid: (guid: string) => Uint8Array | null;
};

async function bytesForAsset(
  asset: IndexedAsset,
  document: unknown,
  readAssetChunk: ExportDocumentLoaders["readAssetChunk"],
  transcoderAvailable: boolean,
): Promise<Uint8Array | null> {
  if (JSON_TYPES.has(asset.header.type) && document) {
    return encoder.encode(JSON.stringify(document));
  }
  if (asset.header.type === "Texture") {
    try {
      const selected = selectTextureChunk(asset.header, { transcoderAvailable });
      return await readAssetChunk(asset.path, selected.chunk.id);
    } catch {
      return null;
    }
  }
  if (asset.header.type === "Audio") {
    const payload = normalizeAudioPayload(document ?? asset.header.payload);
    const blobs = await collectPackedAudioClipBlobs({
      payload,
      readChunk: (chunkId) => readAssetChunk(asset.path, chunkId),
    });
    if (!blobs) return null;
    return encodePackedAudioAsset(
      payload,
      blobs.length === 1 ? blobs[0]! : blobs,
    );
  }
  if (asset.header.type === "Model") {
    const source = await readAssetChunk(asset.path, "source");
    if (!source || source.byteLength === 0) return null;
    return encodePackedModelAsset(
      normalizeModelPayload(document ?? asset.header.payload),
      source,
    );
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

async function fontChunkBytesForAsset(
  asset: IndexedAsset,
  chunkId: string,
  readAssetChunk: ExportDocumentLoaders["readAssetChunk"],
): Promise<Uint8Array | null> {
  if (asset.header.type !== "Font") return null;
  try {
    const bytes = await readAssetChunk(asset.path, chunkId);
    return bytes && bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function fontFacetypeBytesForAsset(
  asset: IndexedAsset,
  readAssetChunk: ExportDocumentLoaders["readAssetChunk"],
): Promise<Uint8Array | null> {
  return fontChunkBytesForAsset(asset, FONT_FACETYPE_CHUNK_ID, readAssetChunk);
}

export async function loadExportDocuments(
  loaders: ExportDocumentLoaders,
): Promise<LoadedExportDocuments> {
  const scenes = new Map<string, SerializedScene>();
  const graphs = new Map<string, SerializedGraph>();
  const payloads = new Map<string, unknown>();
  const bytes = new Map<string, Uint8Array>();
  const fontFacetypes = new Map<string, Uint8Array>();
  const fontMsdfJson = new Map<string, Uint8Array>();
  const fontMsdfPng = new Map<string, Uint8Array>();
  const navmeshes = new Map<string, Uint8Array>();
  const audioReverbs = new Map<string, Uint8Array>();
  for (const asset of loaders.assets) {
    const kind = documentKindForAssetType(asset.header.type);
    let document: unknown = null;
    if (
      kind &&
      kind !== "asset-settings" &&
      (JSON_TYPES.has(asset.header.type) ||
        asset.header.type === "Class" ||
        asset.header.type === "Graph" ||
        asset.header.type === "Scene" ||
        asset.header.type === "Font" ||
        asset.header.type === "Audio" ||
        asset.header.type === "Model")
    ) {
      try {
        document = await loaders.loadDocument(kind, asset.path);
      } catch {
        document = asset.header.type === "Audio" || asset.header.type === "Model"
          ? asset.header.payload
          : null;
      }
    }
    if (document && typeof document === "object") {
      payloads.set(asset.header.guid, document);
    } else if (asset.header.type === "Texture") {
      payloads.set(asset.header.guid, asset.header.payload);
    }
    if (asset.header.type === "Scene" && document) {
      scenes.set(asset.header.guid, document as SerializedScene);
    }
    if (
      (asset.header.type === "Class" || asset.header.type === "Graph") &&
      document
    ) {
      graphs.set(asset.header.guid, document as SerializedGraph);
    }
    const payload = await bytesForAsset(
      asset,
      document,
      loaders.readAssetChunk,
      loaders.transcoderAvailable !== false,
    );
    if (payload) bytes.set(asset.header.guid, payload);
    const facetype = await fontFacetypeBytesForAsset(asset, loaders.readAssetChunk);
    if (facetype) fontFacetypes.set(asset.header.guid, facetype);
    const msdfJson = await fontChunkBytesForAsset(
      asset,
      FONT_MSDF_CHUNK_ID,
      loaders.readAssetChunk,
    );
    if (msdfJson) fontMsdfJson.set(asset.header.guid, msdfJson);
    const msdfPng = await fontChunkBytesForAsset(
      asset,
      FONT_MSDF_PNG_CHUNK_ID,
      loaders.readAssetChunk,
    );
    if (msdfPng) fontMsdfPng.set(asset.header.guid, msdfPng);
    if (asset.header.type === "Scene") {
      try {
        const nav = await loaders.readAssetChunk(asset.path, NAVMESH_CHUNK_ID);
        if (nav && nav.byteLength > 0) {
          navmeshes.set(asset.header.guid, nav);
        }
      } catch {
        // Scene JSON still packs when the extra chunk is missing.
      }
      try {
        const field = await loaders.readAssetChunk(
          asset.path,
          AUDIO_REVERB_CHUNK_ID,
        );
        if (field && field.byteLength > 0) {
          audioReverbs.set(asset.header.guid, field);
        }
      } catch {
        // Scene JSON still packs when the extra chunk is missing.
      }
    }
  }
  return {
    sceneByGuid: (guid) => scenes.get(guid) ?? null,
    graphByGuid: (guid) => graphs.get(guid) ?? null,
    payloadByGuid: (guid) => payloads.get(guid) ?? null,
    bytesByGuid: (guid) => bytes.get(guid) ?? null,
    fontFacetypeBytesByGuid: (guid) => fontFacetypes.get(guid) ?? null,
    fontMsdfJsonByGuid: (guid) => fontMsdfJson.get(guid) ?? null,
    fontMsdfPngByGuid: (guid) => fontMsdfPng.get(guid) ?? null,
    navmeshByGuid: (guid) => navmeshes.get(guid) ?? null,
    audioReverbByGuid: (guid) => audioReverbs.get(guid) ?? null,
  };
}
