import type { ImportResult, IndexedAsset } from "@babylonslate/assets";
import {
  DOCUMENT_CHUNK_ID,
  audioAssetDependencies,
  particleAssetDependencies,
  createDefaultMigrationRegistry,
  createDefaultSpritePayload,
  createDefaultSpriteAnimationPayload,
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
  createDefaultAudioMixerPayload,
  createDefaultAudioChannelPayload,
  createDefaultSoundAttenuationPayload,
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  modelAssetGuids,
  createDefaultSkyboxCreatorPayload,
  skyboxCreatorAssetDependencies,
  parseSpriteAnimationPayload,
  skeletonAssetGuids,
  animationAssetGuids,
  normalizeAnimationPayload,
  spriteAnimationTextureGuids,
} from "@babylonslate/assets";
import {
  createDefaultScene,
  isLegacyMaterialAssetType,
} from "@babylonslate/core";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createDefaultBehaviourTree,
  createDefaultBlackboard,
} from "@babylonslate/behaviour-tree";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  materialDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  parseMaterialDomain,
} from "@babylonslate/shader-graph";
import {
  engineParentOf,
  rangeSelectTreeIds,
  resolveTypeVisual,
  walkAncestry,
  type TypeVisual,
  type TreeDropPlacement,
} from "@babylonslate/editor-kit";
import { typeColorThumbAccent } from "@babylonslate/ui/lib/data-types";
import { createDefaultLogicGraphSerialized, defaultNodeRegistry } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";

export const ASSETS_ROOT = "assets";

export type ContentBrowserPaintHit =
  | { kind: "asset"; guid: string }
  | { kind: "folder"; path: string };

export type ContentBrowserSelection = {
  guids: Set<string>;
  folderPaths: Set<string>;
};

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
  "EditorUtilityObject",
  "EditorFunctionLibrary",
  "BTTask",
  "BTDecorator",
  "BTService",
  "BTComposite",
] as const;

export type ParentClassTreeRow = {
  id: string;
  parentClassId: string | null;
  depth: number;
  group: "Engine" | "Project";
  /** False when selecting this parent would exceed MAX_CLASS_INHERITANCE_DEPTH. */
  selectable: boolean;
};

/**
 * Flattened inheritance tree for the New Asset Parent Class picker.
 * Engine bases first (forest), then project/plugin Classes nested under their parents.
 */
export function buildParentClassTreeRows(
  assets: ReadonlyArray<{
    path?: string;
    header: { type: string; name: string; parentClass?: string | null };
  }>,
  options?: { search?: string; maxDepth?: number },
): ParentClassTreeRow[] {
  const maxDepth = options?.maxDepth ?? 16;
  const parentOf = classParentLookup(assets);
  const projectIds: string[] = [];
  const seenProject = new Set<string>();
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const id = classIdFromClassAsset(asset);
    if (seenProject.has(id)) continue;
    seenProject.add(id);
    projectIds.push(id);
  }
  projectIds.sort((a, b) => a.localeCompare(b));

  const children = new Map<string | null, string[]>();
  const addChild = (parent: string | null, id: string) => {
    const list = children.get(parent) ?? [];
    if (!list.includes(id)) list.push(id);
    children.set(parent, list);
  };
  for (const id of ENGINE_BASE_CLASSES) {
    const parent = engineParentOf(id) ?? null;
    // Only nest engine bases under other engine bases that appear in the picker.
    if (parent && (ENGINE_BASE_CLASSES as readonly string[]).includes(parent)) {
      addChild(parent, id);
    } else {
      addChild(null, id);
    }
  }
  for (const id of projectIds) {
    const parent = parentOf(id);
    addChild(parent, id);
  }
  for (const [, list] of children) {
    list.sort((a, b) => a.localeCompare(b));
  }

  const rows: ParentClassTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const ancestryLen = walkAncestry(id, parentOf).length;
    const group: "Engine" | "Project" = (
      ENGINE_BASE_CLASSES as readonly string[]
    ).includes(id)
      ? "Engine"
      : "Project";
    rows.push({
      id,
      parentClassId: parentOf(id),
      depth,
      group,
      selectable: ancestryLen < maxDepth,
    });
    for (const child of children.get(id) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const root of children.get(null) ?? []) {
    walk(root, 0);
  }
  // Orphans (parent not in tree) still appear.
  for (const id of [...ENGINE_BASE_CLASSES, ...projectIds]) {
    if (!visited.has(id)) walk(id, 0);
  }

  const query = options?.search?.trim().toLowerCase() ?? "";
  if (!query) return rows;
  const matched = new Set(
    rows.filter((row) => row.id.toLowerCase().includes(query)).map((row) => row.id),
  );
  // Keep ancestors of matches so the tree context stays readable.
  for (const id of [...matched]) {
    for (const ancestor of walkAncestry(id, parentOf)) {
      matched.add(ancestor);
    }
  }
  return rows.filter((row) => matched.has(row.id));
}

