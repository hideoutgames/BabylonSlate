import { checkStorageRevision, StorageReadCounter, validateStorageRange } from "./storage-range";
import { open, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectFolderName, projectRelativePath } from "./project-path";
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
  private readonly reads = new StorageReadCounter();
  getReadMetrics() { return this.reads.snapshot(); }

  private folder: ProjectFolderHandle | null = null;
  private rootPath: string | null = null;
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }
  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    return this.openDocumentsProject("MyGame");
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    const root = confinedPath(resolve(this.baseDir), projectFolderName(name));
    await mkdir(root, { recursive: true });
    this.rootPath = root;
    this.folder = { id: `node:${root}`, name, tier: "documents" };
    return this.folder;
  }

  async openAbsoluteFolder(
    absPath: string,
    name?: string,
    tier: ProjectFolderHandle["tier"] = "external",
  ): Promise<ProjectFolderHandle> {
    const root = resolve(absPath);
    await mkdir(root, { recursive: true });
    this.rootPath = root;
    this.folder = {
      id: `node:${root}`,
      name: name ?? root.split(/[\\/]/).pop() ?? "Project",
      tier,
    };
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

  private resolvePath(path: string, allowRoot = false): string {
    const root = this.assertRoot();
    return confinedPath(root, projectRelativePath(allowRoot && path === "." ? "" : path, allowRoot));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    try {
      const buf = await readFile(this.resolvePath(path));
      this.reads.record("full", buf.byteLength);
      return new Uint8Array(buf);
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string) {
    validateStorageRange(offset, length);
    const full = this.resolvePath(path);
    const handle = await open(full, "r");
    let actualBytesRead = 0;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`Not a file: ${path}`);
      const revisionOf = (value: typeof before) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
      const revision = revisionOf(before);
      checkStorageRevision(path, revision, expectedRevision);
      const totalSize = Number(before.size);
      validateStorageRange(offset, length, totalSize);
      const bytes = new Uint8Array(length);
      while (actualBytesRead < length) {
        const read = await handle.read(bytes, actualBytesRead, length - actualBytesRead, offset + actualBytesRead);
        if (read.bytesRead === 0) throw new Error(`Unexpected end of file: ${path}`);
        actualBytesRead += read.bytesRead;
      }
      checkStorageRevision(path, revisionOf(await handle.stat({ bigint: true })), revision);
      // An atomic replacement leaves the old descriptor valid; reject it too.
      checkStorageRevision(path, revisionOf(await stat(full, { bigint: true })), revision);
      return { bytes, totalSize, revision, actualBytesRead };
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { actualBytesRead });
    } finally {
      this.reads.record("range", length, actualBytesRead);
      await handle.close();
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
      await stat(this.resolvePath(path, true));
      return true;
    } catch {
      return false;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const full = this.resolvePath(path === "." ? "" : path, true);
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
      const s = await stat(this.resolvePath(path, true));
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

function confinedPath(root: string, path: string): string {
  const full = resolve(root, path);
  const within = relative(root, full);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes project root: ${path}`);
  }
  return full;
}
