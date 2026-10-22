import {
  actorPropertyReferences,
  assetFolderOfPath,
  classIdForAssetPath,
  classIdsFromVariableMembers,
  assetVariableGuidsFromGraph,
  areaEmissionTextureGuids,
  err,
  isEditorOnlyAsset,
  isFolderWithin,
  normalizeAlwaysPackageFolders,
  normalizeAssetFolderPath,
  materialParameterTextureGuidsFromGraph,
  renderTargetAssetGuidsFromGraph,
  ok,
  text2dImageGuidsFromScene,
  type Result,
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import {
  subsystemBaseClassIdOf,
  type SubsystemClassHierarchy,
} from "@haptic/object-model";
import { dataAssetDependencies, dataGraphAssetDependencies } from "@haptic/assets";
import { MISSING_STARTUP_SCENE_MESSAGE } from "./constants";
import type {
  ExportClosureInput,
  ExportIndexedAsset,
  ExportReachability,
  ExportRootInput,
  HeaderReachabilityInput,
} from "./types";

function pluginGuidFromRoot(rootId: string): string | null {
  return rootId.startsWith("plugin:") ? rootId.slice("plugin:".length) : null;
}

/** Serialized reference fields. Ordinary authored strings must never be scanned. */
function isReferenceField(key: string): boolean {
  return (
    /Guids?$/.test(key) ||
    key === "Asset" ||
    key === "classId" ||
    key === "itemClassId" ||
    key === "sceneLayerActors" ||
    key === "default:classId" ||
    key === "parentClass" ||
    key === "scene" ||
    key === "sceneGuid" ||
    key.endsWith(":asset")
  );
}

function collectTypedRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectTypedRefs(entry, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(row)) {
    if (Array.isArray(row.dataSchema) && (key === "default:values" || key === "dataSchema")) continue;
    if (isReferenceField(key)) {
      if (typeof entry === "string" && entry.trim()) into.add(entry.trim());
      if (Array.isArray(entry)) {
        for (const item of entry) {
          if (typeof item === "string" && item.trim()) into.add(item.trim());
        }
      }
    }
    if (key === "faces" && entry && typeof entry === "object") {
      for (const face of Object.values(entry as Record<string, unknown>)) {
        if (typeof face === "string" && face.trim()) into.add(face.trim());
      }
    }
    if (entry && typeof entry === "object") collectTypedRefs(entry, into);
  }
}

function isIncluded(
  asset: ExportIndexedAsset,
  input: Pick<ExportRootInput, "pluginEnabledGuids" | "parentOf">,
): boolean {
  const pluginGuid = pluginGuidFromRoot(asset.rootId);
  if (pluginGuid && !input.pluginEnabledGuids.has(pluginGuid)) return false;
  return !isEditorOnlyAsset(
    { type: asset.type, parentClass: asset.parentClass ?? null },
    input.parentOf,
  );
}

/** Class ancestry through the project's class headers, class id first. */
function classHierarchy(
  parentOf: ExportRootInput["parentOf"],
): SubsystemClassHierarchy {
  return {
    ancestry(classId) {
      const chain: string[] = [];
      const seen = new Set<string>();
      let current: string | undefined = classId;
      while (current && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        current = parentOf(current)?.trim();
      }
      return chain;
    },
  };
}

/**
 * GameSubsystem / SceneSubsystem classes run without being referenced, so every
 * Class whose parent chain reaches either base ships. The walk starts at the
 * header parent: the engine bases are never assets, so they are never roots.
 */
function isSubsystemClassAsset(
  asset: ExportIndexedAsset,
  hierarchy: SubsystemClassHierarchy,
): boolean {
  const parentClass = asset.type === "Class" ? asset.parentClass?.trim() : "";
  return (
    !!parentClass && subsystemBaseClassIdOf(hierarchy, parentClass) !== null
  );
}

/**
 * Compile class id of a Class asset: its storage file stem, as the editor
 * compiles and lists it. A header without a storage path has none.
 */
function classIdOf(asset: ExportIndexedAsset): string | undefined {
  return asset.type === "Class" && asset.path ? classIdForAssetPath(asset.path) : undefined;
}

type ClosureIndex = {
  sortedAssets: ExportIndexedAsset[];
  byGuid: Map<string, ExportIndexedAsset>;
  /** Class assets by compile class id, in guid order. */
  byClassId: Map<string, ExportIndexedAsset[]>;
};

function indexAssets(assets: readonly ExportIndexedAsset[]): ClosureIndex {
  const sortedAssets = [...assets].sort((a, b) => a.guid.localeCompare(b.guid));
  const byGuid = new Map(sortedAssets.map((asset) => [asset.guid, asset]));
  const byClassId = new Map<string, ExportIndexedAsset[]>();
  for (const asset of sortedAssets) {
    const classId = classIdOf(asset);
    if (!classId) continue;
    const list = byClassId.get(classId) ?? [];
    list.push(asset);
    byClassId.set(classId, list);
  }
  return { sortedAssets, byGuid, byClassId };
}

