import type { ImportResult, IndexedAsset } from "@babylonslate/assets";
import {
  DOCUMENT_CHUNK_ID,
  createDefaultSpritePayload,
} from "@babylonslate/assets";
import {
  createDefaultScene,
  SCENE_SCHEMA_VERSION,
} from "@babylonslate/core";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import { createDefaultShaderGraph } from "@babylonslate/shader-graph";
import { createDefaultPlayHud } from "@babylonslate/ui-runtime";
import {
  engineParentOf,
  resolveTypeVisual,
  walkAncestry,
  type TypeVisual,
} from "@babylonslate/editor-kit";
import { createDefaultLogicGraphSerialized } from "../services/graph-validation";

export const ASSET_DRAG_MIME = "application/x-babylonslate-asset";
export const FOLDER_DRAG_MIME = "application/x-babylonslate-folder";
export const ASSETS_ROOT = "assets";

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
  "FunctionLibrary",
  "BDebugCommand",
] as const;

/** Asset types creatable from the Content Browser New Asset flow. */
export const CREATABLE_ASSET_TYPES = [
  "Scene",
  "Class",
  "UserInterface",
  "Sprite",
  "AnimationGraph",
  "Shader",
  "Enum",
  "Structure",
  "ScriptInterface",
] as const;

export type CreatableAssetType = (typeof CREATABLE_ASSET_TYPES)[number];

export function assetDragPayload(asset: IndexedAsset): string {
  return JSON.stringify({
    guid: asset.header.guid,
    type: asset.header.type,
    path: asset.path,
  });
}

export function guidFromAssetDragData(raw: string): string | null {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as { guid?: string };
    if (payload.guid) return payload.guid;
  } catch {
    return raw;
  }
  return raw;
}

export function isFolderTreeRoot(
  path: string,
  rootPath: string = ASSETS_ROOT,
): boolean {
  return path === rootPath;
}

export function folderDropTargetFromElement(
  target: EventTarget | null,
): string | null {
  if (!(target instanceof Element)) return null;
  return (
    target.closest("[data-folder-path]")?.getAttribute("data-folder-path") ??
    target.closest("[data-asset-folder]")?.getAttribute("data-asset-folder")
  );
}

export function folderDropTargetFromPoint(
  clientX: number,
  clientY: number,
): string | null {
  return folderDropTargetFromElement(document.elementFromPoint(clientX, clientY));
}

