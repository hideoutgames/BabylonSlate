import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { Directory, Filesystem } from "@capacitor/filesystem";

const PROJECTS_ROOT = "BabylonSlate/projects";

export interface DocumentsFilesystemApi {
  mkdir(options: {
    path: string;
    directory?: Directory;
    recursive?: boolean;
  }): Promise<void>;
  readdir(options: {
    path: string;
    directory?: Directory;
  }): Promise<{ files: Array<{ name: string; type: string; size: number; mtime: number }> }>;
  readFile(options: {
    path: string;
    directory?: Directory;
    encoding?: "utf8" | "base64";
  }): Promise<{ data: string }>;
  writeFile(options: {
    path: string;
    data: string;
    directory?: Directory;
    encoding?: "utf8" | "base64";
    recursive?: boolean;
  }): Promise<unknown>;
  deleteFile(options: {
    path: string;
    directory?: Directory;
  }): Promise<void>;
  rmdir(options: {
    path: string;
    directory?: Directory;
    recursive?: boolean;
  }): Promise<void>;
  stat(options: {
    path: string;
    directory?: Directory;
  }): Promise<{ type: string; size: number; mtime: number }>;
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

/**
 * Durable iPad / Android Documents tier via Capacitor Filesystem.
 * No picker or bookmark — projects live under BabylonSlate/projects/.
 */
export class DocumentsStorageAdapter implements ProjectStorage {
  private folder: ProjectFolderHandle | null = null;
  private readonly fs: DocumentsFilesystemApi;
  private readonly directory: Directory;

  constructor(
    fs: DocumentsFilesystemApi = Filesystem as unknown as DocumentsFilesystemApi,
    directory: Directory = Directory.Documents,
  ) {
    this.fs = fs;
    this.directory = directory;
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    throw new Error(
      "Documents tier has no picker; use openDocumentsProject or openKnownFolder",
    );
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    const root = `${PROJECTS_ROOT}/${name}`;
    await this.fs.mkdir({
      path: root,
      directory: this.directory,
      recursive: true,
    });
    this.folder = { id: `documents:${name}`, name, tier: "documents" };
    return this.folder;
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    if (handle.tier !== "documents") {
      throw new Error(`Documents adapter cannot open tier ${handle.tier}`);
    }
    return this.openDocumentsProject(handle.name);
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    try {
      await this.fs.mkdir({
        path: PROJECTS_ROOT,
        directory: this.directory,
        recursive: true,
      });
      const { files } = await this.fs.readdir({
        path: PROJECTS_ROOT,
        directory: this.directory,
      });
      return files
        .filter((f) => f.type === "directory")
        .map((f) => ({
          id: `documents:${f.name}`,
          name: f.name,
          tier: "documents" as const,
        }));
    } catch {
      return [];
    }
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder;
  }

  async releaseFolder(): Promise<void> {
    this.folder = null;
  }

  private assertFolder(): ProjectFolderHandle {
    if (!this.folder) {
      throw new Error("No project folder selected");
    }
    return this.folder;
  }

  private abs(path: string): string {
    const folder = this.assertFolder();
    const cleaned = path.replace(/^\.\/+/, "").replace(/^\/+/, "");
    const base = `${PROJECTS_ROOT}/${folder.name}`;
    return cleaned ? `${base}/${cleaned}` : base;
  }

  async readText(path: string): Promise<string> {
    try {
      const { data } = await this.fs.readFile({
        path: this.abs(path),
        directory: this.directory,
        encoding: "utf8",
      });
      return data;
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.fs.writeFile({
      path: this.abs(path),
      data,
      directory: this.directory,
      encoding: "utf8",
      recursive: true,
    });
  }

  async readBinary(path: string): Promise<Uint8Array> {
    try {
      const { data } = await this.fs.readFile({
        path: this.abs(path),
        directory: this.directory,
        encoding: "base64",
      });
      return decodeBinary(data);
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.fs.writeFile({
      path: this.abs(path),
      data: encodeBinary(data),
      directory: this.directory,
      encoding: "base64",
      recursive: true,
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fs.stat({ path: this.abs(path), directory: this.directory });
      return true;
    } catch {
      return false;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    try {
      const { files } = await this.fs.readdir({
        path: this.abs(path === "." ? "" : path),
        directory: this.directory,
      });
      return files.map((f) => ({
        name: f.name,
        isDir: f.type === "directory",
        size: f.type === "file" ? f.size : null,
        mtime: f.mtime,
      }));
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await this.fs.mkdir({
      path: this.abs(path),
      directory: this.directory,
      recursive,
    });
  }

  async remove(path: string): Promise<void> {
    const full = this.abs(path);
    try {
      const info = await this.fs.stat({
        path: full,
        directory: this.directory,
      });
      if (info.type === "directory") {
        await this.fs.rmdir({
          path: full,
          directory: this.directory,
          recursive: true,
        });
      } else {
        await this.fs.deleteFile({ path: full, directory: this.directory });
      }
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const info = await this.fs.stat({
        path: this.abs(path),
        directory: this.directory,
      });
      return {
        isDir: info.type === "directory",
        size: info.type === "file" ? info.size : null,
        mtime: info.mtime,
      };
    } catch {
      throw new Error(`File not found: ${path}`);
    }
  }
}
