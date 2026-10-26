/**
 * Content paths and folder-tree shape for the Content Browser: the assets
 * root, parent and joined folder paths, folder guid collection, and the
 * flattened folder and asset rows the tree views render.
 * `content-browser-helpers.ts` re-exports the public names.
 */
import type { IndexedAsset } from "@haptic/assets";

export const ASSETS_ROOT = "assets";

export function isFolderTreeRoot(
  path: string,
  rootPath: string | readonly string[] = ASSETS_ROOT,
): boolean {
  if (typeof rootPath === "string") return path === rootPath;
  return rootPath.includes(path);
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
      label: asset.header.name,
      depth: depth + 1,
      hasChildren: false,
      expanded: true,
      path: asset.path,
      guid: asset.header.guid,
    });
  }
  return rows;
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

export function joinAssetFolderPath(folderPath: string, fileName: string): string {
  const folder = folderPath.replace(/\/+$/, "");
  return folder ? `${folder}/${fileName}` : fileName;
}
