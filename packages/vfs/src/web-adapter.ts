import { checkStorageRevision, rethrowStorageReadFailure, StorageReadCounter, validateStorageRange } from "./storage-range";
import { isStorageNotFound, ProjectOpenElsewhereError, SourceRevisionChangedError, StorageNotFoundError } from "@babylonslate/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "./test-mode";

const META_KEY = "babylonslate:opfs-meta";
/** Reads of a file whose snapshot a concurrent write replaced, before giving up. */
const OPFS_READ_ATTEMPTS = 4;
const STALE_SNAPSHOT_ERRORS = new Set(["NotReadableError", "NotFoundError"]);
const writeRevisions = new Map<string, number>();
const lifecycleQueues = new Map<string, Promise<void>>();
const directoryNames = new Map<string, Promise<string>>();

function domErrorName(error: unknown): string {
  return String((error as { name?: unknown } | null)?.name ?? "");
}

/**
 * Map an OPFS lookup failure. NotFoundError means the entry is absent; while
 * descending directories, TypeMismatchError means a file occupies a directory
 * name (POSIX ENOTDIR), so the path cannot exist either. Every other failure
 * (InvalidStateError, NotAllowedError, TypeError…) keeps its own error.
 */
function lookupError(error: unknown, path: string, action: string, directory: boolean): Error {
  const name = domErrorName(error);
  if (name === "NotFoundError" || (directory && name === "TypeMismatchError")) {
    return new StorageNotFoundError(path, { cause: error });
  }
  return new Error(`Could not ${action} ${path}: ${String(error)}`, { cause: error });
}

/** Serialize binding and deletion across adapters and, with Web Locks, browser tabs. */
function withProjectLifecycle<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = lifecycleQueues.get(id) ?? Promise.resolve();
  const next = previous.then(() => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    return locks ? locks.request(`babylonslate:opfs:${id}`, work) : work();
  });
  const settled = next.then(() => undefined, () => undefined);
  lifecycleQueues.set(id, settled);
  void settled.then(() => {
    if (lifecycleQueues.get(id) === settled) lifecycleQueues.delete(id);
  });
  return next;
}

/** A tab's claim on a project it has bound; the browser frees it when the tab goes away. */
interface ProjectSession {
  readonly id: string;
  /** Settles once the browser has released the lock, so the project can be claimed again at once. */
  release(): Promise<void>;
}

/**
 * Hold the project's session lock until the session is released. It is a
 * different lock from the lifecycle one, which only covers a bind or a delete.
 * Locks die with their document, so a reload or a crash frees the project.
 * Resolves to null when another tab holds it; without Web Locks nothing can be
 * told, so the claim always succeeds.
 */
