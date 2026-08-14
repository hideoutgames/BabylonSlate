import type { ImportResult, IndexedAsset } from "@babylonslate/assets";
import {
  DOCUMENT_CHUNK_ID,
  createDefaultMigrationRegistry,
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
} from "@babylonslate/assets";
import {
  createDefaultScene,
} from "@babylonslate/core";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createDefaultBehaviourTree,
  createDefaultBlackboard,
} from "@babylonslate/behaviour-tree";
import { createDefaultShaderGraph } from "@babylonslate/shader-graph";
import { createDefaultUserInterface } from "@babylonslate/ui-runtime";
import {
  engineParentOf,
  resolveTypeVisual,
  walkAncestry,
  type TypeVisual,
} from "@babylonslate/editor-kit";
import { typeColorThumbAccent } from "@babylonslate/ui/lib/data-types";
import { createDefaultLogicGraphSerialized } from "../services/graph-validation";

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
  "BTTask",
  "BTDecorator",
  "BTService",
  "BTComposite",
] as const;

/** Asset types creatable from the Content Browser New Asset flow. */
export const CREATABLE_ASSET_TYPES = [
  "Scene",
  "Class",
  "UserInterface",
  "Sprite",
  "AnimationGraph",
  "Shader",
  "Tileset",
  "Tilemap",
  "BehaviourTree",
  "Blackboard",
  "Enum",
  "Structure",
  "ScriptInterface",
] as const;

export type CreatableAssetType = (typeof CREATABLE_ASSET_TYPES)[number];

export function isFolderTreeRoot(
  path: string,
  rootPath: string = ASSETS_ROOT,
): boolean {
  return path === rootPath;
}

export function displayAssetTitle(name: string): string {
  return name.replace(/\.[A-Za-z][A-Za-z0-9]*$/, "");
}

/** Additive Content Browser tile selection. Click never replaces. */
export function addSelectedAssetGuid(
  selected: ReadonlySet<string>,
  guid: string,
): Set<string> {
  const next = new Set(selected);
  next.add(guid);
  return next;
}

/** Additive Content Browser folder-tile selection. Click never replaces. */
export function addSelectedFolderPath(
  selected: ReadonlySet<string>,
  path: string,
): Set<string> {
  const next = new Set(selected);
  next.add(path);
  return next;
}

export { typeColorThumbAccent as assetTypeThumbAccent };

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
  const recursive = options.recursive ?? false;

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

export type MoveKind = "asset" | "folder";

export interface FlattenedFolderRow {
  id: string;
  label: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  path: string;
}

export function parentFolderPath(
  path: string,
  rootPath: string = ASSETS_ROOT,
): string {
  if (path === rootPath || !path.includes("/")) return rootPath;
  return path.slice(0, path.lastIndexOf("/")) || rootPath;
}

export function isValidMoveDestination(options: {
  kind: MoveKind;
  sourcePath: string;
  destinationPath: string;
  operation?: "move" | "copy";
}): boolean {
  const { kind, sourcePath, destinationPath, operation = "move" } = options;
  if (kind === "asset") {
    return operation === "copy" || destinationPath !== sourcePath;
  }
  if (destinationPath === sourcePath) return false;
  if (destinationPath.startsWith(`${sourcePath}/`)) return false;
  if (operation === "copy") return true;
  return destinationPath !== parentFolderPath(sourcePath);
}

export function isValidSelectionMoveDestination(options: {
  destinationPath: string;
  operation?: "move" | "copy";
  assetSourcePaths?: readonly string[];
  folderSourcePaths?: readonly string[];
}): boolean {
  const assetSourcePaths = options.assetSourcePaths ?? [];
  const folderSourcePaths = options.folderSourcePaths ?? [];
  if (assetSourcePaths.length + folderSourcePaths.length === 0) return false;
  for (const sourcePath of folderSourcePaths) {
    if (
      !isValidMoveDestination({
        kind: "folder",
        sourcePath,
        destinationPath: options.destinationPath,
        operation: options.operation,
      })
    ) {
      return false;
    }
  }
  for (const sourcePath of assetSourcePaths) {
    if (
      !isValidMoveDestination({
        kind: "asset",
        sourcePath,
        destinationPath: options.destinationPath,
        operation: options.operation,
      })
    ) {
      return false;
    }
  }
  return true;
}