/** What a game ships without any Scene referencing it. */
export type ExportRoots = {
  /** Guids or class ids that ship with the startup Scene. */
  startupRefs: string[];
  /** Assets under an Always Package Folder, each shipping on its own. */
  alwaysPackageGuids: string[];
};

/**
 * The roots shared by every export and Editor Play: Input assets, subsystem
 * Classes, debug commands, the project systems named in settings and
 * everything in an Always Package Folder. The traversal still drops
 * editor-only assets and disabled plugin content.
 */
export function selectExportRoots(input: ExportRootInput): ExportRoots {
  return rootsFromIndex(input, indexAssets(input.assets));
}

function rootsFromIndex(input: ExportRootInput, { sortedAssets }: ClosureIndex): ExportRoots {
  const hierarchy = classHierarchy(input.parentOf);
  const startupRefs: string[] = [];
  for (const asset of sortedAssets) if (asset.type === "InputAction" || asset.type === "InputAxis") startupRefs.push(asset.guid);
  for (const asset of sortedAssets) if (isSubsystemClassAsset(asset, hierarchy)) startupRefs.push(asset.guid);
  // Commands are discoverable from catalog metadata, but their resources
  // remain deferred until the command runs.
  for (const asset of sortedAssets) if (asset.consoleCommand || (asset.type === "Class" && asset.parentClass && hierarchy.ancestry(asset.parentClass).includes("BDebugCommand"))) startupRefs.push(asset.guid);
  for (const ref of [input.gameInstanceClass, input.audioMixerGuid, input.saveGameDefinitionGuid, ...(input.renderAssetGuids ?? [])]) {
    if (ref?.trim()) startupRefs.push(ref.trim());
  }
  const folders = normalizeAlwaysPackageFolders(input.alwaysPackageFolders);
  const alwaysPackageGuids = folders.length === 0 ? [] : sortedAssets
    .filter((asset) => {
      if (!asset.path) return false;
      const folder = normalizeAssetFolderPath(assetFolderOfPath(asset.path));
      return folders.some((root) => isFolderWithin(folder, root));
    })
    .map((asset) => asset.guid);
  return { startupRefs, alwaysPackageGuids };
}

/**
 * Adds the references beyond the header `dependencies` that a closure follows
 * from `asset`.
 */
type RefExpander = (asset: ExportIndexedAsset, refs: Set<string>) => void;

/**
 * The included asset a reference names: an asset guid, or else the compile
 * class id of a Class. Display names never resolve.
 */
function resolveReference(input: ExportRootInput, { byGuid, byClassId }: ClosureIndex, ref: string): ExportIndexedAsset | undefined {
  const direct = byGuid.get(ref);
  if (direct) return isIncluded(direct, input) ? direct : undefined;
  return byClassId.get(ref)?.find((candidate) => isIncluded(candidate, input));
}

/**
 * Walks references from the roots. `scenes` are the Scene passes to start;
 * the first carries the roots, and Scenes reached from any pass start their
 * own. Returns the union of everything reached and each pass's share.
 */
function walkClosure(
  input: ExportRootInput,
  index: ClosureIndex,
  scenes: readonly string[],
  expand: RefExpander,
): Result<ExportReachability, string> {
  const roots = rootsFromIndex(input, index);
  const bySceneGuid = new Map<string, Set<string>>();
  const pendingScenes = [...scenes].reverse();
  const traversedScenes = new Set<string>();

  while (pendingScenes.length) {
    const sceneRoot = pendingScenes.pop()!;
    if (traversedScenes.has(sceneRoot)) continue;
    traversedScenes.add(sceneRoot);
    const reached = new Set<string>();
    bySceneGuid.set(sceneRoot, reached);
    const rootAsset = index.byGuid.get(sceneRoot);
    const pending = rootAsset && isIncluded(rootAsset, input) ? [sceneRoot] : [];
    const seen = new Set<string>([sceneRoot]);

    const enqueue = (ref: string): void => {
      const asset = resolveReference(input, index, ref);
      if (!asset) return;
      if (asset.type === "Scene" && asset.guid !== sceneRoot) {
        if (!traversedScenes.has(asset.guid)) pendingScenes.push(asset.guid);
        return;
      }
      if (!seen.has(asset.guid)) {
        seen.add(asset.guid);
        pending.push(asset.guid);
      }
    };

    if (sceneRoot === scenes[0]) {
      for (const ref of roots.startupRefs) enqueue(ref);
      for (const guid of roots.alwaysPackageGuids) enqueue(guid);
    }

    // Every queued guid is an included asset; the order is deterministic
    // because roots come from guid-sorted headers and references are sorted.
    while (pending.length) {
      const asset = index.byGuid.get(pending.pop()!)!;
      const refs = new Set<string>(asset.dependencies);
      const parentClass = asset.type === "Class" ? asset.parentClass?.trim() : "";
      if (parentClass) refs.add(parentClass);
      expand(asset, refs);
      reached.add(asset.guid);
      for (const next of [...refs].sort()) enqueue(next);
    }
  }

  const guids = [
    ...new Set([...bySceneGuid.values()].flatMap((set) => [...set])),
  ].sort();
  return ok({ guids, bySceneGuid });
}

