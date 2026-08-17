import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { Preferences } from "@capacitor/preferences";
import {
  BabylonSlateFolder,
  type BabylonSlateFolderPort,
  type FolderIdentity,
} from "./babylon-slate-folder-port";

const FOLDER_PREF_KEY = "babylonslate:scoped-folder";
const STALE_PREF_KEY = "babylonslate:scoped-stale";
const STALE_BOOKMARK_CODE = "STALE_BOOKMARK";

type FolderRef = FolderIdentity;

function toHandle(folder: FolderRef): ProjectFolderHandle {
  return {
    id: folder.id,
    name: folder.name || "Project",
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

function isStaleBookmarkError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === STALE_BOOKMARK_CODE
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /bookmark|secur(e|ity).?scope|not.?access|stale/i.test(message);
}

/**
 * Opt-in external-folder tier through the first-party iOS folder plugin.
 * The native plugin owns security-scoped access and coordinates file-provider I/O.
 */
export class ScopedStorageAdapter implements ProjectStorage {
  private folder: FolderRef | null = null;
  private stale = false;
  private readonly native: BabylonSlateFolderPort;

  constructor(native: BabylonSlateFolderPort = BabylonSlateFolder) {
    this.native = native;
  }

  async init(): Promise<void> {
    const { value } = await Preferences.get({ key: FOLDER_PREF_KEY });
    if (value) {
      this.folder = JSON.parse(value) as FolderRef;
    }
    const stale = await Preferences.get({ key: STALE_PREF_KEY });
    this.stale = stale.value === "1";
    if (this.folder && !this.stale) {
      try {
        await this.resolvePersistedFolder(this.folder);
      } catch (error) {
        console.warn("Unable to resolve the persisted external folder", error);
        this.stale = true;
        await this.persistStale(true);
      }
    }
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    const { folder } = await this.native.pickFolder();
    await this.persistFolder(folder);
    this.stale = false;
    await this.persistStale(false);
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
    const folder = await this.resolvePersistedFolder({
      id: handle.id,
      name: handle.name,
    });
    return toHandle(folder);
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return this.folder && !this.stale ? [toHandle(this.folder)] : [];
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder ? toHandle(this.folder) : null;
  }

  async releaseFolder(): Promise<void> {
    await this.native.releaseFolder();
    this.folder = null;
    this.stale = false;
    await Preferences.remove({ key: FOLDER_PREF_KEY });
    await this.persistStale(false);
  }

  async needsReconnect(): Promise<boolean> {
    return this.stale;
  }

  async reconnectFolder(): Promise<ProjectFolderHandle> {
    return this.pickProjectFolder();
  }

  /** Test / diagnostic helper for the Homepage reconnect state. */
  async markStale(): Promise<void> {
    this.stale = true;
    await this.persistStale(true);
  }

  private async resolvePersistedFolder(folder: FolderRef): Promise<FolderRef> {
    try {
      const result = await this.native.resolveFolder({ bookmark: folder.id });
      const resolved = result.folder;
      await this.persistFolder(resolved);
      this.folder = resolved;
      this.stale = false;
      await this.persistStale(false);
      return resolved;
    } catch (error) {
      if (isStaleBookmarkError(error)) {
        await this.markStale();
        throw new Error("Project folder bookmark is stale; reconnect required");
      }
      throw error;
    }
  }

  private async persistFolder(folder: FolderRef): Promise<void> {
    this.folder = folder;
    await Preferences.set({
      key: FOLDER_PREF_KEY,
      value: JSON.stringify(folder),
    });
  }

  private async persistStale(stale: boolean): Promise<void> {
    await Preferences.set({
      key: STALE_PREF_KEY,
      value: stale ? "1" : "0",
    });
  }

  private assertBound(): FolderRef {
    if (!this.folder) {
      throw new Error("No project folder selected");
    }
    if (this.stale) {
      throw new Error("Project folder bookmark is stale; reconnect required");
    }
    return this.folder;
  }

  private async withScope<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isStaleBookmarkError(error)) {
        await this.markStale();
        throw new Error("Project folder bookmark is stale; reconnect required");
      }
      throw error;
    }
  }

  async readText(path: string): Promise<string> {
    return this.withScope(async () => {
      this.assertBound();
      const { data } = await this.native.readFile({ path, encoding: "utf8" });
      return data;
    });
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.withScope(async () => {
      this.assertBound();
      await this.native.writeFile({ path, data, encoding: "utf8" });
    });
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return this.withScope(async () => {
      this.assertBound();
      const { data } = await this.native.readFile({ path, encoding: "base64" });
      return decodeBinary(data);
    });
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.withScope(async () => {
      this.assertBound();
      await this.native.writeFile({
        path,
        data: encodeBinary(data),
        encoding: "base64",
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.withScope(async () => {
      this.assertBound();
      const { exists } = await this.native.exists({ path });
      return exists;
    });
  }

  async readdir(path: string): Promise<DirEntry[]> {
    return this.withScope(async () => {
      this.assertBound();
      const { entries } = await this.native.readdir({ path });
      return entries;
    });
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await this.withScope(async () => {
      this.assertBound();
      await this.native.mkdir({ path, recursive });
    });
  }

  async remove(path: string): Promise<void> {
    await this.withScope(async () => {
      this.assertBound();
      const info = await this.native.stat({ path });
      if (info.type === "directory") {
        await this.native.rmdir({ path });
      } else {
        await this.native.deleteFile({ path });
      }
    });
  }

  async stat(path: string): Promise<FileStat> {
    return this.withScope(async () => {
      this.assertBound();
      const info = await this.native.stat({ path });
      return {
        isDir: info.type === "directory",
        size: info.type === "file" ? info.size : null,
        mtime: info.mtime,
      };
    });
  }
}
