/**
 * The Assets panel of Scene and Scene Layer Design mode: which placeable
 * items it lists, how search, filters and sort narrow them, how a pick
 * changes the multi-selection and where several dropped items land.
 */
import {
  rangeSelectTreeIds,
  walkAncestry,
  type TreeSelectOptions,
  type TypeVisual,
} from "@haptic/editor-kit";
import { classIdFromClassAsset, classParentLookup } from "./class-asset-lookup";
import {
  featuredPlaceActors,
  placeActorsForHost,
  visualForPlaceActor,
  type PlaceActorItem,
} from "./place-actors";

/** What an Assets panel entry places: the filter and sort key. */
export type SceneAssetKind = "model" | "actor" | "prefab" | "element" | "layer-actor";

export const SCENE_ASSET_KIND_LABELS: Record<SceneAssetKind, string> = {
  model: "Model",
  actor: "Actor Class",
  prefab: "Prefab",
  element: "2D Element",
  "layer-actor": "Layer Actor Class",
};

/** The Asset Types filter of a host, in menu order. */
export function sceneAssetFilterKinds(
  overlay: boolean,
): ReadonlyArray<{ kind: SceneAssetKind; label: string }> {
  return overlay
    ? [
        { kind: "element", label: "2D Elements" },
        { kind: "layer-actor", label: "Layer Actor Classes" },
        { kind: "model", label: "Models" },
      ]
    : [
        { kind: "model", label: "Models" },
        { kind: "actor", label: "Actor Classes" },
        { kind: "prefab", label: "Prefabs" },
      ];
}

export type SceneAssetItem = {
  id: string;
  /** What `spawnPlacedActor` places. */
  item: PlaceActorItem;
  title: string;
  kind: SceneAssetKind;
  /** Containing folder of the asset file; empty for built-in 2D elements. */
  folder: string;
  /** Display name of the plugin that owns the asset; null for project assets and built-ins. */
  pluginName: string | null;
  guid: string | null;
  path: string | null;
  visual: TypeVisual;
};

type SceneAssetSource = {
  rootId?: string;
  path?: string;
  header: {
    guid: string;
    name: string;
    type?: string;
    parentClass?: string | null;
  };
};

function folderOf(path: string | undefined): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The entries of an Assets panel. A Scene lists Models, Classes deriving from
 * Actor and Prefabs; a Scene Layer lists its built-in 2D elements first, then
 * Classes deriving from SceneLayerActor and Models. `projectItems` is
 * `projectPlaceActors` for the same host; `assets` supplies each asset's
 * content root (project or plugin) and the Class ancestry.
 */
export function sceneAssetItems(options: {
  projectItems: readonly PlaceActorItem[];
  assets: readonly SceneAssetSource[];
  overlay: boolean;
  pluginName: (rootId: string) => string | null;
}): SceneAssetItem[] {
  const { overlay } = options;
  const byGuid = new Map<string, SceneAssetSource>();
  for (const asset of options.assets) {
    if (!byGuid.has(asset.header.guid)) byGuid.set(asset.header.guid, asset);
  }
  const parentOf = classParentLookup(
    options.assets.map((asset) => ({
      path: asset.path,
      header: {
        type: asset.header.type ?? "",
        name: asset.header.name,
        parentClass: asset.header.parentClass,
        guid: asset.header.guid,
      },
    })),
  );
  const elements: SceneAssetItem[] = overlay
    ? featuredPlaceActors(placeActorsForHost({ overlay: true }), { overlay: true }).map((item) => ({
        id: item.id,
        item,
        title: item.title,
        kind: "element",
        folder: "",
        pluginName: null,
        guid: null,
        path: null,
        visual: visualForPlaceActor(item),
      }))
    : [];
  const project: SceneAssetItem[] = [];
  for (const item of options.projectItems) {
    if (item.kind.type !== "asset") continue;
    const { assetType, guid, path } = item.kind;
    let kind: SceneAssetKind | null = null;
    if (assetType === "Model") kind = "model";
    else if (assetType === "Prefab") kind = overlay ? null : "prefab";
    else if (assetType === "Class") {
      const classId = item.kind.classId ?? classIdFromClassAsset({
        path,
        header: { type: "Class", name: item.kind.name },
      });
      const ancestry = walkAncestry(classId, parentOf);
      if (overlay) kind = ancestry.includes("SceneLayerActor") ? "layer-actor" : null;
      else kind = ancestry.includes("Actor") && !ancestry.includes("SceneLayerActor") ? "actor" : null;
    }
    if (!kind) continue;
    const rootId = byGuid.get(guid)?.rootId;
    project.push({
      id: item.id,
      item,
      title: item.title,
      kind,
      folder: folderOf(path),
      pluginName: rootId && rootId.startsWith("plugin:") ? options.pluginName(rootId) : null,
      guid,
      path: path ?? null,
      visual: visualForPlaceActor(item),
    });
  }
  return [...elements, ...project];
}

