import { Capacitor } from "@capacitor/core";
import { browserDeviceFacts, type BuildPlatform, type GameEnvironment } from "@haptic/core";
import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
} from "@haptic/core";
import type { LibraryFolder } from "./library-folders";
import type { NativeHttpImageUpload } from "./native-http-port";
import type { EngineSettings } from "./app-settings";

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

/** The desktop app's own Electron runtime, for packaging games for the OS it runs on. */
export interface ElectronGameShellBridge {
  /** Node's `process.platform` and `process.arch` of the running app. */
  platform: string;
  arch: string;
  /** This app's Electron files named as the release lists them, zipped in that layout; refused unless `electronVersion` is the app's. */
  runtime(files: string[], electronVersion: string): Promise<Uint8Array>;
  /** macOS only: Developer ID Application identities in this Mac's keychain. */
  macIdentities(): Promise<string[]>;
  /** macOS only: packages, signs and (with a profile) notarizes a macOS game; see `apps/desktop/src/mac-game-package.ts`. */
  packageMac(request: ElectronMacGameRequest): Promise<{ fileName: string; bytes: Uint8Array; notarized: boolean }>;
  /** The JDK and Android SDK Android packaging would use with these settings, or why it cannot. */
  androidToolchain(settings: EngineSettings["androidPackaging"]["toolchain"]): Promise<AndroidToolchainStatus>;
  /** Asks for a keystore file; null when the user cancels. */
  pickAndroidKeystore(): Promise<string | null>;
  /** Builds and signs an Android game; see `apps/desktop/src/android-game-package.ts`. */
  packageAndroid(request: ElectronAndroidGameRequest): Promise<{ fileName: string; bytes: Uint8Array; debugSigned: boolean }>;
}

export interface AndroidToolchainStatus {
  javaHome: string | null;
  javaVersion: number | null;
  sdk: string | null;
  /** Empty when both were found. */
  problems: string[];
}

export interface ElectronAndroidGameRequest {
  game: [string, Uint8Array][];
  name: string;
  appId: string;
  version: string;
  buildNumber: number;
  format: "apk" | "aab";
  /** App Icon PNGs at the Android launcher sizes, or null for the system's default icon. */
  icon: [number, Uint8Array][] | null;
  toolchain: EngineSettings["androidPackaging"]["toolchain"];
  signing: EngineSettings["androidPackaging"]["signing"];
}

export interface ElectronMacGameRequest {
  game: [string, Uint8Array][];
  name: string;
  appId: string;
  version: string;
  buildNumber: number;
  gameId: string;
  /** The App Icon as an `.icns`, or null for Electron's. */
  icon: Uint8Array | null;
  identity: string | null;
  notaryProfile: string;
}

export function getElectronGameShellBridge(): ElectronGameShellBridge | null {
  const host = globalThis as {
    haptic?: { gameShell?: ElectronGameShellBridge };
  };
  return host.haptic?.gameShell ?? null;
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

/**
 * The platform this editor plays games as, for platform directives: the iOS or Android app, the desktop app's
 * operating system, or the web.
 */
export function editorBuildPlatform(): BuildPlatform {
  const host = getHostPlatform();
  if (host === "ios" || host === "android") return host;
  if (host === "electron") {
    const platform = getElectronGameShellBridge()?.platform;
    if (platform === "win32") return "windows";
    if (platform === "darwin") return "macos";
    if (platform === "linux") return "linux";
  }
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