export type ContentBrowserContextAction =
  | "duplicate"
  | "rename"
  | "move"
  | "copy"
  | "show-references"
  | "delete";

export function contentBrowserContextActions(options: {
  assetCount: number;
  folderCount: number;
}): ContentBrowserContextAction[] {
  const total = options.assetCount + options.folderCount;
  if (total === 0) return [];
  const actions: ContentBrowserContextAction[] = ["duplicate"];
  if (total === 1) actions.push("rename");
  actions.push("move", "copy");
  if (options.assetCount === 1 && options.folderCount === 0) {
    actions.push("show-references");
  }
  actions.push("delete");
  return actions;
}

export function contentBrowserMoveDialogTitle(options: {
  operation: "move" | "copy";
  itemCount: number;
  folderCount?: number;
  assetCount?: number;
}): string {
  const verb = options.operation === "copy" ? "Copy" : "Move";
  if (options.itemCount !== 1) return `${verb} ${options.itemCount} items`;
  if ((options.folderCount ?? 0) === 1) return `${verb} Folder`;
  return `${verb} Asset`;
}

export function contentBrowserMovePreviewName(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.length} items`;
}

export function guidsOutsideSelectedFolders(
  guids: readonly string[],
  folderPaths: readonly string[],
  resolvePath: (guid: string) => string | undefined,
): string[] {
  return guids.filter((guid) => {
    const path = resolvePath(guid);
    if (!path) return true;
    const folder = parentFolderPath(path);
    return !folderPaths.some(
      (selected) => folder === selected || folder.startsWith(`${selected}/`),
    );
  });
}

export function rootSelectedFolderPaths(
  folderPaths: readonly string[],
): string[] {
  return folderPaths.filter(
    (path) =>
      !folderPaths.some(
        (other) => other !== path && path.startsWith(`${other}/`),
      ),
  );
}

export function filterFolderTreeRows<T extends { path: string; label: string }>(
  rows: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  const matching = new Set<string>();
  for (const row of rows) {
    if (
      row.label.toLowerCase().includes(needle) ||
      row.path.toLowerCase().includes(needle)
    ) {
      matching.add(row.path);
    }
  }
  return rows.filter((row) => {
    if (matching.has(row.path)) return true;
    for (const path of matching) {
      if (path.startsWith(`${row.path}/`)) return true;
    }
    return false;
  });
}

export function remapPathAfterFolderMove(
  path: string,
  fromFolder: string,
  toFolder: string,
): string {
  if (path === fromFolder || path.startsWith(`${fromFolder}/`)) {
    return `${toFolder}${path.slice(fromFolder.length)}`;
  }
  return path;
}

export interface ContentBrowserTreeRow {
  id: string;
  kind: MoveKind;
  label: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  path: string;
  guid?: string;
}

export interface ContentBrowserDropMove {
  kind: MoveKind;
  sourcePath: string;
  destinationPath: string;
  id: string;
  guid?: string;
}

function folderLabel(node: FolderTreeLike): string {
  return (
    node.name ??
    (node.path.includes("/")
      ? node.path.slice(node.path.lastIndexOf("/") + 1)
      : node.path)
  );
}

function findFolderNode(
  node: FolderTreeLike,
  folderPath: string,
): FolderTreeLike | null {
  if (node.path === folderPath) return node;
  for (const child of node.children) {
    const found = findFolderNode(child, folderPath);
    if (found) return found;
  }
  return null;
}

export function listChildFolders(
  tree: FolderTreeLike,
  folderPath: string,
): Array<{ name: string; path: string }> {
  const node = findFolderNode(tree, folderPath);
  if (!node) return [];
  return node.children.map((child) => ({
    name: folderLabel(child),
    path: child.path,
  }));
}

export function flattenContentBrowserTree(
  node: FolderTreeLike,
  assets: ReadonlyArray<IndexedAsset>,
  collapsed: ReadonlySet<string> = new Set(),
  depth = 0,
  byGuid?: ReadonlyMap<string, IndexedAsset>,
): ContentBrowserTreeRow[] {
  const map =
    byGuid ?? new Map(assets.map((asset) => [asset.header.guid, asset]));
  const hasChildren = node.children.length > 0 || node.assets.length > 0;
  const expanded = !collapsed.has(node.path);
  const rows: ContentBrowserTreeRow[] = [
    {
      id: node.path,
      kind: "folder",
      label: folderLabel(node),
      depth,
      hasChildren,
      expanded,
      path: node.path,
    },
  ];
  if (!expanded) return rows;
  for (const child of node.children) {
    rows.push(
      ...flattenContentBrowserTree(child, assets, collapsed, depth + 1, map),
    );
  }
  for (const guid of node.assets) {
    const asset = map.get(guid);
    if (!asset) continue;
    rows.push({
      id: asset.path,
      kind: "asset",
      label: displayAssetTitle(asset.header.name),
      depth: depth + 1,
      hasChildren: false,
      expanded: true,
      path: asset.path,
      guid: asset.header.guid,
    });
  }
  return rows;
}

export function contentBrowserMoveFromDrop(
  dragId: string,
  targetId: string | null,
  rows: ReadonlyArray<ContentBrowserTreeRow>,
): ContentBrowserDropMove | null {
  const source = rows.find((row) => row.id === dragId);
  if (!source) return null;
  if (source.kind === "folder" && isFolderTreeRoot(source.path)) return null;
  let destinationPath = ASSETS_ROOT;
  if (targetId !== null) {
    const target = rows.find((row) => row.id === targetId);
    if (!target) return null;
    destinationPath =
      target.kind === "folder" ? target.path : parentFolderPath(target.path);
  }
  const sourcePath =
    source.kind === "asset" ? parentFolderPath(source.path) : source.path;
  if (
    !isValidMoveDestination({
      kind: source.kind,
      sourcePath,
      destinationPath,
    })
  ) {
    return null;
  }
  return {
    kind: source.kind,
    sourcePath,
    destinationPath,
    id: source.id,
    ...(source.guid ? { guid: source.guid } : {}),
  };
}

export function flattenFolderTree(
  node: FolderTreeLike,
  collapsed: ReadonlySet<string> = new Set(),
  depth = 0,
): FlattenedFolderRow[] {
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
  assets: ReadonlyArray<{
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
      version: createDefaultMigrationRegistry().currentVersion("Scene"),
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
      ...createDefaultUserInterface(name),
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

  if (type === "Tileset") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultTilesetPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "Tilemap") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultTilemapPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "BehaviourTree") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultBehaviourTree(name) as unknown as Record<string, unknown>,
    );
  }

  if (type === "Blackboard") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultBlackboard(name) as unknown as Record<string, unknown>,
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
  const safe = name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_");
  if (!safe) return "";
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
                : type === "Tileset"
                  ? ".tileset.babasset"
                : type === "Tilemap"
                  ? ".tilemap.babasset"
                  : type === "BehaviourTree"
                    ? ".bt.babasset"
                    : type === "Blackboard"
                      ? ".blackboard.babasset"
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
    version: createDefaultMigrationRegistry().currentVersion(type) || 1,
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
  const fileName = newAssetFileName(type, name);
  if (!fileName) return false;
  const path = joinAssetFolderPath(folderPath, fileName);
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
