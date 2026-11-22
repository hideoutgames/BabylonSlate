import { isStorageNotFound, type DirEntry, type ProjectStorage } from "@haptic/core";
import { blobRequestedSince } from "./blob-store";
import { BLOBS_DIR } from "./hproject";
import { readAssetCatalog } from "./payload-loader";
import { STORAGE_MOVE_BACKUP_PREFIX } from "./storage-move";

/** A blob file's name: the SHA-256 of its bytes. Any other name in a blob folder is never removed. */
const BLOB_NAME = /^[0-9a-f]{64}$/;

/** Files modified less than this long ago are never swept: a write may be about to name them. */
export const BLOB_SWEEP_GRACE_MS = 60_000;

/** Removals between two `canRemove` checks (and yields to the event loop). */
const SWEEP_BATCH = 32;

/** Every blob some asset in the project names, or why that cannot be known. */
export type ReferencedBlobs =
  | { complete: true; blobs: Set<string> }
  | { complete: false; reason: "unreadable"; paths: string[] }
  | { complete: false; reason: "linked" };

/**
 * The blob names every `.hasset` header in the project folder references,
 * read from disk: every content root (project, plugins, extensions, nested
 * folders), files outside any root, and the backups a move or rename keeps
 * beside its file (`STORAGE_MOVE_BACKUP_PREFIX`), which may hold the only
 * copy of an asset. `.git` is left out. Only headers are read, never a
 * payload. A header that cannot be read (half written, damaged, another
 * app's file) makes the set incomplete, and a symbolic link (desktop) at or
 * under a folder may alias a blob folder: callers then remove nothing.
 */
export async function collectReferencedBlobs(storage: ProjectStorage, signal?: AbortSignal): Promise<ReferencedBlobs> {
  const assets: string[] = [];
  const walk = async (dir: string): Promise<boolean> => {
    signal?.throwIfAborted();
    for (const entry of await storage.readdir(dir)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.link) return false;
      if (entry.isDir) {
        if (path === ".git") continue;
        if (!(await walk(path))) return false;
      } else if (entry.name.endsWith(".hasset") || entry.name.startsWith(STORAGE_MOVE_BACKUP_PREFIX)) {
        assets.push(path);
      }
    }
    return true;
  };
  if (!(await walk(""))) return { complete: false, reason: "linked" };
  const blobs = new Set<string>();
  const unreadable: string[] = [];
  for (const path of assets) {
    signal?.throwIfAborted();
    try {
      const { header } = await readAssetCatalog(storage, path, signal ? { signal } : {});
      for (const chunk of header.chunks) if ("blob" in chunk.locator) blobs.add(chunk.locator.blob);
    } catch (error) {
      signal?.throwIfAborted();
      // Gone since the listing: it names nothing.
      if (isStorageNotFound(error)) continue;
      unreadable.push(path);
    }
  }
  return unreadable.length > 0 ? { complete: false, reason: "unreadable", paths: unreadable } : { complete: true, blobs };
}

/** A blob folder file `sweepOrphanedBlobs` would remove. */
export interface SweepCandidate {
  path: string;
  bytes: number;
  kind: "blob" | "staged";
}

