import { Capacitor } from "@capacitor/core";
import { browserDeviceFacts, type GameEnvironment } from "@haptic/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
} from "@haptic/core";
import type { LibraryFolder } from "./library-folders";
import type { NativeHttpImageUpload } from "./native-http-port";

export type HostPlatform = "ios" | "android" | "electron" | "web";

/**
 * Preload bridges the Electron host installs on `globalThis.haptic`.
 * `userData` persists Engine Settings; `project` is the Node VFS IPC surface;
 * `library` reaches the app-owned user libraries under `userData/libraries`.
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
  const host = globalThis as { haptic?: { saveGames?: ElectronSaveGameBridge } };
  return host.haptic?.saveGames ?? null;
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
    upload?: NativeHttpImageUpload;
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
  /** Projects Folder projects only; main refuses picked folders. */
  deleteProject(handle: ProjectFolderHandle): Promise<void>;
  releaseFolder(): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string): Promise<Omit<import("@haptic/core").StorageRangeRead, "bytes"> & { bytes: ArrayBuffer; error?: string; errorCode?: "source-revision-changed" | "not-found" }>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}

/**
 * File operations on one app-owned user library (see `library-folders.ts`).
 * The first argument is the library scope; the desktop main process refuses
 * any other folder and offers no picker, listing or reopen for libraries.
 */
export type ElectronLibraryBridge = {
  [K in "readBinary" | "readBinaryRange" | "writeBinary" | "exists" | "readdir" | "mkdir" | "remove" | "stat"]:
    (scope: LibraryFolder, ...args: Parameters<ElectronProjectBridge[K]>) => ReturnType<ElectronProjectBridge[K]>;
};

export function getElectronLibraryBridge(): ElectronLibraryBridge | null {
  const host = globalThis as {
    haptic?: { library?: ElectronLibraryBridge };
  };
  return host.haptic?.library ?? null;
}

export function getElectronUserDataBridge(): ElectronUserDataBridge | null {
  const host = globalThis as {
    haptic?: { userData?: ElectronUserDataBridge };
  };
  return host.haptic?.userData ?? null;
}

export function getElectronProjectBridge(): ElectronProjectBridge | null {
  const host = globalThis as {
    haptic?: { project?: ElectronProjectBridge };
  };
  return host.haptic?.project ?? null;
}

export function getElectronSecretsBridge(): ElectronSecretsBridge | null {
  const host = globalThis as {
    haptic?: { secrets?: ElectronSecretsBridge };
  };
  return host.haptic?.secrets ?? null;
}

/** Separate host store: account credentials must never use plaintext fallback. */
export function getElectronAccountSecretsBridge(): ElectronSecretsBridge | null {
  const host = globalThis as {
    haptic?: { accountSecrets?: ElectronSecretsBridge };
  };
  return host.haptic?.accountSecrets ?? null;
}

/** The desktop save dialog: writes `data` where the user chooses; false when they cancel. */
export interface ElectronFileBridge {
  save(name: string, data: ArrayBuffer): Promise<boolean>;
}

export function getElectronFileBridge(): ElectronFileBridge | null {
  const host = globalThis as { haptic?: { files?: ElectronFileBridge } };
  return host.haptic?.files ?? null;
}

export function getElectronHttpBridge(): ElectronHttpBridge | null {
  const host = globalThis as {
    haptic?: { http?: ElectronHttpBridge };
  };
  return host.haptic?.http ?? null;
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

/**
 * The device facts editor Play reports to its scripts (Get Platform, Is Touch Device). The
 * native apps name their OS directly; a browser's comes from its user agent.
 */
export function deviceEnvironment(): Pick<GameEnvironment, "platform" | "touchDevice"> {
  const facts = browserDeviceFacts(typeof navigator === "undefined" ? undefined : navigator);
  const host = getHostPlatform();
  if (host === "ios") return { ...facts, platform: "iOS" };
  if (host === "android") return { ...facts, platform: "Android" };
  return facts;
}

/** iPhone or iPad, in the iOS app or a browser. iPadOS Safari and WKWebView report a Mac; touch support gives it away. */
export function isAppleMobileOperatingSystem(): boolean {
  if (getHostPlatform() === "ios") return true;
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && (navigator.maxTouchPoints ?? 0) > 1;
}
