import type { DirEntry, FileStat, ProjectFolderHandle, ProjectStorage, StorageReadOptions } from "@babylonslate/core";
import { isStorageNotFound, StorageNotFoundError } from "@babylonslate/core";
import { projectRelativePath } from "./project-path";
import { StorageReadCounter, validateStorageRange } from "./storage-range";

const textDecoder = new TextDecoder();

export interface ProjectStorageMount {
  /** Virtual file or directory path. A deeper mount shadows an enclosing one. */
  path: string;
  storage: ProjectStorage;
  sourcePath: string;
}

/** Read-only catalog views; taking a snapshot never copies source payloads. */
export function createMountedProjectStorage(mounts: readonly ProjectStorageMount[], name = "mounted-content"): ProjectStorage {
  return new MountedProjectStorage(mounts, name);
}

class MountedProjectStorage implements ProjectStorage {
  private readonly mounts: readonly ProjectStorageMount[];
  private readonly reads = new StorageReadCounter();
  private readonly handle: ProjectFolderHandle;
  private active = true;

  constructor(mounts: readonly ProjectStorageMount[], name: string) {
    this.mounts = mounts.map(mount => ({ ...mount, path: projectRelativePath(mount.path, true), sourcePath: projectRelativePath(mount.sourcePath, true) }))
      .sort((a, b) => b.path.length - a.path.length);
    if (new Set(this.mounts.map(mount => mount.path)).size !== mounts.length) throw new Error("Duplicate mounted storage path");
    this.handle = { id: `mounted:${name}`, name, tier: "opfs" };
  }

  private path(path: string): string {
    if (!this.active) throw new Error("No project folder selected");
    return projectRelativePath(path, true);
  }

  private route(path: string): { storage: ProjectStorage; path: string } | null {
    const mount = this.mounts.find(value => !value.path || path === value.path || path.startsWith(`${value.path}/`));
    if (!mount) return null;
    const suffix = path.slice(mount.path.length).replace(/^\//, "");
    return { storage: mount.storage, path: [mount.sourcePath, suffix].filter(Boolean).join("/") };
  }

  /** A path with a deeper mount below it is a directory, whatever its own mount holds. */
  private hasNestedMount(path: string): boolean {
    return this.mounts.some(mount => mount.path.startsWith(`${path}/`));
  }

  private file(path: string): { storage: ProjectStorage; path: string } {
    const cleaned = this.path(path);
    const target = this.route(cleaned);
    if (!cleaned || !target) throw new StorageNotFoundError(path);
    return target;
  }

  getReadMetrics() { return this.reads.snapshot(); }
  get hasStrongSourceRevisions() { return this.mounts.every(mount => mount.storage.hasStrongSourceRevisions === true); }
  getCurrentFolder() { return this.active ? this.handle : null; }
  async releaseFolder() { this.active = false; }
  async listProjects() { return [this.handle]; }
  async openKnownFolder(handle: ProjectFolderHandle) {
    if (handle.id !== this.handle.id) throw new Error("Unknown mounted storage root");
    this.active = true;
    return this.handle;
  }
  async pickProjectFolder(): Promise<ProjectFolderHandle> { throw new Error("Storage is read-only"); }
  async openDocumentsProject(): Promise<ProjectFolderHandle> { throw new Error("Storage is read-only"); }
  async writeText(): Promise<void> { throw new Error("Storage is read-only"); }
  async writeBinary(): Promise<void> { throw new Error("Storage is read-only"); }
  async mkdir(): Promise<void> { throw new Error("Storage is read-only"); }
  async remove(): Promise<void> { throw new Error("Storage is read-only"); }

  async readBinary(path: string, options?: StorageReadOptions): Promise<Uint8Array> {
    options?.signal?.throwIfAborted();
    const target = this.file(path);
    const stat = await target.storage.stat(target.path);
    options?.signal?.throwIfAborted();
    return this.reads.full(stat.size ?? 0, () => target.storage.readBinary(target.path, options));
  }
  async readText(path: string, options?: StorageReadOptions) { return textDecoder.decode(await this.readBinary(path, options)); }
  async readBinaryRange(path: string, offset: number, length: number, revision?: string, options?: StorageReadOptions) {
    validateStorageRange(offset, length);
    const target = this.file(path);
    return this.reads.range(length, () => target.storage.readBinaryRange(target.path, offset, length, revision, options));
  }
  async stat(path: string): Promise<FileStat> {
    const cleaned = this.path(path);
    if (!cleaned || this.hasNestedMount(cleaned)) return { isDir: true, size: null, mtime: null };
    const target = this.route(cleaned);
    if (!target) throw new StorageNotFoundError(path);
    return target.storage.stat(target.path);
  }
  async exists(path: string): Promise<boolean> {
    const cleaned = this.path(path);
    if (!cleaned || this.hasNestedMount(cleaned)) return true;
    const target = this.route(cleaned);
    return target ? target.storage.exists(target.path) : false;
  }
  async readdir(path: string): Promise<DirEntry[]> {
    const cleaned = this.path(path);
    const entries = new Map<string, DirEntry>();
    const target = this.route(cleaned);
    const source = target ? await sourceKind(target) : "missing";
    if (source === "directory") for (const entry of await target!.storage.readdir(target!.path || ".")) entries.set(entry.name, entry);
    const prefix = cleaned ? `${cleaned}/` : "";
    for (const mount of this.mounts) {
      if (!mount.path.startsWith(prefix) || mount.path === cleaned) continue;
      const rest = mount.path.slice(prefix.length);
      const childName = rest.split("/")[0]!;
      if (!childName) continue;
      // Match stat(): a child with a deeper mount below it is a directory.
      const stat = rest.includes("/") || this.hasNestedMount(mount.path)
        ? { isDir: true, size: null, mtime: null }
        : await mount.storage.stat(mount.sourcePath);
      entries.set(childName, { name: childName, ...stat });
    }
    if ((!target || source === "file") && !entries.size && cleaned) throw new StorageNotFoundError(path, { message: `Directory not found: ${path}` });
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Only a directory source is listed; a file mount's children come from deeper mounts. */
async function sourceKind(target: { storage: ProjectStorage; path: string }): Promise<"directory" | "file" | "missing"> {
  if (!target.path) return "directory";
  try {
    return (await target.storage.stat(target.path)).isDir ? "directory" : "file";
  } catch (error) {
    if (isStorageNotFound(error)) return "missing";
    throw error;
  }
}