export interface BlobSweepOptions {
  /** The blob folder; default the project's `assets/.blobs`. */
  blobDir?: string;
  /** Files modified less than this long ago stay (`BLOB_SWEEP_GRACE_MS`). */
  minAgeMs?: number;
  /** The clock mtimes are compared with. */
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * The files of a blob folder nothing needs: blobs not in `referenced`, and
 * staged write files (`.haptic-<uuid>.tmp`, a killed write or download's;
 * only where storage can list them) — each only when its mtime is known and
 * at least `minAgeMs` old, never one in the future, and never a blob this
 * process asked for within the window. Anything else in the folder (another
 * name, a folder) stays. Reads listings and stats; never a blob.
 */
export async function orphanedBlobCandidates(
  storage: ProjectStorage,
  referenced: ReadonlySet<string>,
  options: BlobSweepOptions = {},
): Promise<SweepCandidate[]> {
  const blobDir = options.blobDir ?? BLOBS_DIR;
  const minAgeMs = options.minAgeMs ?? BLOB_SWEEP_GRACE_MS;
  const now = (options.now ?? Date.now)();
  const since = now - minAgeMs;
  let listed: DirEntry[];
  let staged: DirEntry[];
  try {
    listed = await storage.readdir(blobDir);
    staged = (await storage.listStagedWrites?.(blobDir)) ?? [];
  } catch (error) {
    if (isStorageNotFound(error)) return [];
    throw error;
  }
  const candidates: SweepCandidate[] = [];
  const consider = async (entry: DirEntry, kind: SweepCandidate["kind"]) => {
    if (entry.isDir || entry.link) return;
    if (kind === "blob" && (referenced.has(entry.name) || blobRequestedSince(entry.name, since))) return;
    const path = `${blobDir}/${entry.name}`;
    let mtime = entry.mtime;
    let size = entry.size;
    if (mtime === undefined || size === undefined) {
      options.signal?.throwIfAborted();
      try {
        const stat = await storage.stat(path);
        if (stat.isDir) return;
        mtime = stat.mtime;
        size = stat.size;
      } catch (error) {
        if (isStorageNotFound(error)) return;
        throw error;
      }
    }
    // No mtime: its age cannot be told, so it stays. A future one (clock skew, a copy) is not old.
    if (mtime === null || mtime === undefined || !Number.isFinite(mtime) || mtime > now || now - mtime < minAgeMs) return;
    candidates.push({ path, bytes: size ?? 0, kind });
  };
  for (const entry of listed) if (BLOB_NAME.test(entry.name)) await consider(entry, "blob");
  for (const entry of staged) await consider(entry, "staged");
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

export interface BlobSweepResult {
  removed: string[];
  bytes: number;
  /** A `canRemove` check refused, so files may remain that a later sweep removes. */
  stopped: boolean;
}

/**
 * Removes the blob folder's orphaned files (`orphanedBlobCandidates`) in
 * batches of `SWEEP_BATCH`, yielding to the event loop between them. Each
 * batch goes through `admit`, which runs the given removal through the
 * writer it chooses while holding whatever keeps other writers out, after
 * checking nothing wrote since `referenced` was read; it answers false to
 * stop the sweep (a write happened, the lock could not be taken). Without
 * `admit` the batch is removed through `storage`. A file already gone
 * counts as removed by someone else, not by this sweep.
 *
 * `referenced` must be complete: every blob any asset on disk names
 * (`collectReferencedBlobs`); with less, nothing may be swept.
 */
export async function sweepOrphanedBlobs(
  storage: ProjectStorage,
  referenced: ReadonlySet<string>,
  options: BlobSweepOptions & {
    admit?: (removeBatch: (writer: ProjectStorage) => Promise<void>) => Promise<boolean>;
  } = {},
): Promise<BlobSweepResult> {
  const candidates = await orphanedBlobCandidates(storage, referenced, options);
  const result: BlobSweepResult = { removed: [], bytes: 0, stopped: false };
  const admit = options.admit ?? (async (removeBatch) => {
    await removeBatch(storage);
    return true;
  });
  for (let start = 0; start < candidates.length; start += SWEEP_BATCH) {
    options.signal?.throwIfAborted();
    const batch = candidates.slice(start, start + SWEEP_BATCH);
    const admitted = await admit(async (writer) => {
      for (const { path, bytes } of batch) {
        try {
          await writer.remove(path);
        } catch (error) {
          if (isStorageNotFound(error)) continue;
          throw error;
        }
        result.removed.push(path);
        result.bytes += bytes;
      }
    });
    if (!admitted) {
      result.stopped = true;
      break;
    }
    // Saves, edits and rendering run between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return result;
}
