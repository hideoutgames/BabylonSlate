/**
 * Content Browser grid and tree selection: exclusive, additive and range
 * selects, paint-select, and the pointer hit-tests behind them.
 * `content-browser-helpers.ts` re-exports the public names.
 */
import { rangeSelectTreeIds } from "@haptic/editor-kit";
import { parentFolderPath, type ContentBrowserTreeRow } from "./content-browser-tree";

export type ContentBrowserPaintHit =
  | { kind: "asset"; guid: string }
  | { kind: "folder"; path: string };

export type ContentBrowserSelection = {
  guids: Set<string>;
  folderPaths: Set<string>;
};

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
