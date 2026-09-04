import {
  err,
  isEditorOnlyAsset,
  ok,
  text2dImageGuidsFromScene,
  type Result,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { MISSING_STARTUP_SCENE_MESSAGE } from "./constants";
import type {
  ExportClosureInput,
  ExportIndexedAsset,
  ExportReachability,
} from "./types";

function pluginGuidFromRoot(rootId: string): string | null {
  return rootId.startsWith("plugin:") ? rootId.slice("plugin:".length) : null;
}

/** Serialized reference fields. Ordinary authored strings must never be scanned. */
function isReferenceField(key: string): boolean {
  return (
    /Guids?$/.test(key) ||
    key === "classId" ||
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
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
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
  input: ExportClosureInput,
): boolean {
  const pluginGuid = pluginGuidFromRoot(asset.rootId);
  if (pluginGuid && !input.pluginEnabledGuids.has(pluginGuid)) return false;
  return !isEditorOnlyAsset(
    { type: asset.type, parentClass: asset.parentClass ?? null },
    input.parentOf,
  );
}

export function collectExportReachability(
  input: ExportClosureInput,
): Result<ExportReachability, string> {
  const startup = input.startupSceneGuid?.trim() ?? "";
  const sortedAssets = [...input.assets].sort((a, b) =>
    a.guid.localeCompare(b.guid),
  );
  const byGuid = new Map(sortedAssets.map((asset) => [asset.guid, asset]));
  const startupAsset = startup ? byGuid.get(startup) : undefined;
  if (!startup || !startupAsset || startupAsset.type !== "Scene") {
    return err(MISSING_STARTUP_SCENE_MESSAGE);
  }

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

  const bySceneGuid = new Map<string, Set<string>>();
  const pendingScenes = [startup];
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
    if (sceneRoot === startup) {
      for (const ref of [input.gameInstanceClass, input.audioMixerGuid]) {
        if (ref?.trim()) pending.push(ref.trim());
      }
    }

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

    while (pending.length) {
      pending.sort((a, b) => b.localeCompare(a));
      const ref = pending.pop()!;
      const asset = byGuid.get(ref) ?? byClassName.get(ref)?.[0];
      if (!asset || !isIncluded(asset, input)) continue;
      reached.add(asset.guid);
      const refs = new Set<string>(asset.dependencies);
      if (asset.type === "Scene") {
        const scene: SerializedScene | null = input.sceneByGuid(asset.guid);
        if (scene) {
          collectTypedRefs(scene, refs);
          for (const guid of text2dImageGuidsFromScene(scene)) refs.add(guid);
        }
      } else if (asset.type === "Class" || asset.type === "Graph") {
        const graph: SerializedGraph | null = input.graphByGuid(asset.guid);
        if (graph) collectTypedRefs(graph, refs);
      }
      const payload = input.payloadByGuid?.(asset.guid);
      if (payload) {
        collectTypedRefs(payload, refs);
        if (typeof payload === "object" && "actors" in payload) {
          for (const guid of text2dImageGuidsFromScene(
            payload as SerializedScene,
          ))
            refs.add(guid);
        }
      }
      for (const next of [...refs].sort()) enqueue(next);
    }
  }

  const guids = [
    ...new Set([...bySceneGuid.values()].flatMap((set) => [...set])),
  ].sort();
  return ok({ guids, bySceneGuid });
}

/** Backwards-compatible flat closure for callers that do not assign packs. */
export function collectExportClosure(
  input: ExportClosureInput,
): Result<string[], string> {
  const result = collectExportReachability(input);
  if ("error" in result) return err(result.error);
  return ok(result.value.guids);
}
