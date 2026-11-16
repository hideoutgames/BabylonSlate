import { humanizePropertyLabel, type SerializedActor, type SerializedComponent, type SerializedGraph } from "@haptic/core";
import type { GraphDiff } from "./asset-diff-graph";
import { diffGraphDocuments } from "./asset-diff-graph-families";
import {
  countStatus,
  documentGroups,
  emptyCounts,
  formatRotation,
  groupStatus,
  isPlainObject,
  propertyRows,
  sameValue,
  statusOf,
  valueRow,
  type DiffCounts,
  type DiffStatus,
  type PropertyDiffGroup,
  type PropertyDiffRow,
} from "./asset-diff-values";

/** One row of the Actors window: an Outliner folder or an actor, in Outliner order (parents before children). */
export interface SceneDiffRow {
  /** The actor id, or `folder:<id>`. */
  id: string;
  kind: "actor" | "folder";
  name: string;
  /** The actor's class; null for a folder. */
  classId: string | null;
  depth: number;
  /** The row it sits under, or null at the root. */
  parent: string | null;
  status: DiffStatus;
  /** Some row below it is not unchanged. */
  changedBelow: boolean;
  hasChildren: boolean;
}

export interface SceneDiff {
  kind: "scene";
  rows: SceneDiffRow[];
  /** Actors only. */
  counts: DiffCounts;
  /** The property groups of every actor that is not unchanged, by actor id. */
  actors: Record<string, PropertyDiffGroup[]>;
  /** Scene-level fields (name, settings, timeline clips), apart from actors, folders and the script. */
  scene: PropertyDiffGroup[];
  /** The Scene Script's changes, or null when it did not change. */
  script: GraphDiff | null;
}

type Scene = {
  actors?: SerializedActor[];
  folders?: Array<{ id: string; name: string; parentFolderId: string | null }>;
  script?: SerializedGraph;
  [key: string]: unknown;
};

const SCENE_SKIP = new Set(["actors", "folders", "script"]);
const ACTOR_HANDLED = new Set(["id", "name", "classId", "parentId", "transform", "visible", "locked", "components", "properties", "folderId", "prefabGuid", "suppressedComponentSourceIds"]);
const COMPONENT_HANDLED = new Set(["id", "classId", "name", "parentId", "transform", "properties", "sourceId", "overrideKeys", "category"]);

function asScene(value: unknown): Scene {
  return isPlainObject(value) ? (value as Scene) : {};
}

function transformRows(prefix: string, base: SerializedActor["transform"] | undefined, compare: SerializedActor["transform"] | undefined): PropertyDiffRow[] {
  return [
    valueRow(`${prefix}position`, "Location", base?.position, compare?.position),
    valueRow(`${prefix}rotation`, "Rotation", base?.rotation, compare?.rotation, formatRotation),
    valueRow(`${prefix}scale`, "Scale", base?.scale, compare?.scale),
  ];
}

