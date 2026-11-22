import { BabylonSlateScopedStorage, decodeBase64, encodeBase64, type NativeRangeOptions, type NativeRangeRead } from "./capacitor-scoped-storage";
import { rethrowNativeStorageRangeError, rethrowStorageReadFailure, StorageReadCounter, utf8ByteLength, validateStorageRange, validateStorageRangeResult } from "./storage-range";
import { PROJECT_FILE, StorageNotFoundError } from "@haptic/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@haptic/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { getHostPlatform, type HostPlatform } from "./platform";
import { projectFolderName, projectRelativePath } from "./project-path";
import { isAppOwnedFolder } from "./library-folders";
import { isStagedWrite, stagedWriteName } from "./staged-write";

const PROJECTS_ROOT = "BabylonSlate/projects";

/** Files-visible Documents on iPad; app-private Data on Android, whose public Documents needs a picker. */
function mobileDocumentsDirectory(platform: HostPlatform = getHostPlatform()): Directory {
  return platform === "android" ? Directory.Data : Directory.Documents;
}

function hasFilesystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function rethrowFilesystemError(error: unknown, path: string): never {
  if (hasFilesystemCode(error, "OS-PLUG-FILE-0008")) {
    throw new StorageNotFoundError(path, { cause: error });
  }
  throw error;
}

