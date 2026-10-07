import { checkStorageRevision, StorageReadCounter, validateStorageRange } from "./storage-range";
import type { Dirent, Stats } from "node:fs";
import { open, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectFolderName, projectRelativePath } from "./project-path";
import { isStorageNotFound, StorageNotFoundError } from "@babylonslate/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";

/** Only a missing entry (or a file in place of a parent directory) means "not found". */
function nodeStorageError(error: unknown, path: string): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? new StorageNotFoundError(path, { cause: error }) : error;
}

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
    const full = this.resolvePath(path);
    let buf: Buffer;
    try {
      buf = await readFile(full);
    } catch (error) {
      throw nodeStorageError(error, path);
    }
    this.reads.record("full", buf.byteLength);
    return new Uint8Array(buf);
  }

  async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string) {
    validateStorageRange(offset, length);
    const full = this.resolvePath(path);
    const handle = await open(full, "r").catch((error: unknown) => { throw nodeStorageError(error, path); });
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
      await this.stat(path);
      return true;
    } catch (error) {
      if (isStorageNotFound(error)) return false;
      throw error;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const full = this.resolvePath(path === "." ? "" : path, true);
    let entries: Dirent[];
    try {
      entries = await readdir(full, { withFileTypes: true });
    } catch (error) {
      throw nodeStorageError(error, path);
    }
    const out: DirEntry[] = [];
    for (const e of entries) {
      let s: Stats;
      try {
        s = await stat(join(full, e.name));
      } catch (error) {
        // Removed after it was listed.
        if ((error as { code?: unknown } | null)?.code === "ENOENT") continue;
        throw error;
      }
      out.push({
        name: e.name,
        isDir: e.isDirectory(),
        size: e.isFile() ? s.size : null,
        mtime: s.mtimeMs,
      });
    }
    return out;
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await mkdir(this.resolvePath(path), { recursive });
  }

  async remove(path: string): Promise<void> {
    const full = this.resolvePath(path);
    try {
      await rm(full, { recursive: true, force: false });
    } catch (error) {
      throw nodeStorageError(error, path);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const full = this.resolvePath(path, true);
    let s: Stats;
    try {
      s = await stat(full);
    } catch (error) {
      throw nodeStorageError(error, path);
    }
    return {
      isDir: s.isDirectory(),
      size: s.isFile() ? s.size : null,
      mtime: s.mtimeMs,
    };
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
