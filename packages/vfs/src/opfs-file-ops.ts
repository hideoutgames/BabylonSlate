import { isStagedWrite, stagedWriteName } from "./staged-write";

/**
 * OPFS file operations, addressed by a project's directory name and a
 * project-relative path. The same code runs on the main thread and inside the
 * storage worker, so it imports nothing beyond pure helpers: no `@haptic/core`
 * barrel and no dynamic `import()` (a worker's graph must not have one).
 *
 * Failures are `OpfsFailure` values that the adapter turns into the storage
 * port's errors; they cross the worker boundary as plain data.
 */

/** Reads of a file whose snapshot a concurrent write replaced, before giving up. */
const OPFS_READ_ATTEMPTS = 4;
const STALE_SNAPSHOT_ERRORS = new Set(["NotReadableError", "NotFoundError"]);
/** Failures of a cached handle that may only mean the entry was removed or replaced since it was cached. */
const STALE_HANDLE_ERRORS = new Set(["NotFoundError", "InvalidStateError", "TypeMismatchError"]);
const DIRECTORY_CACHE_LIMIT = 256;
const FILE_CACHE_LIMIT = 1024;
const LISTING_CONCURRENCY = 16;
/**
 * A SyncAccessHandle write blocks the worker's event loop; between chunks of
 * this size it yields, so the client's liveness pings are still answered.
 */
const STAGED_WRITE_CHUNK = 16 * 1024 * 1024;

export type OpfsFailureKind =
  /** The path (or, with `project`, the project folder) does not exist. */
  | "not-found"
  /** `Could not <action> <path>: …`; with `project`, `message` is the cause's text. */
  | "failed"
  /** The operation's own error, rethrown as it is. */
  | "error"
  | "revision-changed"
  /** The requested range exceeds `totalSize`. */
  | "range"
  /** The storage worker stopped while a mutation was in flight: it may or may not have happened. */
  | "interrupted";

export interface OpfsFailureData {
  kind: OpfsFailureKind;
  path: string;
  message: string;
  /** The failure is about the project folder itself, which the adapter names. */
  project?: boolean;
  /** Name and message of the underlying error, which may live in another realm. */
  cause?: { name: string; message: string };
  totalSize?: number;
  /** Bytes a range read returned before failing; present once the read was attempted. */
  read?: number;
  /** Bytes the error must carry as `actualBytesRead`. */
  actualBytesRead?: number;
  /**
   * A snapshot read failed while the file's metadata looked unchanged: a write
   * the adapter staged meanwhile still makes it a changed revision.
   */
  recheck?: boolean;
}

/** A tagged file-operation failure; `error` is the original, available only in the realm that raised it. */
export class OpfsFailure implements OpfsFailureData {
  kind: OpfsFailureKind;
  path: string;
  message: string;
  project?: boolean;
  cause?: { name: string; message: string };
  totalSize?: number;
  read?: number;
  actualBytesRead?: number;
  recheck?: boolean;
  readonly error?: unknown;

  constructor(data: OpfsFailureData, error?: unknown) {
    this.kind = data.kind;
    this.path = data.path;
    this.message = data.message;
    if (data.project) this.project = true;
    if (data.cause) this.cause = data.cause;
    if (data.totalSize !== undefined) this.totalSize = data.totalSize;
    if (data.read !== undefined) this.read = data.read;
    if (data.actualBytesRead !== undefined) this.actualBytesRead = data.actualBytesRead;
    if (data.recheck) this.recheck = true;
    if (error !== undefined) {
      this.error = error;
      this.cause ??= { name: errorName(error), message: errorMessage(error) };
    }
  }

  /** The failure as structured-clone-safe data (without the original error). */
  toData(): OpfsFailureData {
    const data: OpfsFailureData & { error?: unknown } = { ...this };
    delete data.error;
    return data;
  }

