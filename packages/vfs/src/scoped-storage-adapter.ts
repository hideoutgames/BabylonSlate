import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { Preferences } from "@capacitor/preferences";
import { ScopedStorage } from "@daniele-rolli/capacitor-scoped-storage";

const FOLDER_PREF_KEY = "babylonslate:scoped-folder";
const STALE_PREF_KEY = "babylonslate:scoped-stale";

interface FolderRef {
  id: string;
  name?: string;
}

type PluginDirEntry = {
  name?: string;
  isDir?: boolean;
  type?: string;
  size?: number | null;
  mtime?: number | null;
};

function toDirEntry(entry: PluginDirEntry): DirEntry {
  return {
    name: entry.name ?? "",
    isDir: entry.isDir ?? entry.type === "directory",
    size: entry.size ?? null,
    mtime: entry.mtime ?? null,
  };
}

function toHandle(folder: FolderRef): ProjectFolderHandle {
  return {
    id: folder.id,
    name: folder.name ?? "Project",
    tier: "external",
  };
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

/**
 * Opt-in external-folder tier via Capacitor scoped storage.
 * Bookmark staleness surfaces as needsReconnect() → Homepage Reconnect flow.
 * Working Copy / NSFileCoordinator spike: expect a custom Swift plugin; see docs/architecture/vfs.md.
 */
export class ScopedStorageAdapter implements ProjectStorage {
  private folder: FolderRef | null = null;
  private stale = false;

  async init(): Promise<void> {
    const { value } = await Preferences.get({ key: FOLDER_PREF_KEY });
    if (value) {
      this.folder = JSON.parse(value) as FolderRef;
    }
    const stale = await Preferences.get({ key: STALE_PREF_KEY });
    this.stale = stale.value === "1";
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    const { folder } = await ScopedStorage.pickFolder();
    this.folder = folder;
    this.stale = false;
    await Preferences.set({
      key: FOLDER_PREF_KEY,
      value: JSON.stringify(folder),
    });
    await Preferences.set({ key: STALE_PREF_KEY, value: "0" });
    return toHandle(folder);
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
    if (handle.tier !== "external") {
      throw new Error(`Scoped adapter cannot open tier ${handle.tier}`);
    }
    if (this.stale) {
      throw new Error("Project folder bookmark is stale; reconnect required");
    }
    // Rebind from persisted bookmark without showing the picker.
    if (this.folder && this.folder.id === handle.id) {
      return toHandle(this.folder);
    }
    this.folder = { id: handle.id, name: handle.name };
    await Preferences.set({
      key: FOLDER_PREF_KEY,
      value: JSON.stringify(this.folder),
    });
    return toHandle(this.folder);
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return this.folder && !this.stale ? [toHandle(this.folder)] : [];
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder ? toHandle(this.folder) : null;
  }

  async releaseFolder(): Promise<void> {
    this.folder = null;
    await Preferences.remove({ key: FOLDER_PREF_KEY });
    await Preferences.set({ key: STALE_PREF_KEY, value: "0" });
  }

  async needsReconnect(): Promise<boolean> {
    return this.stale;
  }

  async reconnectFolder(): Promise<ProjectFolderHandle> {
    return this.pickProjectFolder();
  }

  /** Test / spike helper — mark the bookmark stale. */
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

  private async probe(
    path: string,
  ): Promise<{ exists: boolean; isDirectory: boolean }> {
    return this.withScope(async () => {
      const result = await ScopedStorage.exists({
        folder: this.getFolder(),
        path,
      });
      return {
        exists: result.exists,
        isDirectory: result.isDirectory ?? false,
      };
    });
  }

  private async withScope<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/bookmark|secur(e|ity).?scope|not.?access|stale/i.test(message)) {
        await this.markStale();
        throw new Error("Project folder bookmark is stale; reconnect required");
      }
      throw err;
    }
  }

  async readText(path: string): Promise<string> {
    return this.withScope(async () => {
      const { data } = await ScopedStorage.readFile({
        folder: this.getFolder(),
        path,
        encoding: "utf8",
      });
      return data;
    });
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.withScope(async () => {
      await ScopedStorage.writeFile({
        folder: this.getFolder(),
        path,
        data,
        encoding: "utf8",
      });
    });
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return this.withScope(async () => {
      const { data } = await ScopedStorage.readFile({
        folder: this.getFolder(),
        path,
        encoding: "base64",
      });
      return decodeBinary(data);
    });
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.withScope(async () => {
      await ScopedStorage.writeFile({
        folder: this.getFolder(),
        path,
        data: encodeBinary(data),
        encoding: "base64",
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    return (await this.probe(path)).exists;
  }

  async readdir(path: string): Promise<DirEntry[]> {
    return this.withScope(async () => {
      const { entries } = await ScopedStorage.readdir({
        folder: this.getFolder(),
        path,
      });
      return (entries as unknown as PluginDirEntry[]).map(toDirEntry);
    });
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await this.withScope(async () => {
      await ScopedStorage.mkdir({
        folder: this.getFolder(),
        path,
        recursive,
      });
    });
  }

  async remove(path: string): Promise<void> {
    const { exists, isDirectory } = await this.probe(path);
    if (!exists) {
      throw new Error(`File not found: ${path}`);
    }
    await this.withScope(async () => {
      const folder = this.getFolder();
      if (isDirectory) {
        await ScopedStorage.rmdir({ folder, path, recursive: true });
        return;
      }
      await ScopedStorage.deleteFile({ folder, path });
    });
  }

  async stat(path: string): Promise<FileStat> {
    const { exists, isDirectory } = await this.probe(path);
    if (!exists) {
      throw new Error(`File not found: ${path}`);
    }
    return this.withScope(async () => {
      const { size, mtime } = await ScopedStorage.stat({
        folder: this.getFolder(),
        path,
      });
      return {
        isDir: isDirectory,
        size: size ?? null,
        mtime: mtime ?? null,
      };
    });
  }
}
