import type {
  DirEntry,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/shared";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "./test-mode";

const FOLDER_KEY = "babylonslate:web-folder";

interface WebStore {
  folder: ProjectFolderHandle | null;
  files: Record<string, string>;
}

function loadStore(): WebStore {
  const raw = localStorage.getItem(FOLDER_KEY);
  if (!raw) {
    return { folder: null, files: {} };
  }
  return JSON.parse(raw) as WebStore;
}

function saveStore(store: WebStore): void {
  localStorage.setItem(FOLDER_KEY, JSON.stringify(store));
}

export class WebStorageAdapter implements ProjectStorage {
  private store = loadStore();

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    const name = isTestModeEnabled()
      ? TEST_PROJECT_NAME
      : (globalThis.prompt?.("Project folder name", "MyGame.babylonslate") ??
        "MyGame.babylonslate");
    const folder: ProjectFolderHandle = {
      id: `web:${name}`,
      name,
    };
    this.store.folder = folder;
    saveStore(this.store);
    return folder;
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.store.folder;
  }

  private assertFolder(): ProjectFolderHandle {
    if (!this.store.folder) {
      throw new Error("No project folder selected");
    }
    return this.store.folder;
  }

  async readText(path: string): Promise<string> {
    this.assertFolder();
    const data = this.store.files[path];
    if (data === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return data;
  }

  async writeText(path: string, data: string): Promise<void> {
    this.assertFolder();
    this.store.files[path] = data;
    saveStore(this.store);
  }

  async exists(path: string): Promise<boolean> {
    this.assertFolder();
    return Object.prototype.hasOwnProperty.call(this.store.files, path);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    this.assertFolder();
    const prefix = path === "" || path === "." ? "" : `${path.replace(/\/$/, "")}/`;
    const names = new Set<string>();

    for (const filePath of Object.keys(this.store.files)) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const segment = rest.split("/")[0];
      if (segment) names.add(segment);
    }

    return [...names].map((name) => ({
      name,
      isDir: Object.keys(this.store.files).some((p) =>
        p.startsWith(`${prefix}${name}/`),
      ),
    }));
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    this.assertFolder();
    const marker = path.endsWith("/") ? `${path}.keep` : `${path}/.keep`;
    if (!this.store.files[marker]) {
      this.store.files[marker] = "";
      saveStore(this.store);
    }
    if (recursive) {
      // Web adapter uses flat file map; marker is sufficient for directory creation.
    }
  }
}