  /** The original error, or an `Error` carrying its name and message when it came from another realm. */
  reason(): unknown {
    if (this.error !== undefined) return this.error;
    if (!this.cause) return undefined;
    const revived = new Error(this.cause.message);
    revived.name = this.cause.name || "Error";
    return revived;
  }
}

function errorName(error: unknown): string {
  return String((error as { name?: unknown } | null)?.name ?? "");
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

/** The operation's own error, unchanged. */
function own(error: unknown, path: string, extra: Partial<OpfsFailureData> = {}): OpfsFailure {
  return new OpfsFailure({ kind: "error", path, message: errorMessage(error), ...extra }, error);
}

function failed(path: string, message: string, error?: unknown): OpfsFailure {
  return new OpfsFailure({ kind: "failed", path, message }, error);
}

/**
 * Map an OPFS lookup failure. NotFoundError means the entry is absent; while
 * descending directories, TypeMismatchError means a file occupies a directory
 * name (POSIX ENOTDIR), so the path cannot exist either. Every other failure
 * (InvalidStateError, NotAllowedError, TypeError…) keeps its own error.
 */
function lookupFailure(error: unknown, path: string, action: string, directory: boolean): OpfsFailure {
  if (error instanceof OpfsFailure) return error;
  const name = errorName(error);
  if (name === "NotFoundError" || (directory && name === "TypeMismatchError")) {
    return new OpfsFailure({ kind: "not-found", path, message: `File not found: ${path}` }, error);
  }
  return failed(path, `Could not ${action} ${path}: ${String(error)}`, error);
}

function asFailure(error: unknown, map: (error: unknown) => OpfsFailure): OpfsFailure {
  return error instanceof OpfsFailure ? error : map(error);
}

/** Project-relative path segments. `""` and `"."` name the project root; `..` is refused. */
export function splitOpfsPath(path: string): string[] {
  const parts = path
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
  if (parts.includes("..")) throw new Error(`Path escapes project root: ${path}`);
  return parts;
}

export interface OpfsFileStat {
  isDir: boolean;
  size: number | null;
  mtime: number | null;
}

export interface OpfsDirEntry extends OpfsFileStat {
  name: string;
}

export interface OpfsRangeRead {
  bytes: Uint8Array;
  totalSize: number;
  revision: string;
  actualBytesRead: number;
}

/**
 * File operations on one OPFS root. The adapter's state (write counters,
 * metadata, locks) stays with the caller: a range read takes the caller's
 * write counter for the file, and the caller checks it again afterwards.
 */
export interface OpfsFileOps {
  /** Create the project folder; only binding does this. */
  ensureProjectDir(dirName: string): Promise<void>;
  removeProjectDir(dirName: string): Promise<void>;
  readBinary(dirName: string, path: string): Promise<Uint8Array>;
  readRange(
    dirName: string, path: string, offset: number, length: number, counter: number, expectedRevision?: string,
  ): Promise<OpfsRangeRead>;
  writeBinary(dirName: string, path: string, data: Uint8Array): Promise<void>;
  stat(dirName: string, path: string): Promise<OpfsFileStat>;
  exists(dirName: string, path: string): Promise<boolean>;
  readdir(dirName: string, path: string): Promise<OpfsDirEntry[]>;
  mkdir(dirName: string, path: string, recursive: boolean): Promise<void>;
  remove(dirName: string, path: string): Promise<void>;
}

export const OPFS_MUTATIONS: ReadonlySet<keyof OpfsFileOps> = new Set<keyof OpfsFileOps>([
  "ensureProjectDir", "removeProjectDir", "writeBinary", "mkdir", "remove",
]);
export const OPFS_OPERATIONS: ReadonlySet<keyof OpfsFileOps> = new Set<keyof OpfsFileOps>([
  ...OPFS_MUTATIONS, "readBinary", "readRange", "stat", "exists", "readdir",
]);

/** The origin's OPFS root, requested on first use; a refused request is asked again next time. */
export function navigatorOpfsRoot(): () => Promise<FileSystemDirectoryHandle> {
  let root: FileSystemDirectoryHandle | null = null;
  return async () => {
    if (root) return root;
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      throw new Error("Persistent project storage is unavailable in this browser.");
    }
    // A denied or transient storage request must never turn saves into volatile memory.
    root = await navigator.storage.getDirectory();
    return root;
  };
}

