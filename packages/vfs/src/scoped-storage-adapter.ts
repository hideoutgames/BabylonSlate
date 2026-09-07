import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { Preferences } from "@capacitor/preferences";
import { projectRelativePath as scopedStoragePath } from "./project-path";
import type {
  BabylonSlateScopedStoragePlugin,
  NativeDirEntry,
  NativeFileStat,
} from "./capacitor-scoped-storage";
import {
  BabylonSlateScopedStorage,
  isScopedStorageError,
  ScopedStorageErrorCode,
} from "./capacitor-scoped-storage";

const FOLDER_PREF_KEY = "babylonslate:scoped-folder";
const STALE_PREF_KEY = "babylonslate:scoped-stale";

interface FolderRef {
  id: string;
  name?: string;
}

function toHandle(folder: FolderRef): ProjectFolderHandle {
  return {
    id: folder.id,
    name: folder.name ?? "Project",
    tier: "external",
  };
}

function isLegacyBookmark(id: string): boolean {
  // Legacy ids are base64 bookmarks; new ids are UUIDs.
  return /^[A-Za-z0-9+/=]{40,}$/.test(id) && !/^[0-9a-f-]{36}$/i.test(id);
}

function encodeBinary(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

function decodeBinary(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
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
 * Bookmarks are kept in native storage keyed by a stable folder id.
 * @see docs/architecture/vfs.md
 */
export class ScopedStorageAdapter implements ProjectStorage {
  private folder: FolderRef | null = null;
  private stale = false;
  private readonly plugin: BabylonSlateScopedStoragePlugin;

  constructor(
    plugin: BabylonSlateScopedStoragePlugin = BabylonSlateScopedStorage,
  ) {
    this.plugin = plugin;
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
        throw new Error(message, { cause: err });
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

    if (this.folder && isLegacyBookmark(this.folder.id)) {
      try {
        await this.openKnownFolder(toHandle(this.folder));
      } catch {
        // An offline legacy provider must not block the Documents tier.
        // Keep its identity for a later explicit reconnect instead.
        this.stale = true;
        await Preferences.set({ key: STALE_PREF_KEY, value: "1" });
      }
    }
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
      if (isLegacyBookmark(handle.id)) {
        if (!this.plugin.importBookmark) throw { code: ScopedStorageErrorCode.Stale };
        ({ folder } = await this.plugin.importBookmark({ bookmark: handle.id, name: handle.name }));
      } else {
        ({ folder } = await this.plugin.openFolder({ id: handle.id }));
      }
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

  async releaseFolder(): Promise<void> {
    this.folder = null;
    this.stale = false;
    await Preferences.remove({ key: FOLDER_PREF_KEY });
    await Preferences.remove({ key: STALE_PREF_KEY });
  }

  async needsReconnect(): Promise<boolean> {
    return this.stale;
  }

  async reconnectFolder(validate?: (candidate: ProjectStorage) => Promise<void>): Promise<ProjectFolderHandle> {
    const { folder } = await this.plugin.pickFolder();
    const candidate = new ScopedStorageAdapter(this.plugin);
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
          path,
          encoding: "utf8",
        }),
      { path },
    );
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

  async readBinary(path: string): Promise<Uint8Array> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    const { data } = await this.withScope(
      () =>
        this.plugin.readFile({
          folder: folder.id,
          path,
          encoding: "base64",
        }),
      { path },
    );
    return decodeBinary(data);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    path = scopedStoragePath(path, false);
    const folder = this.getFolder();
    await this.withScope(() =>
      this.plugin.writeFile({
        folder: folder.id,
        path,
        data: encodeBinary(data),
        encoding: "base64",
      }),
    );
  }

  async exists(path: string): Promise<boolean> {
    path = scopedStoragePath(path, true);
    const folder = this.getFolder();
    const { exists } = await this.withScope(() =>
      this.plugin.exists({ folder: folder.id, path }),
    );
    return exists;
  }

  async readdir(path: string): Promise<DirEntry[]> {
    path = scopedStoragePath(path, true);
    const folder = this.getFolder();
    const { entries } = await this.withScope(() =>
      this.plugin.readdir({ folder: folder.id, path }),
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
        throw new Error(`File not found: ${path}`);
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
      () => this.plugin.stat({ folder: folder.id, path }),
      { path },
    );
    return toFileStat(stat);
  }

  /** Test helper — mark the folder stale. */
  async markStale(): Promise<void> {
    this.stale = true;
    await Preferences.set({ key: STALE_PREF_KEY, value: "1" });
  }

  private getFolder(): FolderRef {
    if (!this.folder) {
      throw new Error("No project folder selected");
    }
    if (this.stale) {
      throw new Error("Project folder bookmark is stale; reconnect required");
    }
    return this.folder;
  }
}
