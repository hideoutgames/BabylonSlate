import { PROJECT_FILE } from "@haptic/core";
import { contentRootBlobFolder, FOLDER_MARKER_NAME, readHassetHeader, type AssetRegistry } from "@haptic/assets";
import { lfsObjectId, type ChangeKind, type FileChange, type PullChoice, type PullChoices, type PullConflict } from "@haptic/source-control";

/** What the Source Control tab knows about an indexed asset: its registry entry, read without opening the file. */
export interface ChangedAssetInfo {
  name: string;
  type: string;
  /**
   * Paths of the blobs its chunks are stored in, in its own root's blob
   * folder (`assets/.blobs/<sha256>`, `plugins/<name>/assets/.blobs/<sha256>`):
   * a blob that two roots hold is two files, each loaded by its own root's assets.
   */
  blobPaths: readonly string[];
}

export type ChangeLookup = (path: string) => ChangedAssetInfo | null;

/**
 * An asset's `.hasset`: the only files History follows (**This Asset**) and
 * Revert writes. Project Settings and folder markers are plain files; a
 * reverted `project.json` would reload the whole project.
 */
export function isAssetPath(path: string): boolean {
  return path.endsWith(".hasset");
}

/**
 * The blob folder of the content root a path sits in, by its path alone (the
 * project's `assets/.blobs`, a plugin's or an extension's), or null outside
 * one: for versions and assets the registry does not index.
 */
export function assetBlobFolder(path: string): string | null {
  const root = /^((?:(?:plugins|extensions)\/[^/]+\/)?assets)\//.exec(path);
  return root ? `${root[1]}/.blobs` : null;
}

/** Changed `.hasset` files as the asset registry indexes them: no file is read. */
export function registryChangeLookup(registry: Pick<AssetRegistry, "getByPath" | "getRoot"> | null | undefined): ChangeLookup {
  return (path) => {
    const asset = registry?.getByPath(path);
    if (!registry || !asset) return null;
    const names = asset.header.chunks.flatMap((chunk) => ("blob" in chunk.locator ? [chunk.locator.blob] : []));
    // Only placeholders lack a mounted root, and they have no chunks.
    const root = names.length > 0 ? registry.getRoot(asset.rootId) : undefined;
    const folder = root ? contentRootBlobFolder(root) : null;
    return { name: asset.header.name, type: asset.header.type, blobPaths: folder ? names.map((name) => `${folder}/${name}`) : [] };
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
}

/** Whether two row lists say the same: every row with the same fields, its paths in the same order. */
export function sameChangeRows(a: readonly ChangeRow[], b: readonly ChangeRow[]): boolean {
  if (a === b) return true;
  return a.length === b.length && a.every((row, index) => sameRow(row, b[index]!));
}

function sameRow(a: ChangeRow, b: ChangeRow): boolean {
  const keys = Object.keys(a) as (keyof ChangeRow)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) =>
    key === "paths" ? a.paths.length === b.paths.length && a.paths.every((path, index) => path === b.paths[index]) : a[key] === b[key],
  );
}

/**
 * The Content Browser's change markers by `.hasset` path: each asset added
 * or modified since the last commit. A deleted asset has no tile (the
 * Changes window lists it), so it has none.
 */
export function assetChangeStatuses(rows: readonly ChangeRow[]): ReadonlyMap<string, "added" | "modified"> {
  const statuses = new Map<string, "added" | "modified">();
  for (const row of rows) {
    if (row.kind !== "deleted" && isAssetPath(row.id)) statuses.set(row.id, row.kind);
  }
  return statuses;
}

const ASSET_EXTENSION = /(\.[a-z0-9-]+)?\.hasset$/i;

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

function describe(change: FileChange, asset: ChangedAssetInfo | null): Omit<ChangeRow, "paths"> {
  const { path, kind } = change;
  if (path === PROJECT_FILE) return { id: path, name: "Project Settings", folder: "Project", kind, type: "Project" };
  if (fileName(path) === FOLDER_MARKER_NAME) {
    const folder = path.slice(0, -(FOLDER_MARKER_NAME.length + 1));
    return { id: path, name: fileName(folder), folder: folderLabel(folder), kind, type: "Folder" };
  }
  if (asset) return { id: path, name: asset.name, folder: folderLabel(path), kind, type: asset.type };
  return { id: path, name: fileName(path).replace(ASSET_EXTENSION, ""), folder: folderLabel(path), kind, type: null };
}