/** The DOM lib in use declares neither the directory iterator nor `move` and SyncAccessHandles outside workers. */
type DirectoryHandle = FileSystemDirectoryHandle & {
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};
interface SyncAccessHandle {
  write(buffer: Uint8Array<ArrayBuffer>, options: { at: number }): number | Promise<number>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}
type FileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
  move?: (parent: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

interface StagedFile {
  name: string;
  handle: FileHandle;
}

/** Where a write goes: the target itself (`createWritable`), or a staged file moved over it. */
interface WriteTarget {
  parent: FileSystemDirectoryHandle;
  handle?: FileHandle;
  staged?: StagedFile;
}

/** Insertion-ordered map evicting the least recently used entry; holds handles only, never locks. */
class HandleCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
  /** Drop `key` and everything below it. */
  purge(key: string): void {
    for (const cached of [...this.entries.keys()]) {
      if (cached === key || cached.startsWith(`${key}/`)) this.entries.delete(cached);
    }
  }
}

/** A cached handle failed in a way that a removal or replacement explains; the walk starts again from the root. */
class StaleHandle {
  readonly key: string;
  constructor(key: string) {
    this.key = key;
  }
}

function cacheKey(dirName: string, parts: readonly string[], depth = parts.length): string {
  return depth === 0 ? dirName : `${dirName}/${parts.slice(0, depth).join("/")}`;
}

interface Walk {
  /**
   * The operation may create entries, so the project folder is looked up from
   * the root, without creating it, before any cached descendant is used: a
   * save racing a deletion fails instead of resurrecting the project.
   */
  creates: boolean;
  /** Create missing directories while descending. */
  createDirectories: boolean;
  /** Map a failure to open a directory along the path. */
  fail(error: unknown): OpfsFailure;
}

