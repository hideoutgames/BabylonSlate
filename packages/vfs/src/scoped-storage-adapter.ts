import { rethrowNativeStorageRangeError, rethrowStorageReadFailure, StorageReadCounter, utf8ByteLength, validateStorageRange, validateStorageRangeResult } from "./storage-range";
import { isStorageNotFound, StorageNotFoundError } from "@haptic/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
  ProjectStorageReader,
  StorageReadOptions,
} from "@haptic/core";
import { nativeBinaryBridge, type NativeBinaryBridge, type NativeBinaryRange, type NativeFileLocation } from "./native-binary-bridge";
import { Preferences } from "@capacitor/preferences";
import { projectRelativePath as scopedStoragePath } from "./project-path";
import type {
  BabylonSlateScopedStoragePlugin,
  NativeDirEntry,
  NativeFileStat,
  NativeRangeRead,
} from "./capacitor-scoped-storage";
import {
  BabylonSlateScopedStorage,
  decodeBase64,
  encodeBase64,
  isScopedStorageError,
  ScopedStorageErrorCode,
} from "./capacitor-scoped-storage";

const FOLDER_PREF_KEY = "haptic:scoped-folder";
const STALE_PREF_KEY = "haptic:scoped-stale";

interface FolderRef {
  id: string;
  name?: string;
  supportsReadScope?: boolean;
}

function toHandle(folder: FolderRef): ProjectFolderHandle {
  return {
    id: folder.id,
    name: folder.name ?? "Project",
    tier: "external",
  };
}

function toDirEntry(entry: NativeDirEntry): DirEntry {
  return {
    name: entry.name,
    isDir: entry.isDir,
    size: entry.size ?? null,
    mtime: entry.mtime ?? null,
  };
}

function toFileStat(stat: NativeFileStat): FileStat {
  return {
    isDir: stat.isDir,
    size: stat.size ?? null,
    mtime: stat.mtime ?? null,
  };
}

/**
 * Opt-in external-folder tier via our own Capacitor scoped-storage plugin.
 * Native scope identities are kept in native storage under a stable folder id.
 * @see .agents/reference/architecture/vfs.md
 */
export class ScopedStorageAdapter implements ProjectStorage {
  private reads = new StorageReadCounter();
  getReadMetrics() { return this.reads.snapshot(); }
  private folder: FolderRef | null = null;
  private stale = false;
  private readonly plugin: BabylonSlateScopedStoragePlugin;
  private readScopeId: string | undefined;
  private readScopeClosed = false;
  /** File bytes as raw bodies where the host has the binary transport; else the plugin's base64 calls. */
  private readonly bridge: Promise<NativeBinaryBridge | null>;

  constructor(
    plugin: BabylonSlateScopedStoragePlugin = BabylonSlateScopedStorage,
    bridge?: NativeBinaryBridge | null | Promise<NativeBinaryBridge | null>,
  ) {
    this.plugin = plugin;
    this.bridge = bridge === undefined ? nativeBinaryBridge(plugin) : Promise.resolve(bridge);
  }

  private location(folder: FolderRef, path: string): NativeFileLocation {
    return { folder: folder.id, path, ...(this.readScopeId ? { readScope: this.readScopeId } : {}) };
  }