/**
 * Status changes as the Changes window lists them: one row per asset, which
 * also commits the changed blobs it references, and one per other file.
 * Blobs are never listed alone, and one no changed asset references is in
 * no row. Rows keep status order (by path).
 */
export function groupChanges(changes: readonly FileChange[], lookup: ChangeLookup): GroupedChanges {
  /** Changed blob files by path: each root holds its own copy of a blob. */
  const blobs = new Map<string, ChangeKind>();
  const others: FileChange[] = [];
  for (const change of changes) {
    if (lfsObjectId(change.path)) blobs.set(change.path, change.kind);
    else others.push(change);
  }
  const claimed = new Set<string>();
  const rows = others.map((change): ChangeRow => {
    const asset = change.path.endsWith(".hasset") ? lookup(change.path) : null;
    const paths = [change.path];
    if (change.kind !== "deleted") {
      for (const path of asset?.blobPaths ?? []) {
        if (!blobs.has(path) || claimed.has(path)) continue;
        // A blob two changed assets share goes with the first; `commitPaths` adds it to the other's commit too.
        claimed.add(path);
        paths.push(path);
      }
    }
    return { ...describe(change, asset), paths };
  });
  return { rows };
}

/**
 * The paths a commit of the chosen rows writes: their own files and every
 * changed blob a chosen asset references (also one another row lists). A
 * `.hasset` is never committed without its blobs, which a teammate would
 * need to load it. A changed blob no chosen asset references stays out (an
 * edit's that a revert abandoned, an undone import's): nothing would load
 * it, and pushing it would only store a dead LFS object. `lookup` should
 * describe the chosen assets by the files committed (`withWorkingHeaders`).
 */
export function commitPaths(grouped: GroupedChanges, chosen: ReadonlySet<string>, lookup: ChangeLookup): string[] {
  // A row's paths after its own file are the changed blobs it claimed.
  const changedBlobs = new Set(grouped.rows.flatMap((row) => row.paths.slice(1)));
  const out = new Set<string>();
  for (const row of grouped.rows) {
    if (!chosen.has(row.id)) continue;
    for (const path of row.paths) out.add(path);
    if (row.kind === "deleted" || !row.id.endsWith(".hasset")) continue;
    for (const path of lookup(row.id)?.blobPaths ?? []) {
      if (changedBlobs.has(path)) out.add(path);
    }
  }
  return [...out].sort();
}

/**
 * `lookup` with each chosen, changed asset described by its own header, read
 * from the working copy (the commit reads those files anyway): the blobs a
 * commit takes are the ones the file it commits references, whatever the
 * registry last indexed, and an asset the registry does not index (a
 * disabled plugin's, an Editor Only extension's) still goes with its blobs.
 * Only those assets are read; with none, `lookup` itself.
 */
export async function withWorkingHeaders(
  lookup: ChangeLookup,
  changes: readonly FileChange[],
  chosen: ReadonlySet<string>,
  read: (path: string) => Promise<Uint8Array>,
): Promise<ChangeLookup> {
  const found = new Map<string, ChangedAssetInfo>();
  for (const { path, kind } of changes) {
    if (kind === "deleted" || !chosen.has(path) || !path.endsWith(".hasset")) continue;
    const bytes = await read(path);
    let header: ReturnType<typeof readHassetHeader>;
    try {
      header = readHassetHeader(bytes);
    } catch {
      // A file that is no readable asset loads no blob; the registry's answer stands.
      continue;
    }
    const folder = assetBlobFolder(path);
    const blobPaths = folder ? header.chunks.flatMap((chunk) => ("blob" in chunk.locator ? [`${folder}/${chunk.locator.blob}`] : [])) : [];
    found.set(path, { name: header.name, type: header.type, blobPaths });
  }
  return found.size === 0 ? lookup : (path) => found.get(path) ?? lookup(path);
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
