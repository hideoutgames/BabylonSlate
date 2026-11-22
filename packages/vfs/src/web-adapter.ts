import { checkStorageRevision, rethrowStorageReadFailure, StorageReadCounter, validateStorageRange } from "./storage-range";
import { ProjectOpenElsewhereError, SourceRevisionChangedError, StorageNotFoundError } from "@haptic/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@haptic/core";
import { createOpfsFileOps, navigatorOpfsRoot, OpfsFailure, splitOpfsPath, type OpfsFileOps, type OpfsRangeRead } from "./opfs-file-ops";
import { opfsWorkerSupported, sharedOpfsWorkerOps } from "./opfs-worker-client";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "./test-mode";

const META_KEY = "haptic:opfs-meta";
/**
 * Write counters per `${projectId}/${path}`. Values come from one sequence and
 * are never reused, so a removed path's entry can be dropped: a rewrite cannot
 * reproduce a revision string a reader still holds. Entries are dropped only
 * once the removal succeeds, so a file that stays keeps its revision.
 */
const writeRevisions = new Map<string, number>();
let writeSequence = 0;

/** Write counters of `key` and every path below it, taken before a removal. */
function writeRevisionsUnder(key: string): Map<string, number> {
  return new Map([...writeRevisions].filter(([cached]) => cached === key || cached.startsWith(`${key}/`)));
}

/**
 * Drop the counters of removed files. A counter that a write changed during
 * the removal stays, because that write may have created the file again.
 */
function forgetRemovedRevisions(removed: Map<string, number>): void {
  for (const [key, value] of removed) {
    if (writeRevisions.get(key) === value) writeRevisions.delete(key);
  }
}

const lifecycleQueues = new Map<string, Promise<void>>();
const directoryNames = new Map<string, Promise<string>>();

/**
 * The storage port's error for a file-operation failure, the same whether the
 * operation ran here or in the storage worker (whose errors arrive as their
 * name and message).
 */
function storageError(failure: OpfsFailure, folder: ProjectFolderHandle): unknown {
  const cause = failure.reason();
  const options = cause === undefined ? undefined : { cause };
  switch (failure.kind) {
    case "not-found":
      return failure.project
        ? new StorageNotFoundError(folder.name, { cause, message: `Project folder not found: ${folder.name}` })
        : new StorageNotFoundError(failure.path, options);
    case "failed":
      return new Error(failure.project ? `Could not open project ${folder.name}: ${failure.message}` : failure.message, options);
    case "revision-changed":
      return Object.assign(new SourceRevisionChangedError(failure.message), options);
    case "range":
      return new RangeError(failure.message);
    case "interrupted":
      return new Error(failure.message);
    case "error":
      return cause;
  }
}

