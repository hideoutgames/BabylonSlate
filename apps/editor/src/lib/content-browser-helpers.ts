import type { IndexedAsset } from "@haptic/assets";
import {
  normalizeAnimationPayload,
  contentEntryNameError,
  renamedAssetPath,
} from "@haptic/assets";
import {
  isSceneWorkspaceKind,
  type SerializedScene,
  type ViewportMode,
} from "@haptic/core";
import {
  engineParentOf,
  resolveTypeVisual,
  walkAncestry,
  type TypeVisual,
} from "@haptic/editor-kit";
import {
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  isLockedEngineClassId,
} from "@haptic/object-model";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  classIdFromClassAsset,
  classParentLookup,
  newAssetFileName,
} from "./class-asset-lookup";
import { joinAssetFolderPath } from "./content-browser-tree";
import { isMaterialAssetType } from "./material-asset-filters";
import { shownCompressionState } from "./texture-encode-state";

// Boot-path consumers import these from `class-asset-lookup` directly; the
// re-export keeps every other importer of this module unchanged.
export {
  classDocumentShowsPrefab,
  classIdFromClassAsset,
  classParentLookup,
  newAssetFileName,
  newAssetFileSuffix,
  registryClassParentLookup,
  type ClassAssetRef,
} from "./class-asset-lookup";

// Content paths and folder trees, selection, search and sort, moves, New Asset
// factories, header dependencies and Material filters live in sibling
// modules; the re-exports keep every importer of this module unchanged.
export {
  ASSETS_ROOT,
  isFolderTreeRoot,
  collectFolderGuids,
  type MoveKind,
  type FlattenedFolderRow,
  parentFolderPath,
  filterFolderTreeRows,
  type ContentBrowserTreeRow,
  listChildFolders,
  listChildFoldersFromTrees,
  collectFolderGuidsFromTrees,
  flattenFolderForest,
  flattenContentBrowserForest,
  nestedFolderPaths,
  withAutoCollapsedNestedFolders,
  flattenContentBrowserTree,
  flattenFolderTree,
  joinAssetFolderPath,
} from "./content-browser-tree";
export {
  type ContentBrowserPaintHit,
  type ContentBrowserSelection,
  isContentBrowserEmptyGridDoubleClickTarget,
  exclusiveSelectAsset,
  exclusiveSelectFolder,
  applyContentBrowserTileSelect,
  applyContentBrowserTreeSelect,
  paintSelectTiles,
  resolveContentBrowserPaintHit,
} from "./content-browser-selection";
export {
  filterAssets,
  type ContentBrowserSortMode,
  CONTENT_BROWSER_SORT_OPTIONS,
  sortAssets,
  sortChildFolders,
  uniqueAssetTypes,
} from "./content-browser-filter-sort";
export {
  isValidMoveDestination,
  contentBrowserSelectionMoves,
  moveNameCollision,
  contentBrowserMoveDialogTitle,
  contentBrowserMovePreviewName,
  guidsOutsideSelectedFolders,
  rootSelectedFolderPaths,
  remapPathAfterFolderMove,
  type ContentBrowserDropMove,
  isCrossRootMove,
  contentBrowserMoveFromDrop,
  contentBrowserTreeDropMoves,
} from "./content-browser-moves";
export {
  defaultParentClassForType,
  buildNewAssetResult,
  buildMaterialInstanceAssetResult,
  materialInstanceNameFor,
} from "./new-asset-result";
export {
  materialAssetDependencies,
  assetHeaderDependencyMetadata,
  assetHeaderDependencies,
  assetDependenciesIncludingOpenDocuments,
} from "./asset-header-dependencies";
export {
  materialHeaderMeta,
  isMaterialSamplerTextureAsset,
  MATERIAL_ASSET_TYPES,
  isMaterialAssetType,
  isPostProcessMaterialAsset,
  isParticleMaterialAsset,
  isPostProcessMaterialForPicker,
  isParticleMaterialForPicker,
  materialDomainsFromAssets,
  filterInspectorPinPickerAssets,
} from "./material-asset-filters";

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
  "Object",
  "Actor",
  "RenderTargetCapture",
  "SceneLayerActor",
  "SceneLayerActorSwitcher",
  "SceneStreamingActor",
  "ActorComponent",
  "GameInstance",
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  "FunctionLibrary",
  "DebugCommand",
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
    // Nest engine bases under the nearest engine base the picker lists, so
    // the subsystem bases sit under Object past the hidden Subsystem base.
    const parent =
      walkAncestry(engineParentOf(id), (ancestor) => engineParentOf(ancestor))
        .find((ancestor) =>
          (ENGINE_BASE_CLASSES as readonly string[]).includes(ancestor),
        ) ?? null;
    addChild(parent, id);
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
    if (walkAncestry(id, parentOf).includes("SceneLayer")) return;
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
  "SceneLayer",
  "Class",
  "Prefab",
  "Sprite",
  "SpriteAnimation",
  "AnimationGraph",
  "Material",
  "MaterialInstance",
  "MaterialFunction",
  "Tileset",
  "Tilemap",
  "BehaviourTree",
  "Blackboard",
  "SaveGame",
  "Enum",
  "Structure",
  "DataDefinition",
  "DataTree",
  "FloatCurve",
  "VectorCurve",
  "ColorCurve",
  "Timeline",
  "ScriptInterface",
  "AudioMixer",
  "AudioChannel",
  "SoundAttenuation",
  "InputAction",
  "InputAxis",
  "ParticleEmitter",
  "ParticleGraph",
  "ParticleSystem",
  "Water",
  "RenderTarget",
  "RenderTargetTexture",
  "SkyboxCreator",
] as const;

