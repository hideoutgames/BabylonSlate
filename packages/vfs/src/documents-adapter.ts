import { BabylonSlateScopedStorage, decodeBase64, encodeBase64, type BabylonSlateScopedStoragePlugin, type NativeRangeOptions, type NativeRangeRead } from "./capacitor-scoped-storage";
import { rethrowNativeStorageRangeError, rethrowStorageReadFailure, StorageReadCounter, utf8ByteLength, validateStorageRange, validateStorageRangeResult } from "./storage-range";
import { StorageNotFoundError } from "@haptic/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
  StorageReadOptions,
} from "@haptic/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { getHostPlatform, type HostPlatform } from "./platform";
import { projectFolderName, projectRelativePath } from "./project-path";
import { isAppOwnedFolder } from "./library-folders";
import { asideWriteName, asideWriteTarget, isStagedWrite, stagedWriteName } from "./staged-write";
import { nativeBinaryBridge, type NativeBinaryBridge, type NativeBinaryBridgePlugin, type NativeBinaryRange } from "./native-binary-bridge";

/** Where projects live in app storage; the native plugin accepts app-storage paths under this root only. */
export const PROJECTS_ROOT = "Projects";

/**
 * Where app-private data (derived data) lives in Capacitor `Directory.Library`.
 * iOS: `Library/Application Support/Haptic`, hidden from the Files app, never
 * purged, and excluded from backup by the storage plugin at launch. Android:
 * `filesDir/Haptic`, excluded from cloud backup by the backup rules. The
 * native plugin mirrors both roots.
 */
export function libraryRoot(platform: HostPlatform = getHostPlatform()): string {
  return platform === "ios" ? "Application Support/Haptic" : "Haptic";
}

/**
 * `documents`: projects and libraries (Files-visible Documents on iPad;
 * app-private Data on Android, whose public Documents needs a picker).
 * `library`: app-private data the user never browses.
 */
export type DocumentsStorageLocation = "documents" | "library";

function capacitorDirectory(location: DocumentsStorageLocation, platform: HostPlatform): Directory {
  if (location === "library") return Directory.Library;
  return platform === "android" ? Directory.Data : Directory.Documents;
}

function hasFilesystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Capacitor Filesystem and the native plugin each name a missing file their own way. */
function isMissing(error: unknown): boolean {
  return hasFilesystemCode(error, "OS-PLUG-FILE-0008") || hasFilesystemCode(error, "NOT_FOUND");
}