export interface DocumentsFilesystemApi {
  readFileRange?(options: NativeRangeOptions & { directory?: Directory }): Promise<NativeRangeRead>;
  mkdir(options: {
    path: string;
    directory?: Directory;
    recursive?: boolean;
  }): Promise<void>;
  readdir(options: {
    path: string;
    directory?: Directory;
  }): Promise<{ files: Array<{ name: string; type: string; size: number; mtime: number }> }>;
  /** Omit `encoding` for bytes (base64 data). Any encoding name means text: iOS writes an unknown one, such as "base64", as UTF-8. */
  readFile(options: {
    path: string;
    directory?: Directory;
    encoding?: "utf8";
  }): Promise<{ data: string }>;
  writeFile(options: {
    path: string;
    data: string;
    directory?: Directory;
    encoding?: "utf8";
    recursive?: boolean;
  }): Promise<unknown>;
  deleteFile(options: {
    path: string;
    directory?: Directory;
  }): Promise<void>;
  /** Replaces an existing file at `to` (iOS removes it first, Android renames over it). */
  rename(options: {
    from: string;
    to: string;
    directory?: Directory;
    toDirectory?: Directory;
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

/**
 * Durable mobile default tier via Capacitor Filesystem: iPad Documents or
 * Android app-private Data. No picker — projects live under BabylonSlate/projects/.
 */
export class DocumentsStorageAdapter implements ProjectStorage {
  private readonly reads = new StorageReadCounter();
  getReadMetrics() { return this.reads.snapshot(); }
  private folder: ProjectFolderHandle | null = null;
  private readonly fs: DocumentsFilesystemApi;
  private readonly directory: Directory;
  /** Ranges go to the native storage plugin unless a filesystem was injected. */
  private readonly nativeRanges: boolean;

  constructor(
    fs?: DocumentsFilesystemApi,
    directory: Directory = mobileDocumentsDirectory(),
  ) {
    this.fs = fs ?? (Filesystem as unknown as DocumentsFilesystemApi);
    this.nativeRanges = fs === undefined;
    this.directory = directory;
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    throw new Error(
      "Documents tier has no picker; use openDocumentsProject or openKnownFolder",
    );
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    name = projectFolderName(name);
    const root = `${PROJECTS_ROOT}/${name}`;
    await this.ensureDirectory(root);
    await this.finishProjectFileReplace(root);
    this.folder = { id: `documents:${name}`, name, tier: "documents" };
    return this.folder;
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    if (handle.tier !== "documents") {
      throw new Error(`Documents adapter cannot open tier ${handle.tier}`);
    }
    if (!handle.id.startsWith("documents:")) throw new Error("Invalid Documents project id");
    const name = projectFolderName(handle.id.slice("documents:".length));
    const info = await this.fs.stat({ path: `${PROJECTS_ROOT}/${name}`, directory: this.directory });
    if (info.type !== "directory") throw new Error("Project folder is not a directory.");
    await this.finishProjectFileReplace(`${PROJECTS_ROOT}/${name}`);
    this.folder = { id: `documents:${name}`, name, tier: "documents" };
    return this.folder;
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
      await this.ensureDirectory(PROJECTS_ROOT);
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
  }

  private async ensureDirectory(path: string, recursive = true): Promise<void> {
    try {
      await this.fs.mkdir({ path, directory: this.directory, recursive });
    } catch (error) {
      if (!hasFilesystemCode(error, "OS-PLUG-FILE-0010")) throw error;
      const info = await this.fs.stat({ path, directory: this.directory });
      if (info.type !== "directory") throw error;
    }
  }

  /**
   * Permanently deletes a project folder. The app-owned folders beside
   * projects (libraries, derived data) are refused; a missing folder is done.
   */
  async deleteProject(handle: ProjectFolderHandle): Promise<void> {
    if (handle.tier !== "documents" || !handle.id.startsWith("documents:")) {
      throw new Error(`Documents adapter cannot delete project ${handle.id}`);
    }
    const name = projectFolderName(handle.id.slice("documents:".length));
    if (isAppOwnedFolder(name)) throw new Error(`${name} is not a project`);
    const path = `${PROJECTS_ROOT}/${name}`;
    try {
      const info = await this.fs.stat({ path, directory: this.directory });
      if (info.type !== "directory") throw new Error("Project folder is not a directory.");
      await this.fs.rmdir({ path, directory: this.directory, recursive: true });
    } catch (error) {
      if (!hasFilesystemCode(error, "OS-PLUG-FILE-0008")) throw error;
    }
    if (this.folder?.id === `documents:${name}`) this.folder = null;
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

  private abs(path: string, allowRoot = false): string {
    const folder = this.assertFolder();
    const cleaned = projectRelativePath(path, allowRoot);
    const base = `${PROJECTS_ROOT}/${folder.name}`;
    return cleaned ? `${base}/${cleaned}` : base;
  }

  async readText(path: string): Promise<string> {
    const full = this.abs(path);
    try {
      const { data } = await this.fs.readFile({
        path: full,
        directory: this.directory,
        encoding: "utf8",
      });
      this.reads.record("full", utf8ByteLength(data));
      return data;
    } catch (error) {
      rethrowFilesystemError(error, path);
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeStaged(path, data, "utf8");
  }

  /**
   * Writes the bytes to a staged sibling (`.haptic-<uuid>.tmp`, which
   * listings leave out), then renames it over the target, so a killed app or
   * a full disk leaves the target whole (its old bytes, or absent) rather
   * than truncated. A failed write or rename removes the staged file. Only
   * when the rename refuses an existing target (no host this runs on does)
   * is the target written in place, as before staging.
   */
  private async writeStaged(path: string, data: string, encoding?: "utf8"): Promise<void> {
    const target = this.abs(path);
    const folder = target.slice(0, target.lastIndexOf("/"));
    const stagedName = stagedWriteName();
    const staged = `${folder}/${stagedName}`;
    // `project.json` alone gets a marker naming its staged file, written once that file is complete:
    // iOS's rename removes the target before it moves, so a kill in between would leave the project unopenable.
    const marker = projectRelativePath(path, false) === PROJECT_FILE ? `${folder}/${stagedWriteName()}` : null;
    const directory = this.directory;
    try {
      await this.fs.writeFile({ path: staged, data, directory, ...(encoding ? { encoding } : {}), recursive: true });
      if (marker) await this.fs.writeFile({ path: marker, data: JSON.stringify({ target: PROJECT_FILE, staged: stagedName }), directory, encoding: "utf8" });
      try {
        await this.fs.rename({ from: staged, to: target, directory, toDirectory: directory });
      } catch (error) {
        if (!(await this.isFile(target))) throw error;
        await this.fs.writeFile({ path: target, data, directory, ...(encoding ? { encoding } : {}), recursive: true });
        await this.fs.deleteFile({ path: staged, directory }).catch(() => undefined);
      }
    } catch (error) {
      await this.fs.deleteFile({ path: staged, directory }).catch(() => undefined);
      throw error;
    } finally {
      if (marker) await this.fs.deleteFile({ path: marker, directory }).catch(() => undefined);
    }
  }

  /**
   * Finishes a `project.json` replacement a killed app left half done, from
   * its marker (never by guessing from content): with `project.json` missing
   * and the marker's complete staged file present, the staged file becomes
   * `project.json`. Otherwise the marker and its staged file are leftovers of
   * a write that finished or never got that far, and are removed. Failures
   * leave everything as it was; opening goes on.
   */
  private async finishProjectFileReplace(root: string): Promise<void> {
    const directory = this.directory;
    try {
      const { files } = await this.fs.readdir({ path: root, directory });
      const names = new Set(files.map((file) => file.name));
      for (const file of files) {
        if (file.type !== "file" || !isStagedWrite(file.name) || file.size > 1024) continue;
        let staged: string;
        try {
          const record = JSON.parse((await this.fs.readFile({ path: `${root}/${file.name}`, directory, encoding: "utf8" })).data) as { target?: unknown; staged?: unknown };
          if (record.target !== PROJECT_FILE || typeof record.staged !== "string" || !isStagedWrite(record.staged)) continue;
          staged = record.staged;
        } catch {
          continue;
        }
        if (!names.has(PROJECT_FILE) && names.has(staged)) {
          await this.fs.rename({ from: `${root}/${staged}`, to: `${root}/${PROJECT_FILE}`, directory, toDirectory: directory });
          names.add(PROJECT_FILE);
        } else if (names.has(staged)) {
          await this.fs.deleteFile({ path: `${root}/${staged}`, directory });
        }
        await this.fs.deleteFile({ path: `${root}/${file.name}`, directory });
      }
    } catch {
      // Left for the next open.
    }
  }

  private async isFile(full: string): Promise<boolean> {
    try {
      return (await this.fs.stat({ path: full, directory: this.directory })).type !== "directory";
    } catch {
      return false;
    }
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const full = this.abs(path);
    try {
      const { data } = await this.fs.readFile({
        path: full,
        directory: this.directory,
      });
      const bytes = decodeBase64(data);
      this.reads.record("full", bytes.byteLength);
      return bytes;
    } catch (error) {
      rethrowFilesystemError(error, path);
    }
  }

  async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string) {
    validateStorageRange(offset, length);
    const options = { path: this.abs(path), directory: this.directory, offset, length, expectedRevision };
    // Capacitor Filesystem.readFile loads the whole file. Native positioned I/O
    // is provided by our existing storage plugin instead of disguising that read.
    // Decided at construction, never by probing the Capacitor plugin: its proxy
    // answers every property name, so `readFileRange` looks present and rejects.
    const result = await this.reads.range(length, async () => {
      try {
        if (this.nativeRanges) return await BabylonSlateScopedStorage.readDocumentsRange(options);
        if (this.fs.readFileRange) return await this.fs.readFileRange(options);
        throw new Error("Documents filesystem does not support bounded reads");
      } catch (error) { rethrowNativeStorageRangeError(error, path); }
    });
    try { return validateStorageRangeResult(path, offset, length, { ...result, bytes: decodeBase64(result.data) }, expectedRevision); }
    catch (error) { rethrowStorageReadFailure(error, result.actualBytesRead); }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.writeStaged(path, encodeBase64(data));
  }

  async exists(path: string): Promise<boolean> {
    const full = this.abs(path, true);
    try {
      await this.fs.stat({ path: full, directory: this.directory });
      return true;
    } catch (error) {
      if (hasFilesystemCode(error, "OS-PLUG-FILE-0008")) return false;
      throw error;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const full = this.abs(path, true);
    try {
      const { files } = await this.fs.readdir({
        path: full,
        directory: this.directory,
      });
      return files
        .filter((f) => !isStagedWrite(f.name))
        .map((f) => ({
          name: f.name,
          isDir: f.type === "directory",
          size: f.type === "file" ? f.size : null,
          mtime: f.mtime,
        }));
    } catch (error) {
      rethrowFilesystemError(error, path);
    }
  }

  async listStagedWrites(path: string): Promise<DirEntry[]> {
    const full = this.abs(path, true);
    try {
      const { files } = await this.fs.readdir({ path: full, directory: this.directory });
      return files
        .filter((f) => f.type === "file" && isStagedWrite(f.name))
        .map((f) => ({ name: f.name, isDir: false, size: f.size, mtime: f.mtime }));
    } catch (error) {
      rethrowFilesystemError(error, path);
    }
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await this.ensureDirectory(this.abs(path), recursive);
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
    } catch (error) {
      rethrowFilesystemError(error, path);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const full = this.abs(path, true);
    try {
      const info = await this.fs.stat({
        path: full,
        directory: this.directory,
      });
      return {
        isDir: info.type === "directory",
        size: info.type === "file" ? info.size : null,
        mtime: info.mtime,
      };
    } catch (error) {
      rethrowFilesystemError(error, path);
    }
  }
}