export type CreatableAssetType = (typeof CREATABLE_ASSET_TYPES)[number];

export type CreatableAssetTypeGroup = {
  id: string;
  label: string;
  types: readonly CreatableAssetType[];
};

/** Catalog groups for the New Asset type-card grid. */
export const CREATABLE_ASSET_TYPE_GROUPS: readonly CreatableAssetTypeGroup[] = [
  { id: "world", label: "World", types: ["Scene", "SceneLayer", "Prefab"] },
  { id: "input", label: "Input", types: ["InputAction", "InputAxis"] },
  { id: "data", label: "Data", types: ["DataDefinition", "DataTree", "FloatCurve", "VectorCurve", "ColorCurve"] },
  {
    id: "scripting",
    label: "Scripting",
    types: ["Class", "Enum", "Structure", "ScriptInterface", "SaveGame"],
  },
  {
    id: "2d",
    label: "2D",
    types: ["Sprite", "Tileset", "Tilemap"],
  },
  {
    id: "animation",
    label: "Animation",
    types: ["AnimationGraph", "SpriteAnimation", "Timeline"],
  },
  {
    id: "rendering",
    label: "Rendering",
    types: ["Material", "MaterialInstance", "MaterialFunction", "RenderTarget", "RenderTargetTexture", "Water", "ParticleEmitter", "ParticleGraph", "ParticleSystem", "SkyboxCreator"],
  },
  {
    id: "audio",
    label: "Audio",
    types: ["AudioMixer", "AudioChannel", "SoundAttenuation"],
  },
  {
    id: "ai",
    label: "AI",
    types: ["BehaviourTree", "Blackboard"],
  },
];