export function displayAssetTitle(name: string): string {
  return name.replace(/\.[A-Za-z][A-Za-z0-9]*$/, "");
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
    typeFilters: string[] | null;
    search: string;
  },
): IndexedAsset[] {
  const types = options.typeFilters ?? [];
  return assets.filter((asset) => {
    if (options.folderGuids && !options.folderGuids.has(asset.header.guid)) {
      return false;
    }
    if (types.length > 0 && !types.includes(asset.header.type)) {
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
  name?: string;
  path: string;
  assets: string[];
  children: FolderTreeLike[];
}

export function collectFolderGuids(
  folderPath: string,
  tree: FolderTreeLike,
  options: { recursive?: boolean } = {},
): Set<string> {
  const guids = new Set<string>();
  const recursive = options.recursive ?? folderPath === "assets";

  const visit = (node: FolderTreeLike, includeChildren: boolean) => {
    for (const guid of node.assets) {
      guids.add(guid);
    }
    if (!includeChildren) return;
    for (const child of node.children) {
      visit(child, true);
    }
  };

  const find = (node: FolderTreeLike): boolean => {
    if (node.path === folderPath) {
      visit(node, recursive);
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

export function flattenFolderTree(
  node: FolderTreeLike,
  collapsed: ReadonlySet<string> = new Set(),
  depth = 0,
): Array<{
  id: string;
  label: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  path: string;
}> {
  const hasChildren = node.children.length > 0;
  const expanded = !collapsed.has(node.path);
  const label =
    node.name ??
    (node.path.includes("/") ? node.path.slice(node.path.lastIndexOf("/") + 1) : node.path);
  const rows = [
    {
      id: node.path,
      label,
      depth,
      hasChildren,
      expanded,
      path: node.path,
    },
  ];
  if (expanded) {
    for (const child of node.children) {
      rows.push(...flattenFolderTree(child, collapsed, depth + 1));
    }
  }
  return rows;
}

export function uniqueAssetTypes(assets: IndexedAsset[]): string[] {
  return [...new Set(assets.map((asset) => asset.header.type))].sort();
}

export function classParentLookup(
  assets: Array<{
    header: { type: string; name: string; parentClass?: string | null };
  }>,
): (id: string) => string | null {
  const map = new Map<string, string | null>();
  for (const asset of assets) {
    if (asset.header.type === "Class") {
      map.set(asset.header.name, asset.header.parentClass ?? "BObject");
    }
  }
  return (id) => map.get(id) ?? engineParentOf(id) ?? null;
}

export function visualForIndexedAsset(
  asset: IndexedAsset,
  parentOf: (id: string) => string | null,
): TypeVisual {
  if (asset.header.type === "Class") {
    const start = asset.header.parentClass ?? "BObject";
    return resolveTypeVisual({
      assetType: "Class",
      parentClass: asset.header.parentClass,
      ancestry: walkAncestry(start, parentOf),
    });
  }
  return resolveTypeVisual({ assetType: asset.header.type });
}

export function classDocumentShowsPrefab(
  parentClass: string | null | undefined,
  parentOf: (id: string) => string | null,
  options?: { assetType?: string },
): boolean {
  const start =
    parentClass ??
    (options?.assetType === "Graph" ? "Actor" : "BObject");
  return walkAncestry(start, parentOf).includes("Actor");
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
      version: SCENE_SCHEMA_VERSION,
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

  if (type === "Class") {
    const payload = createDefaultLogicGraphSerialized() as unknown as Record<
      string,
      unknown
    >;
    return {
      type: "Class",
      name,
      guid,
      version: 1,
      dependencies: [],
      parentClass: parentClass ?? defaultParentClassForType(type),
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

  if (type === "UserInterface") {
    const payload = {
      ...createDefaultPlayHud(name),
      logic: createDefaultLogicGraphSerialized(),
    } as unknown as Record<string, unknown>;
    return documentAsset(type, name, guid, payload);
  }

  if (type === "Sprite") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSpritePayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "AnimationGraph") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultAnimGraph(name) as unknown as Record<string, unknown>,
    );
  }

  if (type === "Shader") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultShaderGraph(name) as unknown as Record<string, unknown>,
    );
  }

  if (type === "Enum" || type === "Structure" || type === "ScriptInterface") {
    const payload: Record<string, unknown> =
      type === "Enum"
        ? { kind: "enum", guid, name, members: [{ name: "None", value: 0 }] }
        : type === "Structure"
          ? { kind: "structure", guid, name, fields: [] }
          : { kind: "scriptInterface", guid, name, methods: [] };
    return {
      type,
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

  const exhaustive: never = type;
  throw new Error(`Unsupported creatable asset type: ${String(exhaustive)}`);
}

export function newAssetFileName(
  type: CreatableAssetType,
  name: string,
): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_") || "NewAsset";
  const suffix =
    type === "Scene"
      ? ".scene.babasset"
      : type === "Class"
        ? ".class.babasset"
        : type === "UserInterface"
          ? ".ui.babasset"
          : type === "Sprite"
            ? ".sprite.babasset"
            : type === "AnimationGraph"
              ? ".anim.babasset"
              : type === "Shader"
                ? ".shader.babasset"
                : ".babasset";
  return `${safe}${suffix}`;
}

function documentAsset(
  type: string,
  name: string,
  guid: string,
  payload: Record<string, unknown>,
): ImportResult {
  return {
    type,
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

export function folderRelativePath(
  selectedFolderPath: string,
  assetsRoot: string,
): string {
  if (selectedFolderPath === assetsRoot) return "";
  return selectedFolderPath.startsWith(`${assetsRoot}/`)
    ? selectedFolderPath.slice(assetsRoot.length + 1)
    : "";
}

export function joinAssetFolderPath(folderPath: string, fileName: string): string {
  const folder = folderPath.replace(/\/+$/, "");
  return folder ? `${folder}/${fileName}` : fileName;
}

export function isNewAssetNameTaken(
  existingPaths: Iterable<string>,
  folderPath: string,
  type: CreatableAssetType,
  name: string,
): boolean {
  const path = joinAssetFolderPath(folderPath, newAssetFileName(type, name));
  for (const existing of existingPaths) {
    if (existing === path) return true;
  }
  return false;
}

export function isFolderNameTaken(
  folderPaths: Iterable<string>,
  parentPath: string,
  name: string,
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const path = joinAssetFolderPath(parentPath, trimmed);
  for (const existing of folderPaths) {
    if (existing === path) return true;
  }
  return false;
}

export function isRenameNameTaken(
  existingPaths: Iterable<string>,
  currentPath: string,
  newName: string,
): boolean {
  const safe = newName.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_");
  if (!safe) return false;
  const dir = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/"))
    : "";
  const newPath = dir ? `${dir}/${safe}.babasset` : `${safe}.babasset`;
  if (newPath === currentPath) return false;
  for (const existing of existingPaths) {
    if (existing === newPath) return true;
  }
  return false;
}
