import { Capacitor } from "@capacitor/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
} from "@babylonslate/core";

export type HostPlatform = "ios" | "android" | "electron" | "web";

/**
 * Preload bridges the Electron host installs on `globalThis.babylonslate`.
 * `userData` persists Engine Settings; `project` is the Node VFS IPC surface.
 */
export interface ElectronUserDataBridge {
  readSettings(): Promise<string | null>;
  writeSettings(json: string): Promise<void>;
}

/** Structured IPC failures preserve quota and I/O categories across Electron serialization. */
export type SaveGameBridgeResult<T> = { ok: true; value: T } | {
  ok: false; error: { name: string; message: string; code?: string };
};

export interface ElectronSaveGameBridge {
  read(key: string): Promise<SaveGameBridgeResult<string | null>>;
  write(key: string, text: string): Promise<SaveGameBridgeResult<void>>;
  remove(key: string): Promise<SaveGameBridgeResult<void>>;
  list(prefix: string): Promise<SaveGameBridgeResult<string[]>>;
  acquireLock(key: string): Promise<SaveGameBridgeResult<string>>;
  releaseLock(token: string): Promise<SaveGameBridgeResult<void>>;
}

export function getElectronSaveGameBridge(): ElectronSaveGameBridge | null {
  const host = globalThis as { babylonslate?: { saveGames?: ElectronSaveGameBridge } };
  return host.babylonslate?.saveGames ?? null;
}

export interface ElectronSecretsBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ElectronHttpBridge {
  fetch(request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    bodyText: string;
    headers?: Record<string, string>;
  }>;
}

export interface ElectronProjectBridge {
  pickProjectFolder(): Promise<ProjectFolderHandle>;
  openDocumentsProject(name: string): Promise<ProjectFolderHandle>;
  openKnownFolder(handle: ProjectFolderHandle): Promise<ProjectFolderHandle>;
  listProjects(): Promise<ProjectFolderHandle[]>;
  releaseFolder(): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string): Promise<Omit<import("@babylonslate/core").StorageRangeRead, "bytes"> & { bytes: ArrayBuffer; error?: string; errorCode?: "source-revision-changed" }>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}

export function getElectronUserDataBridge(): ElectronUserDataBridge | null {
  const host = globalThis as {
    babylonslate?: { userData?: ElectronUserDataBridge };
  };
  return host.babylonslate?.userData ?? null;
}

export function getElectronProjectBridge(): ElectronProjectBridge | null {
  const host = globalThis as {
    babylonslate?: { project?: ElectronProjectBridge };
  };
  return host.babylonslate?.project ?? null;
}

export function getElectronSecretsBridge(): ElectronSecretsBridge | null {
  const host = globalThis as {
    babylonslate?: { secrets?: ElectronSecretsBridge };
  };
  return host.babylonslate?.secrets ?? null;
}

/** Separate host store: account credentials must never use plaintext fallback. */
export function getElectronAccountSecretsBridge(): ElectronSecretsBridge | null {
  const host = globalThis as {
    babylonslate?: { accountSecrets?: ElectronSecretsBridge };
  };
  return host.babylonslate?.accountSecrets ?? null;
}

export function getElectronHttpBridge(): ElectronHttpBridge | null {
  const host = globalThis as {
    babylonslate?: { http?: ElectronHttpBridge };
  };
  return host.babylonslate?.http ?? null;
}

export function isElectronHost(): boolean {
  return getElectronUserDataBridge() !== null;
}

export function getHostPlatform(): HostPlatform {
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") return platform;
  if (isElectronHost()) return "electron";
  return "web";
}

export function isMobilePlatform(): boolean {
  const platform = getHostPlatform();
  return platform === "ios" || platform === "android";
}