/** Serialize binding and deletion across adapters and, with Web Locks, browser tabs. */
function withProjectLifecycle<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = lifecycleQueues.get(id) ?? Promise.resolve();
  const next = previous.then(() => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    return locks ? locks.request(`haptic:opfs:${id}`, work) : work();
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
    const done = locks.request(`haptic:opfs-session:${id}`, { ifAvailable: true }, (lock) => {
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
  return locks ? locks.request("haptic:opfs-meta", update) : Promise.resolve().then(update);
}

export interface OpfsStorageOptions {
  /**
   * App-owned libraries and derived data bind without joining the project
   * list or becoming the project a new adapter restores.
   */
  library?: boolean;
  /**
   * File operations to use instead of the realm's storage worker (or, where
   * there is none, this adapter's own main-thread operations); tests drive the
   * worker client through it.
   */
  files?: OpfsFileOps;
}

/**
 * Durable browser storage. Hosts without OPFS must report the failure to the caller.
 * File operations run in the storage worker where there is one; metadata, locks,
 * write counters and read metrics stay here.
 */
export class OpfsStorageAdapter implements ProjectStorage {
  private readonly reads = new StorageReadCounter();
  getReadMetrics() { return this.reads.snapshot(); }

  private folder: ProjectFolderHandle | null = null;
  private readonly library: boolean;
  private readonly files: OpfsFileOps;
  /** Held while a project is bound; libraries are shared app data and take none. */
  private session: ProjectSession | null = null;

  constructor(options: OpfsStorageOptions = {}) {
    this.library = options.library === true;
    this.files = options.files ?? (opfsWorkerSupported() ? sharedOpfsWorkerOps() : createOpfsFileOps(navigatorOpfsRoot()));
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

  /** Binding creates the project folder; later file operations never recreate it. */
  private async ensureProjectDir(handle: ProjectFolderHandle): Promise<void> {
    const dirName = await directoryName(handle.id);
    try { await this.files.ensureProjectDir(dirName); }
    catch (error) { throw error instanceof OpfsFailure ? storageError(error, handle) : error; }
  }

  private async bind(name: string): Promise<ProjectFolderHandle> {
    const handle: ProjectFolderHandle = { id: `opfs:${name}`, name, tier: "opfs" };
    return withProjectLifecycle(handle.id, async () => {
      if (this.library) {
        await this.ensureProjectDir(handle);
        this.folder = handle;
        return handle;
      }
      // A refused bind changes nothing: the previous project stays bound.
      const previous = this.session;
      const session = previous?.id === handle.id ? previous : await claimSession(handle.id);
      if (!session) throw new ProjectOpenElsewhereError();
      try {
        await this.ensureProjectDir(handle);
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
      const revisions = writeRevisionsUnder(handle.id);
      try { await this.files.removeProjectDir(await directoryName(handle.id)); }
      catch (error) {
        if (!(error instanceof OpfsFailure)) throw error;
        if (error.kind !== "not-found") throw storageError(error, handle);
      }
      forgetRemovedRevisions(revisions);
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

  /** The write counter key of `path`; an invalid path fails here, before any file operation. */
  private revisionKey(folder: ProjectFolderHandle, path: string): string {
    return `${folder.id}/${splitOpfsPath(path).join("/")}`;
  }

  /** Run a file operation on the bound project, mapping its failure to the storage port's error. */
  private async run<T>(path: string, work: (dirName: string) => Promise<T>): Promise<T> {
    const folder = this.assertFolder();
    splitOpfsPath(path);
    const dirName = await directoryName(folder.id);
    try { return await work(dirName); }
    catch (error) { throw error instanceof OpfsFailure ? storageError(error, folder) : error; }
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const bytes = await this.run(path, (dirName) => this.files.readBinary(dirName, path));
    this.reads.record("full", bytes.byteLength);
    return bytes;
  }

  /**
   * The write counter is part of the revision and lives here, so the read
   * takes its current value and the counter is checked again afterwards: a
   * write staged or committed during the read changes the revision.
   */
  async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string) {
    validateStorageRange(offset, length);
    const folder = this.assertFolder();
    const key = this.revisionKey(folder, path);
    const counter = writeRevisions.get(key) ?? 0;
    let result: OpfsRangeRead;
    try {
      result = await this.files.readRange(await directoryName(folder.id), path, offset, length, counter, expectedRevision);
    } catch (error) {
      if (!(error instanceof OpfsFailure)) throw error;
      if (error.read !== undefined) this.reads.record("range", length, error.read);
      if (error.kind === "range") validateStorageRange(offset, length, error.totalSize);
      const failure = error.recheck && (writeRevisions.get(key) ?? 0) !== counter
        ? Object.assign(new SourceRevisionChangedError(`Source revision changed: ${path}`), { cause: error.reason() })
        : storageError(error, folder);
      if (error.actualBytesRead !== undefined) rethrowStorageReadFailure(failure, error.actualBytesRead);
      throw failure;
    }
    this.reads.record("range", length, result.actualBytesRead);
    try {
      checkStorageRevision(path, String(writeRevisions.get(key) ?? 0), String(counter));
      return result;
    } catch (error) { rethrowStorageReadFailure(error, result.actualBytesRead); }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const key = this.revisionKey(this.assertFolder(), path);
    await this.run(path, async (dirName) => {
      // Ranges read while the write is staged see a changed revision.
      const before = writeRevisions.get(key);
      const staged = ++writeSequence;
      writeRevisions.set(key, staged);
      try {
        await this.files.writeBinary(dirName, path, data);
      } catch (error) {
        if (error instanceof OpfsFailure && error.kind === "interrupted") {
          // The bytes may have changed, so no revision read before or during the write may match them.
          writeRevisions.set(key, ++writeSequence);
        } else if (writeRevisions.get(key) === staged) {
          // The committed bytes are unchanged, so readers holding their revision stay valid.
          if (before === undefined) writeRevisions.delete(key);
          else writeRevisions.set(key, before);
        }
        throw error;
      }
      writeRevisions.set(key, ++writeSequence);
    });
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBinary(path));
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBinary(path, new TextEncoder().encode(data));
  }

  async exists(path: string): Promise<boolean> {
    return this.run(path, (dirName) => this.files.exists(dirName, path));
  }

  async readdir(path: string): Promise<DirEntry[]> {
    return this.run(path, (dirName) => this.files.readdir(dirName, path));
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await this.run(path, (dirName) => this.files.mkdir(dirName, path, recursive));
  }

  async remove(path: string): Promise<void> {
    const key = this.revisionKey(this.assertFolder(), path);
    const revisions = writeRevisionsUnder(key);
    await this.run(path, (dirName) => this.files.remove(dirName, path));
    forgetRemovedRevisions(revisions);
  }

  async stat(path: string): Promise<FileStat> {
    return this.run(path, (dirName) => this.files.stat(dirName, path));
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