/** Asset types creatable from the Content Browser New Asset flow. */
export const CREATABLE_ASSET_TYPES = [
  "Scene",
  "Class",
  "Sprite",
  "SpriteAnimation",
  "AnimationGraph",
  "Material",
  "MaterialFunction",
  "Tileset",
  "Tilemap",
  "BehaviourTree",
  "Blackboard",
  "Enum",
  "Structure",
  "ScriptInterface",
  "AudioMixer",
  "AudioChannel",
  "SoundAttenuation",
  "ParticleEmitter",
  "ParticleSystem",
  "SkyboxCreator",
] as const;

export type CreatableAssetType = (typeof CREATABLE_ASSET_TYPES)[number];

export type CreatableAssetTypeGroup = {
  id: string;
  label: string;
  types: readonly CreatableAssetType[];
  hint?: string;
};

/** Catalog groups for the New Asset type-card grid. */
export const CREATABLE_ASSET_TYPE_GROUPS: readonly CreatableAssetTypeGroup[] = [
  { id: "world", label: "World", types: ["Scene"] },
  {
    id: "scripting",
    label: "Scripting",
    types: ["Class", "Enum", "Structure", "ScriptInterface"],
  },
  {
    id: "2d",
    label: "2D",
    types: ["Sprite", "Tileset", "Tilemap"],
  },
  {
    id: "animation",
    label: "Animation",
    types: ["AnimationGraph", "SpriteAnimation"],
    hint: "Animation Graph is the state machine; Sprite Animation is a 2D clip (also under 2D).",
  },
  {
    id: "rendering",
    label: "Rendering",
    types: ["Material", "MaterialFunction", "ParticleEmitter", "ParticleSystem", "SkyboxCreator"],
  },
  {
    id: "audio",
    label: "Audio",
    types: ["AudioMixer", "AudioChannel", "SoundAttenuation"],
    hint: "Sounds are Import (WAV / MP3 / OGG), not created here.",
  },
  {
    id: "ai",
    label: "AI",
    types: ["BehaviourTree", "Blackboard"],
  },
];

const CREATABLE_ASSET_TYPE_DESCRIPTIONS: Record<CreatableAssetType, string> = {
  Scene: "A 3D or 2D world document.",
  Class: "A class with a parent and a logic graph.",
  Sprite: "A 2D sprite sheet with named frames and pivots.",
  SpriteAnimation: "A pickable 2D clip of Texture frames for Animation Graph.",
  AnimationGraph: "A state machine that plays Sprite or Animation clips.",
  Material: "A shader graph that compiles to a Babylon material.",
  MaterialFunction: "A reusable shader subgraph for materials.",
  Tileset: "Tile definitions and collision for painting tilemaps.",
  Tilemap: "A painted 2D tile layer that references a Tileset.",
  BehaviourTree: "An AI tree of composites, tasks, and decorators.",
  Blackboard: "Shared keys that a behaviour tree reads and writes.",
  Enum: "Named integer members used by pins and variables.",
  Structure: "A user-defined struct of typed fields.",
  ScriptInterface: "A contract of methods that classes can implement.",
  AudioMixer: "Global and per-channel default volumes for Play.",
  AudioChannel: "A routing bus with an optional parent and reverb send.",
  SoundAttenuation: "Distance falloff that opts Audio into 3D playback.",
  ParticleEmitter: "One Babylon particle recipe: texture, shape, lifetime, and color.",
  ParticleSystem: "Starts several Particle Emitters on one actor.",
  SkyboxCreator:
    "Editor-only helper tool that slices a texture into six skybox faces.",
};

