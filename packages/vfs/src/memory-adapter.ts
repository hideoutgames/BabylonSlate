import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
  StorageTier,
} from "@babylonslate/core";

interface MemoryNode {
  kind: "file";
  data: Uint8Array;
  mtime: number;
}

interface MemoryDir {
  kind: "dir";
  children: Map<string, MemoryNode | MemoryDir>;
  mtime: number;
}

function now(): number {
  return Date.now();
}

function textEncoder(): TextEncoder {
  return new TextEncoder();
}

function textDecoder(): TextDecoder {
  return new TextDecoder();
}

/**
 * In-memory ProjectStorage for unit tests and hosts without OPFS.
 */
export class MemoryStorageAdapter implements ProjectStorage {
  private folder: ProjectFolderHandle | null = null;
  private readonly roots = new Map<string, MemoryDir>();
  private readonly tier: StorageTier;

  constructor(tier: StorageTier = "opfs") {
    this.tier = tier;
  }

  async pickProjectFolder(name = "MyGame"): Promise<ProjectFolderHandle> {
    return this.bindProject(name, this.tier === "documents" ? "documents" : "opfs");
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    return this.bindProject(name, "documents");
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    return this.bindProject(handle.name, handle.tier);
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return [...this.roots.keys()].map((id) => {
      const name = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
      return { id, name, tier: this.tier };
    });
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder;
  }

  async releaseFolder(): Promise<void> {
    this.folder = null;
  }

  async deleteProject(handle: ProjectFolderHandle): Promise<void> {
    this.roots.delete(handle.id);
    if (this.folder?.id === handle.id) {
      this.folder = null;
    }
  }

  private bindProject(name: string, tier: StorageTier): ProjectFolderHandle {
    const id = `${tier}:${name}`;
    if (!this.roots.has(id)) {
      this.roots.set(id, { kind: "dir", children: new Map(), mtime: now() });
    }
    this.folder = { id, name, tier };
    return this.folder;
  }

  private assertFolder(): ProjectFolderHandle {
    if (!this.folder) {
      throw new Error("No project folder selected");
    }
    return this.folder;
  }

  private root(): MemoryDir {
    const folder = this.assertFolder();
    const root = this.roots.get(folder.id);
    if (!root) {
      throw new Error(`Missing root for ${folder.id}`);
    }
    return root;
  }

  private split(path: string): string[] {
    return path
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .split("/")
      .filter((s) => s.length > 0 && s !== ".");
  }

  private walk(
    parts: string[],
    createDirs: boolean,
  ): { parent: MemoryDir; name: string | null } {
    let dir = this.root();
    if (parts.length === 0) {
      return { parent: dir, name: null };
    }
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let child = dir.children.get(seg);
      if (!child) {
        if (!createDirs) {
          throw new Error(`File not found: ${parts.join("/")}`);
        }
        child = { kind: "dir", children: new Map(), mtime: now() };
        dir.children.set(seg, child);
      }
      if (child.kind !== "dir") {
        throw new Error(`Not a directory: ${parts.slice(0, i + 1).join("/")}`);
      }
      dir = child;
    }
    return { parent: dir, name: parts[parts.length - 1]! };
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const parts = this.split(path);
    const { parent, name } = this.walk(parts, false);
    if (!name) {
      throw new Error(`File not found: ${path}`);
    }
    const node = parent.children.get(name);
    if (!node || node.kind !== "file") {
      throw new Error(`File not found: ${path}`);
    }
    return new Uint8Array(node.data);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const parts = this.split(path);
    const { parent, name } = this.walk(parts, true);
    if (!name) {
      throw new Error(`Cannot write to root path`);
    }
    parent.children.set(name, {
      kind: "file",
      data: new Uint8Array(data),
      mtime: now(),
    });
    parent.mtime = now();
  }

  async readText(path: string): Promise<string> {
    return textDecoder().decode(await this.readBinary(path));
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBinary(path, textEncoder().encode(data));
  }

  async exists(path: string): Promise<boolean> {
    try {
      const parts = this.split(path);
      if (parts.length === 0) return true;
      const { parent, name } = this.walk(parts, false);
      return name !== null && parent.children.has(name);
    } catch {
      return false;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const parts = this.split(path === "." ? "" : path);
    let dir = this.root();
    for (const seg of parts) {
      const child = dir.children.get(seg);
      if (!child || child.kind !== "dir") {
        throw new Error(`File not found: ${path}`);
      }
      dir = child;
    }
    return [...dir.children.entries()].map(([name, node]) => ({
      name,
      isDir: node.kind === "dir",
      size: node.kind === "file" ? node.data.byteLength : null,
      mtime: node.mtime,
    }));
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    const parts = this.split(path);
    if (parts.length === 0) return;
    let dir = this.root();
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      let child = dir.children.get(seg);
      if (!child) {
        if (!recursive && i < parts.length - 1) {
          throw new Error(`File not found: ${parts.slice(0, i + 1).join("/")}`);
        }
        child = { kind: "dir", children: new Map(), mtime: now() };
        dir.children.set(seg, child);
      } else if (child.kind !== "dir") {
        throw new Error(`Not a directory: ${parts.slice(0, i + 1).join("/")}`);
      }
      dir = child;
    }
  }

  async remove(path: string): Promise<void> {
    const parts = this.split(path);
    const { parent, name } = this.walk(parts, false);
    if (!name) {
      throw new Error(`Cannot remove root`);
    }
    if (!parent.children.has(name)) {
      throw new Error(`File not found: ${path}`);
    }
    parent.children.delete(name);
    parent.mtime = now();
  }

  async stat(path: string): Promise<FileStat> {
    const parts = this.split(path);
    if (parts.length === 0) {
      const root = this.root();
      return { isDir: true, size: null, mtime: root.mtime };
    }
    const { parent, name } = this.walk(parts, false);
    if (!name) {
      throw new Error(`File not found: ${path}`);
    }
    const node = parent.children.get(name);
    if (!node) {
      throw new Error(`File not found: ${path}`);
    }
    return {
      isDir: node.kind === "dir",
      size: node.kind === "file" ? node.data.byteLength : null,
      mtime: node.mtime,
    };
  }
}
