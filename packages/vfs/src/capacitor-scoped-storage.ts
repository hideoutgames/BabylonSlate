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
}

export interface BabylonSlateScopedStoragePlugin {
  pickFolder(): Promise<{ folder: PickedFolder }>;
  openFolder(options: { id: string }): Promise<{ folder: PickedFolder }>;
  importBookmark?(options: {
    bookmark: string;
    name?: string;
  }): Promise<{ folder: PickedFolder }>;

  readFile(options: {
    folder: string;
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
    path?: string;
  }): Promise<{ entries: NativeDirEntry[] }>;
  stat(options: { folder: string; path: string }): Promise<NativeFileStat>;
  exists(options: {
    folder: string;
    path: string;
  }): Promise<{ exists: boolean; isDirectory: boolean }>;
}

export const ScopedStorageErrorCode = {
  Stale: "STALE",
  NotFound: "NOT_FOUND",
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

export const BabylonSlateScopedStorage =
  registerPlugin<BabylonSlateScopedStoragePlugin>(
    "BabylonSlateScopedStorage",
  );
