import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NativeDirEntry {
  name: string;
  isDir: boolean;
  size?: number | null;
  mtime?: number | null;
}

export interface NativeFileStat {
  isDir: boolean;
  size?: number | null;
  mtime?: number | null;
}

export interface PickedFolder {
  id: string;
  name: string;
  supportsReadScope?: boolean;
}

export interface NativeRangeRead {
  data: string;
  totalSize: number;
  revision: string;
  actualBytesRead: number;
}

export interface NativeRangeOptions {
  path: string;
  offset: number;
  length: number;
  expectedRevision?: string;
}

/**
 * One streamed transfer between a URL and a file in app storage (`path`
 * under `Haptic/projects/` in `directory`, as `readDocumentsRange`
 * names it): see `NativeFileTransferRequest`. `id` names it for
 * `cancelTransfer` and its `transferProgress` events.
 */
export interface NativeTransferOptions {
  id: string;
  method: "GET" | "PUT";
  url: string;
  headers: Record<string, string>;
  directory: string;
  path: string;
  expectedSize?: number;
  expectedSha256?: string;
}

export interface NativeTransferResult {
  status: number;
  bytes: number;
  sha256: string;
}

export interface NativeTransferProgress {
  id: string;
  bytes: number;
}

export interface BabylonSlateScopedStoragePlugin {
  readFileRange(options: NativeRangeOptions & { folder: string; readScope?: string }): Promise<NativeRangeRead>;
  /** Streams a file to or from a URL natively; rejects `MISMATCH`, `CANCELLED` or `UNREACHABLE` (a refused path). */
  transferFile(options: NativeTransferOptions): Promise<NativeTransferResult>;
  /** Cancels the transfer `id` (a download's temporary file is removed); unknown ids are ignored. */
  cancelTransfer(options: { id: string }): Promise<void>;
  /** The Git benchmark's objects: `size` random bytes in a new file of the folder `path`, named by their SHA-256. */
  writeRandomObject(options: { directory: string; path: string; size: number }): Promise<{ sha256: string }>;
  readDocumentsRange(options: NativeRangeOptions & { directory: string }): Promise<NativeRangeRead>;
  pickFolder(): Promise<{ folder: PickedFolder }>;
  openFolder(options: { id: string }): Promise<{ folder: PickedFolder }>;
  beginReadScope?(options: { folder: string }): Promise<{ readScope: string }>;
  endReadScope?(options: { readScope: string }): Promise<void>;

  readFile(options: {
    folder: string;
    readScope?: string;
    path: string;
    encoding?: "utf8" | "base64";
  }): Promise<{ data: string }>;
  writeFile(options: {
    folder: string;
    path: string;
    data: string;
    encoding?: "utf8" | "base64";
  }): Promise<void>;
  mkdir(options: {
    folder: string;
    path: string;
    recursive?: boolean;
  }): Promise<void>;
  deleteFile(options: { folder: string; path: string }): Promise<void>;
  rmdir(options: {
    folder: string;
    path: string;
    recursive?: boolean;
  }): Promise<void>;

  readdir(options: {
    folder: string;
    readScope?: string;
    path?: string;
  }): Promise<{ entries: NativeDirEntry[] }>;
  stat(options: { folder: string; path: string; readScope?: string }): Promise<NativeFileStat>;
  exists(options: {
    folder: string;
    readScope?: string;
    path: string;
  }): Promise<{ exists: boolean; isDirectory: boolean }>;
}

/** The plugin's events (Capacitor's own `addListener`, so not a plugin method of its own). */
export interface BabylonSlateScopedStorageEvents {
  addListener(event: "transferProgress", listener: (progress: NativeTransferProgress) => void): Promise<PluginListenerHandle>;
}

export const ScopedStorageErrorCode = {
  Stale: "STALE",
  AccessRevoked: "ACCESS_REVOKED",
  NotFound: "NOT_FOUND",
  RevisionChanged: "REVISION_CHANGED",
  Cancelled: "CANCELLED",
  Unreachable: "UNREACHABLE",
  /** A transfer's body or file did not match its expected size and SHA-256. */
  Mismatch: "MISMATCH",
} as const;

export type ScopedStorageErrorCode =
  (typeof ScopedStorageErrorCode)[keyof typeof ScopedStorageErrorCode];

export function isScopedStorageError(
  err: unknown,
  code: ScopedStorageErrorCode,
): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/** Base64 for native bridge payloads, built in chunks rather than one string append per byte. */
export function encodeBase64(data: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...data.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export const BabylonSlateScopedStorage =
  registerPlugin<BabylonSlateScopedStoragePlugin & BabylonSlateScopedStorageEvents>(
    "BabylonSlateScopedStorage",
  );
