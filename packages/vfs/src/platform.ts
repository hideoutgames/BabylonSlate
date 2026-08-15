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

export interface ElectronProjectBridge {
  pickProjectFolder(): Promise<ProjectFolderHandle>;
  openDocumentsProject(name: string): Promise<ProjectFolderHandle>;
  openKnownFolder(handle: ProjectFolderHandle): Promise<ProjectFolderHandle>;
  listProjects(): Promise<ProjectFolderHandle[]>;
  getCurrentFolder(): Promise<ProjectFolderHandle | null>;
  releaseFolder(): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
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
