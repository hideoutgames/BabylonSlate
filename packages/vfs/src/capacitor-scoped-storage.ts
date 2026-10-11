import { registerPlugin } from "@capacitor/core";

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

export interface BabylonSlateScopedStoragePlugin {
  readFileRange(options: NativeRangeOptions & { folder: string; readScope?: string }): Promise<NativeRangeRead>;
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

export const ScopedStorageErrorCode = {
  Stale: "STALE",
  AccessRevoked: "ACCESS_REVOKED",
  NotFound: "NOT_FOUND",
  RevisionChanged: "REVISION_CHANGED",
  Cancelled: "CANCELLED",
  Unreachable: "UNREACHABLE",
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
  registerPlugin<BabylonSlateScopedStoragePlugin>(
    "BabylonSlateScopedStorage",
  );
