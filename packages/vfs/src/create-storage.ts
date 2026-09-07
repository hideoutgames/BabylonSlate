import type { ProjectStorage } from "@babylonslate/core";
import { isElectronHost, isMobilePlatform } from "./platform";
import { MobileStorageAdapter } from "./mobile-storage-adapter";
import { ElectronStorageAdapter } from "./electron-storage-adapter";
import { OpfsStorageAdapter } from "./web-adapter";

export function createStorage(): ProjectStorage {
  if (isMobilePlatform()) {
    return new MobileStorageAdapter();
  }
  if (isElectronHost()) {
    return new ElectronStorageAdapter();
  }
  return new OpfsStorageAdapter();
}
