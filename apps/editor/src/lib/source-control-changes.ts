import { PROJECT_FILE } from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import type { ChangeKind, FileChange, PullChoice, PullChoices, PullConflict } from "@haptic/source-control";

/** What the Source Control tab knows about an indexed asset: its registry entry, read without opening the file. */
export interface ChangedAssetInfo {
  name: string;
  type: string;
  /** SHA-256 names of the blobs its chunks are stored in. */
  blobs: readonly string[];
}

export type ChangeLookup = (path: string) => ChangedAssetInfo | null;

/** Changed `.hasset` files as the asset registry indexes them: no file is read. */
export function registryChangeLookup(registry: { getByPath(path: string): IndexedAsset | undefined } | null | undefined): ChangeLookup {
  return (path) => {
    const asset = registry?.getByPath(path);
    if (!asset) return null;
    const blobs = asset.header.chunks.flatMap((chunk) => ("blob" in chunk.locator ? [chunk.locator.blob] : []));
    return { name: asset.header.name, type: asset.header.type, blobs };
  };
}

/** One row of the Changes window: an asset (its `.hasset` and the blobs it references) or another project file. */
export interface ChangeRow {
  /** The row's own file: the `.hasset`, or the file itself. */
  id: string;
  name: string;
  /** The folder it sits in, as the Content Browser names it ("Assets" for the root, "Project" outside assets). */
  folder: string;
  kind: ChangeKind;
  /** The asset's registry type, for its type icon; `Folder` for a folder marker; null for other files. */
  type: string | null;
  /** Every changed path the row commits, its own first. */
  paths: readonly string[];
}

export interface GroupedChanges {
  rows: readonly ChangeRow[];
  /**
   * Added or changed blobs no listed asset references. Blobs are named by
   * their content and never rewritten, so they go with any commit; a deleted
   * one is never committed by itself, as an unchanged asset may still use it.
   */
  loose: readonly string[];
}

const BLOB_PATH = /(?:^|\/)\.blobs\/([0-9a-f]{64})$/;
const FOLDER_MARKER = ".haptic-folder";
const ASSET_EXTENSION = /(\.[a-z0-9-]+)?\.hasset$/i;

function blobName(path: string): string | null {
  return BLOB_PATH.exec(path)?.[1] ?? null;
}

/** `assets/Levels/Forest.scene.hasset` → `Levels`; a root asset → `Assets`; anything outside assets → `Project`. */
function folderLabel(path: string): string {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent === "assets") return "Assets";
  if (parent.startsWith("assets/")) return parent.slice("assets/".length);
  return parent === "" ? "Project" : parent;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function describe(change: FileChange, lookup: ChangeLookup): Omit<ChangeRow, "paths"> {
  const { path, kind } = change;
  if (path === PROJECT_FILE) return { id: path, name: "Project Settings", folder: "Project", kind, type: "Project" };
  if (fileName(path) === FOLDER_MARKER) {
    const folder = path.slice(0, -(FOLDER_MARKER.length + 1));
    return { id: path, name: fileName(folder), folder: folderLabel(folder), kind, type: "Folder" };
  }
  const asset = path.endsWith(".hasset") ? lookup(path) : null;
  if (asset) return { id: path, name: asset.name, folder: folderLabel(path), kind, type: asset.type };
  return { id: path, name: fileName(path).replace(ASSET_EXTENSION, ""), folder: folderLabel(path), kind, type: null };
}

/**
 * Status changes as the Changes window lists them: one row per asset, which
 * also commits the changed blobs it references, and one per other file.
 * Blobs are never listed alone. Rows keep status order (by path).
 */
export function groupChanges(changes: readonly FileChange[], lookup: ChangeLookup): GroupedChanges {
  const blobs = new Map<string, FileChange>();
  const others: FileChange[] = [];
  for (const change of changes) {
    const name = blobName(change.path);
    if (name) blobs.set(name, change);
    else others.push(change);
  }
  const claimed = new Set<string>();
  const rows = others.map((change): ChangeRow => {
    const row = describe(change, lookup);
    const own = change.path.endsWith(".hasset") && change.kind !== "deleted" ? lookup(change.path) : null;
    const paths = [change.path];
    for (const name of own?.blobs ?? []) {
      const blob = blobs.get(name);
      if (!blob || claimed.has(blob.path)) continue;
      // A blob two changed assets share goes with the first; `commitPaths` adds it to the other's commit too.
      claimed.add(blob.path);
      paths.push(blob.path);
    }
    return { ...row, paths };
  });
  const loose = [...blobs.values()]
    .filter((change) => !claimed.has(change.path) && change.kind !== "deleted")
    .map((change) => change.path);
  return { rows, loose };
}

/**
 * The paths a commit of the chosen rows writes: their own files, every
 * changed blob a chosen asset references (also one another row lists), and
 * the loose blobs. A `.hasset` is never committed without its blobs, which a
 * teammate would need to load it.
 */
export function commitPaths(grouped: GroupedChanges, chosen: ReadonlySet<string>, lookup: ChangeLookup): string[] {
  const changedBlobs = new Map<string, string>();
  for (const row of grouped.rows) {
    for (const path of row.paths.slice(1)) {
      const name = blobName(path);
      if (name) changedBlobs.set(name, path);
    }
  }
  const out = new Set<string>(grouped.loose);
  for (const row of grouped.rows) {
    if (!chosen.has(row.id)) continue;
    for (const path of row.paths) out.add(path);
    if (row.kind === "deleted" || !row.id.endsWith(".hasset")) continue;
    for (const name of lookup(row.id)?.blobs ?? []) {
      const path = changedBlobs.get(name);
      if (path) out.add(path);
    }
  }
  return [...out].sort();
}

/** One Pull Conflicts row: an asset with the files of it changed on both sides, or another file. */
export interface ConflictRow {
  id: string;
  name: string;
  folder: string;
  type: string | null;
  mine: ChangeKind;
  theirs: ChangeKind;
  paths: readonly string[];
}

/** Conflicting paths grouped by asset, as the Pull Conflicts dialog lists them. */
export function groupConflicts(conflicts: readonly PullConflict[], lookup: ChangeLookup): ConflictRow[] {
  const grouped = groupChanges(conflicts.map((conflict) => ({ path: conflict.path, kind: conflict.mine })), lookup);
  const byPath = new Map(conflicts.map((conflict) => [conflict.path, conflict]));
  const rows = grouped.rows.map((row): ConflictRow => {
    const conflict = byPath.get(row.id)!;
    return { id: row.id, name: row.name, folder: row.folder, type: row.type, mine: conflict.mine, theirs: conflict.theirs, paths: row.paths };
  });
  // A conflicting blob no conflicting asset claims still needs a choice: list it on its own.
  const claimed = new Set(rows.flatMap((row) => row.paths));
  for (const conflict of conflicts) {
    if (claimed.has(conflict.path)) continue;
    rows.push({ id: conflict.path, name: fileName(conflict.path), folder: folderLabel(conflict.path), type: null, mine: conflict.mine, theirs: conflict.theirs, paths: [conflict.path] });
  }
  return rows;
}

/** Each row's choice for every path it covers. */
export function conflictChoices(rows: readonly ConflictRow[], chosen: ReadonlyMap<string, PullChoice>): PullChoices {
  const out: Record<string, PullChoice> = {};
  for (const row of rows) {
    const choice = chosen.get(row.id);
    if (!choice) continue;
    for (const path of row.paths) out[path] = choice;
  }
  return out;
}
