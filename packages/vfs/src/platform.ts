import { Capacitor } from "@capacitor/core";

export type HostPlatform = "ios" | "android" | "electron" | "web";

/**
 * Preload bridge the Electron host (P14) installs on `globalThis`. Until then
 * only the app-settings half exists, so desktop settings survive a restart
 * while the rest of the desktop shell is still a stub.
 */
export interface ElectronUserDataBridge {
  readSettings(): Promise<string | null>;
  writeSettings(json: string): Promise<void>;
}

export function getElectronUserDataBridge(): ElectronUserDataBridge | null {
  const host = globalThis as {
    babylonslate?: { userData?: ElectronUserDataBridge };
  };
  return host.babylonslate?.userData ?? null;
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
