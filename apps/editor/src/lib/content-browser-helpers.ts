import type { ImportResult, IndexedAsset } from "@babylonslate/assets";
import { DOCUMENT_CHUNK_ID } from "@babylonslate/assets";
import {
  createDefaultGraph,
  createDefaultScene,
} from "@babylonslate/core";

export const ASSET_DRAG_MIME = "application/x-babylonslate-asset";

export type TextureCompressionState =
  | "pending"
  | "encoding"
  | "compressed"
  | "fallback_uncompressed"
  | "encode_failed";

export const TEXTURE_COMPRESSION_STATES: TextureCompressionState[] = [
  "pending",
  "encoding",
  "fallback_uncompressed",
  "encode_failed",
];

/** Engine base classes available when authoring a new Class asset. */
export const ENGINE_BASE_CLASSES = [
  "BObject",
  "Actor",
  "ActorComponent",
  "GameInstance",
] as const;

/** Asset types creatable from the Content Browser New Asset flow. */
export const CREATABLE_ASSET_TYPES = [
  "Scene",
  "Graph",
  "Texture",
  "Material",
  "Model",
  "Audio",
  "Font",
  "Class",
] as const;

export type CreatableAssetType = (typeof CREATABLE_ASSET_TYPES)[number];

export function assetDragPayload(asset: IndexedAsset): string {
  return JSON.stringify({
    guid: asset.header.guid,
    type: asset.header.type,
    path: asset.path,
  });
}

export function matchesAssetSearch(asset: IndexedAsset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    asset.header.name.toLowerCase().includes(needle) ||
    asset.path.toLowerCase().includes(needle) ||
    asset.header.type.toLowerCase().includes(needle)
  );
}

export function filterAssets(
  assets: IndexedAsset[],
  options: {
    folderGuids: Set<string> | null;
    typeFilter: string | null;
    search: string;
  },
): IndexedAsset[] {
  return assets.filter((asset) => {
    if (options.folderGuids && !options.folderGuids.has(asset.header.guid)) {
      return false;
    }
    if (options.typeFilter && asset.header.type !== options.typeFilter) {
      return false;
    }
    return matchesAssetSearch(asset, options.search);
  });
}

export function textureCompressionState(
  asset: IndexedAsset,
): TextureCompressionState | null {
  if (asset.header.type !== "Texture") return null;
  const state = asset.header.payload.compressionState;
  if (typeof state !== "string") return null;
  if (TEXTURE_COMPRESSION_STATES.includes(state as TextureCompressionState)) {
    return state as TextureCompressionState;
  }
  return null;
}

export function compressionBadgeLabel(state: TextureCompressionState): string {
  switch (state) {
    case "pending":
      return "Compress pending";
    case "encoding":
      return "Encoding";
    case "fallback_uncompressed":
      return "Uncompressed fallback";
    case "encode_failed":
      return "Encode failed";
    default:
      return state;
  }
}

interface FolderTreeLike {
  path: string;
  assets: string[];
  children: FolderTreeLike[];
}

export function collectFolderGuids(
  folderPath: string,
  tree: FolderTreeLike,
): Set<string> {
  const guids = new Set<string>();

  const visit = (node: FolderTreeLike) => {
    for (const guid of node.assets) {
      guids.add(guid);
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  const find = (node: FolderTreeLike): boolean => {
    if (node.path === folderPath) {
      visit(node);
      return true;
    }
    for (const child of node.children) {
      if (find(child)) return true;
    }
    return false;
  };

  find(tree);
  return guids;
}

export function uniqueAssetTypes(assets: IndexedAsset[]): string[] {
  return [...new Set(assets.map((asset) => asset.header.type))].sort();
}

export function defaultParentClassForType(
  type: CreatableAssetType,
): string | null {
  return type === "Class" ? "BObject" : null;
}

export function buildNewAssetResult(options: {
  type: CreatableAssetType;
  name: string;
  guid: string;
  parentClass: string | null;
}): ImportResult {
  const { type, name, guid, parentClass } = options;

  if (type === "Scene") {
    const payload = createDefaultScene() as unknown as Record<string, unknown>;
    return {
      type: "Scene",
      name,
      guid,
      version: 1,
      dependencies: [],
      parentClass: null,
      payload,
      chunks: [
        {
          id: DOCUMENT_CHUNK_ID,
          kind: "document",
          mime: "application/json",
          data: new TextEncoder().encode(JSON.stringify(payload)),
        },
      ],
    };
  }

  if (type === "Graph") {
    const payload = createDefaultGraph() as unknown as Record<string, unknown>;
    return {
      type: "Graph",
      name,
      guid,
      version: 1,
      dependencies: [],
      parentClass: null,
      payload,
      chunks: [
        {
          id: DOCUMENT_CHUNK_ID,
          kind: "document",
          mime: "application/json",
          data: new TextEncoder().encode(JSON.stringify(payload)),
        },
      ],
    };
  }

  const payload: Record<string, unknown> =
    type === "Texture"
      ? { compressionState: "pending", usage: "albedo" }
      : {};

  return {
    type,
    name,
    guid,
    version: 1,
    dependencies: [],
    parentClass:
      type === "Class"
        ? (parentClass ?? defaultParentClassForType(type))
        : null,
    payload,
    chunks: [],
  };
}

export function newAssetFileName(
  type: CreatableAssetType,
  name: string,
): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_") || "NewAsset";
  const suffix =
    type === "Scene"
      ? ".scene.babasset"
      : type === "Graph"
        ? ".graph.babasset"
        : ".babasset";
  return `${safe}${suffix}`;
}

export function folderRelativePath(
  selectedFolderPath: string,
  assetsRoot: string,
): string {
  if (selectedFolderPath === assetsRoot) return "";
  return selectedFolderPath.startsWith(`${assetsRoot}/`)
    ? selectedFolderPath.slice(assetsRoot.length + 1)
    : "";
}
