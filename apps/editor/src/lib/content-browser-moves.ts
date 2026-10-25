/**
 * Content Browser move, copy and tree-drop rules: valid destinations, content
 * root and name collision checks, Move dialog labels, and the moves a
 * selection or a tree drop makes.
 * `content-browser-helpers.ts` re-exports the public names.
 */
import type { TreeDropPlacement } from "@haptic/editor-kit";
import {
  ASSETS_ROOT,
  isFolderTreeRoot,
  joinAssetFolderPath,
  parentFolderPath,
  type ContentBrowserTreeRow,
  type MoveKind,
} from "./content-browser-tree";

export function isValidMoveDestination(options: {
  kind: MoveKind;
  sourcePath: string;
  destinationPath: string;
  operation?: "move" | "copy";
}): boolean {
  const { kind, sourcePath, destinationPath, operation = "move" } = options;
  if (kind === "asset") {
    return operation === "copy" || destinationPath !== sourcePath;
  }
  if (destinationPath === sourcePath) return false;
  if (destinationPath.startsWith(`${sourcePath}/`)) return false;
  if (operation === "copy") return true;
  return destinationPath !== parentFolderPath(sourcePath);
}

/**
 * What Move… / Copy to Folder… does with a selection at `destinationPath`,
 * under the tree drop's rules: a Move may change content root when neither
 * root is read-only, a Copy stays in its own root, and items that cannot go
 * stay where they are, as do items already in the destination (Move). A
 * folder never goes into itself or a descendant, and a Move never lands on an
 * existing or already-claimed name, so it cannot fail after moving part of
 * the selection. `error` says why the destination cannot be used.
 */
export function contentBrowserSelectionMoves(options: {
  destinationPath: string;
  operation?: "move" | "copy";
  assetPaths: readonly string[];
  folderPaths: readonly string[];
  rootPaths?: readonly string[];
  /** Root prefixes of read-only content (engine plugins). */
  readOnlyRootPaths?: readonly string[];
  /** Asset and folder paths that already exist, for the Move name check. */
  existingPaths?: ReadonlySet<string>;
}): { moves: ContentBrowserDropMove[]; error: string | null } {
  const { destinationPath: destination, operation = "move" } = options;
  const rootPaths = options.rootPaths ?? [ASSETS_ROOT];
  const readOnly = options.readOnlyRootPaths ?? [];
  const verb = operation === "copy" ? "copied" : "moved";
  if (options.folderPaths.some((path) => isFolderMoveCycle(path, destination))) {
    return { moves: [], error: `A folder cannot be ${verb} inside itself.` };
  }
  const destRoot = contentRootOfPath(destination, rootPaths);
  if (readOnly.includes(destRoot)) {
    return { moves: [], error: `Items cannot be ${verb} into read-only content.` };
  }
  const rootOf = (path: string) => contentRootOfPath(path, rootPaths);
  const canGo = (path: string) => operation === "copy"
    ? rootOf(path) === destRoot
    : canMoveBetweenRoots(rootOf(path), destRoot, readOnly);
  const folders = options.folderPaths.filter(canGo);
  const assets = options.assetPaths.filter(canGo);
  if (folders.length + assets.length === 0) {
    return {
      moves: [],
      error: operation === "copy"
        ? "Items in another content root cannot be copied here."
        : "Read-only content cannot be moved.",
    };
  }
  const changesFolder = (from: string) => operation === "copy" || from !== destination;
  const moves: ContentBrowserDropMove[] = [
    ...folders
      .filter((path) => changesFolder(parentFolderPath(path, rootOf(path))))
      .map((path) => ({ kind: "folder" as const, sourcePath: path, destinationPath: destination, id: path })),
    ...assets.flatMap((path) => {
      const from = parentFolderPath(path, rootOf(path));
      return changesFolder(from)
        ? [{ kind: "asset" as const, sourcePath: from, destinationPath: destination, id: path }]
        : [];
    }),
  ];
  if (moves.length === 0) {
    return { moves, error: "The selected items are already in this folder." };
  }
  const collision = operation === "move" ? moveNameCollision(moves, options.existingPaths) : null;
  return collision ? { moves: [], error: collision } : { moves, error: null };
}

/**
 * Why these moves would land on an existing file or folder name in their
 * destination, or on a name another of them claims; null when none does.
 */
export function moveNameCollision(
  moves: readonly ContentBrowserDropMove[],
  existingPaths: ReadonlySet<string> = new Set(),
): string | null {
  const claimed = new Set<string>();
  for (const move of moves) {
    const name = move.id.slice(move.id.lastIndexOf("/") + 1);
    const target = joinAssetFolderPath(move.destinationPath, name);
    if (existingPaths.has(target) || claimed.has(target)) {
      return `"${name}" already exists in ${move.destinationPath}.`;
    }
    claimed.add(target);
  }
  return null;
}