const CREATABLE_ASSET_TYPE_DESCRIPTIONS: Record<CreatableAssetType, string> = {
  InputAction: "A button action, such as Jump, Interact, or Fire. Add controls, then use its event in a graph.",
  InputAxis: "A number or 2D direction, such as Move, Look, or Throttle. Combine keys, sticks, and touch controls.",
  Scene: "A 3D or 2D world document.",
  SceneLayer: "An unlit 2D overlay that draws on top of world scenes.",
  Class: "A class with a parent and a logic graph.",
  Prefab: "Placeable components without logic. Lighter than an Actor class: no graph, events, variables, or tick.",
  Sprite: "A 2D sprite sheet with named frames and pivots.",
  SpriteAnimation: "A pickable 2D clip of Texture frames for Animation Graph.",
  AnimationGraph: "A state machine that plays Sprite or Animation clips.",
  Material: "A shader graph that compiles to a Babylon material.",
  MaterialFunction: "A reusable shader subgraph for materials.",
  MaterialInstance: "Parameter values for a parent Material. Shares its compiled shader, so edits and variants cost no recompile.",
  Tileset: "Tile definitions and collision for painting tilemaps.",
  Tilemap: "A painted 2D tile layer that references a Tileset.",
  BehaviourTree: "An AI tree of composites, tasks, and decorators.",
  SaveGame: "Typed player progress with defaults, stable fields, and reliable local save slots.",
  Blackboard: "Shared keys that a behaviour tree reads and writes.",
  Enum: "Named integer members used by pins and variables.",
  Structure: "A user-defined struct of typed fields.",
  DataDefinition: "Define fields, defaults, and validation for Data Tree entries.",
  DataTree: "Organize typed entries in a hierarchy. Branches can use different Data Definitions.",
  FloatCurve: "A number that changes over time, shared by every script that reads it.",
  VectorCurve: "A vector that changes over time, shared by every script that reads it.",
  ColorCurve: "A colour and alpha that change over time, shared by every script that reads it.",
  Timeline: "Groups Timeline Clips from Scenes and Scene Layers, so any class can play them and bind their events.",
  ScriptInterface: "A contract of methods that classes can implement.",
  AudioMixer: "Global and per-channel default volumes for Play.",
  AudioChannel: "A routing bus with an optional parent and reverb send.",
  SoundAttenuation: "Distance falloff that opts Audio into 3D playback.",
  ParticleEmitter:
    "A GPU emitter built from a stack of modules for spawn, shape, motion, and color. Its look comes from a particle Material.",
  ParticleGraph:
    "A node-graph emitter for custom particle behavior, simulated on the CPU. Its look comes from a particle Material.",
  ParticleSystem:
    "Plays up to 8 Basic Particle Emitters or Particle Graphs together on one actor.",
  Water: "Shared water appearance and waves for oceans, lakes, rivers, and puddles.",
  RenderTarget: "A scene capture's render mode and output resolution.",
  RenderTargetTexture: "A live Render Target output that Materials can sample as a texture.",
  SkyboxCreator:
    "Editor-only helper tool that slices a texture into six skybox faces.",
};

/** New Asset rows whose label differs from the split type name. */
const CREATABLE_ASSET_TYPE_LABELS: Partial<Record<CreatableAssetType, string>> = {
  ParticleEmitter: "Basic Particle Emitter",
};

/** Title Case label for a creatable asset type (`User Interface`). */
export function creatableAssetTypeLabel(type: CreatableAssetType): string {
  return (
    CREATABLE_ASSET_TYPE_LABELS[type] ??
    type
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  );
}

export function creatableAssetTypeDescription(
  type: CreatableAssetType,
): string {
  return CREATABLE_ASSET_TYPE_DESCRIPTIONS[type];
}

/** `encoding`: the Texture's encode is running, which only the editor's memory knows (`shownCompressionState`). */
export function textureCompressionState(
  asset: IndexedAsset,
  encoding = false,
): TextureCompressionState | null {
  if (asset.header.type !== "Texture") return null;
  const state = shownCompressionState(asset.header.payload.compressionState, encoding);
  if (state === null) return null;
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

export type ContentBrowserContextAction =
  | "open"
  | "generate-thumbnail"
  | "import-msdf-atlas"
  | "create-material-instance"
  | "duplicate"
  | "rename"
  | "retarget"
  | "move"
  | "copy"
  | "copy-asset-reference"
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
  canGenerateThumbnails?: boolean;
  singleAssetType?: string;
}): ContentBrowserContextAction[] {
  const total = options.assetCount + options.folderCount;
  if (total === 0) return [];
  const actions: ContentBrowserContextAction[] = [];
  if (options.canGenerateThumbnails && options.assetCount > 0 && options.folderCount === 0) {
    actions.push("generate-thumbnail");
  }
  if (options.assetCount === 1 && options.folderCount === 0) {
    actions.push("open");
    if (options.singleAssetType === "Font") {
      actions.push("import-msdf-atlas");
    }
    if (isMaterialAssetType(options.singleAssetType ?? "")) {
      actions.push("create-material-instance");
    }
  }
  actions.push("duplicate");
  if (total === 1) actions.push("rename");
  if (options.canRetarget && options.assetCount > 0 && options.folderCount === 0) {
    actions.push("retarget");
  }
  actions.push("move", "copy");
  if (options.assetCount === 1 && options.folderCount === 0) {
    actions.push("copy-asset-reference", "show-references");
  }
  actions.push("delete");
  return actions;
}

