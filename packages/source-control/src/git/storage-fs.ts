import { isStorageNotFound, type FileStat, type ProjectStorage } from "@haptic/core";
import { lfsObjectId, lfsPointerText, parseLfsPointer } from "../lfs-pointer";
import { SyncError, throwIfCancelled } from "../sync-port";

/** The working tree root isomorphic-git is given; its paths map to project storage paths below it. */
export const WORKTREE = "/";
export const GITDIR = "/.git";

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040000;

/** Storage traffic of one operation, for tests and the benchmark. */
export interface StorageFsCounters {
  /** Full reads of working tree files (`.git` excluded). */
  workingReads: number;
  /** `.blobs` files answered with their pointer, from the stat alone. */
  pointerReads: number;
  /** Pointer writes skipped because the object's file was already in place. */
  smudgedPointers: number;
}

export interface StorageStats {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function fsError(code: string, path: string, cause?: unknown): Error {
  return Object.assign(new Error(`${code}: ${path}`, cause === undefined ? undefined : { cause }), { code });
}

/** A storage path: no leading slash, no `.` segments; `..` is refused by storage itself. */
export function storagePath(path: string): string {
  return path.split("/").filter((part) => part !== "" && part !== ".").join("/");
}

function isGitPath(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

/** A working tree `.blobs/<sha256>` file: an LFS object Git stores as a pointer. */
function workingLfsObject(path: string): string | null {
  return isGitPath(path) ? null : lfsObjectId(path);
}

/** Repository state a fetch writes besides objects: the shallow list and refs. */
function isGitMetadata(path: string): boolean {
  return isGitPath(path) && !path.startsWith(".git/objects/");
}

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function statsOf(stat: FileStat): StorageStats {
  const isDir = stat.isDir;
  // A file without an mtime can never match the index, so its content decides.
  const mtimeMs = stat.mtime ?? (isDir ? 0 : Date.now());
  return {
    type: isDir ? "dir" : "file",
    mode: isDir ? DIR_MODE : FILE_MODE,
    size: stat.size ?? 0,
    ino: 0,
    dev: 0,
    uid: 0,
    gid: 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  };
}

/**
 * The `fs` isomorphic-git runs on, over project storage, with Git LFS's clean
 * and smudge filters for `.blobs` files:
 * - stats are storage's size and mtime, so status compares stat data with the
 *   index and reads only files whose stats changed;
 * - reading a `.blobs/<sha256>` file answers its pointer, built from the name
 *   and the stat size, so the object's bytes are never read or Git-hashed;
 * - writing a pointer to a `.blobs` path leaves the object's file in place
 *   (callers download missing objects first), so the index records the real
 *   file's stats against the pointer's id, as git-lfs leaves it;
 * - removing a `.blobs` file keeps it: it may be the object's only copy (a
 *   commit not pushed yet), so a checkout of a tree without it only drops its
 *   index entry and leaves it untracked.
 * A directory listing answers the following stats of its entries, so a status
 * costs one storage call per directory. Use one instance per operation: the
 * listing cache does not see writes made outside it. Once the operation's
 * signal aborts, every write and remove is refused (checkout stops).
 */
export class StorageFs {
  readonly counters: StorageFsCounters = { workingReads: 0, pointerReads: 0, smudgedPointers: 0 };
  /** Bytes of pack files and pack indexes read: what isomorphic-git's cache keeps of them. */
  packBytes = 0;
  private readonly signal: AbortSignal | undefined;
  /** While a fetch runs: its `.git` writes outside `objects/` by path (null removes), written once it resolves. */
  private held: Map<string, Uint8Array | null> | null = null;
  readonly promises: {
    readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<StorageStats>;
    lstat(path: string): Promise<StorageStats>;
    readlink(path: string): Promise<never>;
    symlink(target: string, path: string): Promise<never>;
  };
  private readonly storage: ProjectStorage;
  private readonly listed = new Map<string, FileStat>();

  constructor(storage: ProjectStorage, signal?: AbortSignal) {
    this.storage = storage;
    this.signal = signal;
    // Every method is async, even with a bad argument: isomorphic-git calls `readFile()` bare and
    // treats an fs whose answer is not a promise as callback-style.
    this.promises = {
      readFile: async (path, options) => this.readFile(storagePath(path), options),
      writeFile: async (path, data) => {
        throwIfCancelled(this.signal);
        return this.writeFile(storagePath(path), data);
      },
      unlink: async (path) => {
        throwIfCancelled(this.signal);
        return this.unlink(storagePath(path));
      },
      readdir: async (path) => this.readdir(storagePath(path)),
      mkdir: async (path) => {
        throwIfCancelled(this.signal);
        return this.mkdir(storagePath(path));
      },
      // One parameter: isomorphic-git takes a two-parameter rmdir for a recursive remove.
      rmdir: async (path) => {
        throwIfCancelled(this.signal);
        return this.rmdir(storagePath(path));
      },
      stat: async (path) => this.stat(storagePath(path)),
      lstat: async (path) => this.stat(storagePath(path)),
      readlink: async (path) => {
        throw fsError("ENOTSUP", path);
      },
      symlink: async (_target, path) => {
        throw fsError("ENOTSUP", path);
      },
    };
  }

  /**
   * Runs a fetch with its writes and removes in `.git` outside `objects/`
   * held back until it resolves, then makes them. isomorphic-git writes the
   * shallow list and refs before the pack, so a fetch cancelled or killed in
   * between would leave them naming commits this copy never stored (every
   * later history walk then fails). A fetch that fails makes none of them.
   * One that resolved has stored its pack, so they are made even if the
   * signal aborted meanwhile: the shallow list then matches the objects.
   */
  async objectsFirst<T>(fetch: () => Promise<T>): Promise<T> {
    const held = new Map<string, Uint8Array | null>();
    this.held = held;
    let result: T;
    try {
      result = await fetch();
    } finally {
      this.held = null;
    }
    for (const [path, bytes] of held) {
      this.listed.delete(path);
      if (bytes === null) {
        await this.storage.remove(path).catch((error: unknown) => {
          if (!isStorageNotFound(error)) throw error;
        });
      } else {
        await this.storage.mkdir(parentOf(path), true);
        await this.storage.writeBinary(path, bytes);
      }
    }
    return result;
  }

  async stat(path: string): Promise<StorageStats> {
    const held = this.held?.get(path);
    if (held === null) throw fsError("ENOENT", path);
    if (held) return statsOf({ isDir: false, size: held.byteLength, mtime: Date.now() });
    const listed = this.listed.get(path);
    if (listed) return statsOf(listed);
    try {
      return statsOf(await this.storage.stat(path));
    } catch (error) {
      throw isStorageNotFound(error) ? fsError("ENOENT", path, error) : error;
    }
  }

  private async readFile(path: string, options: unknown): Promise<Uint8Array | string> {
    const encoding = typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
    let bytes: Uint8Array;
    const oid = workingLfsObject(path);
    if (oid) {
      const stats = await this.stat(path);
      if (stats.isDirectory()) throw fsError("EISDIR", path);
      this.counters.pointerReads += 1;
      bytes = new TextEncoder().encode(lfsPointerText(oid, stats.size));
    } else {
      bytes = await this.readBytes(path);
      if (!isGitPath(path)) this.counters.workingReads += 1;
      else if (path.startsWith(".git/objects/pack/")) this.packBytes += bytes.byteLength;
    }
    return encoding === "utf8" ? new TextDecoder().decode(bytes) : bytes;
  }

  private async readBytes(path: string): Promise<Uint8Array> {
    const held = this.held?.get(path);
    if (held === null) throw fsError("ENOENT", path);
    if (held) return held;
    try {
      return await this.storage.readBinary(path);
    } catch (error) {
      if (isStorageNotFound(error)) throw fsError("ENOENT", path, error);
      // Ref lookups probe paths that may be directories (`refs/remotes/origin`).
      if ((await this.stat(path).catch(() => null))?.isDirectory()) throw fsError("EISDIR", path, error);
      throw error;
    }
  }

  private async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const oid = workingLfsObject(path);
    const pointer = oid ? parseLfsPointer(bytes) : null;
    if (oid && pointer) {
      if (pointer.oid !== oid) {
        throw new SyncError("lfs", `${path} holds a pointer to another object.`, { code: "lfs-object-corrupt" });
      }
      const present = await this.stat(path).catch(() => null);
      if (!present || present.isDirectory() || present.size !== pointer.size) {
        throw new SyncError("lfs", `${path} has not been downloaded.`, { code: "lfs-object-missing" });
      }
      this.counters.smudgedPointers += 1;
      return;
    }
    if (this.held && isGitMetadata(path)) {
      this.held.set(path, bytes);
      return;
    }
    this.listed.delete(path);
    await this.storage.writeBinary(path, bytes);
  }

  private async unlink(path: string): Promise<void> {
    if (workingLfsObject(path)) return;
    if (this.held && isGitMetadata(path)) {
      this.held.set(path, null);
      return;
    }
    this.listed.delete(path);
    try {
      await this.storage.remove(path);
    } catch (error) {
      throw isStorageNotFound(error) ? fsError("ENOENT", path, error) : error;
    }
  }

  private async readdir(path: string): Promise<string[]> {
    let entries;
    try {
      entries = await this.storage.readdir(path);
    } catch (error) {
      if (isStorageNotFound(error)) throw fsError("ENOENT", path, error);
      if ((await this.stat(path).catch(() => null))?.isFile()) throw fsError("ENOTDIR", path, error);
      throw error;
    }
    const prefix = path === "" ? "" : `${path}/`;
    for (const entry of entries) {
      // A listing without a file's size or mtime cannot stand in for its stat.
      if (entry.isDir || (entry.size != null && entry.mtime != null)) {
        this.listed.set(`${prefix}${entry.name}`, { isDir: entry.isDir, size: entry.size ?? null, mtime: entry.mtime ?? null });
      }
    }
    return entries.map((entry) => entry.name);
  }

  private async mkdir(path: string): Promise<void> {
    this.listed.delete(path);
    await this.storage.mkdir(path, true);
  }

  /** Removes an empty directory only: checkout prunes directories it emptied, never untracked files. */
  private async rmdir(path: string): Promise<void> {
    if ((await this.readdir(path)).length > 0) throw fsError("ENOTEMPTY", path);
    this.listed.delete(path);
    try {
      await this.storage.remove(path);
    } catch (error) {
      throw isStorageNotFound(error) ? fsError("ENOENT", path, error) : error;
    }
  }
}
