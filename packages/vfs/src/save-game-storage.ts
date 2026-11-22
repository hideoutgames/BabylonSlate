import type { SaveGameStorage } from "@haptic/core";
import { getElectronSaveGameBridge, getHostPlatform } from "./platform";
import { ElectronSaveGameStorage } from "./save-game-electron";
import { WebSaveGameStorage } from "./save-game-web";

/** The same adapter selection is used by editor Play and the exported player. */
export function createSaveGameStorage(): SaveGameStorage {
  const platform = getHostPlatform();
  if (platform === "ios" || platform === "android") return mobileSaveGameStorage();
  const bridge = getElectronSaveGameBridge();
  if (bridge) return new ElectronSaveGameStorage(bridge);
  if (platform === "electron") throw new Error("Desktop save storage bridge is unavailable");
  return new WebSaveGameStorage();
}

/**
 * The iOS and Android adapter, loaded on first use: it is a platform module (`save-game-mobile.ts`), so web and
 * desktop games leave it and `@capacitor/filesystem` out.
 */
function mobileSaveGameStorage(): SaveGameStorage {
  let loaded: Promise<SaveGameStorage> | null = null;
  const storage = () => loaded ??= import("./save-game-mobile").then(({ MobileSaveGameStorage }) => new MobileSaveGameStorage());
  return {
    read: async (key) => (await storage()).read(key),
    write: async (key, text) => (await storage()).write(key, text),
    remove: async (key) => (await storage()).remove(key),
    list: async (prefix) => (await storage()).list(prefix),
    withLock: async (key, operation) => (await storage()).withLock(key, operation),
  };
}