  private async withScope<T>(
    fn: () => Promise<T>,
    opts?: { path?: string },
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        isScopedStorageError(err, ScopedStorageErrorCode.Stale) ||
        isScopedStorageError(err, ScopedStorageErrorCode.AccessRevoked)
      ) {
        this.stale = true;
        await Preferences.set({ key: STALE_PREF_KEY, value: "1" });
        throw err;
      }
      if (isScopedStorageError(err, ScopedStorageErrorCode.NotFound)) {
        const message = opts?.path
          ? `File not found: ${opts.path}`
          : "File not found";
        throw new StorageNotFoundError(opts?.path ?? "", { cause: err, message });
      }
      if (isScopedStorageError(err, ScopedStorageErrorCode.RevisionChanged)) {
        rethrowNativeStorageRangeError(err, opts?.path ?? "asset");
      }
      throw err;
    }
  }

  async init(): Promise<void> {
    const { value } = await Preferences.get({ key: FOLDER_PREF_KEY });
    if (value) {
      try {
        const folder: unknown = JSON.parse(value);
        if (folder && typeof folder === "object" && "id" in folder &&
            typeof folder.id === "string" && folder.id &&
            (!("name" in folder) || typeof folder.name === "string")) {
          this.folder = folder as FolderRef;
        }
      } catch {
        // Invalid old preferences must not prevent opening local projects.
      }
    }
    const stale = await Preferences.get({ key: STALE_PREF_KEY });
    this.stale = !!this.folder && stale.value === "1";
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    const { folder } = await this.withScope(() => this.plugin.pickFolder());
    this.folder = folder;
    this.stale = false;
    await Preferences.set({
      key: FOLDER_PREF_KEY,
      value: JSON.stringify(this.folder),
    });
    await Preferences.set({ key: STALE_PREF_KEY, value: "0" });
    return toHandle(this.folder);
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    void name;
    throw new Error(
      "Documents tier is handled by DocumentsStorageAdapter; use createStorage()",
    );
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    if (handle.tier !== "external") throw new Error("Expected an external project folder");
    let folder: FolderRef;
    try {
      ({ folder } = await this.plugin.openFolder({ id: handle.id }));
    } catch (error) {
      if (isScopedStorageError(error, ScopedStorageErrorCode.Stale) ||
          isScopedStorageError(error, ScopedStorageErrorCode.AccessRevoked) ||
          isScopedStorageError(error, ScopedStorageErrorCode.NotFound)) {
        this.folder = { id: handle.id, name: handle.name };
        this.stale = true;
        await Preferences.set({ key: FOLDER_PREF_KEY, value: JSON.stringify(this.folder) });
        await Preferences.set({ key: STALE_PREF_KEY, value: "1" });
        if (isScopedStorageError(error, ScopedStorageErrorCode.NotFound)) {
          throw new Error("Project folder access is missing; reconnect required", { cause: error });
        }
      }
      throw error;
    }
    this.folder = folder;
    this.stale = false;
    await Preferences.set({
      key: FOLDER_PREF_KEY,
      value: JSON.stringify(this.folder),
    });
    await Preferences.set({ key: STALE_PREF_KEY, value: "0" });
    return toHandle(this.folder);
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return this.folder ? [toHandle(this.folder)] : [];
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder ? toHandle(this.folder) : null;
  }

  /** Forgets the folder and ends the native session access to it (iOS holds one security-scoped access per folder). */
  async releaseFolder(): Promise<void> {
    const folder = this.folder;
    this.folder = null;
    this.stale = false;
    await Preferences.remove({ key: FOLDER_PREF_KEY });
    await Preferences.remove({ key: STALE_PREF_KEY });
    if (folder) await this.plugin.releaseFolder({ folder: folder.id });
  }

  async needsReconnect(): Promise<boolean> {
    return this.stale;
  }

  async reconnectFolder(validate?: (candidate: ProjectStorage) => Promise<void>): Promise<ProjectFolderHandle> {
    const { folder } = await this.plugin.pickFolder();
    const candidate = new ScopedStorageAdapter(this.plugin, this.bridge);
    candidate.folder = folder;
    await validate?.(candidate);
    this.folder = folder;
    this.stale = false;
    await Preferences.set({ key: FOLDER_PREF_KEY, value: JSON.stringify(folder) });
    await Preferences.set({ key: STALE_PREF_KEY, value: "0" });
    return toHandle(folder);
  }

  async readText(path: string): Promise<string> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    const { data } = await this.withScope(
      () =>
        this.plugin.readFile({
          folder: folder.id,
          ...(this.readScopeId ? { readScope: this.readScopeId } : {}),
          path,
          encoding: "utf8",
        }),
      { path },
    );
    this.reads.record("full", utf8ByteLength(data));
    return data;
  }

  async writeText(path: string, data: string): Promise<void> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    await this.withScope(() =>
      this.plugin.writeFile({
        folder: folder.id,
        path,
        data,
        encoding: "utf8",
      }),
    );
  }

  async readBinary(path: string, options?: StorageReadOptions): Promise<Uint8Array> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    const bridge = await this.bridge;
    const bytes = await this.withScope(async () => bridge
      ? bridge.read(this.location(folder, path), options)
      : decodeBase64((await this.plugin.readFile({
        folder: folder.id,
        ...(this.readScopeId ? { readScope: this.readScopeId } : {}),
        path,
        encoding: "base64",
      })).data), { path });
    this.reads.record("full", bytes.byteLength);
    return bytes;
  }

  async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string, options?: StorageReadOptions) {
    path = scopedStoragePath(path, false);
    validateStorageRange(offset, length);
    const folder = this.getFolder();
    const bridge = await this.bridge;
    const result = await this.reads.range(length, () => this.withScope<NativeBinaryRange | NativeRangeRead>(() => bridge
      ? bridge.readRange(this.location(folder, path), offset, length, expectedRevision, options)
      : this.plugin.readFileRange({
        folder: folder.id, path, offset, length, expectedRevision,
        ...(this.readScopeId ? { readScope: this.readScopeId } : {}),
      }), { path }));
    try {
      const bytes = "bytes" in result ? result.bytes : decodeBase64(result.data);
      return validateStorageRangeResult(path, offset, length, { ...result, bytes }, expectedRevision);
    } catch (error) { rethrowStorageReadFailure(error, result.actualBytesRead); }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    const bridge = await this.bridge;
    await this.withScope(async () => {
      if (bridge && await bridge.write({ folder: folder.id, path }, data)) return;
      await this.plugin.writeFile({
        folder: folder.id,
        path,
        data: encodeBase64(data),
        encoding: "base64",
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    path = scopedStoragePath(path, true);
    const folder = this.getFolder();
    try {
      const { exists } = await this.withScope(() =>
        this.plugin.exists({ folder: folder.id, path, ...(this.readScopeId ? { readScope: this.readScopeId } : {}) }),
      );
      return exists;
    } catch (error) {
      if (isStorageNotFound(error)) return false;
      throw error;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    path = scopedStoragePath(path, true);
    const folder = this.getFolder();
    const { entries } = await this.withScope(() =>
      this.plugin.readdir({ folder: folder.id, path, ...(this.readScopeId ? { readScope: this.readScopeId } : {}) }),
    );
    return entries.map(toDirEntry);
  }

  async mkdir(path: string, recursive?: boolean): Promise<void> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    await this.withScope(() =>
      this.plugin.mkdir({ folder: folder.id, path, recursive }),
    );
  }

  async remove(path: string): Promise<void> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    await this.withScope(async () => {
      const { exists, isDirectory } = await this.plugin.exists({
        folder: folder.id,
        path,
      });
      if (!exists) {
        throw new StorageNotFoundError(path);
      }
      if (isDirectory) {
        await this.plugin.rmdir({ folder: folder.id, path, recursive: true });
      } else {
        await this.plugin.deleteFile({ folder: folder.id, path });
      }
    });
  }

  async stat(path: string): Promise<FileStat> {
    path = scopedStoragePath(path, true);
    const folder = this.getFolder();
    const stat = await this.withScope(
      () => this.plugin.stat({ folder: folder.id, path, ...(this.readScopeId ? { readScope: this.readScopeId } : {}) }),
      { path },
    );
    return toFileStat(stat);
  }

  private getFolder(): FolderRef {
    if (this.readScopeClosed) throw new Error("Read scope is closed");
    if (!this.folder) {
      throw new Error("No project folder selected");
    }
    if (this.stale) {
      throw new Error("Project folder bookmark is stale; reconnect required");
    }
    return this.folder;
  }

  async withReadScope<T>(operation: (storage: ProjectStorageReader) => Promise<T>): Promise<T> {
    const folder = this.getFolder();
    if (!folder.supportsReadScope || !this.plugin.beginReadScope || !this.plugin.endReadScope) return operation(this);
    const { readScope } = await this.withScope(() => this.plugin.beginReadScope!({ folder: folder.id }));
    // A distinct reader keeps simultaneous scans and ordinary I/O independent.
    const reader = new ScopedStorageAdapter(this.plugin, this.bridge);
    reader.folder = folder;
    reader.reads = this.reads;
    reader.readScopeId = readScope;
    try { return await operation(reader); }
    finally {
      reader.readScopeClosed = true;
      if (reader.stale && this.folder?.id === folder.id) this.stale = true;
      await this.plugin.endReadScope({ readScope });
    }
  }
}
