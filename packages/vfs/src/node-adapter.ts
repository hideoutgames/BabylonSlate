import { checkStorageRevision, StorageReadCounter, validateStorageRange } from "./storage-range";
import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, open, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectFolderName, projectRelativePath } from "./project-path";
import { isStorageNotFound, StorageNotFoundError } from "@haptic/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@haptic/core";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Staged writes are renamed over their file; listings hide one a crash left behind. */
const STAGED_WRITE = /^\.haptic-[0-9a-f-]{36}\.tmp$/;

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** Only a missing entry (or a file in place of a parent directory) means "not found". */
function nodeStorageError(error: unknown, path: string): unknown {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" ? new StorageNotFoundError(path, { cause: error }) : error;
}

interface NodeRoot {
  /** As opened; project paths are joined to it. */
  path: string;
  /** With symbolic links resolved: every file the adapter touches must be inside it. */
  real: string;
}

/**
 * Node filesystem adapter for the Electron main process, CI and tooling.
 */
export class NodeStorageAdapter implements ProjectStorage {
  private readonly reads = new StorageReadCounter();
  getReadMetrics() { return this.reads.snapshot(); }

  private folder: ProjectFolderHandle | null = null;
  private root: NodeRoot | null = null;
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
    return this.bind(root, { id: `node:${root}`, name, tier: "documents" });
  }

  async openAbsoluteFolder(
    absPath: string,
    name?: string,
    tier: ProjectFolderHandle["tier"] = "external",
  ): Promise<ProjectFolderHandle> {
    const root = resolve(absPath);
    await mkdir(root, { recursive: true });
    return this.bind(root, {
      id: `node:${root}`,
      name: name ?? root.split(/[\\/]/).pop() ?? "Project",
      tier,
    });
  }

  /**
   * Reopens an existing Documents project by its id. Picked folders are
   * reopened by the host with `openAbsoluteFolder` after its own grant check.
   */
  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    const base = resolve(this.baseDir);
    const root = handle.id.startsWith("node:") ? resolve(handle.id.slice("node:".length)) : null;
    if (handle.tier !== "documents" || !root || dirname(root) !== base) {
      throw new Error(`Node adapter cannot open project ${handle.id}`);
    }
    const name = projectFolderName(basename(root));
    let info: Stats;
    try {
      info = await stat(root);
    } catch (error) {
      throw nodeStorageError(error, name);
    }
    if (!info.isDirectory()) throw new Error(`Project folder is not a directory: ${name}`);
    return this.bind(root, { id: `node:${root}`, name, tier: "documents" });
  }

  private async bind(root: string, handle: ProjectFolderHandle): Promise<ProjectFolderHandle> {
    const real = await realpath(root);
    this.root = { path: root, real };
    this.folder = handle;
    return handle;
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
    this.root = null;
  }

  private assertRoot(): NodeRoot {
    if (!this.root) {
      throw new Error("No project folder selected");
    }
    return this.root;
  }

  /**
   * Confine `path` lexically, then check where its existing part really is:
   * a symbolic link inside the project must not reach files outside it.
   * `followFinal: false` checks only the parent, for operations that act on
   * the link itself.
   */
  private async resolvePath(path: string, allowRoot = false, followFinal = true): Promise<{ full: string; root: NodeRoot }> {
    const root = this.assertRoot();
    const full = confinedPath(root.path, projectRelativePath(path, allowRoot));
    let candidate = followFinal ? full : dirname(full);
    for (let hops = 0; hops < 40; hops++) {
      let real: string | null = null;
      try {
        real = await realpath(candidate);
      } catch (error) {
        const code = errorCode(error);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      if (real !== null) {
        if (escapes(root.real, real)) throw new Error(`Path escapes project root: ${path}`);
        return { full, root };
      }
      // A missing root holds no links; the operation itself reports it.
      if (candidate === root.path) return { full, root };
      // Writing through a dangling link would create its target wherever it points.
      const link = await lstat(candidate).then((info) => info.isSymbolicLink(), () => false);
      candidate = link ? resolve(dirname(candidate), await readlink(candidate)) : dirname(candidate);
    }
    throw new Error(`Too many symbolic links: ${path}`);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const { full } = await this.resolvePath(path);
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
    const { full } = await this.resolvePath(path);
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

  /**
   * Stage the bytes beside the file, flush them, then rename over it, so a
   * crash leaves either the previous or the new file, never a truncated one.
   */
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const { full } = await this.resolvePath(path);
    // A link inside the project keeps pointing at its (checked) target.
    const target = await realpath(full).catch(() => full);
    await mkdir(dirname(target), { recursive: true });
    const staged = join(dirname(target), `.haptic-${randomUUID()}.tmp`);
    try {
      const file = await open(staged, "wx");
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(staged, target);
    } catch (error) {
      await unlink(staged).catch(() => {});
      throw error;
    }
  }

  async readText(path: string): Promise<string> {
    return textDecoder.decode(await this.readBinary(path));
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBinary(path, textEncoder.encode(data));
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
    const { full, root } = await this.resolvePath(path, true);
    let entries: Dirent[];
    try {
      entries = await readdir(full, { withFileTypes: true });
    } catch (error) {
      throw nodeStorageError(error, path);
    }
    const out: DirEntry[] = [];
    let ancestors: string[] | null = null;
    for (const e of entries) {
      if (STAGED_WRITE.test(e.name)) continue;
      const entryPath = join(full, e.name);
      let s: Stats;
      try {
        const target = e.isSymbolicLink() ? await realpath(entryPath) : null;
        // A link that resolves outside the project root is not part of the project.
        if (target !== null && escapes(root.real, target)) continue;
        s = await stat(entryPath);
        // A link to a directory on the path being listed (or one containing it)
        // would lead every recursive walk back here without end.
        if (target !== null && s.isDirectory()) {
          ancestors ??= await realAncestors(root, full);
          if (ancestors.some((dir) => !escapes(target, dir))) continue;
        }
      } catch (error) {
        // Removed after it was listed, or a dangling link.
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      // Pipes, sockets and devices are not project files.
      if (!s.isFile() && !s.isDirectory()) continue;
      out.push({
        name: e.name,
        isDir: s.isDirectory(),
        size: s.isFile() ? s.size : null,
        mtime: s.mtimeMs,
      });
    }
    return out;
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await mkdir((await this.resolvePath(path)).full, { recursive });
  }

  async remove(path: string): Promise<void> {
    // Removing a link removes the link, not its target.
    const { full } = await this.resolvePath(path, false, false);
    try {
      await rm(full, { recursive: true, force: false });
    } catch (error) {
      throw nodeStorageError(error, path);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const { full } = await this.resolvePath(path, true);
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

/**
 * Real locations of the root and of each directory on the path down to
 * `full`, as reached through any links along it.
 */
async function realAncestors(root: NodeRoot, full: string): Promise<string[]> {
  const reals = [root.real];
  let current = root.path;
  for (const part of relative(root.path, full).split(sep)) {
    if (!part) continue;
    current = join(current, part);
    reals.push(await realpath(current));
  }
  return reals;
}

function escapes(root: string, full: string): boolean {
  const within = relative(root, full);
  return isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`);
}

function confinedPath(root: string, path: string): string {
  const full = resolve(root, path);
  if (escapes(root, full)) {
    throw new Error(`Path escapes project root: ${path}`);
  }
  return full;
}