function isEngineClassId(classId: string): boolean {
  return isLockedEngineClassId(classId) || engineParentOf(classId) !== undefined;
}

/**
 * Class ids are file stems shared by the whole project, so `Rain-Weather` and
 * `Rain_Weather`, or one stem in two folders, would compile to one class.
 * Why a Class written at `path` cannot take its id, or null. `exceptPath` is
 * the Class being renamed.
 */
export function classIdConflict(
  assets: ReadonlyArray<{ path: string; header: { type: string } }>,
  path: string,
  exceptPath?: string,
): string | null {
  const classId = classIdForGraphPath(path);
  if (isEngineClassId(classId)) {
    return `"${classId}" is an engine class name. Choose another Class name.`;
  }
  return assets.some((asset) =>
    asset.header.type === "Class" &&
    asset.path !== exceptPath &&
    classIdForGraphPath(asset.path) === classId)
    ? `Another Class already uses the class id "${classId}".`
    : null;
}

export function visualForIndexedAsset(
  asset: IndexedAsset,
  parentOf: (id: string) => string | null,
): TypeVisual {
  if (asset.header.type === "Class") {
    const start = asset.header.parentClass ?? "Object";
    return resolveTypeVisual({
      assetType: "Class",
      parentClass: asset.header.parentClass,
      ancestry: walkAncestry(start, parentOf),
    });
  }
  return resolveTypeVisual({ assetType: asset.header.type });
}

/**
 * The mode new authored content starts in: the active Scene or Scene Layer
 * tab's, else the first open one's; 3D when none is open.
 */
export function openSceneViewportMode(
  documents: ReadonlyArray<{ id: string; ref: { kind: string }; content: unknown }>,
  activeDocumentId: string | null,
): ViewportMode {
  const scenes = documents.filter((doc) => isSceneWorkspaceKind(doc.ref.kind));
  const scene = scenes.find((doc) => doc.id === activeDocumentId) ?? scenes[0];
  return (scene?.content as SerializedScene | null | undefined)?.viewportMode === "2d" ? "2d" : "3d";
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
/** What a Content Browser delete was asked for: assets, one folder, or a mixed selection. */
export type DeleteTarget =
  | { kind: "assets"; guids: string[] }
  | { kind: "folder"; path: string; guids: string[] }
  | { kind: "selection"; folders: string[]; guids: string[] };

/** The folders a delete removes, with everything in them. */
export function deleteTargetFolders(target: DeleteTarget | null): string[] {
  if (target?.kind === "folder") return [target.path];
  return target?.kind === "selection" ? target.folders : [];
}

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
  if (contentEntryNameError(newName)) return false;
  const newPath = renamedAssetPath(currentPath, newName);
  if (newPath === currentPath) return false;
  for (const existing of existingPaths) {
    if (existing === newPath) return true;
  }
  return false;
}

/**
 * Content Browser Import sets `busy` before convert/embed. Always clear it
 * (and the progress overlay) so Import / New Asset cannot stay disabled.
 */
export async function runWithContentBrowserImportBusy(
  setBusy: (busy: boolean) => void,
  clearImportProgress: () => void,
  work: () => Promise<void>,
): Promise<void> {
  setBusy(true);
  try {
    await work();
  } finally {
    clearImportProgress();
    setBusy(false);
  }
}
