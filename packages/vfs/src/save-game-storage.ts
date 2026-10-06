import type { SaveGameStorage } from "@babylonslate/core";
import { getElectronSaveGameBridge, getHostPlatform } from "./platform";
import { ElectronSaveGameStorage } from "./save-game-electron";
import { MobileSaveGameStorage } from "./save-game-mobile";
import { WebSaveGameStorage } from "./save-game-web";

/** The same adapter selection is used by editor Play and the exported player. */
export function createSaveGameStorage(): SaveGameStorage {
  const platform = getHostPlatform();
  if (platform === "ios" || platform === "android") return new MobileSaveGameStorage();
  const bridge = getElectronSaveGameBridge();
  if (bridge) return new ElectronSaveGameStorage(bridge);
  if (platform === "electron") throw new Error("Desktop save storage bridge is unavailable");
  return new WebSaveGameStorage();
}