export type SceneAssetFilter = {
  search: string;
  /** Kinds to keep; empty keeps every kind. */
  kinds: readonly SceneAssetKind[];
  showPluginContent: boolean;
  /** Folder to keep; empty keeps every folder. */
  folder: string;
};

/** Search matches name, type, folder and plugin, like the Place Actors catalog. */
export function filterSceneAssets(
  items: readonly SceneAssetItem[],
  filter: SceneAssetFilter,
): SceneAssetItem[] {
  const needle = filter.search.trim().toLowerCase();
  return items.filter((entry) => {
    if (!filter.showPluginContent && entry.pluginName !== null) return false;
    if (filter.kinds.length > 0 && !filter.kinds.includes(entry.kind)) return false;
    if (filter.folder && entry.folder !== filter.folder) return false;
    if (!needle) return true;
    return [entry.title, SCENE_ASSET_KIND_LABELS[entry.kind], entry.folder, entry.pluginName ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

export type SceneAssetSort = "name" | "type" | "folder";

const byName = (a: SceneAssetItem, b: SceneAssetItem) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

/**
 * One flat list. Built-in 2D elements stay first, in catalog order; the
 * rest follow `sort`, with names breaking ties.
 */
export function sortSceneAssets(
  items: readonly SceneAssetItem[],
  sort: SceneAssetSort,
): SceneAssetItem[] {
  const key = sort === "type"
    ? (entry: SceneAssetItem) => SCENE_ASSET_KIND_LABELS[entry.kind]
    : sort === "folder"
      ? (entry: SceneAssetItem) => entry.folder
      : null;
  const order = new Map(items.map((entry, index) => [entry.id, index]));
  return [...items].sort((a, b) => {
    const aElement = a.kind === "element";
    const bElement = b.kind === "element";
    if (aElement !== bElement) return aElement ? -1 : 1;
    if (aElement) return order.get(a.id)! - order.get(b.id)!;
    return (key ? key(a).localeCompare(key(b)) : 0) || byName(a, b);
  });
}

/** Folders the Folder filter offers, sorted; built-ins have none. */
export function sceneAssetFolders(items: readonly SceneAssetItem[]): string[] {
  return [...new Set(items.map((entry) => entry.folder).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export type SceneAssetSelection = { ids: string[]; anchor: string | null };

/**
 * A pick on `id`: replace, Ctrl/Cmd toggle, or Shift range from the anchor
 * across the visible order, as in the Outliner and Content Browser.
 */
export function selectSceneAsset(
  id: string,
  options: TreeSelectOptions | undefined,
  orderedIds: readonly string[],
  current: SceneAssetSelection,
): SceneAssetSelection {
  if (options?.range) {
    return { ids: rangeSelectTreeIds(orderedIds, current.anchor ?? id, id), anchor: current.anchor ?? id };
  }
  if (options?.additive) {
    const ids = current.ids.includes(id)
      ? current.ids.filter((entry) => entry !== id)
      : [...current.ids, id];
    return { ids, anchor: id };
  }
  return { ids: [id], anchor: id };
}

/** Dragging a selected entry carries the whole selection, in list order; any other entry goes alone. */
export function draggedSceneAssetIds(
  id: string,
  selectedIds: readonly string[],
  orderedIds: readonly string[],
): string[] {
  if (!selectedIds.includes(id)) return [id];
  const selected = new Set(selectedIds);
  return orderedIds.filter((entry) => selected.has(entry));
}

/** World units between neighbours when several entries land at once. */
export const SCENE_ASSET_DROP_SPACING = 2;

/**
 * Where `count` entries land around `center`: a near-square grid, row by
 * row, centred on the point. 3D spreads across the ground plane (X/Z) at
 * the point's height; 2D across the screen plane (X/Y), first row on top.
 */
export function sceneAssetDropPositions(
  center: readonly [number, number, number],
  count: number,
  plane: "xz" | "xy",
  spacing = SCENE_ASSET_DROP_SPACING,
): Array<[number, number, number]> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const positions: Array<[number, number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const across = (column - (columns - 1) / 2) * spacing;
    const down = (row - (rows - 1) / 2) * spacing;
    positions.push(
      plane === "xz"
        ? [center[0] + across, center[1], center[2] + down]
        : [center[0] + across, center[1] - down, center[2]],
    );
  }
  return positions;
}