export function createOpfsFileOps(getRoot: () => Promise<FileSystemDirectoryHandle>): OpfsFileOps {
  /** Directory handles by `dirName/relative/dir`; the project folder by `dirName`. */
  const directories = new HandleCache<FileSystemDirectoryHandle>(DIRECTORY_CACHE_LIMIT);
  /** File handles of bounded reads, which repeat for every revision check. */
  const files = new HandleCache<FileSystemFileHandle>(FILE_CACHE_LIMIT);

  const purge = (key: string) => {
    directories.purge(key);
    files.purge(key);
  };

  async function root(path: string): Promise<FileSystemDirectoryHandle> {
    try { return await getRoot(); }
    catch (error) { throw own(error, path); }
  }

  /** The project folder, looked up from the root without creating it. */
  async function projectFolder(dirName: string, path: string): Promise<FileSystemDirectoryHandle> {
    const opfs = await root(path);
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await opfs.getDirectoryHandle(dirName);
    } catch (error) {
      if (errorName(error) === "NotFoundError") {
        throw new OpfsFailure({ kind: "not-found", path, message: "Project folder not found", project: true }, error);
      }
      throw new OpfsFailure({ kind: "failed", path, message: String(error), project: true }, error);
    }
    directories.set(dirName, dir);
    return dir;
  }

  async function openDirectory(
    dirName: string, parts: readonly string[], path: string, walk: Walk, useCache: boolean,
  ): Promise<{ dir: FileSystemDirectoryHandle; cachedKey?: string }> {
    let dir: FileSystemDirectoryHandle | undefined = walk.creates ? await projectFolder(dirName, path) : undefined;
    let start = 0;
    let cachedKey: string | undefined;
    if (useCache) {
      for (let depth = parts.length; depth >= (walk.creates ? 1 : 0); depth--) {
        const key = cacheKey(dirName, parts, depth);
        const hit = directories.get(key);
        if (hit) {
          dir = hit;
          start = depth;
          cachedKey = key;
          break;
        }
      }
    }
    dir ??= await projectFolder(dirName, path);
    for (let index = start; index < parts.length; index++) {
      try {
        dir = await dir.getDirectoryHandle(parts[index]!, walk.createDirectories ? { create: true } : undefined);
      } catch (error) {
        if (cachedKey !== undefined && STALE_HANDLE_ERRORS.has(errorName(error))) throw new StaleHandle(cachedKey);
        throw walk.fail(error);
      }
      directories.set(cacheKey(dirName, parts, index + 1), dir);
    }
    return { dir, cachedKey };
  }

  /**
   * Run `work` on the directory at `parts`. When a cached handle fails in a way
   * a removal explains (this tab, or another tab sharing a library), it is
   * evicted and the work runs once more from the root, so a directory removed
   * and recreated never leaves the cache wrong. `work` must be safe to repeat
   * after such a failure: a lookup, a listing or a removal.
   */
  async function withDirectory<T>(
    dirName: string, parts: readonly string[], path: string, walk: Walk,
    work: (dir: FileSystemDirectoryHandle) => Promise<T>,
  ): Promise<T> {
    for (let fromCache = true; ; fromCache = false) {
      let opened: { dir: FileSystemDirectoryHandle; cachedKey?: string };
      try {
        opened = await openDirectory(dirName, parts, path, walk, fromCache);
      } catch (error) {
        if (!(error instanceof StaleHandle)) throw error;
        // Only the failing entry: the walk from the root caches what it passes again, and a
        // stale descendant is noticed when it is used.
        directories.delete(error.key);
        continue;
      }
      try {
        return await work(opened.dir);
      } catch (error) {
        if (opened.cachedKey === undefined || !STALE_HANDLE_ERRORS.has(errorName(error))) throw error;
        directories.delete(opened.cachedKey);
      }
    }
  }

  const reading = (path: string, action: string): Walk => ({
    creates: false, createDirectories: false, fail: (error) => lookupFailure(error, path, action, true),
  });
  const creating = (path: string, createDirectories: boolean): Walk => ({
    creates: true, createDirectories, fail: (error) => own(error, path),
  });

  /** The parent's segments and the entry's name; the project root names no entry. */
  async function entry(dirName: string, path: string, walk: Walk): Promise<{ parents: string[]; name: string }> {
    const parts = split(path);
    if (parts.length === 0) {
      await openDirectory(dirName, parts, path, walk, true);
      throw new OpfsFailure({ kind: "failed", path, message: `Invalid path: ${path}` });
    }
    return { parents: parts.slice(0, -1), name: parts[parts.length - 1]! };
  }

  function split(path: string): string[] {
    try { return splitOpfsPath(path); }
    catch (error) { throw new OpfsFailure({ kind: "failed", path, message: errorMessage(error) }); }
  }

  /** A bounded read's file handle and snapshot, reusing the handle until it no longer resolves. */
  async function rangeFile(dirName: string, path: string): Promise<{ handle: FileSystemFileHandle; file: File }> {
    const parts = split(path);
    const key = cacheKey(dirName, parts);
    const cached = files.get(key);
    if (cached) {
      try { return { handle: cached, file: await cached.getFile() }; }
      catch { files.delete(key); }
    }
    const { parents, name } = await entry(dirName, path, reading(path, "read"));
    try {
      const found = await withDirectory(dirName, parents, path, reading(path, "read"), async (dir) => {
        const handle = await dir.getFileHandle(name);
        return { handle, file: await handle.getFile() };
      });
      files.set(key, found.handle);
      return found;
    } catch (error) {
      throw lookupFailure(error, path, "read", false);
    }
  }

  /**
   * Whether this realm's file handles have `createWritable`, learned from the
   * first file handle a write sees. Where they do not, writes stage the bytes
   * and never create the target before moving them into place.
   */
  let canCreateWritable: boolean | undefined;

  async function createStaged(dir: FileSystemDirectoryHandle): Promise<StagedFile> {
    const name = stagedWriteName();
    return { name, handle: await dir.getFileHandle(name, { create: true }) as FileHandle };
  }

  /**
   * The target's handle for a `createWritable` write, or a staged file to move
   * into place. Repeatable after a stale-handle failure: it only looks up or
   * creates entries, and removes a staged file it created for nothing.
   */
  async function openTarget(dir: FileSystemDirectoryHandle, name: string): Promise<WriteTarget> {
    if (canCreateWritable === true) return { parent: dir, handle: await dir.getFileHandle(name, { create: true }) as FileHandle };
    if (canCreateWritable === false) return { parent: dir, staged: await createStaged(dir) };
    // Learn from the target if it exists, else from a staged file: creating the
    // target only to find no createWritable on it would leave an empty file.
    let probe: FileHandle;
    let staged: StagedFile | undefined;
    try {
      probe = await dir.getFileHandle(name) as FileHandle;
    } catch (error) {
      if (errorName(error) !== "NotFoundError") throw error;
      staged = await createStaged(dir);
      probe = staged.handle;
    }
    canCreateWritable = typeof probe.createWritable === "function";
    if (!canCreateWritable) return { parent: dir, staged };
    if (!staged) return { parent: dir, handle: probe };
    await dir.removeEntry(staged.name).catch(() => {});
    return { parent: dir, handle: await dir.getFileHandle(name, { create: true }) as FileHandle };
  }

  async function stagedWrite(
    parent: FileSystemDirectoryHandle, name: string, path: string, data: Uint8Array, staged?: StagedFile,
  ): Promise<void> {
    const temp = staged ?? await createStaged(parent);
    try {
      if (typeof temp.handle.createSyncAccessHandle !== "function" || typeof temp.handle.move !== "function") {
        throw new OpfsFailure({ kind: "failed", path, message: `Could not write ${path}: this browser cannot replace files safely` });
      }
      // The handle locks only the staged file and only for this one write; reads never take one,
      // and the target is never opened, so a failure leaves its bytes untouched.
      const access = await temp.handle.createSyncAccessHandle();
      try {
        let written = 0;
        let nextYield = STAGED_WRITE_CHUNK;
        while (written < data.byteLength) {
          const end = Math.min(data.byteLength, written + STAGED_WRITE_CHUNK);
          const count = await access.write(data.subarray(written, end) as Uint8Array<ArrayBuffer>, { at: written });
          if (!(count > 0)) throw new Error(`Could not write ${path}: the file accepted no bytes`);
          written += count;
          if (written >= nextYield && written < data.byteLength) {
            nextYield = written + STAGED_WRITE_CHUNK;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        await access.flush();
      } finally {
        await access.close();
      }
      await temp.handle.move(parent, name);
    } catch (error) {
      await parent.removeEntry(temp.name).catch(() => {});
      throw error;
    }
  }

  return {
    async ensureProjectDir(dirName) {
      const opfs = await root(dirName);
      try {
        directories.set(dirName, await opfs.getDirectoryHandle(dirName, { create: true }));
      } catch (error) {
        throw own(error, dirName);
      }
    },

    async removeProjectDir(dirName) {
      const opfs = await root(dirName);
      try {
        await opfs.removeEntry(dirName, { recursive: true });
      } catch (error) {
        if (errorName(error) === "NotFoundError") {
          throw new OpfsFailure({ kind: "not-found", path: "", message: "Project folder not found", project: true }, error);
        }
        throw own(error, dirName);
      } finally {
        // Also after a failure: part of the folder may be gone.
        purge(dirName);
      }
    },

    async readBinary(dirName, path) {
      const { parents, name } = await entry(dirName, path, reading(path, "read"));
      for (let attempt = 1; ; attempt++) {
        let file: File;
        try {
          file = await withDirectory(dirName, parents, path, reading(path, "read"),
            async (dir) => (await dir.getFileHandle(name)).getFile());
        } catch (error) {
          // A directory at the path (TypeMismatchError) is not a missing file.
          throw lookupFailure(error, path, "read", false);
        }
        try {
          return new Uint8Array(await file.arrayBuffer());
        } catch (error) {
          // `getFile()` is a snapshot: a write that closes before it is read
          // (Chromium swaps the new contents in) fails the read with
          // NotReadableError or NotFoundError. Read the committed file again.
          if (attempt < OPFS_READ_ATTEMPTS && STALE_SNAPSHOT_ERRORS.has(errorName(error))) continue;
          throw failed(path, `Could not read ${path}: ${String(error)}`, error);
        }
      }
    },

    async readRange(dirName, path, offset, length, counter, expectedRevision) {
      const { handle, file } = await rangeFile(dirName, path);
      const revisionOf = (value: File) => `${value.lastModified}:${value.size}:${counter}`;
      const revision = revisionOf(file);
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new OpfsFailure({ kind: "revision-changed", path, message: `Source revision changed: ${path}` });
      }
      if (!(offset + length <= file.size)) {
        throw new OpfsFailure({ kind: "range", path, message: "Storage byte range exceeds the file", totalSize: file.size });
      }
      if (length === 0) {
        return { bytes: new Uint8Array(0), totalSize: file.size, revision, actualBytesRead: 0 };
      }
      // Reading the Blob slice is essential: slicing an ArrayBuffer already read
      // from the complete File would eagerly retain every inline asset payload.
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      } catch (error) {
        let recheck = false;
        if (STALE_SNAPSHOT_ERRORS.has(errorName(error))) {
          let current: File | undefined;
          try { current = await handle.getFile(); }
          catch { /* A missing/unreadable file alone does not prove a changed revision. */ }
          if (current && revisionOf(current) !== revision) {
            throw new OpfsFailure({ kind: "revision-changed", path, message: `Source revision changed: ${path}`, read: 0 }, error);
          }
          recheck = current !== undefined;
        }
        throw own(error, path, { read: 0, recheck });
      }
      const read = bytes.byteLength;
      if (read !== length) {
        throw new OpfsFailure({ kind: "failed", path, message: `Unexpected end of file: ${path}`, read, actualBytesRead: read });
      }
      let current: File;
      try { current = await handle.getFile(); }
      catch (error) { throw own(error, path, { read, actualBytesRead: read }); }
      if (revisionOf(current) !== revision) {
        throw new OpfsFailure({ kind: "revision-changed", path, message: `Source revision changed: ${path}`, read, actualBytesRead: read });
      }
      return { bytes, totalSize: file.size, revision, actualBytesRead: read };
    },

    async writeBinary(dirName, path, data) {
      const walk = creating(path, true);
      const { parents, name } = await entry(dirName, path, walk);
      try {
        const target = await withDirectory(dirName, parents, path, walk, (dir) => openTarget(dir, name));
        if (target.handle) {
          const writable = await target.handle.createWritable();
          try {
            // Storage bytes are never SharedArrayBuffer-backed; DOM BufferSource
            // requires an ArrayBuffer-backed view.
            await writable.write(data as Uint8Array<ArrayBuffer>);
            await writable.close();
          } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
          }
        } else {
          await stagedWrite(target.parent, name, path, data, target.staged);
        }
      } catch (error) {
        throw asFailure(error, (raw) => own(raw, path));
      }
    },

    async stat(dirName, path) {
      const parts = split(path);
      const walk = reading(path, "stat");
      if (parts.length === 0) {
        // Nothing below would touch a cached project handle, so look the folder up.
        await projectFolder(dirName, path);
        return { isDir: true, size: null, mtime: null };
      }
      const name = parts[parts.length - 1]!;
      try {
        return await withDirectory(dirName, parts.slice(0, -1), path, walk, async (dir) => {
          try {
            const file = await (await dir.getFileHandle(name)).getFile();
            return { isDir: false, size: file.size, mtime: file.lastModified };
          } catch (error) {
            // getFileHandle reports an existing directory as TypeMismatchError.
            if (errorName(error) !== "TypeMismatchError") throw error;
          }
          await dir.getDirectoryHandle(name);
          return { isDir: true, size: null, mtime: null };
        });
      } catch (error) {
        throw lookupFailure(error, path, "stat", false);
      }
    },

    async exists(dirName, path) {
      const parts = split(path);
      const walk = reading(path, "stat");
      try {
        if (parts.length === 0) {
          await projectFolder(dirName, path);
          return true;
        }
        const name = parts[parts.length - 1]!;
        return await withDirectory(dirName, parts.slice(0, -1), path, walk, async (dir) => {
          try {
            await dir.getFileHandle(name);
          } catch (error) {
            // getFileHandle reports an existing directory as TypeMismatchError.
            if (errorName(error) !== "TypeMismatchError") throw error;
          }
          return true;
        });
      } catch (error) {
        const failure = lookupFailure(error, path, "stat", false);
        if (failure.kind === "not-found") return false;
        throw failure;
      }
    },

    async readdir(dirName, path) {
      const parts = split(path);
      const listed = await withDirectory(dirName, parts, path, reading(path, "list"), async (dir) => {
        const iterable = dir as DirectoryHandle;
        // An empty listing would let callers treat a full folder as empty.
        if (!iterable.entries) throw failed(path, `Could not list ${path}: directory iteration is unavailable`);
        const found: Array<[string, FileSystemHandle]> = [];
        for await (const listedEntry of iterable.entries()) found.push(listedEntry);
        return found;
      }).catch((error: unknown) => { throw asFailure(error, (raw) => own(raw, path)); });
      // Chromium lists a write's `<name>.crswap` swap file until the writable closes;
      // a staged `.haptic-<uuid>.tmp` is never part of the project.
      const kept = listed.filter(([name, handle]) => !isStagedWrite(name) && !(handle.kind !== "directory" && name.endsWith(".crswap")));
      const out: Array<OpfsDirEntry | null> = new Array(kept.length).fill(null);
      let next = 0;
      const fetchMetadata = async () => {
        while (next < kept.length) {
          const index = next++;
          const [name, handle] = kept[index]!;
          if (handle.kind === "directory") {
            out[index] = { name, isDir: true, size: null, mtime: null };
            continue;
          }
          let file: File;
          try {
            file = await (handle as FileSystemFileHandle).getFile();
          } catch (error) {
            // Removed (or its swap renamed away) after it was listed.
            if (errorName(error) === "NotFoundError") continue;
            throw own(error, path);
          }
          out[index] = { name, isDir: false, size: file.size, mtime: file.lastModified };
        }
      };
      await Promise.all(Array.from({ length: Math.min(LISTING_CONCURRENCY, kept.length) }, fetchMetadata));
      return out.filter((value): value is OpfsDirEntry => value !== null);
    },

    async mkdir(dirName, path, recursive) {
      const parts = split(path);
      const walk = creating(path, recursive);
      try {
        if (parts.length === 0) {
          await openDirectory(dirName, parts, path, walk, true);
          return;
        }
        const last = parts[parts.length - 1]!;
        // The last segment is always looked up, so a stale cached handle is noticed.
        await withDirectory(dirName, parts.slice(0, -1), path, walk, async (dir) => {
          directories.set(cacheKey(dirName, parts), await dir.getDirectoryHandle(last, { create: true }));
        });
      } catch (error) {
        throw asFailure(error, (raw) => own(raw, path));
      }
    },

    async remove(dirName, path) {
      const { parents, name } = await entry(dirName, path, reading(path, "remove"));
      try {
        await withDirectory(dirName, parents, path, reading(path, "remove"),
          (dir) => dir.removeEntry(name, { recursive: true }));
      } catch (error) {
        throw lookupFailure(error, path, "remove", false);
      } finally {
        // Also after a failure: part of a directory may be gone.
        purge(cacheKey(dirName, [...parents, name]));
      }
    },
  };
}
