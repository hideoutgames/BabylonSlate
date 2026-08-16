import {
  err,
  isEditorOnlyAsset,
  ok,
  type Result,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { MISSING_STARTUP_SCENE_MESSAGE } from "./constants";
import type { ExportClosureInput, ExportIndexedAsset } from "./types";

function pluginGuidFromRoot(rootId: string): string | null {
  return rootId.startsWith("plugin:") ? rootId.slice("plugin:".length) : null;
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string" && value.length > 0) {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, into);
    }
  }
}

function enqueueRefs(
  value: unknown,
  byGuid: Map<string, ExportIndexedAsset>,
  byClassName: Map<string, ExportIndexedAsset[]>,
  pending: string[],
  seen: Set<string>,
): void {
  const refs = new Set<string>();
  collectStrings(value, refs);
  for (const ref of refs) {
    const asset = byGuid.get(ref);
    if (asset && !seen.has(asset.guid)) {
      seen.add(asset.guid);
      pending.push(asset.guid);
    }
    const named = byClassName.get(ref);
    if (!named) continue;
    for (const entry of named) {
      if (seen.has(entry.guid)) continue;
      seen.add(entry.guid);
      pending.push(entry.guid);
    }
  }
}

function isIncluded(
  asset: ExportIndexedAsset,
  pluginEnabledGuids: ReadonlySet<string>,
  parentOf: (classId: string) => string | null | undefined,
): boolean {
  const pluginGuid = pluginGuidFromRoot(asset.rootId);
  if (pluginGuid && !pluginEnabledGuids.has(pluginGuid)) return false;
  if (
    isEditorOnlyAsset(
      { type: asset.type, parentClass: asset.parentClass ?? null },
      parentOf,
    )
  ) {
    return false;
  }
  return true;
}

export function collectExportClosure(
  input: ExportClosureInput,
): Result<string[], string> {
  const startup = input.startupSceneGuid?.trim() ?? "";
  const byGuid = new Map(input.assets.map((asset) => [asset.guid, asset]));
  const startupAsset = startup ? byGuid.get(startup) : undefined;
  if (!startup || !startupAsset || startupAsset.type !== "Scene") {
    return err(MISSING_STARTUP_SCENE_MESSAGE);
  }

  const byClassName = new Map<string, ExportIndexedAsset[]>();
  for (const asset of input.assets) {
    if (asset.type !== "Class" && asset.type !== "Graph") continue;
    const list = byClassName.get(asset.name) ?? [];
    list.push(asset);
    byClassName.set(asset.name, list);
  }

  const seen = new Set<string>([startup]);
  const pending = [startup];
  const included: string[] = [];

  while (pending.length > 0) {
    const guid = pending.pop()!;
    const asset = byGuid.get(guid);
    if (!asset) continue;
    if (!isIncluded(asset, input.pluginEnabledGuids, input.parentOf)) continue;
    included.push(guid);

    enqueueRefs(
      asset.dependencies,
      byGuid,
      byClassName,
      pending,
      seen,
    );
    if (asset.guid === startup && input.gameInstanceClass) {
      enqueueRefs(
        input.gameInstanceClass,
        byGuid,
        byClassName,
        pending,
        seen,
      );
    }

    if (asset.type === "Scene") {
      const scene: SerializedScene | null = input.sceneByGuid(guid);
      if (scene) {
        enqueueRefs(scene, byGuid, byClassName, pending, seen);
      }
    }

    if (asset.type === "Class" || asset.type === "Graph") {
      const graph: SerializedGraph | null = input.graphByGuid(guid);
      if (graph) {
        enqueueRefs(graph, byGuid, byClassName, pending, seen);
      }
    }

    const payload = input.payloadByGuid?.(guid);
    if (payload) {
      enqueueRefs(payload, byGuid, byClassName, pending, seen);
    }
  }

  return ok([...new Set(included)].sort());
}
