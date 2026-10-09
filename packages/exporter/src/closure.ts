import {
  actorPropertyReferences,
  assetFolderOfPath,
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
} from "@babylonslate/core";
import {
  subsystemBaseClassIdOf,
  type SubsystemClassHierarchy,
} from "@babylonslate/object-model";
import { dataAssetDependencies, dataGraphAssetDependencies } from "@babylonslate/assets";
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
    key === "gameInstanceClass" ||
    key === "scene" ||
    key === "sceneName" ||
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

type ClosureIndex = {
  sortedAssets: ExportIndexedAsset[];
  byGuid: Map<string, ExportIndexedAsset>;
  byClassName: Map<string, ExportIndexedAsset[]>;
  bySceneName: Map<string, ExportIndexedAsset>;
};

function indexAssets(assets: readonly ExportIndexedAsset[]): ClosureIndex {
  const sortedAssets = [...assets].sort((a, b) => a.guid.localeCompare(b.guid));
  const byGuid = new Map(sortedAssets.map((asset) => [asset.guid, asset]));
  const byClassName = new Map<string, ExportIndexedAsset[]>();
  const bySceneName = new Map<string, ExportIndexedAsset>();
  for (const asset of sortedAssets) {
    if (asset.type === "Class" || asset.type === "Graph") {
      const list = byClassName.get(asset.name) ?? [];
      list.push(asset);
      byClassName.set(asset.name, list);
    }
    if (
      asset.type === "Scene" &&
      asset.name.trim() &&
      !bySceneName.has(asset.name)
    ) {
      bySceneName.set(asset.name, asset);
    }
  }
  return { sortedAssets, byGuid, byClassName, bySceneName };
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

/** Adds the references beyond the header `dependencies` that a closure follows from `asset`. */
type RefExpander = (asset: ExportIndexedAsset, refs: Set<string>) => string | undefined;

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
  const { byGuid, byClassName, bySceneName } = index;
  const roots = rootsFromIndex(input, index);
  const bySceneGuid = new Map<string, Set<string>>();
  const pendingScenes = [...scenes];
  const traversedScenes = new Set<string>();

  while (pendingScenes.length) {
    pendingScenes.sort((a, b) => b.localeCompare(a));
    const sceneRoot = pendingScenes.pop()!;
    if (traversedScenes.has(sceneRoot)) continue;
    traversedScenes.add(sceneRoot);
    const reached = new Set<string>();
    bySceneGuid.set(sceneRoot, reached);
    const pending = [sceneRoot];
    const seen = new Set<string>([sceneRoot]);

    const enqueue = (ref: string): void => {
      const direct = byGuid.get(ref);
      const matches = direct ? [direct] : (byClassName.get(ref) ?? []);
      const sceneByName = bySceneName.get(ref);
      if (sceneByName && !matches.includes(sceneByName))
        matches.push(sceneByName);
      for (const asset of matches) {
        if (!isIncluded(asset, input)) continue;
        if (asset.type === "Scene" && asset.guid !== sceneRoot) {
          if (!traversedScenes.has(asset.guid)) pendingScenes.push(asset.guid);
          continue;
        }
        if (!seen.has(asset.guid)) {
          seen.add(asset.guid);
          pending.push(asset.guid);
        }
      }
    };

    if (sceneRoot === scenes[0]) {
      pending.push(...roots.startupRefs);
      for (const guid of roots.alwaysPackageGuids) enqueue(guid);
    }

    while (pending.length) {
      pending.sort((a, b) => b.localeCompare(a));
      const ref = pending.pop()!;
      const asset = byGuid.get(ref) ?? byClassName.get(ref)?.[0];
      if (!asset || !isIncluded(asset, input)) continue;
      const refs = new Set<string>(asset.dependencies);
      const parentClass = asset.type === "Class" || asset.type === "Graph" ? asset.parentClass?.trim() : "";
      if (parentClass) refs.add(parentClass);
      const failure = expand(asset, refs);
      if (failure) return err(failure);
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
  const { sortedAssets, byGuid, byClassName } = index;
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

  const dataClassReferences = sortedAssets.filter((entry) => entry.type === "Class" || entry.type === "Graph")
    .map((entry) => ({ guid: entry.guid, classId: entry.name }));

  /** Scans the document and payload of an asset for the references its header omits. */
  const expand: RefExpander = (asset, refs) => {
    if (asset.type === "DataObject" || asset.type === "DataSheet") return `Historical ${asset.type === "DataObject" ? "Data Object" : "Data Sheet"} "${asset.name}" is referenced by this game. Replace that reference with a Data Tree entry before exporting.`;
    const collectOverrides = (value: unknown) => {
      const references = actorPropertyReferences(value, classId => {
        const entry = byGuid.get(classId) ?? byClassName.get(classId)?.find(candidate => candidate.type === "Class");
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
    } else if (asset.type === "Class" || asset.type === "Graph") {
      const graph: SerializedGraph | null = input.graphByGuid(asset.guid);
      if (graph) {
        collectTypedRefs(graph, refs);
        collectOverrides({ classId: asset.name, properties: graph.actorDefaults?.properties, graph });
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
    return undefined;
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
