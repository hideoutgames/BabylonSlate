import type { SearchEntry, SearchEntryKind, SearchOpenTarget } from "@babylonslate/assets";
import {
  engineParentOf,
  resolveActorTypeVisual,
  resolveTypeVisual,
  walkAncestry,
  type TypeVisual,
} from "@babylonslate/editor-kit";

export const SEARCH_RESULT_GROUPS: Array<{ kind: SearchEntryKind; label: string }> = [
  { kind: "asset", label: "Assets" },
  { kind: "actor", label: "Actors" },
  { kind: "component", label: "Components" },
  { kind: "graph-node", label: "Graph Nodes" },
  { kind: "class", label: "Classes" },
  { kind: "variable", label: "Variables" },
];

export type SearchDocumentOpen =
  | { kind: "scene"; path: string }
  | { kind: "graph"; path: string }
  | { kind: "content-browser"; path: string };

export function documentOpenForTarget(target: SearchOpenTarget): SearchDocumentOpen {
  switch (target.kind) {
    case "asset":
      if (target.assetType === "Scene") {
        return { kind: "scene", path: target.path };
      }
      if (target.assetType === "Graph") {
        return { kind: "graph", path: target.path };
      }
      return { kind: "content-browser", path: target.path };
    case "scene-actor":
    case "scene-component":
      return { kind: "scene", path: target.scenePath };
    case "graph-node":
    case "variable":
      return { kind: "graph", path: target.graphPath };
    case "class":
      return { kind: "content-browser", path: target.path ?? "" };
  }
}

export function revealAssetFromTarget(
  target: SearchOpenTarget,
): { guid: string; path: string } | null {
  if (target.kind === "asset" && target.assetType !== "Scene" && target.assetType !== "Graph") {
    return { guid: target.guid, path: target.path };
  }
  if (target.kind === "class" && target.guid && target.path) {
    return { guid: target.guid, path: target.path };
  }
  return null;
}

export function groupSearchEntries(
  entries: SearchEntry[],
): Array<{ kind: SearchEntryKind; label: string; entries: SearchEntry[] }> {
  return SEARCH_RESULT_GROUPS.map((group) => ({
    ...group,
    entries: entries.filter((entry) => entry.kind === group.kind),
  })).filter((group) => group.entries.length > 0);
}

export function graphFocusNodeId(target: SearchOpenTarget): string | null {
  if (target.kind === "graph-node" || target.kind === "variable") {
    return target.nodeId;
  }
  return null;
}

export function sceneFocusActorId(target: SearchOpenTarget): string | null {
  if (target.kind === "scene-actor" || target.kind === "scene-component") {
    return target.actorId;
  }
  return null;
}

export function visualForSearchEntry(entry: SearchEntry): TypeVisual {
  const { target } = entry;
  if (target.kind === "asset") {
    return resolveTypeVisual({ assetType: target.assetType });
  }
  if (target.kind === "class") {
    const parent = entry.description?.startsWith("extends ")
      ? entry.description.slice("extends ".length)
      : null;
    return resolveTypeVisual({
      assetType: "Class",
      classId: target.classId,
      parentClass: parent,
      ancestry: parent
        ? walkAncestry(parent, (id) => engineParentOf(id) ?? null)
        : undefined,
    });
  }
  if (entry.kind === "actor") {
    const classId = entry.description?.split(" · ")[0];
    return resolveActorTypeVisual({ classId });
  }
  if (entry.kind === "component") {
    return resolveTypeVisual({ classId: entry.label });
  }
  if (entry.kind === "graph-node" || entry.kind === "variable") {
    return resolveTypeVisual({ assetType: "Graph" });
  }
  return resolveTypeVisual({});
}
