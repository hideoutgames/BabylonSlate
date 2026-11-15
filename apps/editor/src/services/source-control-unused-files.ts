import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import { readAssetCatalog, STORAGE_MOVE_BACKUP_PREFIX } from "@haptic/assets";
import { throwIfCancelled } from "@haptic/source-control";
import { assetBlobFolder } from "../lib/source-control-changes";
import type { UnusedFiles } from "./source-control-sync";

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** What the asset headers on disk keep, per blob folder: blob paths, or every file of a folder whose assets cannot all be read. */
interface Kept {
  paths: Set<string>;
  wholeFolders: Set<string>;
}

/** The project's files the scan reads: its assets, and whether a symbolic link may alias a blob folder. */
interface ProjectFiles {
  /** Every `.hasset`, and every backup a move or rename keeps beside its file. */
  assets: string[];
  /**
   * A `.blobs` folder is a symbolic link, sits under one or holds one, so one
   * file may show under two folders' paths (Git lists both), and removing it
   * through one takes it from the other, whose own assets may need it.
   */
  aliased: boolean;
}

/**
 * Every `.hasset` in the project folder (`.git` and blob folders left out),
 * from directory listings, with the backups a move or rename keeps beside its
 * file (`STORAGE_MOVE_BACKUP_PREFIX`): one whose restore failed holds the
 * only copy of the original asset. Each blob folder is listed too, for links
 * (`DirEntry.link`: only desktop folders hold them).
 */
async function projectFiles(storage: ProjectStorage, signal: AbortSignal): Promise<ProjectFiles> {
  const found: ProjectFiles = { assets: [], aliased: false };
  const blobFolders: string[] = [];
  const walk = async (dir: string, linked: boolean) => {
    throwIfCancelled(signal);
    for (const entry of await storage.readdir(dir)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDir) {
        if (path === ".git") continue;
        if (entry.name !== ".blobs") await walk(path, linked || entry.link === true);
        else if (linked || entry.link === true) found.aliased = true;
        else blobFolders.push(path);
      } else if (entry.name.endsWith(".hasset") || entry.name.startsWith(STORAGE_MOVE_BACKUP_PREFIX)) {
        found.assets.push(path);
      }
    }
  };
  await walk("", false);
  for (const folder of blobFolders) {
    if (found.aliased) break;
    throwIfCancelled(signal);
    found.aliased = (await storage.readdir(folder)).some((entry) => entry.link === true);
  }
  return found;
}

/**
 * The blobs of `folders` some asset header on disk references. A content
 * root's assets load blobs from its own folder only (`assetBlobFolder`), so
 * only the headers of roots that hold a candidate are read, and only their
 * headers (no chunk). A `.hasset` outside every content root (a plugin's
 * settings) keeps its blobs in each folder. An asset whose header cannot be
 * read (half written, or by another app) keeps its whole folder. Null while a
 * symbolic link may alias a blob folder: every file is kept then.
 */
async function keptBy(storage: ProjectStorage, folders: ReadonlySet<string>, signal: AbortSignal): Promise<Kept | null> {
  const kept: Kept = { paths: new Set(), wholeFolders: new Set() };
  const files = await projectFiles(storage, signal);
  if (files.aliased) return null;
  for (const path of files.assets) {
    const folder = assetBlobFolder(path);
    if (folder !== null && !folders.has(folder)) continue;
    const owners = folder === null ? [...folders] : [folder];
    throwIfCancelled(signal);
    let names: string[];
    try {
      const { header } = await readAssetCatalog(storage, path, { signal });
      names = header.chunks.flatMap((chunk) => ("blob" in chunk.locator ? [chunk.locator.blob] : []));
    } catch (error) {
      throwIfCancelled(signal);
      // Gone since the listing: it references nothing.
      if (isStorageNotFound(error)) continue;
      for (const owner of owners) kept.wholeFolders.add(owner);
      continue;
    }
    for (const owner of owners) for (const name of names) kept.paths.add(`${owner}/${name}`);
  }
  return kept;
}

/**
 * Of `candidates` (untracked `.blobs` files no unpushed commit holds), those
 * nothing needs: in a content root's own blob folder (any other `.blobs`
 * file is left alone) and referenced by no asset header on disk, with their
 * total size; none while a symbolic link may alias a blob folder. Reads
 * listings, the needed headers and stats; never a blob.
 */
export async function unusedLfsObjects(storage: ProjectStorage, candidates: readonly string[], signal: AbortSignal): Promise<UnusedFiles> {
  const inRoots = candidates.filter((path) => assetBlobFolder(path) === parentOf(path));
  if (inRoots.length === 0) return { paths: [], bytes: 0 };
  const kept = await keptBy(storage, new Set(inRoots.map(parentOf)), signal);
  if (!kept) return { paths: [], bytes: 0 };
  const paths: string[] = [];
  let bytes = 0;
  for (const path of inRoots) {
    if (kept.paths.has(path) || kept.wholeFolders.has(parentOf(path))) continue;
    throwIfCancelled(signal);
    try {
      bytes += (await storage.stat(path)).size ?? 0;
    } catch (error) {
      if (isStorageNotFound(error)) continue;
      throw error;
    }
    paths.push(path);
  }
  return { paths: paths.sort(), bytes };
}

/**
 * Removes those of `candidates` nothing needs now, judged as
 * `unusedLfsObjects` does from `storage`, through `writer` (the project's
 * only writer, so no asset is written meanwhile). Stops at a cancel.
 */
export async function removeUnusedLfsObjects(
  storage: ProjectStorage,
  writer: ProjectStorage,
  candidates: readonly string[],
  signal: AbortSignal,
): Promise<UnusedFiles> {
  const unused = await unusedLfsObjects(storage, candidates, signal);
  for (const path of unused.paths) {
    throwIfCancelled(signal);
    await writer.remove(path);
  }
  return unused;
}
