import {
  documentKindForAssetType,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { selectTextureChunk, type IndexedAsset } from "@babylonslate/assets";

const JSON_TYPES = new Set([
  "Scene",
  "Class",
  "Graph",
  "UserInterface",
  "AnimationGraph",
  "BehaviourTree",
  "Blackboard",
  "ShaderGraph",
  "Shader",
  "Sprite",
  "Tilemap",
  "Tileset",
  "Enum",
  "Structure",
  "ScriptInterface",
]);

const encoder = new TextEncoder();

export type ExportDocumentLoaders = {
  assets: readonly IndexedAsset[];
  loadDocument: (kind: string, path: string) => Promise<unknown>;
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
};

export type LoadedExportDocuments = {
  sceneByGuid: (guid: string) => SerializedScene | null;
  graphByGuid: (guid: string) => SerializedGraph | null;
  bytesByGuid: (guid: string) => Uint8Array | null;
};

async function bytesForAsset(
  asset: IndexedAsset,
  document: unknown,
  readAssetChunk: ExportDocumentLoaders["readAssetChunk"],
): Promise<Uint8Array | null> {
  if (JSON_TYPES.has(asset.header.type) && document) {
    return encoder.encode(JSON.stringify(document));
  }
  if (asset.header.type === "Texture") {
    try {
      const selected = selectTextureChunk(asset.header);
      return await readAssetChunk(asset.path, selected.chunk.id);
    } catch {
      return null;
    }
  }
  for (const chunk of asset.header.chunks) {
    if (chunk.id === "document") continue;
    const bytes = await readAssetChunk(asset.path, chunk.id);
    if (bytes) return bytes;
  }
  return null;
}

export async function loadExportDocuments(
  loaders: ExportDocumentLoaders,
): Promise<LoadedExportDocuments> {
  const scenes = new Map<string, SerializedScene>();
  const graphs = new Map<string, SerializedGraph>();
  const bytes = new Map<string, Uint8Array>();
  for (const asset of loaders.assets) {
    const kind = documentKindForAssetType(asset.header.type);
    let document: unknown = null;
    if (
      kind &&
      kind !== "asset-settings" &&
      (JSON_TYPES.has(asset.header.type) ||
        asset.header.type === "Class" ||
        asset.header.type === "Graph" ||
        asset.header.type === "Scene")
    ) {
      try {
        document = await loaders.loadDocument(kind, asset.path);
      } catch {
        document = null;
      }
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
    const payload = await bytesForAsset(asset, document, loaders.readAssetChunk);
    if (payload) bytes.set(asset.header.guid, payload);
  }
  return {
    sceneByGuid: (guid) => scenes.get(guid) ?? null,
    graphByGuid: (guid) => graphs.get(guid) ?? null,
    bytesByGuid: (guid) => bytes.get(guid) ?? null,
  };
}