function rethrowFilesystemError(error: unknown, path: string): never {
  if (isMissing(error)) {
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
  /** Moves a staged write over its file. */
  rename(options: {
    from: string;
    to: string;
    directory?: Directory;
    toDirectory?: Directory;
  }): Promise<void>;
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

type DocumentsNativePlugin = Pick<BabylonSlateScopedStoragePlugin, "readDocumentsRange"> & Partial<NativeBinaryBridgePlugin>;

export interface DocumentsStorageOptions {
  /** Capacitor Filesystem unless injected (tests). */
  fs?: DocumentsFilesystemApi;
  location?: DocumentsStorageLocation;
  platform?: HostPlatform;
  /**
   * Native bounded reads and the binary transport. The app's storage plugin
   * unless a filesystem was injected, so tests never reach Capacitor.
   */
  plugin?: DocumentsNativePlugin;
  /** The binary transport; by default the plugin's, when it has one. */
  bridge?: NativeBinaryBridge | null;
}

const textEncoder = new TextEncoder();

/**
 * Durable mobile default tier via Capacitor Filesystem: iPad Documents or
 * Android app-private Data under Projects/, or app-private
 * Library data. No picker. Bytes cross the binary transport where the host
 * has one, else the plugin calls; every write replaces its file atomically.
 */
export class DocumentsStorageAdapter implements ProjectStorage {
  readonly speculativeRangeReads = true;
  private readonly reads = new StorageReadCounter();
  getReadMetrics() { return this.reads.snapshot(); }
  private folder: ProjectFolderHandle | null = null;
  private readonly fs: DocumentsFilesystemApi;
  private readonly directory: Directory;
  private readonly root: string;
  private readonly plugin: DocumentsNativePlugin | undefined;
  private readonly bridge: Promise<NativeBinaryBridge | null>;
  /** Aside copies (full paths) of this adapter's writes still running, which listings leave to them. */
  private readonly asidesInFlight = new Set<string>();

  constructor(options: DocumentsStorageOptions = {}) {
    const platform = options.platform ?? getHostPlatform();
    const location = options.location ?? "documents";
    this.fs = options.fs ?? (Filesystem as unknown as DocumentsFilesystemApi);
    // Decided at construction, never by probing the Capacitor plugin: its proxy
    // answers every property name, so `readFileRange` looks present and rejects.
    this.plugin = options.plugin ?? (options.fs ? undefined : BabylonSlateScopedStorage);
    this.bridge = options.bridge !== undefined
      ? Promise.resolve(options.bridge)
      : this.plugin ? nativeBinaryBridge(this.plugin) : Promise.resolve(null);
    this.directory = capacitorDirectory(location, platform);
    this.root = location === "library" ? libraryRoot(platform) : PROJECTS_ROOT;
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    throw new Error(
      "Documents tier has no picker; use openDocumentsProject or openKnownFolder",
    );
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    name = projectFolderName(name);
    const root = `${this.root}/${name}`;
    await this.ensureDirectory(root);
    await this.settleFolder(root);
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
    const info = await this.fs.stat({ path: `${this.root}/${name}`, directory: this.directory });
    if (info.type !== "directory") throw new Error("Project folder is not a directory.");
    await this.settleFolder(`${this.root}/${name}`);
    this.folder = { id: `documents:${name}`, name, tier: "documents" };
    return this.folder;
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
      await this.ensureDirectory(this.root);
      const { files } = await this.fs.readdir({
        path: this.root,
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
    const path = `${this.root}/${name}`;
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
    const base = `${this.root}/${folder.name}`;
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
    const full = this.abs(path);
    const bridge = await this.bridge;
    if (bridge && await bridge.write({ directory: this.directory, path: full }, textEncoder.encode(data))) return;
    await this.stagedWrite(full, { data, encoding: "utf8" });
  }

  /**
   * Settles the project root's aside copies before anything reads
   * `project.json` (`settleAsides`); a failure leaves them for the next
   * listing, and opening goes on.
   */
  private async settleFolder(root: string): Promise<void> {
    try {
      const { files } = await this.fs.readdir({ path: root, directory: this.directory });
      await this.settleAsides(root, files);
    } catch {
      // Left for the next listing.
    }
  }

  /**
   * Finishes what a write killed mid-replace left in `folder`, from the names
   * alone (`asideWriteName`): an aside copy whose file is missing is the file
   * and moves back; one beside its file is stale and goes. Copies of this
   * adapter's writes still running are theirs. Returns the listing as it is
   * now, without staged or aside names; a step that fails stays for the next
   * listing.
   */
  private async settleAsides<T extends { name: string; type: string }>(folder: string, files: readonly T[]): Promise<T[]> {
    const names = new Set(files.map((file) => file.name));
    const restored: T[] = [];
    for (const file of files) {
      const target = asideWriteTarget(file.name);
      const aside = `${folder}/${file.name}`;
      if (target === null || file.type !== "file" || this.asidesInFlight.has(aside)) continue;
      try {
        if (names.has(target)) {
          await this.fs.deleteFile({ path: aside, directory: this.directory });
        } else {
          await this.fs.rename({ from: aside, to: `${folder}/${target}`, directory: this.directory, toDirectory: this.directory });
          names.add(target);
          restored.push({ ...file, name: target });
        }
      } catch {
        // Left for the next listing.
      }
    }
    return [...files.filter((file) => !isStagedWrite(file.name) && asideWriteTarget(file.name) === null), ...restored];
  }

  async readBinary(path: string, options?: StorageReadOptions): Promise<Uint8Array> {
    const full = this.abs(path);
    const bridge = await this.bridge;
    try {
      const bytes = bridge
        ? await bridge.read({ directory: this.directory, path: full }, options)
        : decodeBase64((await this.fs.readFile({ path: full, directory: this.directory })).data);
      this.reads.record("full", bytes.byteLength);
      return bytes;
    } catch (error) {
      rethrowFilesystemError(error, path);
    }
  }

  async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string, options?: StorageReadOptions) {
    validateStorageRange(offset, length);
    const full = this.abs(path);
    const bridge = await this.bridge;
    // Capacitor Filesystem.readFile loads the whole file, so bounded reads
    // are always native positioned I/O, never a disguised full read.
    const result = await this.reads.range(length, async (): Promise<NativeRangeRead | NativeBinaryRange> => {
      try {
        if (bridge) return await bridge.readRange({ directory: this.directory, path: full }, offset, length, expectedRevision, options);
        const request = { path: full, directory: this.directory, offset, length, expectedRevision };
        if (this.plugin) return await this.plugin.readDocumentsRange(request);
        if (this.fs.readFileRange) return await this.fs.readFileRange(request);
        throw new Error("Documents filesystem does not support bounded reads");
      } catch (error) {
        if (isMissing(error)) rethrowFilesystemError(error, path);
        rethrowNativeStorageRangeError(error, path);
      }
    });
    try {
      const bytes = "bytes" in result ? result.bytes : decodeBase64(result.data);
      return validateStorageRangeResult(path, offset, length, { ...result, bytes }, expectedRevision);
    } catch (error) { rethrowStorageReadFailure(error, result.actualBytesRead); }
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const full = this.abs(path);
    const bridge = await this.bridge;
    if (bridge && await bridge.write({ directory: this.directory, path: full }, data)) return;
    await this.stagedWrite(full, { data: encodeBase64(data) });
  }

  /**
   * Without the binary transport: the bytes go to a staged `.haptic-<uuid>.tmp`
   * beside the file, then replace it. Capacitor's `rename` is no atomic
   * replace (iOS removes an existing file before it moves the staged one), so
   * the file being replaced first moves to an aside copy named after it
   * (`asideWriteName`), the staged file moves into place, and the copy goes.
   * Killed at any step, the next listing or open finds the old or the new
   * complete file (`settleAsides`); a failure removes the staged file and
   * moves the old one back. The transport's native commit is one POSIX
   * rename and needs none of this.
   */
  private async stagedWrite(full: string, content: { data: string; encoding?: "utf8" }): Promise<void> {
    const slash = full.lastIndexOf("/");
    const directory = this.directory;
    const staged = `${full.slice(0, slash)}/${stagedWriteName()}`;
    const aside = `${full.slice(0, slash)}/${asideWriteName(full.slice(slash + 1))}`;
    let setAside = false;
    this.asidesInFlight.add(aside);
    try {
      try {
        await this.fs.writeFile({ path: staged, ...content, directory, recursive: true });
        try {
          await this.fs.rename({ from: full, to: aside, directory, toDirectory: directory });
          setAside = true;
        } catch (error) {
          // A new file has nothing to set aside; any other failure leaves the file as it was.
          if (!isMissing(error) && await this.fileExists(full)) throw error;
        }
        await this.fs.rename({ from: staged, to: full, directory, toDirectory: directory });
      } catch (error) {
        await this.fs.deleteFile({ path: staged, directory }).catch(() => {});
        if (setAside) await this.fs.rename({ from: aside, to: full, directory, toDirectory: directory }).catch(() => {});
        throw error;
      }
      // The new file is in place; a copy left by a failure here goes at the next listing.
      if (setAside) await this.fs.deleteFile({ path: aside, directory }).catch(() => {});
    } finally {
      this.asidesInFlight.delete(aside);
    }
  }

  private async fileExists(full: string): Promise<boolean> {
    try {
      await this.fs.stat({ path: full, directory: this.directory });
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
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
      return (await this.settleAsides(full, files))
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
