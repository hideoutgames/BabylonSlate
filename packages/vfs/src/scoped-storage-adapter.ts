import type {
  DirEntry,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { Preferences } from "@capacitor/preferences";
import { ScopedStorage } from "@daniele-rolli/capacitor-scoped-storage";

const FOLDER_PREF_KEY = "babylonslate:scoped-folder";

interface FolderRef {
  id: string;
  name?: string;
}

function toHandle(folder: FolderRef): ProjectFolderHandle {
  return { id: folder.id, name: folder.name ?? "Project" };
}

export class ScopedStorageAdapter implements ProjectStorage {
  private folder: FolderRef | null = null;

  async init(): Promise<void> {
    const { value } = await Preferences.get({ key: FOLDER_PREF_KEY });
    if (value) {
      this.folder = JSON.parse(value) as FolderRef;
    }
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    const { folder } = await ScopedStorage.pickFolder();
    this.folder = folder;
    await Preferences.set({
      key: FOLDER_PREF_KEY,
      value: JSON.stringify(folder),
    });
    return toHandle(folder);
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder ? toHandle(this.folder) : null;
  }

  private getFolder(): FolderRef {
    if (!this.folder) {
      throw new Error("No project folder selected");
    }
    return this.folder;
  }

  async readText(path: string): Promise<string> {
    const { data } = await ScopedStorage.readFile({
      folder: this.getFolder(),
      path,
      encoding: "utf8",
    });
    return data;
  }

  async writeText(path: string, data: string): Promise<void> {
    await ScopedStorage.writeFile({
      folder: this.getFolder(),
      path,
      data,
      encoding: "utf8",
    });
  }

  async exists(path: string): Promise<boolean> {
    const { exists } = await ScopedStorage.exists({
      folder: this.getFolder(),
      path,
    });
    return exists;
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const { entries } = await ScopedStorage.readdir({
      folder: this.getFolder(),
      path,
    });
    return entries;
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await ScopedStorage.mkdir({
      folder: this.getFolder(),
      path,
      recursive,
    });
  }
}
