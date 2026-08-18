import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { MemoryStorageAdapter } from "./memory-adapter";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "./test-mode";

const META_KEY = "babylonslate:opfs-meta";

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
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore when localStorage unavailable */
  }
}

/**
 * OPFS-backed web adapter. Uses an in-memory fallback when
 * `navigator.storage.getDirectory` is unavailable (jsdom).
 */
export class OpfsStorageAdapter implements ProjectStorage {
  private folder: ProjectFolderHandle | null = null;
  private root: FileSystemDirectoryHandle | null = null;
  private readonly memory = new MemoryStorageAdapter("opfs");
  private opfsUnavailable =
    typeof navigator === "undefined" || !navigator.storage?.getDirectory;

  private async getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
    if (this.opfsUnavailable) return null;
    if (this.root) return this.root;
    try {
      this.root = await navigator.storage.getDirectory();
      return this.root;
    } catch {
      this.opfsUnavailable = true;
      return null;
    }
  }

  private remember(handle: ProjectFolderHandle): ProjectFolderHandle {
    this.folder = handle;
    const meta = loadMeta();
    if (!meta.projects.some((p) => p.id === handle.id)) {
      meta.projects.push({ id: handle.id, name: handle.name });
    }
    meta.currentId = handle.id;
    saveMeta(meta);
    return handle;
  }

  private async bind(name: string): Promise<ProjectFolderHandle> {
    const id = `opfs:${name}`;
    const opfs = await this.getOpfsRoot();
    if (!opfs) {
      await this.memory.pickProjectFolder(name);
      return this.remember({ id, name, tier: "opfs" });
    }
    await opfs.getDirectoryHandle(id.replace(/[^a-zA-Z0-9._:-]/g, "_"), {
      create: true,
    });
    return this.remember({ id, name, tier: "opfs" });
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
    return this.bind(handle.name);
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
    this.folder = null;
    const meta = loadMeta();
    meta.currentId = null;
    saveMeta(meta);
    await this.memory.releaseFolder();
  }

  private assertFolder(): ProjectFolderHandle {
    const folder = this.getCurrentFolder();
    if (!folder) {
      throw new Error("No project folder selected");
    }
    return folder;
  }

  private async usingMemory(): Promise<boolean> {
    return !(await this.getOpfsRoot());
  }

  private async ensureMemoryBound(): Promise<void> {
    const folder = this.assertFolder();
    if (!this.memory.getCurrentFolder()) {
      await this.memory.pickProjectFolder(folder.name);
    }
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
    if (!opfs) throw new Error("OPFS unavailable");
    return opfs.getDirectoryHandle(
      folder.id.replace(/[^a-zA-Z0-9._:-]/g, "_"),
      { create: true },
    );
  }

  private async resolveHandle(
    path: string,
    create: boolean,
  ): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    const dir = await this.projectDir();
    const parts = this.split(path);
    if (parts.length === 0) {
      throw new Error(`Invalid path: ${path}`);
    }
    let parent = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      parent = await parent.getDirectoryHandle(parts[i]!, { create });
    }
    return { parent, name: parts[parts.length - 1]! };
  }

  async readBinary(path: string): Promise<Uint8Array> {
    if (await this.usingMemory()) {
      await this.ensureMemoryBound();
      return this.memory.readBinary(path);
    }
    try {
      const { parent, name } = await this.resolveHandle(path, false);
      const file = await (await parent.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    if (await this.usingMemory()) {
      await this.ensureMemoryBound();
      return this.memory.writeBinary(path, data);
    }
    const { parent, name } = await this.resolveHandle(path, true);
    const writable = await (
      await parent.getFileHandle(name, { create: true })
    ).createWritable();
    await writable.write(data);
    await writable.close();
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
    } catch (err) {
      if (err instanceof Error && err.message.includes("No project folder")) {
        throw err;
      }
      return false;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    if (await this.usingMemory()) {
      await this.ensureMemoryBound();
      return this.memory.readdir(path);
    }
    const root = await this.projectDir();
    const parts = this.split(path === "." ? "" : path);
    let dir = root;
    try {
      for (const seg of parts) {
        dir = await dir.getDirectoryHandle(seg);
      }
    } catch {
      throw new Error(`File not found: ${path}`);
    }
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
          const file = await (handle as FileSystemFileHandle).getFile();
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
    if (await this.usingMemory()) {
      await this.ensureMemoryBound();
      return this.memory.mkdir(path, recursive);
    }
    const root = await this.projectDir();
    let dir = root;
    for (const seg of this.split(path)) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
  }

  async remove(path: string): Promise<void> {
    if (await this.usingMemory()) {
      await this.ensureMemoryBound();
      return this.memory.remove(path);
    }
    try {
      const { parent, name } = await this.resolveHandle(path, false);
      await parent.removeEntry(name, { recursive: true });
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async stat(path: string): Promise<FileStat> {
    if (await this.usingMemory()) {
      await this.ensureMemoryBound();
      return this.memory.stat(path);
    }
    const root = await this.projectDir();
    const parts = this.split(path);
    if (parts.length === 0) {
      return { isDir: true, size: null, mtime: null };
    }
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]!);
    }
    const name = parts[parts.length - 1]!;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return { isDir: false, size: file.size, mtime: file.lastModified };
    } catch {
      try {
        await dir.getDirectoryHandle(name);
        return { isDir: true, size: null, mtime: null };
      } catch {
        throw new Error(`File not found: ${path}`);
      }
    }
  }
}

/** @deprecated Alias — prefer OpfsStorageAdapter. */
export class WebStorageAdapter extends OpfsStorageAdapter {}