/** Title Case label for a creatable asset type (`User Interface`). */
export function creatableAssetTypeLabel(type: CreatableAssetType): string {
  return type
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function creatableAssetTypeDescription(
  type: CreatableAssetType,
): string {
  return CREATABLE_ASSET_TYPE_DESCRIPTIONS[type];
}

export function filterCreatableAssetTypes(
  query: string,
  types: readonly CreatableAssetType[] = CREATABLE_ASSET_TYPES,
): CreatableAssetType[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...types];
  return types.filter((type) => {
    const haystack = `${type} ${creatableAssetTypeLabel(type)}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** True when a double-click landed on empty Content Browser grid space, not a tile. */
export function isContentBrowserEmptyGridDoubleClickTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-asset-path], [data-folder-path]")) return false;
  return Boolean(
    target.closest('[data-testid="content-browser-asset-grid"]'),
  );
}

export function isFolderTreeRoot(
  path: string,
  rootPath: string | readonly string[] = ASSETS_ROOT,
): boolean {
  if (typeof rootPath === "string") return path === rootPath;
  return rootPath.includes(path);
}

export function displayAssetTitle(name: string): string {
  return name.replace(/\.[A-Za-z][A-Za-z0-9]*$/, "");
}

export type ClassAssetRef = {
  path?: string;
  header: {
    type: string;
    name: string;
    parentClass?: string | null;
    guid?: string;
  };
};

/** Compile class id for a Class asset (`main.class` header → `main`). */
export function classIdFromClassAsset(asset: ClassAssetRef): string {
  if (asset.path) return classIdForGraphPath(asset.path);
  return displayAssetTitle(asset.header.name) || asset.header.name;
}

/** Additive Content Browser tile selection. Long-press / context menu never replaces. */
export function addSelectedAssetGuid(
  selected: ReadonlySet<string>,
  guid: string,
): Set<string> {
  const next = new Set(selected);
  next.add(guid);
  return next;
}

/** Additive Content Browser folder-tile selection. Long-press / context menu never replaces. */
export function addSelectedFolderPath(
  selected: ReadonlySet<string>,
  path: string,
): Set<string> {
  const next = new Set(selected);
  next.add(path);
  return next;
}

/** Single tap / click replaces the whole Content Browser selection with one asset. */
export function exclusiveSelectAsset(guid: string): ContentBrowserSelection {
  return { guids: new Set([guid]), folderPaths: new Set() };
}

/** Single tap / click replaces the whole Content Browser selection with one folder. */
export function exclusiveSelectFolder(path: string): ContentBrowserSelection {
  return { guids: new Set(), folderPaths: new Set([path]) };
}

function tileHitKey(hit: ContentBrowserPaintHit): string {
  return hit.kind === "asset" ? `a:${hit.guid}` : `f:${hit.path}`;
}

function hitFromKey(
  key: string,
  ordered: readonly ContentBrowserPaintHit[],
): ContentBrowserPaintHit | null {
  return (
    ordered.find((hit) => tileHitKey(hit) === key) ??
    (key.startsWith("a:")
      ? { kind: "asset", guid: key.slice(2) }
      : key.startsWith("f:")
        ? { kind: "folder", path: key.slice(2) }
        : null)
  );
}

/**
 * Grid card select: exclusive replace, Ctrl/Meta toggle, or Shift range across
 * the visible ordered tiles (same order as the asset grid).
 */
export function applyContentBrowserTileSelect(
  hit: ContentBrowserPaintHit,
  options: { additive?: boolean; range?: boolean } | undefined,
  orderedHits: readonly ContentBrowserPaintHit[],
  current: {
    selectedGuids: ReadonlySet<string>;
    selectedFolderPaths: ReadonlySet<string>;
    anchorKey?: string | null;
  },
): ContentBrowserSelection & { anchorKey: string } {
  const key = tileHitKey(hit);
  if (options?.range) {
    const keys = orderedHits.map(tileHitKey);
    const range = rangeSelectTreeIds(keys, current.anchorKey ?? null, key);
    const selectedGuids = new Set<string>();
    const selectedFolderPaths = new Set<string>();
    for (const id of range) {
      const entry = hitFromKey(id, orderedHits);
      if (!entry) continue;
      if (entry.kind === "asset") selectedGuids.add(entry.guid);
      else selectedFolderPaths.add(entry.path);
    }
    return {
      guids: selectedGuids,
      folderPaths: selectedFolderPaths,
      anchorKey: current.anchorKey ?? key,
    };
  }
  if (options?.additive) {
    const selectedGuids = new Set(current.selectedGuids);
    const selectedFolderPaths = new Set(current.selectedFolderPaths);
    if (hit.kind === "asset") {
      if (selectedGuids.has(hit.guid)) selectedGuids.delete(hit.guid);
      else selectedGuids.add(hit.guid);
    } else if (selectedFolderPaths.has(hit.path)) {
      selectedFolderPaths.delete(hit.path);
    } else {
      selectedFolderPaths.add(hit.path);
    }
    return { guids: selectedGuids, folderPaths: selectedFolderPaths, anchorKey: key };
  }
  if (hit.kind === "asset") {
    return {
      ...exclusiveSelectAsset(hit.guid),
      anchorKey: key,
    };
  }
  return {
    ...exclusiveSelectFolder(hit.path),
    anchorKey: key,
  };
}

/** Exclusive folder tap sets the grid folder; additive/range keep it. */
export function applyContentBrowserTreeSelect(
  rowId: string,
  options: { additive?: boolean; range?: boolean } | undefined,
  rows: readonly ContentBrowserTreeRow[],
  current: {
    selectedGuids: ReadonlySet<string>;
    selectedFolderPaths: ReadonlySet<string>;
    selectedFolderPath: string;
    anchorId?: string | null;
  },
): {
  selectedGuids: Set<string>;
  selectedFolderPaths: Set<string>;
  selectedFolderPath: string;
} {
  const row = rows.find((entry) => entry.id === rowId);
  if (!row) {
    return {
      selectedGuids: new Set(current.selectedGuids),
      selectedFolderPaths: new Set(current.selectedFolderPaths),
      selectedFolderPath: current.selectedFolderPath,
    };
  }
  if (options?.range) {
    const range = rangeSelectTreeIds(
      rows.map((entry) => entry.id),
      current.anchorId ?? null,
      rowId,
    );
    const selectedGuids = new Set<string>();
    const selectedFolderPaths = new Set<string>();
    for (const id of range) {
      const entry = rows.find((item) => item.id === id);
      if (!entry) continue;
      if (entry.kind === "folder") selectedFolderPaths.add(entry.path);
      else if (entry.guid) selectedGuids.add(entry.guid);
    }
    return {
      selectedGuids,
      selectedFolderPaths,
      selectedFolderPath: current.selectedFolderPath,
    };
  }
  if (options?.additive) {
    const selectedGuids = new Set(current.selectedGuids);
    const selectedFolderPaths = new Set(current.selectedFolderPaths);
    if (row.kind === "folder") {
      if (selectedFolderPaths.has(row.path)) selectedFolderPaths.delete(row.path);
      else selectedFolderPaths.add(row.path);
    } else if (row.guid) {
      if (selectedGuids.has(row.guid)) selectedGuids.delete(row.guid);
      else selectedGuids.add(row.guid);
    }
    return {
      selectedGuids,
      selectedFolderPaths,
      selectedFolderPath: current.selectedFolderPath,
    };
  }
  if (row.kind === "folder") {
    return {
      selectedGuids: new Set(),
      selectedFolderPaths: new Set(),
      selectedFolderPath: row.path,
    };
  }
  return {
    selectedGuids: row.guid ? new Set([row.guid]) : new Set(),
    selectedFolderPaths: new Set(),
    selectedFolderPath: parentFolderPath(row.path),
  };
}

/** Paint-select: union of cards dragged over; does not keep a prior selection. */
export function paintSelectTiles(
  hits: readonly ContentBrowserPaintHit[],
): ContentBrowserSelection {
  const guids = new Set<string>();
  const folderPaths = new Set<string>();
  for (const hit of hits) {
    if (hit.kind === "asset") guids.add(hit.guid);
    else folderPaths.add(hit.path);
  }
  return { guids, folderPaths };
}

export function resolveContentBrowserPaintHit(
  element: Element | null,
): ContentBrowserPaintHit | null {
  if (!element) return null;
  const tile = element.closest("[data-asset-guid], [data-folder-path]");
  if (!(tile instanceof Element)) return null;
  const guid = tile.getAttribute("data-asset-guid");
  if (guid) return { kind: "asset", guid };
  const path = tile.getAttribute("data-folder-path");
  if (path) return { kind: "folder", path };
  return null;
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

export type ContentBrowserSortMode =
  | "name-asc"
  | "name-desc"
  | "type-asc"
  | "type-desc"
  | "date-desc"
  | "date-asc";

export const CONTENT_BROWSER_SORT_OPTIONS: ReadonlyArray<{
  mode: ContentBrowserSortMode;
  label: string;
}> = [
  { mode: "name-asc", label: "Name A–Z" },
  { mode: "name-desc", label: "Name Z–A" },
  { mode: "type-asc", label: "Type A–Z" },
  { mode: "type-desc", label: "Type Z–A" },
  { mode: "date-desc", label: "Date Modified (Newest)" },
  { mode: "date-asc", label: "Date Modified (Oldest)" },
];

const NAME_COMPARE: Intl.CollatorOptions = { sensitivity: "base" };

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, NAME_COMPARE);
}

function assetDisplayName(asset: IndexedAsset): string {
  return displayAssetTitle(asset.header.name) || asset.header.name;
}

function compareAssetNames(a: IndexedAsset, b: IndexedAsset): number {
  const byDisplay = compareNames(assetDisplayName(a), assetDisplayName(b));
  if (byDisplay !== 0) return byDisplay;
  return compareNames(a.header.name, b.header.name);
}

function assetMtime(asset: IndexedAsset): number {
  return asset.mtime ?? 0;
}

export function sortAssets(
  assets: readonly IndexedAsset[],
  mode: ContentBrowserSortMode,
): IndexedAsset[] {
  return [...assets].sort((left, right) => {
    let primary = 0;
    switch (mode) {
      case "name-asc":
      case "name-desc":
        primary = compareAssetNames(left, right);
        if (mode === "name-desc") primary = -primary;
        break;
      case "type-asc":
      case "type-desc":
        primary = compareNames(left.header.type, right.header.type);
        if (mode === "type-desc") primary = -primary;
        break;
      case "date-asc":
      case "date-desc":
        primary = assetMtime(left) - assetMtime(right);
        if (mode === "date-desc") primary = -primary;
        break;
    }
    if (primary !== 0) return primary;
    if (mode !== "name-asc" && mode !== "name-desc") {
      const byName = compareAssetNames(left, right);
      if (byName !== 0) return byName;
    }
    return left.header.guid.localeCompare(right.header.guid);
  });
}

export function sortChildFolders<T extends { name: string }>(
  folders: readonly T[],
  mode: ContentBrowserSortMode,
): T[] {
  const descending = mode === "name-desc";
  return [...folders].sort((left, right) => {
    const byName = compareNames(left.name, right.name);
    if (byName !== 0) return descending ? -byName : byName;
    return 0;
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
  | "open"
  | "duplicate"
  | "rename"
  | "retarget"
  | "move"
  | "copy"
  | "show-references"
  | "delete";

export function canRetargetSelectedAssets(
  assets: ReadonlyArray<{ type: string; payload?: unknown }>,
): boolean {
  if (assets.length === 0) return false;
  return assets.every((asset) => {
    if (asset.type !== "Animation") return false;
    return Boolean(normalizeAnimationPayload(asset.payload).skeletonGuid);
  });
}

export function contentBrowserContextActions(options: {
  assetCount: number;
  folderCount: number;
  canRetarget?: boolean;
}): ContentBrowserContextAction[] {
  const total = options.assetCount + options.folderCount;
  if (total === 0) return [];
  const actions: ContentBrowserContextAction[] = [];
  if (options.assetCount === 1 && options.folderCount === 0) {
    actions.push("open");
  }
  actions.push("duplicate");
  if (total === 1) actions.push("rename");
  if (options.canRetarget && options.assetCount > 0 && options.folderCount === 0) {
    actions.push("retarget");
  }
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

export function listChildFoldersFromTrees(
  trees: readonly FolderTreeLike[],
  folderPath: string,
): Array<{ name: string; path: string }> {
  for (const tree of trees) {
    if (findFolderNode(tree, folderPath)) {
      return listChildFolders(tree, folderPath);
    }
  }
  return [];
}

export function collectFolderGuidsFromTrees(
  folderPath: string,
  trees: readonly FolderTreeLike[],
  options: { recursive?: boolean } = {},
): Set<string> {
  for (const tree of trees) {
    if (findFolderNode(tree, folderPath)) {
      return collectFolderGuids(folderPath, tree, options);
    }
  }
  return new Set();
}

export function flattenFolderForest(
  trees: readonly FolderTreeLike[],
  collapsed: ReadonlySet<string> = new Set(),
): FlattenedFolderRow[] {
  return trees.flatMap((tree) => flattenFolderTree(tree, collapsed));
}

export function flattenContentBrowserForest(
  trees: readonly FolderTreeLike[],
  assets: ReadonlyArray<IndexedAsset>,
  collapsed: ReadonlySet<string> = new Set(),
): ContentBrowserTreeRow[] {
  return trees.flatMap((tree) =>
    flattenContentBrowserTree(tree, assets, collapsed),
  );
}

/** Nested folder paths (depth > 0). Forest roots stay expanded. */
export function nestedFolderPaths(
  trees: readonly FolderTreeLike[],
): string[] {
  const paths: string[] = [];
  const walk = (node: FolderTreeLike, depth: number) => {
    if (depth > 0) paths.push(node.path);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const tree of trees) walk(tree, 0);
  return paths;
}

/**
 * Collapse nested folders by default so a packed character folder cannot
 * virtualize root assets (and sibling plugin roots) off the tree viewport.
 * Paths in `userToggled` keep the user's expand/collapse choice.
 */
export function withAutoCollapsedNestedFolders(
  current: ReadonlySet<string>,
  trees: readonly FolderTreeLike[],
  userToggled: ReadonlySet<string>,
): Set<string> {
  const next = new Set(current);
  for (const path of nestedFolderPaths(trees)) {
    if (userToggled.has(path)) continue;
    next.add(path);
  }
  return next;
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

function contentRootOfPath(
  path: string,
  rootPaths: readonly string[],
): string {
  return (
    rootPaths.find(
      (root) => path === root || path.startsWith(`${root}/`),
    ) ?? ASSETS_ROOT
  );
}

function isFolderMoveCycle(
  sourcePath: string,
  destinationPath: string,
): boolean {
  return (
    destinationPath === sourcePath ||
    destinationPath.startsWith(`${sourcePath}/`)
  );
}

function contentBrowserDropDestination(
  dragId: string,
  targetId: string | null,
  rows: ReadonlyArray<ContentBrowserTreeRow>,
  rootPaths: readonly string[],
  placement: TreeDropPlacement = "into",
): { destinationPath: string; destRoot: string; sourceRoot: string } | null {
  const source = rows.find((row) => row.id === dragId);
  if (!source) return null;
  if (source.kind === "folder" && isFolderTreeRoot(source.path, rootPaths)) {
    return null;
  }
  const sourceRoot = contentRootOfPath(source.path, rootPaths);
  let destinationPath = sourceRoot;
  if (targetId !== null) {
    const target = rows.find((row) => row.id === targetId);
    if (!target) return null;
    const around = placement === "before" || placement === "after";
    destinationPath =
      target.kind === "folder"
        ? around
          ? parentFolderPath(target.path, sourceRoot)
          : target.path
        : parentFolderPath(target.path, sourceRoot);
  }
  const destRoot = contentRootOfPath(destinationPath, rootPaths);
  if (destRoot !== sourceRoot) return null;
  return { destinationPath, destRoot, sourceRoot };
}

function contentBrowserDropMoveForRow(
  row: ContentBrowserTreeRow,
  destinationPath: string,
  sourceRoot: string,
): ContentBrowserDropMove {
  const sourcePath =
    row.kind === "asset"
      ? parentFolderPath(row.path, sourceRoot)
      : row.path;
  return {
    kind: row.kind,
    sourcePath,
    destinationPath,
    id: row.id,
    ...(row.guid ? { guid: row.guid } : {}),
  };
}

function treeRowInSelection(
  row: ContentBrowserTreeRow,
  selectedGuids: ReadonlySet<string>,
  selectedFolderPaths: ReadonlySet<string>,
): boolean {
  if (row.kind === "folder") return selectedFolderPaths.has(row.path);
  return Boolean(row.guid && selectedGuids.has(row.guid));
}

export function contentBrowserMoveFromDrop(
  dragId: string,
  targetId: string | null,
  rows: ReadonlyArray<ContentBrowserTreeRow>,
  rootPaths: readonly string[] = [ASSETS_ROOT],
  placement: TreeDropPlacement = "into",
): ContentBrowserDropMove | null {
  const source = rows.find((row) => row.id === dragId);
  const dest = contentBrowserDropDestination(
    dragId,
    targetId,
    rows,
    rootPaths,
    placement,
  );
  if (!source || !dest) return null;
  const move = contentBrowserDropMoveForRow(
    source,
    dest.destinationPath,
    dest.sourceRoot,
  );
  if (
    !isValidMoveDestination({
      kind: move.kind,
      sourcePath: move.sourcePath,
      destinationPath: move.destinationPath,
    })
  ) {
    return null;
  }
  return move;
}

export function contentBrowserTreeDropMoves(options: {
  dragId: string;
  targetId: string | null;
  rows: ReadonlyArray<ContentBrowserTreeRow>;
  selectedGuids: ReadonlySet<string>;
  selectedFolderPaths: ReadonlySet<string>;
  rootPaths?: readonly string[];
  resolvePath?: (guid: string) => string | undefined;
  placement?: TreeDropPlacement;
}): ContentBrowserDropMove[] {
  const {
    dragId,
    targetId,
    rows,
    selectedGuids,
    selectedFolderPaths,
    rootPaths = [ASSETS_ROOT],
    placement = "into",
  } = options;
  const source = rows.find((row) => row.id === dragId);
  const dest = contentBrowserDropDestination(
    dragId,
    targetId,
    rows,
    rootPaths,
    placement,
  );
  if (!source || !dest) return [];
  if (!treeRowInSelection(source, selectedGuids, selectedFolderPaths)) {
    const move = contentBrowserMoveFromDrop(
      dragId,
      targetId,
      rows,
      rootPaths,
      placement,
    );
    return move ? [move] : [];
  }
  const pathOf = (guid: string) =>
    options.resolvePath?.(guid) ??
    rows.find((row) => row.guid === guid)?.path;
  let folders = rootSelectedFolderPaths(
    [...selectedFolderPaths].filter(
      (path) => !isFolderTreeRoot(path, rootPaths),
    ),
  ).filter((path) => path !== dest.destinationPath);
  if (
    folders.some((path) => isFolderMoveCycle(path, dest.destinationPath))
  ) {
    return [];
  }
  const guids = guidsOutsideSelectedFolders(
    [...selectedGuids],
    folders,
    pathOf,
  );
  folders = folders.filter((path) =>
    isValidMoveDestination({
      kind: "folder",
      sourcePath: path,
      destinationPath: dest.destinationPath,
    }),
  );
  const moves: ContentBrowserDropMove[] = [];
  for (const path of folders) {
    if (contentRootOfPath(path, rootPaths) !== dest.destRoot) return [];
    moves.push({
      kind: "folder",
      sourcePath: path,
      destinationPath: dest.destinationPath,
      id: path,
    });
  }
  for (const guid of guids) {
    const path = pathOf(guid);
    if (!path) continue;
    const sourceRoot = contentRootOfPath(path, rootPaths);
    if (sourceRoot !== dest.destRoot) return [];
    const sourcePath = parentFolderPath(path, sourceRoot);
    if (
      !isValidMoveDestination({
        kind: "asset",
        sourcePath,
        destinationPath: dest.destinationPath,
      })
    ) {
      continue;
    }
    moves.push({
      kind: "asset",
      sourcePath,
      destinationPath: dest.destinationPath,
      id: path,
      guid,
    });
  }
  return moves;
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
  assets: ReadonlyArray<ClassAssetRef>,
): (id: string) => string | null {
  const map = new Map<string, string | null>();
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const parent = asset.header.parentClass ?? "BObject";
    const id = classIdFromClassAsset(asset);
    map.set(id, parent);
    if (asset.header.name !== id) map.set(asset.header.name, parent);
  }
  return (id) => {
    return map.get(id) ?? engineParentOf(id) ?? null;
  };
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
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, import("@babylonslate/core").SerializedGraph>;
}): ImportResult {
  const { type, name, guid, parentClass } = options;

  if (type === "Scene") {
    const payload = createDefaultScene() as unknown as Record<string, unknown>;
    payload.name = name;
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
    const payload = createDefaultLogicGraphSerialized(defaultNodeRegistry, {
      parentClass,
      parentOf: options.parentOf,
      parentGraphs: options.parentGraphs,
    }) as unknown as Record<
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

  if (type === "Sprite") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSpritePayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "SpriteAnimation") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSpriteAnimationPayload() as unknown as Record<string, unknown>,
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

  if (type === "Material") {
    const payload = createDefaultMaterialDocument(name) as unknown as Record<
      string,
      unknown
    >;
    return documentAsset(type, name, guid, payload);
  }

  if (type === "MaterialFunction") {
    const payload = createDefaultMaterialFunctionDocument(
      name,
    ) as unknown as Record<string, unknown>;
    return documentAsset(type, name, guid, payload);
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

  if (type === "AudioMixer") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultAudioMixerPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "AudioChannel") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultAudioChannelPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "SoundAttenuation") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSoundAttenuationPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "ParticleEmitter") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultParticleEmitterPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "ParticleSystem") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultParticleSystemPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "SkyboxCreator") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>,
    );
  }

  const exhaustive: never = type;
  throw new Error(`Unsupported creatable asset type: ${String(exhaustive)}`);
}

const ASSET_FILE_SUFFIX: Partial<Record<CreatableAssetType, string>> = {
  Scene: ".scene.babasset",
  Class: ".class.babasset",
  Sprite: ".sprite.babasset",
  SpriteAnimation: ".spriteanim.babasset",
  AnimationGraph: ".anim.babasset",
  Material: ".material.babasset",
  MaterialFunction: ".matfunc.babasset",
  Tileset: ".tileset.babasset",
  Tilemap: ".tilemap.babasset",
  BehaviourTree: ".bt.babasset",
  Blackboard: ".blackboard.babasset",
  AudioMixer: ".mixer.babasset",
  AudioChannel: ".channel.babasset",
  SoundAttenuation: ".atten.babasset",
  ParticleEmitter: ".emitter.babasset",
  ParticleSystem: ".particles.babasset",
  SkyboxCreator: ".skyboxcreator.babasset",
};

export function newAssetFileName(
  type: CreatableAssetType,
  name: string,
): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_");
  if (!safe) return "";
  return `${safe}${ASSET_FILE_SUFFIX[type] ?? ".babasset"}`;
}

/** Relative path next to an existing asset (`assets/HUD.class.babasset` → `Chip.class.babasset`). */
export function siblingAssetRelativePath(hostPath: string, fileName: string): string {
  const slash = hostPath.lastIndexOf("/");
  const dir = slash >= 0 ? hostPath.slice(0, slash) : "";
  const relativeDir =
    dir === "assets" || dir === "" ? "" : dir.replace(/^assets\//, "");
  return relativeDir ? `${relativeDir}/${fileName}` : fileName;
}

/**
 * Textures, called functions and the preview mesh a material references.
 * Saving writes these into `header.dependencies[]` so Show References, delete
 * guards and the export closure all see them.
 */
export function materialAssetDependencies(
  assetType: string,
  payload: Record<string, unknown>,
): string[] {
  if (assetType === "Material" || isLegacyMaterialAssetType(assetType)) {
    return materialDependencies(normalizeMaterialDocument(payload)).all;
  }
  if (assetType === "MaterialFunction") {
    return materialDependencies(normalizeMaterialFunctionDocument(payload)).all;
  }
  return [];
}

/** Header `dependencies[]` written on save for Show References, remap, and export. */
export function assetHeaderDependencies(
  assetType: string,
  payload: Record<string, unknown>,
): string[] {
  const unique = new Set<string>([
    ...materialAssetDependencies(assetType, payload),
    ...audioAssetDependencies(assetType, payload),
    ...particleAssetDependencies(assetType, payload),
    ...skyboxCreatorAssetDependencies(assetType, payload),
    ...(assetType === "SpriteAnimation"
      ? spriteAnimationTextureGuids(parseSpriteAnimationPayload(payload))
      : []),
    ...(assetType === "Model" ? modelAssetGuids(payload) : []),
    ...(assetType === "Skeleton" ? skeletonAssetGuids(payload) : []),
    ...(assetType === "Animation" ? animationAssetGuids(payload) : []),
  ]);
  return [...unique].sort();
}

/** Header payload fields Content Browser / pickers can read without loading the document. */
export function materialHeaderMeta(
  assetType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (assetType !== "Material" && !isLegacyMaterialAssetType(assetType)) {
    return undefined;
  }
  return {
    domain: parseMaterialDomain(payload.domain),
  };
}

export function isPostProcessMaterialAsset(asset: {
  header: { type: string; payload?: Record<string, unknown> };
}): boolean {
  return (
    asset.header.type === "Material" &&
    asset.header.payload?.domain === "postProcess"
  );
}

export function isParticleMaterialAsset(asset: {
  header: { type: string; payload?: Record<string, unknown> };
}): boolean {
  return (
    asset.header.type === "Material" &&
    asset.header.payload?.domain === "particle"
  );
}

export function isPostProcessMaterialForPicker(
  asset: {
    path: string;
    header: { type: string; payload?: Record<string, unknown> };
  },
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>,
): boolean {
  const open = openDocuments.find(
    (entry) =>
      entry.ref.kind === "material" && entry.ref.path === asset.path,
  );
  if (open && open.content && typeof open.content === "object") {
    return (open.content as { domain?: unknown }).domain === "postProcess";
  }
  return isPostProcessMaterialAsset(asset);
}

export function isInterfaceMaterialAsset(asset: {
  header: { type: string; payload?: Record<string, unknown> };
}): boolean {
  return (
    asset.header.type === "Material" &&
    asset.header.payload?.domain === "interface"
  );
}

export function isInterfaceMaterialForPicker(
  asset: {
    path: string;
    header: { type: string; payload?: Record<string, unknown> };
  },
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>,
): boolean {
  const open = openDocuments.find(
    (entry) =>
      entry.ref.kind === "material" && entry.ref.path === asset.path,
  );
  if (open && open.content && typeof open.content === "object") {
    return (open.content as { domain?: unknown }).domain === "interface";
  }
  return isInterfaceMaterialAsset(asset);
}

export function isParticleMaterialForPicker(
  asset: {
    path: string;
    header: { type: string; payload?: Record<string, unknown> };
  },
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>,
): boolean {
  const open = openDocuments.find(
    (entry) =>
      entry.ref.kind === "material" && entry.ref.path === asset.path,
  );
  if (open && open.content && typeof open.content === "object") {
    return (open.content as { domain?: unknown }).domain === "particle";
  }
  return isParticleMaterialAsset(asset);
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

/** Names shown in Delete (N) confirm — selected folders and assets, not flattened contents. */
export function contentBrowserDeleteListNames(options: {
  folderPaths?: readonly string[];
  assetNames?: readonly string[];
}): string[] {
  return [...(options.folderPaths ?? []), ...(options.assetNames ?? [])];
}

/** Every asset guid a confirm will remove, including files inside selected folders. */
export function contentBrowserDeletingGuids(options: {
  extraGuids: readonly string[];
  folderPaths: readonly string[];
  assets: ReadonlyArray<{ header: { guid: string }; path: string }>;
}): Set<string> {
  const guids = new Set(options.extraGuids);
  for (const folder of options.folderPaths) {
    const prefix = `${folder}/`;
    for (const asset of options.assets) {
      if (asset.path === folder || asset.path.startsWith(prefix)) {
        guids.add(asset.header.guid);
      }
    }
  }
  return guids;
}

export function lastSceneClassDeleteLines(
  assets: ReadonlyArray<{ header: { guid: string; type: string } }>,
  deletingGuids: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  for (const type of ["Scene", "Class"] as const) {
    const ofType = assets.filter((asset) => asset.header.type === type);
    if (ofType.length === 0) continue;
    if (ofType.every((asset) => deletingGuids.has(asset.header.guid))) {
      lines.push(`This is the last ${type} in the project.`);
    }
  }
  return lines;
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