export function contentBrowserMoveDialogTitle(options: {
  operation: "move" | "copy";
  itemCount: number;
  folderCount?: number;
  assetCount?: number;
}): string {
  const verb = options.operation === "copy" ? "Copy" : "Move";
  if (options.itemCount !== 1) return `${verb} ${options.itemCount} items`;
  if ((options.folderCount ?? 0) === 1) return `${verb} Folder`;
  return `${verb} Asset`;
}

export function contentBrowserMovePreviewName(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.length} items`;
}

export function guidsOutsideSelectedFolders(
  guids: readonly string[],
  folderPaths: readonly string[],
  resolvePath: (guid: string) => string | undefined,
): string[] {
  return guids.filter((guid) => {
    const path = resolvePath(guid);
    if (!path) return true;
    const folder = parentFolderPath(path);
    return !folderPaths.some(
      (selected) => folder === selected || folder.startsWith(`${selected}/`),
    );
  });
}

export function rootSelectedFolderPaths(
  folderPaths: readonly string[],
): string[] {
  return folderPaths.filter(
    (path) =>
      !folderPaths.some(
        (other) => other !== path && path.startsWith(`${other}/`),
      ),
  );
}

export function remapPathAfterFolderMove(
  path: string,
  fromFolder: string,
  toFolder: string,
): string {
  if (path === fromFolder || path.startsWith(`${fromFolder}/`)) {
    return `${toFolder}${path.slice(fromFolder.length)}`;
  }
  return path;
}

export interface ContentBrowserDropMove {
  kind: MoveKind;
  sourcePath: string;
  destinationPath: string;
  id: string;
  guid?: string;
}

function contentRootOfPath(
  path: string,
  rootPaths: readonly string[],
): string {
  return (
    rootPaths.find(
      (root) => path === root || path.startsWith(`${root}/`),
    ) ?? ASSETS_ROOT
  );
}

function isFolderMoveCycle(
  sourcePath: string,
  destinationPath: string,
): boolean {
  return (
    destinationPath === sourcePath ||
    destinationPath.startsWith(`${sourcePath}/`)
  );
}

/** A move stays in its root, or changes root when neither side is read-only. */
function canMoveBetweenRoots(
  sourceRoot: string,
  destRoot: string,
  readOnlyRootPaths: readonly string[],
): boolean {
  return sourceRoot === destRoot ||
    (!readOnlyRootPaths.includes(sourceRoot) && !readOnlyRootPaths.includes(destRoot));
}

/** Whether `path` lies in a different content root than `destinationPath`. */
export function isCrossRootMove(
  path: string,
  destinationPath: string,
  rootPaths: readonly string[],
): boolean {
  return contentRootOfPath(path, rootPaths) !== contentRootOfPath(destinationPath, rootPaths);
}

function contentBrowserDropDestination(
  dragId: string,
  targetId: string | null,
  rows: ReadonlyArray<ContentBrowserTreeRow>,
  rootPaths: readonly string[],
  placement: TreeDropPlacement = "into",
  readOnlyRootPaths: readonly string[] = [],
): { destinationPath: string; destRoot: string; sourceRoot: string } | null {
  const source = rows.find((row) => row.id === dragId);
  if (!source) return null;
  if (source.kind === "folder" && isFolderTreeRoot(source.path, rootPaths)) {
    return null;
  }
  const sourceRoot = contentRootOfPath(source.path, rootPaths);
  let destinationPath = sourceRoot;
  if (targetId !== null) {
    const target = rows.find((row) => row.id === targetId);
    if (!target) return null;
    const targetRoot = contentRootOfPath(target.path, rootPaths);
    // Beside a root row is still that root: a root has no parent folder.
    const around = (placement === "before" || placement === "after") &&
      !isFolderTreeRoot(target.path, rootPaths);
    destinationPath =
      target.kind === "folder"
        ? around
          ? parentFolderPath(target.path, targetRoot)
          : target.path
        : parentFolderPath(target.path, targetRoot);
  }
  const destRoot = contentRootOfPath(destinationPath, rootPaths);
  if (!canMoveBetweenRoots(sourceRoot, destRoot, readOnlyRootPaths)) return null;
  return { destinationPath, destRoot, sourceRoot };
}

function contentBrowserDropMoveForRow(
  row: ContentBrowserTreeRow,
  destinationPath: string,
  sourceRoot: string,
): ContentBrowserDropMove {
  const sourcePath =
    row.kind === "asset"
      ? parentFolderPath(row.path, sourceRoot)
      : row.path;
  return {
    kind: row.kind,
    sourcePath,
    destinationPath,
    id: row.id,
    ...(row.guid ? { guid: row.guid } : {}),
  };
}

function treeRowInSelection(
  row: ContentBrowserTreeRow,
  selectedGuids: ReadonlySet<string>,
  selectedFolderPaths: ReadonlySet<string>,
): boolean {
  if (row.kind === "folder") return selectedFolderPaths.has(row.path);
  return Boolean(row.guid && selectedGuids.has(row.guid));
}

export function contentBrowserMoveFromDrop(
  dragId: string,
  targetId: string | null,
  rows: ReadonlyArray<ContentBrowserTreeRow>,
  rootPaths: readonly string[] = [ASSETS_ROOT],
  placement: TreeDropPlacement = "into",
  readOnlyRootPaths: readonly string[] = [],
): ContentBrowserDropMove | null {
  const source = rows.find((row) => row.id === dragId);
  const dest = contentBrowserDropDestination(
    dragId,
    targetId,
    rows,
    rootPaths,
    placement,
    readOnlyRootPaths,
  );
  if (!source || !dest) return null;
  const move = contentBrowserDropMoveForRow(
    source,
    dest.destinationPath,
    dest.sourceRoot,
  );
  if (
    !isValidMoveDestination({
      kind: move.kind,
      sourcePath: move.sourcePath,
      destinationPath: move.destinationPath,
    })
  ) {
    return null;
  }
  return move;
}

export function contentBrowserTreeDropMoves(options: {
  dragId: string;
  targetId: string | null;
  rows: ReadonlyArray<ContentBrowserTreeRow>;
  selectedGuids: ReadonlySet<string>;
  selectedFolderPaths: ReadonlySet<string>;
  rootPaths?: readonly string[];
  /** Root prefixes of read-only content; nothing moves into or out of them. */
  readOnlyRootPaths?: readonly string[];
  resolvePath?: (guid: string) => string | undefined;
  placement?: TreeDropPlacement;
}): ContentBrowserDropMove[] {
  const {
    dragId,
    targetId,
    rows,
    selectedGuids,
    selectedFolderPaths,
    rootPaths = [ASSETS_ROOT],
    readOnlyRootPaths = [],
    placement = "into",
  } = options;
  const source = rows.find((row) => row.id === dragId);
  const dest = contentBrowserDropDestination(
    dragId,
    targetId,
    rows,
    rootPaths,
    placement,
    readOnlyRootPaths,
  );
  if (!source || !dest) return [];
  if (!treeRowInSelection(source, selectedGuids, selectedFolderPaths)) {
    const move = contentBrowserMoveFromDrop(
      dragId,
      targetId,
      rows,
      rootPaths,
      placement,
      readOnlyRootPaths,
    );
    return move ? [move] : [];
  }
  const pathOf = (guid: string) =>
    options.resolvePath?.(guid) ??
    rows.find((row) => row.guid === guid)?.path;
  let folders = rootSelectedFolderPaths(
    [...selectedFolderPaths].filter(
      (path) => !isFolderTreeRoot(path, rootPaths),
    ),
  ).filter((path) => path !== dest.destinationPath);
  if (
    folders.some((path) => isFolderMoveCycle(path, dest.destinationPath))
  ) {
    return [];
  }
  const guids = guidsOutsideSelectedFolders(
    [...selectedGuids],
    folders,
    pathOf,
  );
  folders = folders.filter((path) =>
    isValidMoveDestination({
      kind: "folder",
      sourcePath: path,
      destinationPath: dest.destinationPath,
    }),
  );
  const moves: ContentBrowserDropMove[] = [];
  // Selected items that cannot leave their root (or enter the destination's)
  // stay where they are, as items already in the destination do.
  const canGo = (path: string) =>
    canMoveBetweenRoots(contentRootOfPath(path, rootPaths), dest.destRoot, readOnlyRootPaths);
  for (const path of folders) {
    if (!canGo(path)) continue;
    moves.push({
      kind: "folder",
      sourcePath: path,
      destinationPath: dest.destinationPath,
      id: path,
    });
  }
  for (const guid of guids) {
    const path = pathOf(guid);
    if (!path) continue;
    if (!canGo(path)) continue;
    const sourcePath = parentFolderPath(path, contentRootOfPath(path, rootPaths));
    if (
      !isValidMoveDestination({
        kind: "asset",
        sourcePath,
        destinationPath: dest.destinationPath,
      })
    ) {
      continue;
    }
    moves.push({
      kind: "asset",
      sourcePath,
      destinationPath: dest.destinationPath,
      id: path,
      guid,
    });
  }
  return moves;
}
