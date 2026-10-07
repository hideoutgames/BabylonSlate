import { checkStorageRevision, rethrowStorageReadFailure, StorageReadCounter, validateStorageRange } from "./storage-range";
import { isStorageNotFound, SourceRevisionChangedError, StorageNotFoundError } from "@babylonslate/core";
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

/** Serialize migration/binding across adapters and, with Web Locks, browser tabs. */
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

interface OpfsMeta {
  currentId: string | null;
  projects: Array<{ id: string; name: string; directory?: string }>;
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

/** Durable browser storage. Hosts without OPFS must report the failure to the caller. */
export class OpfsStorageAdapter implements ProjectStorage {
  private readonly reads = new StorageReadCounter();
  private readonly rangeHandles = new Map<string, FileSystemFileHandle>();
  getReadMetrics() { return this.reads.snapshot(); }

  private folder: ProjectFolderHandle | null = null;
  private root: FileSystemDirectoryHandle | null = null;

  private async getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
    if (this.root) return this.root;
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      throw new Error("Persistent project storage is unavailable in this browser.");
    }
    // A denied or transient storage request must never turn saves into volatile memory.
    this.root = await navigator.storage.getDirectory();
    return this.root;
  }

  private async remember(handle: ProjectFolderHandle, directory: string): Promise<ProjectFolderHandle> {
    await updateMeta((meta) => {
      const existing = meta.projects.find((project) => project.id === handle.id);
      if (existing) existing.directory = directory;
      else meta.projects.push({ id: handle.id, name: handle.name, directory });
      meta.currentId = handle.id;
    });
    this.folder = handle;
    return handle;
  }

  private async directoryFor(handle: ProjectFolderHandle): Promise<string> {
    const projects = loadMeta().projects;
    const known = projects.find((project) => project.id === handle.id);
    if (known?.directory) return known.directory;
    if (known) {
      const legacy = legacyDirectoryName(known.id);
      const owner = projects.find((project) => (project.directory ?? legacyDirectoryName(project.id)) === legacy);
      if (owner?.id === known.id) return legacy;
      // Older releases could remember two names for one physical directory.
      // Opening the alias gives it an independent copy; the original stays untouched.
      const root = await this.getOpfsRoot();
      const source = await root.getDirectoryHandle(legacy);
      const destinationName = await directoryName(handle.id);
      const destination = await root.getDirectoryHandle(destinationName, { create: true });
      try { await copyDirectory(source, destination); }
      catch (error) {
        try { await root.removeEntry(destinationName, { recursive: true }); } catch { /* Source remains intact. */ }
        throw error;
      }
      return destinationName;
    }
    return directoryName(handle.id);
  }

  private async bind(name: string): Promise<ProjectFolderHandle> {
    const handle: ProjectFolderHandle = { id: `opfs:${name}`, name, tier: "opfs" };
    return withProjectLifecycle(handle.id, async () => {
      const opfs = await this.getOpfsRoot();
      const directory = await this.directoryFor(handle);
      await opfs.getDirectoryHandle(directory, { create: true });
      return this.remember(handle, directory);
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
    if (this.folder) return this.folder;
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
    const meta = loadMeta();
    const known = meta.projects.find((project) => project.id === handle.id);
    if (!known) return;
    const dirName = known.directory ?? legacyDirectoryName(known.id);
    const shared = meta.projects.some((project) => project.id !== handle.id &&
      (project.directory ?? legacyDirectoryName(project.id)) === dirName);
    for (const cached of [...this.rangeHandles.keys()]) {
      if (cached.startsWith(`${handle.id}/`)) this.rangeHandles.delete(cached);
    }
    const opfs = await this.getOpfsRoot();
    if (!shared) {
      try { await opfs.removeEntry(dirName, { recursive: true }); }
      catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
    }
    // Another adapter may have registered or selected a project during disk I/O.
    await updateMeta((latest) => {
      latest.projects = latest.projects.filter((project) => project.id !== handle.id);
      if (latest.currentId === handle.id) latest.currentId = null;
    });
    if (this.folder?.id === handle.id) {
      this.folder = null;
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
    return path
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .split("/")
      .filter((s) => s.length > 0 && s !== ".");
  }

  private async projectDir(): Promise<FileSystemDirectoryHandle> {
    const folder = this.assertFolder();
    const opfs = await this.getOpfsRoot();
    const directory = loadMeta().projects.find((project) => project.id === folder.id)?.directory;
    if (directory) return opfs.getDirectoryHandle(directory, { create: true });
    return withProjectLifecycle(folder.id, async () => {
      const directory = await this.directoryFor(folder);
      const result = await opfs.getDirectoryHandle(directory, { create: true });
      await this.remember(folder, directory);
      return result;
    });
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
    writeRevisions.set(key, (writeRevisions.get(key) ?? 0) + 1);
    try {
      await writable.write(data);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    } finally {
      writeRevisions.set(key, (writeRevisions.get(key) ?? 0) + 1);
    }
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
    // FileSystemDirectoryHandle async iterator (entries may be missing from older DOM libs).
    const dirHandle = dir as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      values?: () => AsyncIterableIterator<FileSystemHandle>;
      keys?: () => AsyncIterableIterator<string>;
    };
    if (dirHandle.entries) {
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

function legacyDirectoryName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._:-]/g, "_");
}

/** Fixed-length, Unicode-safe identity independent of filesystem filename folding. */
async function directoryName(id: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(id)));
  return `project-v2-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function copyDirectory(source: FileSystemDirectoryHandle, destination: FileSystemDirectoryHandle): Promise<void> {
  const entries = source as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, handle] of entries.entries()) {
    if (handle.kind === "directory") {
      await copyDirectory(await source.getDirectoryHandle(name), await destination.getDirectoryHandle(name, { create: true }));
    } else {
      const file = await (handle as FileSystemFileHandle).getFile();
      const writable = await (await destination.getFileHandle(name, { create: true })).createWritable();
      try { await writable.write(await file.arrayBuffer()); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
    }
  }
}
