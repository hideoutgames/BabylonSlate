import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { Preferences } from "@capacitor/preferences";
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
      if (isScopedStorageError(err, ScopedStorageErrorCode.Stale)) {
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
      this.folder = JSON.parse(value) as FolderRef;
    }
    const stale = await Preferences.get({ key: STALE_PREF_KEY });
    this.stale = stale.value === "1";

    if (this.folder && isLegacyBookmark(this.folder.id)) {
      await this.withScope(async () => {
        if (!this.folder || !this.plugin.importBookmark) {
          return;
        }
        const { folder } = await this.plugin.importBookmark({
          bookmark: this.folder.id,
          name: this.folder.name,
        });
        this.folder = folder;
        await Preferences.set({
          key: FOLDER_PREF_KEY,
          value: JSON.stringify(this.folder),
        });
      });
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
    const { folder } = await this.withScope(() =>
      this.plugin.openFolder({ id: handle.id }),
    );
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

  async reconnectFolder(): Promise<ProjectFolderHandle> {
    return this.pickProjectFolder();
  }

  async readText(path: string): Promise<string> {
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
    const folder = this.getFolder();
    const { exists } = await this.withScope(() =>
      this.plugin.exists({ folder: folder.id, path }),
    );
    return exists;
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const folder = this.getFolder();
    const { entries } = await this.withScope(() =>
      this.plugin.readdir({ folder: folder.id, path }),
    );
    return entries.map(toDirEntry);
  }

  async mkdir(path: string, recursive?: boolean): Promise<void> {
    const folder = this.getFolder();
    await this.withScope(() =>
      this.plugin.mkdir({ folder: folder.id, path, recursive }),
    );
  }

  async remove(path: string): Promise<void> {
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
