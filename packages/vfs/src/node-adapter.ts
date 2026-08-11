import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";

/**
 * Node filesystem adapter for CI and tooling.
 */
export class NodeStorageAdapter implements ProjectStorage {
  private folder: ProjectFolderHandle | null = null;
  private rootPath: string | null = null;
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }
  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    return this.openDocumentsProject("MyGame.babproject");
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    const root = resolve(this.baseDir, name);
    await mkdir(root, { recursive: true });
    this.rootPath = root;
    this.folder = { id: `node:${root}`, name, tier: "documents" };
    return this.folder;
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    return this.openDocumentsProject(handle.name);
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    await mkdir(this.baseDir, { recursive: true });
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        id: `node:${resolve(this.baseDir, e.name)}`,
        name: e.name,
        tier: "documents" as const,
      }));
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder;
  }

  async releaseFolder(): Promise<void> {
    this.folder = null;
    this.rootPath = null;
  }

  private assertRoot(): string {
    if (!this.rootPath) {
      throw new Error("No project folder selected");
    }
    return this.rootPath;
  }

  private resolvePath(path: string): string {
    const root = this.assertRoot();
    const cleaned = path.replace(/^\.\/+/, "").replace(/^\/+/, "");
    const full = resolve(root, cleaned);
    if (!full.startsWith(root)) {
      throw new Error(`Path escapes project root: ${path}`);
    }
    return full;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    try {
      const buf = await readFile(this.resolvePath(path));
      return new Uint8Array(buf);
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const full = this.resolvePath(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBinary(path));
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBinary(path, new TextEncoder().encode(data));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(path));
      return true;
    } catch {
      return false;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const full = this.resolvePath(path === "." ? "" : path);
    try {
      const entries = await readdir(full, { withFileTypes: true });
      const out: DirEntry[] = [];
      for (const e of entries) {
        const s = await stat(join(full, e.name));
        out.push({
          name: e.name,
          isDir: e.isDirectory(),
          size: e.isFile() ? s.size : null,
          mtime: s.mtimeMs,
        });
      }
      return out;
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await mkdir(this.resolvePath(path), { recursive });
  }

  async remove(path: string): Promise<void> {
    try {
      await rm(this.resolvePath(path), { recursive: true, force: false });
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const s = await stat(this.resolvePath(path));
      return {
        isDir: s.isDirectory(),
        size: s.isFile() ? s.size : null,
        mtime: s.mtimeMs,
      };
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }
}