function claimSession(id: string): Promise<ProjectSession | null> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve({ id, release: async () => {} });
  return new Promise((resolve, reject) => {
    const done = locks.request(`babylonslate:opfs-session:${id}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      return new Promise<void>((end) => {
        resolve({ id, release: () => { end(); return done.then(() => undefined, () => undefined); } });
      });
    });
    done.catch(reject);
  });
}

interface OpfsMeta {
  currentId: string | null;
  projects: Array<{ id: string; name: string }>;
}

function loadMeta(): OpfsMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) return JSON.parse(raw) as OpfsMeta;
  } catch {
    /* ignore */
  }
  return { currentId: null, projects: [] };
}

function saveMeta(meta: OpfsMeta): void {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

/** Keep different projects' metadata merges atomic across tabs as well. */
function updateMeta(mutate: (meta: OpfsMeta) => void): Promise<void> {
  const update = () => {
    const meta = loadMeta();
    mutate(meta);
    saveMeta(meta);
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request("babylonslate:opfs-meta", update) : Promise.resolve().then(update);
}

export interface OpfsStorageOptions {
  /**
   * App-owned libraries and derived data bind without joining the project
   * list or becoming the project a new adapter restores.
   */
  library?: boolean;
}

/** Durable browser storage. Hosts without OPFS must report the failure to the caller. */
export class OpfsStorageAdapter implements ProjectStorage {
  private readonly reads = new StorageReadCounter();
  private readonly rangeHandles = new Map<string, FileSystemFileHandle>();
  getReadMetrics() { return this.reads.snapshot(); }

  private folder: ProjectFolderHandle | null = null;
  private root: FileSystemDirectoryHandle | null = null;
  private readonly library: boolean;
  /** Held while a project is bound; libraries are shared app data and take none. */
  private session: ProjectSession | null = null;

  constructor(options: OpfsStorageOptions = {}) {
    this.library = options.library === true;
  }

  private async getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
    if (this.root) return this.root;
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      throw new Error("Persistent project storage is unavailable in this browser.");
    }
    // A denied or transient storage request must never turn saves into volatile memory.
    this.root = await navigator.storage.getDirectory();
    return this.root;
  }

  private async remember(handle: ProjectFolderHandle): Promise<ProjectFolderHandle> {
    await updateMeta((meta) => {
      if (!meta.projects.some((project) => project.id === handle.id)) {
        meta.projects.push({ id: handle.id, name: handle.name });
      }
      meta.currentId = handle.id;
    });
    this.folder = handle;
    return handle;
  }

  private async bind(name: string): Promise<ProjectFolderHandle> {
    const handle: ProjectFolderHandle = { id: `opfs:${name}`, name, tier: "opfs" };
    return withProjectLifecycle(handle.id, async () => {
      const opfs = await this.getOpfsRoot();
      if (this.library) {
        await opfs.getDirectoryHandle(await directoryName(handle.id), { create: true });
        this.folder = handle;
        return handle;
      }
      // A refused bind changes nothing: the previous project stays bound.
      const previous = this.session;
      const session = previous?.id === handle.id ? previous : await claimSession(handle.id);
      if (!session) throw new ProjectOpenElsewhereError();
      try {
        await opfs.getDirectoryHandle(await directoryName(handle.id), { create: true });
        await this.remember(handle);
      } catch (error) {
        if (session !== previous) await session.release();
        throw error;
      }
      this.session = session;
      if (previous && previous !== session) await previous.release();
      return handle;
    });
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    let name = "MyGame";
    if (isTestModeEnabled()) {
      name = TEST_PROJECT_NAME;
    } else if (typeof globalThis.prompt === "function") {
      try {
        name = globalThis.prompt("Project folder name", "MyGame") ?? "MyGame";
      } catch {
        name = "MyGame";
      }
    }
    return this.bind(name);
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    return this.bind(name);
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    if (handle.tier !== "opfs") {
      throw new Error(`OPFS adapter cannot open tier ${handle.tier}`);
    }
    const known = loadMeta().projects.find((project) => project.id === handle.id);
    const name = known?.name ?? (handle.id.startsWith("opfs:") ? handle.id.slice(5) : handle.name);
    return this.bind(name);
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return loadMeta().projects.map((p) => ({
      id: p.id,
      name: p.name,
      tier: "opfs" as const,
    }));
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    if (this.folder || this.library) return this.folder;
    const meta = loadMeta();
    if (!meta.currentId) return null;
    const found = meta.projects.find((p) => p.id === meta.currentId);
    if (!found) return null;
    this.folder = { id: found.id, name: found.name, tier: "opfs" };
    return this.folder;
  }

  async releaseFolder(): Promise<void> {
    const folder = this.getCurrentFolder();
    this.folder = null;
    const session = this.session;
    this.session = null;
    await session?.release();
    if (this.library) return;
    await updateMeta((meta) => {
      if (meta.currentId === folder?.id) meta.currentId = null;
    });
  }

  async deleteProject(handle: ProjectFolderHandle): Promise<void> {
    return withProjectLifecycle(handle.id, () => this.deleteProjectUnlocked(handle));
  }

  private async deleteProjectUnlocked(handle: ProjectFolderHandle): Promise<void> {
    if (handle.tier !== "opfs") {
      throw new Error(`OPFS adapter cannot delete tier ${handle.tier}`);
    }
    if (!loadMeta().projects.some((project) => project.id === handle.id)) return;
    // Deleting needs the session as much as opening does: another tab's project must stay.
    const owned = this.session?.id === handle.id;
    const session = owned ? this.session : await claimSession(handle.id);
    if (!session) throw new ProjectOpenElsewhereError();
    let spent = !owned;
    try {
      for (const cached of [...this.rangeHandles.keys()]) {
        if (cached.startsWith(`${handle.id}/`)) this.rangeHandles.delete(cached);
      }
      const opfs = await this.getOpfsRoot();
      try { await opfs.removeEntry(await directoryName(handle.id), { recursive: true }); }
      catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
      // Another adapter may have registered or selected a project during disk I/O.
      await updateMeta((latest) => {
        latest.projects = latest.projects.filter((project) => project.id !== handle.id);
        if (latest.currentId === handle.id) latest.currentId = null;
      });
      if (this.folder?.id === handle.id) {
        this.folder = null;
      }
      if (owned) {
        this.session = null;
        spent = true;
      }
    } finally {
      // A failed deletion leaves this adapter's own project bound, and so locked.
      if (spent) await session.release();
    }
  }

  private assertFolder(): ProjectFolderHandle {
    const folder = this.getCurrentFolder();
    if (!folder) {
      throw new Error("No project folder selected");
    }
    return folder;
  }

  private split(path: string): string[] {
    const parts = path
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .split("/")
      .filter((s) => s.length > 0 && s !== ".");
    if (parts.includes("..")) throw new Error(`Path escapes project root: ${path}`);
    return parts;
  }

  /**
   * Binding creates the project folder. Later file operations never recreate
   * it, so a save racing a deletion fails instead of resurrecting the project.
   */
  private async projectDir(): Promise<FileSystemDirectoryHandle> {
    const folder = this.assertFolder();
    const opfs = await this.getOpfsRoot();
    try {
      return await opfs.getDirectoryHandle(await directoryName(folder.id));
    } catch (error) {
      if (domErrorName(error) === "NotFoundError") {
        throw new StorageNotFoundError(folder.name, { cause: error, message: `Project folder not found: ${folder.name}` });
      }
      throw new Error(`Could not open project ${folder.name}: ${String(error)}`, { cause: error });
    }
  }

  private async resolveHandle(
    path: string,
    create: boolean,
    action = "open",
  ): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    const dir = await this.projectDir();
    const parts = this.split(path);
    if (parts.length === 0) {
      throw new Error(`Invalid path: ${path}`);
    }
    if (create) {
      let parent = dir;
      for (let i = 0; i < parts.length - 1; i++) {
        parent = await parent.getDirectoryHandle(parts[i]!, { create });
      }
      return { parent, name: parts[parts.length - 1]! };
    }
    return { parent: await this.descend(dir, parts.slice(0, -1), path, action), name: parts[parts.length - 1]! };
  }

  /** Open existing directories, reporting a missing segment as StorageNotFoundError. */
  private async descend(
    dir: FileSystemDirectoryHandle,
    parts: string[],
    path: string,
    action: string,
  ): Promise<FileSystemDirectoryHandle> {
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return dir;
    } catch (error) {
      throw lookupError(error, path, action, true);
    }
  }

  async readBinary(path: string): Promise<Uint8Array> {
    this.assertFolder();
    for (let attempt = 1; ; attempt++) {
      const { parent, name } = await this.resolveHandle(path, false, "read");
      let file: File;
      try {
        file = await (await parent.getFileHandle(name)).getFile();
      } catch (error) {
        // A directory at the path (TypeMismatchError) is not a missing file.
        throw lookupError(error, path, "read", false);
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        this.reads.record("full", bytes.byteLength);
        return bytes;
      } catch (error) {
        // `getFile()` is a snapshot: a write that closes before it is read
        // (Chromium swaps the new contents in) fails the read with
        // NotReadableError or NotFoundError. Read the committed file again.
        const name = String((error as { name?: unknown } | null)?.name ?? "");
        if (attempt < OPFS_READ_ATTEMPTS && STALE_SNAPSHOT_ERRORS.has(name)) continue;
        throw new Error(`Could not read ${path}: ${String(error)}`, { cause: error });
      }
    }
  }

  /**
   * Bounded catalog reads repeat for every revision check. Each OPFS call is a
   * separate task, which a busy render loop can delay by a frame, so reuse the
   * file handle and fall back to a fresh lookup when it no longer resolves.
   */
  private async rangeFile(key: string, path: string): Promise<{ handle: FileSystemFileHandle; file: File }> {
    const cached = this.rangeHandles.get(key);
    if (cached) {
      try { return { handle: cached, file: await cached.getFile() }; }
      catch { this.rangeHandles.delete(key); }
    }
    const { parent, name } = await this.resolveHandle(path, false, "read");
    let handle: FileSystemFileHandle;
    let file: File;
    try {
      handle = await parent.getFileHandle(name);
      file = await handle.getFile();
    } catch (error) { throw lookupError(error, path, "read", false); }
    this.rangeHandles.set(key, handle);
    return { handle, file };
  }

  async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string) {
    validateStorageRange(offset, length);
    const key = `${this.assertFolder().id}/${this.split(path).join("/")}`;
    const { handle, file } = await this.rangeFile(key, path);
    const revisionOf = (value: File) => `${value.lastModified}:${value.size}:${writeRevisions.get(key) ?? 0}`;
    const revision = revisionOf(file);
    checkStorageRevision(path, revision, expectedRevision);
    validateStorageRange(offset, length, file.size);
    // Reading the Blob slice is essential: slicing an ArrayBuffer already read
    // from the complete File would eagerly retain every inline asset payload.
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()); }
    catch (error) {
      this.reads.record("range", length, 0);
      if (STALE_SNAPSHOT_ERRORS.has(String((error as { name?: unknown } | null)?.name ?? ""))) {
        let current: File | undefined;
        try { current = await handle.getFile(); }
        catch { /* A missing/unreadable file alone does not prove a changed revision. */ }
        if (current && revisionOf(current) !== revision) {
          throw Object.assign(new SourceRevisionChangedError(`Source revision changed: ${path}`), { cause: error });
        }
      }
      throw error;
    }
    this.reads.record("range", length, bytes.byteLength);
    try {
      if (bytes.byteLength !== length) throw new Error(`Unexpected end of file: ${path}`);
      checkStorageRevision(path, revisionOf(await handle.getFile()), revision);
      return { bytes, totalSize: file.size, revision, actualBytesRead: bytes.byteLength };
    } catch (error) { rethrowStorageReadFailure(error, bytes.byteLength); }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const key = `${this.assertFolder().id}/${this.split(path).join("/")}`;
    const { parent, name } = await this.resolveHandle(path, true);
    const writable = await (
      await parent.getFileHandle(name, { create: true })
    ).createWritable();
    // Ranges read while the write is staged see a changed revision.
    const before = writeRevisions.get(key) ?? 0;
    writeRevisions.set(key, before + 1);
    try {
      // Storage bytes are never SharedArrayBuffer-backed; DOM BufferSource
      // requires an ArrayBuffer-backed view.
      await writable.write(data as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      // The committed bytes are unchanged, so readers holding their revision stay valid.
      if (writeRevisions.get(key) === before + 1) writeRevisions.set(key, before);
      throw error;
    }
    writeRevisions.set(key, (writeRevisions.get(key) ?? 0) + 1);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBinary(path));
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBinary(path, new TextEncoder().encode(data));
  }

  async exists(path: string): Promise<boolean> {
    this.assertFolder();
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (isStorageNotFound(error)) return false;
      throw error;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const root = await this.projectDir();
    const parts = this.split(path === "." ? "" : path);
    const dir = await this.descend(root, parts, path, "list");
    const out: DirEntry[] = [];
    // The DOM lib in use does not declare the directory async iterator.
    const dirHandle = dir as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    // An empty listing would let callers treat a full folder as empty.
    if (!dirHandle.entries) throw new Error(`Could not list ${path}: directory iteration is unavailable`);
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "directory") {
        out.push({ name, isDir: true, size: null, mtime: null });
      } else {
        // Chromium lists a write's `<name>.crswap` swap file until the writable closes.
        if (name.endsWith(".crswap")) continue;
        let file: File;
        try {
          file = await (handle as FileSystemFileHandle).getFile();
        } catch (error) {
          // Removed (or its swap renamed away) after it was listed.
          if (error instanceof DOMException && error.name === "NotFoundError") continue;
          throw error;
        }
        out.push({
          name,
          isDir: false,
          size: file.size,
          mtime: file.lastModified,
        });
      }
    }
    return out;
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    const root = await this.projectDir();
    const parts = this.split(path);
    let dir = root;
    for (const [index, seg] of parts.entries()) {
      dir = await dir.getDirectoryHandle(seg, { create: recursive || index === parts.length - 1 });
    }
  }

  async remove(path: string): Promise<void> {
    const key = `${this.assertFolder().id}/${this.split(path).join("/")}`;
    for (const cached of [...this.rangeHandles.keys()]) {
      if (cached === key || cached.startsWith(`${key}/`)) this.rangeHandles.delete(cached);
    }
    const { parent, name } = await this.resolveHandle(path, false, "remove");
    try {
      await parent.removeEntry(name, { recursive: true });
    } catch (error) {
      throw lookupError(error, path, "remove", false);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const root = await this.projectDir();
    const parts = this.split(path);
    if (parts.length === 0) {
      return { isDir: true, size: null, mtime: null };
    }
    const dir = await this.descend(root, parts.slice(0, -1), path, "stat");
    const name = parts[parts.length - 1]!;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return { isDir: false, size: file.size, mtime: file.lastModified };
    } catch (error) {
      // getFileHandle reports an existing directory as TypeMismatchError.
      if (domErrorName(error) !== "TypeMismatchError") throw lookupError(error, path, "stat", false);
    }
    try {
      await dir.getDirectoryHandle(name);
      return { isDir: true, size: null, mtime: null };
    } catch (error) {
      throw lookupError(error, path, "stat", false);
    }
  }
}

/** Every path resolution needs it, so the digest of a project id is computed once. */
function directoryName(id: string): Promise<string> {
  const cached = directoryNames.get(id);
  if (cached) return cached;
  const pending = digestDirectoryName(id);
  directoryNames.set(id, pending);
  // A failed digest is retried by the next call rather than remembered.
  pending.catch(() => { if (directoryNames.get(id) === pending) directoryNames.delete(id); });
  return pending;
}

/** Fixed-length, Unicode-safe identity independent of filesystem filename folding. */
async function digestDirectoryName(id: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(id)));
  return `project-v2-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
