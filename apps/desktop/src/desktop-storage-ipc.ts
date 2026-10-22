import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isStorageNotFound, SourceRevisionChangedError } from "@haptic/core";
import { isLibraryFolder, type LibraryFolder } from "@haptic/vfs/library-folders";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import { LIBRARY_FILE_OPERATIONS, MAX_IPC_BYTES } from "./packaged-security";

type FileOperation = (typeof LIBRARY_FILE_OPERATIONS)[number];
type StorageOperation = (storage: NodeStorageAdapter, ...args: unknown[]) => Promise<unknown>;

/**
 * File operations behind both the `project:*` and `library:*` channels.
 * Arguments have already passed `validateIpcArguments`.
 */
export const STORAGE_OPERATIONS: Record<FileOperation, StorageOperation> = {
  async readBinary(storage, path) {
    // Whole-file reads share the ranged-read and write cap; larger files use ranges.
    const { size } = await storage.stat(String(path));
    if (size !== null && size > MAX_IPC_BYTES) throw new Error(`File is too large to read at once: ${String(path)}`);
    const bytes = await storage.readBinary(String(path));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  async readBinaryRange(storage, path, offset, length, revision) {
    try {
      const result = await storage.readBinaryRange(String(path), Number(offset), Number(length), revision as string | undefined);
      return { ...result, bytes: result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) };
    } catch (error) {
      // Electron only transports Error.message for rejected invokes. Return a
      // structured failure so reads discarded by revision checks remain visible.
      return { bytes: new ArrayBuffer(0), totalSize: 0, revision: "", error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SourceRevisionChangedError || isStorageNotFound(error) ? { errorCode: error.code } : {}),
        actualBytesRead: (error as { actualBytesRead?: number } | null)?.actualBytesRead ?? 0 };
    }
  },
  writeBinary: (storage, path, data) => storage.writeBinary(String(path), new Uint8Array(data as ArrayBuffer)),
  exists: (storage, path) => storage.exists(String(path)),
  readdir: (storage, path) => storage.readdir(String(path)),
  mkdir: (storage, path, recursive) => storage.mkdir(String(path), recursive !== false),
  remove: (storage, path) => storage.remove(String(path)),
  stat: (storage, path) => storage.stat(String(path)),
};

/**
 * The app-owned user libraries (imported Templates, Engine Plugins and Engine
 * Extensions) as real folders under the canonical `userData/libraries` home,
 * next to (never inside) `userData/projects`. Each editor document owns one
 * adapter per allowlisted scope, dropped with the document like its project.
 */
export class DesktopLibraries {
  private readonly owners = new Map<number, Map<LibraryFolder, Promise<NodeStorageAdapter>>>();

  /** `home` must already be canonical (`realpath`). */
  constructor(private readonly home: string) {}

  storage(owner: number, scope: unknown): Promise<NodeStorageAdapter> {
    // Main validates every request; this guard keeps the allowlist local too.
    if (!isLibraryFolder(scope)) return Promise.reject(new Error("Invalid desktop request"));
    let scopes = this.owners.get(owner);
    if (!scopes) this.owners.set(owner, scopes = new Map());
    let storage = scopes.get(scope);
    if (!storage) {
      storage = this.bind(scope);
      scopes.set(scope, storage);
      storage.catch(() => { if (this.owners.get(owner)?.get(scope) === storage) scopes.delete(scope); });
    }
    return storage;
  }

  releaseOwner(owner: number): void {
    this.owners.delete(owner);
  }

  private async bind(scope: LibraryFolder): Promise<NodeStorageAdapter> {
    const storage = new NodeStorageAdapter(this.home);
    await storage.openDocumentsProject(scope);
    // A link in place of the folder would bind a root outside the libraries home.
    if (dirname(await realpath(join(this.home, scope))) !== this.home) {
      throw new Error(`Library folder is not inside the libraries home: ${scope}`);
    }
    return storage;
  }
}

/** `library:<operation>` listeners, keyed by channel, for an owner (sender id) and scope. */
export function libraryIpcHandlers(
  libraries: DesktopLibraries,
): Record<string, (owner: number, scope: unknown, ...args: unknown[]) => Promise<unknown>> {
  return Object.fromEntries(LIBRARY_FILE_OPERATIONS.map(operation => [
    `library:${operation}`,
    async (owner: number, scope: unknown, ...args: unknown[]) =>
      STORAGE_OPERATIONS[operation](await libraries.storage(owner, scope), ...args),
  ]));
}