export function collectExportReachability(
  input: ExportClosureInput,
): Result<ExportReachability, string> {
  const startup = input.startupSceneGuid?.trim() ?? "";
  const index = indexAssets(input.assets);
  const { sortedAssets, byGuid, byClassId } = index;
  const definitionFields = (guid: string): readonly unknown[] | undefined => {
    const type = byGuid.get(guid)?.type;
    if (type !== "DataDefinition" && type !== "Structure") return undefined;
    const payload = input.payloadByGuid?.(guid);
    return payload && typeof payload === "object" && "fields" in payload && Array.isArray(payload.fields) ? payload.fields : undefined;
  };
  const startupAsset = startup ? byGuid.get(startup) : undefined;
  if (!startup || !startupAsset || startupAsset.type !== "Scene") {
    return err(MISSING_STARTUP_SCENE_MESSAGE);
  }

  const dataClassReferences = sortedAssets.flatMap((entry) => {
    const classId = classIdOf(entry);
    return classId ? [{ guid: entry.guid, classId }] : [];
  });

  /** Scans the document and payload of an asset for the references its header omits. */
  const expand: RefExpander = (asset, refs) => {
    const collectOverrides = (value: unknown) => {
      const references = actorPropertyReferences(value, classId => {
        const entry = byGuid.get(classId) ?? byClassId.get(classId)?.[0];
        if (!entry) return null;
        return { parentClassId: entry.parentClass, members: input.graphByGuid(entry.guid)?.members };
      });
      for (const reference of [...references.assetGuids, ...references.classIds]) refs.add(reference);
    };
    if (asset.type === "Scene") {
      const scene: SerializedScene | null = input.sceneByGuid(asset.guid);
      if (scene) {
        collectTypedRefs(scene, refs);
        collectOverrides(scene);
        for (const guid of text2dImageGuidsFromScene(scene)) refs.add(guid);
      }
    } else if (asset.type === "Class") {
      const graph: SerializedGraph | null = input.graphByGuid(asset.guid);
      if (graph) {
        collectTypedRefs(graph, refs);
        collectOverrides({ classId: classIdOf(asset) ?? asset.guid, properties: graph.actorDefaults?.properties, graph });
        for (const classId of classIdsFromVariableMembers(graph.members ?? [])) refs.add(classId);
        for (const guid of assetVariableGuidsFromGraph(graph)) refs.add(guid);
        for (const guid of materialParameterTextureGuidsFromGraph(graph)) refs.add(guid);
        for (const guid of renderTargetAssetGuidsFromGraph(graph)) refs.add(guid);
        for (const guid of areaEmissionTextureGuids(graph)) refs.add(guid);
        for (const guid of dataGraphAssetDependencies(graph, dataClassReferences, definitionFields)) refs.add(guid);
      }
    }
    const payload = input.payloadByGuid?.(asset.guid);
    if (payload) {
      if (asset.type === "SaveGame" && typeof payload === "object" && "fields" in payload && Array.isArray(payload.fields)) {
        for (const field of payload.fields as Array<{ type?: string; defaultValue?: unknown }>) {
          if (field.type !== "asset") continue;
          const values = Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue];
          for (const value of values) if (typeof value === "string" && value) refs.add(value);
        }
      }
      if (["DataDefinition", "DataTree", "Structure", "Enum"].includes(asset.type)) {
        for (const guid of dataAssetDependencies(asset.type, payload, dataClassReferences, definitionFields)) refs.add(guid);
      } else {
        collectTypedRefs(payload, refs);
        collectOverrides(payload);
        if (typeof payload === "object" && "actors" in payload) {
          for (const guid of text2dImageGuidsFromScene(payload as SerializedScene)) refs.add(guid);
        }
      }
    }
  };
  return walkClosure(input, index, [startup], expand);
}

/**
 * The packaged set from headers alone: everything the export closure reaches
 * through header `dependencies` from the same roots, without opening any
 * document. Editor Play lists it as the game's asset catalog, adding the
 * Scene it starts from through `extraSceneGuids`.
 */
export function collectHeaderReachability(
  input: HeaderReachabilityInput,
): Result<ExportReachability, string> {
  const index = indexAssets(input.assets);
  const scenes = [input.startupSceneGuid, ...(input.extraSceneGuids ?? [])]
    .map((guid) => guid?.trim() ?? "")
    .filter((guid, position, list) => guid !== "" && list.indexOf(guid) === position && index.byGuid.get(guid)?.type === "Scene");
  if (scenes.length === 0) return err(MISSING_STARTUP_SCENE_MESSAGE);
  return walkClosure(input, index, scenes, () => undefined);
}