function componentTitle(component: SerializedComponent): string {
  return component.name?.trim() || humanizePropertyLabel(component.classId.replace(/Component$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")) || "Component";
}

function componentGroup(base: SerializedComponent | undefined, compare: SerializedComponent | undefined, presence: DiffStatus, names: (id: string | null | undefined) => string | undefined): PropertyDiffGroup {
  const shown = compare ?? base!;
  const rows: PropertyDiffRow[] = [];
  if (base?.classId !== compare?.classId) rows.push(valueRow("classId", "Class", base?.classId, compare?.classId));
  if (base?.name !== compare?.name) rows.push(valueRow("name", "Name", base?.name, compare?.name));
  if ((base?.parentId ?? null) !== (compare?.parentId ?? null)) {
    rows.push(valueRow("parentId", "Attach Parent", base ? names(base.parentId) ?? "None" : undefined, compare ? names(compare.parentId) ?? "None" : undefined));
  }
  if (base?.transform || compare?.transform) rows.push(...transformRows("transform.", base?.transform, compare?.transform));
  rows.push(...propertyRows(base?.properties, compare?.properties, "properties."));
  rows.push(...propertyRows(base as unknown as Record<string, unknown> | undefined, compare as unknown as Record<string, unknown> | undefined, "", COMPONENT_HANDLED));
  return { id: `component:${shown.id}`, title: componentTitle(shown), status: groupStatus(rows, presence), rows };
}

/** Rows of every component either version has: the compare version's order, then removed ones. */
function componentGroups(base: SerializedActor | undefined, compare: SerializedActor | undefined): PropertyDiffGroup[] {
  const before = new Map((base?.components ?? []).map((component) => [component.id, component]));
  const after = new Map((compare?.components ?? []).map((component) => [component.id, component]));
  const names = (side: Map<string, SerializedComponent>) => (id: string | null | undefined) => (id ? (side.get(id) ? componentTitle(side.get(id)!) : id) : undefined);
  const ids = [...new Set([...after.keys(), ...before.keys()])];
  return ids.map((id) => {
    const from = before.get(id);
    const to = after.get(id);
    const presence = statusOf(from, to);
    return componentGroup(from, to, presence, (ref) => names(to ? after : before)(ref));
  });
}

function actorGroups(base: SerializedActor | undefined, compare: SerializedActor | undefined, actorName: (id: string | null) => string | null, folderName: (id: string | null) => string | null): PropertyDiffGroup[] {
  const presence = statusOf(base, compare);
  const named = (id: string | null | undefined, name: (id: string | null) => string | null) => (id === undefined ? undefined : name(id) ?? "None");
  const actorRows: PropertyDiffRow[] = [
    valueRow("name", "Name", base?.name, compare?.name),
    valueRow("classId", "Class", base?.classId, compare?.classId),
    valueRow("visible", "Visible", base?.visible, compare?.visible),
    valueRow("locked", "Locked", base?.locked, compare?.locked),
    valueRow("parentId", "Attach Parent", named(base?.parentId, actorName), named(compare?.parentId, actorName)),
    valueRow("folderId", "Folder", named(base?.folderId, folderName), named(compare?.folderId, folderName)),
  ];
  if (base?.prefabGuid !== undefined || compare?.prefabGuid !== undefined) actorRows.push(valueRow("prefabGuid", "Prefab", base?.prefabGuid, compare?.prefabGuid));
  actorRows.push(...propertyRows(base?.properties, compare?.properties, "properties."));
  actorRows.push(...propertyRows(base as unknown as Record<string, unknown> | undefined, compare as unknown as Record<string, unknown> | undefined, "", ACTOR_HANDLED));
  const transform = transformRows("transform.", base?.transform, compare?.transform);
  return [
    { id: "actor", title: "Actor", status: groupStatus(actorRows, presence), rows: actorRows },
    { id: "transform", title: "Transform", status: groupStatus(transform, presence), rows: transform },
    ...componentGroups(base, compare).map((group) => (presence === "added" || presence === "removed" ? { ...group, status: presence } : group)),
  ];
}

interface TreeEntry {
  id: string;
  kind: "actor" | "folder";
  name: string;
  classId: string | null;
  status: DiffStatus;
  /** Row id it sits under (a folder or an attach parent), before checking it exists. */
  under: string | null;
}

/**
 * Two versions of a Scene (or Scene Layer) document, compared by actor id:
 * the Outliner tree of both (removed actors where the base had them), each
 * actor's status, and property groups only for actors that are not unchanged.
 */
export function diffSceneDocuments(baseValue: unknown, compareValue: unknown): SceneDiff {
  const base = asScene(baseValue);
  const compare = asScene(compareValue);
  const baseActors = new Map((base.actors ?? []).map((actor) => [actor.id, actor]));
  const compareActors = new Map((compare.actors ?? []).map((actor) => [actor.id, actor]));
  const baseFolders = new Map((base.folders ?? []).map((folder) => [folder.id, folder]));
  const compareFolders = new Map((compare.folders ?? []).map((folder) => [folder.id, folder]));

  const entries = new Map<string, TreeEntry>();
  for (const id of [...new Set([...compareFolders.keys(), ...baseFolders.keys()])]) {
    const before = baseFolders.get(id);
    const after = compareFolders.get(id);
    const shown = after ?? before!;
    entries.set(`folder:${id}`, {
      id: `folder:${id}`,
      kind: "folder",
      name: shown.name,
      classId: null,
      status: statusOf(before, after),
      under: shown.parentFolderId ? `folder:${shown.parentFolderId}` : null,
    });
  }
  const counts = emptyCounts();
  const actors: Record<string, PropertyDiffGroup[]> = {};
  const actorName = (id: string | null) => (id ? (compareActors.get(id) ?? baseActors.get(id))?.name ?? id : null);
  const folderName = (id: string | null) => (id ? (compareFolders.get(id) ?? baseFolders.get(id))?.name ?? id : null);
  for (const id of [...new Set([...compareActors.keys(), ...baseActors.keys()])]) {
    const before = baseActors.get(id);
    const after = compareActors.get(id);
    const shown = after ?? before!;
    const status = statusOf(before, after);
    countStatus(counts, status);
    if (status !== "unchanged") actors[id] = actorGroups(before, after, actorName, folderName);
    entries.set(id, {
      id,
      kind: "actor",
      name: shown.name,
      classId: shown.classId,
      status,
      under: shown.parentId ? shown.parentId : shown.folderId ? `folder:${shown.folderId}` : null,
    });
  }

  // Children in insertion order: folders, then actors, each the compare version's order then removed ones.
  const children = new Map<string | null, TreeEntry[]>();
  for (const entry of entries.values()) {
    const parent = entry.under && entries.has(entry.under) && entry.under !== entry.id ? entry.under : null;
    entry.under = parent;
    const siblings = children.get(parent);
    if (siblings) siblings.push(entry);
    else children.set(parent, [entry]);
  }
  const rows: SceneDiffRow[] = [];
  const placed = new Set<string>();
  const visit = (entry: TreeEntry, depth: number, parent: string | null): boolean => {
    if (placed.has(entry.id)) return false;
    placed.add(entry.id);
    const row: SceneDiffRow = { id: entry.id, kind: entry.kind, name: entry.name, classId: entry.classId, depth, parent, status: entry.status, changedBelow: false, hasChildren: false };
    rows.push(row);
    let changed = false;
    for (const child of children.get(entry.id) ?? []) {
      row.hasChildren = true;
      if (visit(child, depth + 1, entry.id)) changed = true;
    }
    row.changedBelow = changed;
    return changed || entry.status !== "unchanged";
  };
  for (const entry of children.get(null) ?? []) visit(entry, 0, null);
  // An attach cycle has no root: list what is left at the top.
  for (const entry of entries.values()) if (!placed.has(entry.id)) visit(entry, 0, null);

  const scene = documentGroups(base as Record<string, unknown>, compare as Record<string, unknown>, "Scene", SCENE_SKIP);
  const script = sameValue(base.script, compare.script) ? null : diffGraphDocuments(base.script ?? null, compare.script ?? null);
  return { kind: "scene", rows, counts, actors, scene, script };
}
