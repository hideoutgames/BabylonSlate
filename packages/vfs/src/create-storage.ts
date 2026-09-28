import type { ProjectStorage } from "@babylonslate/core";
import { Directory } from "@capacitor/filesystem";
import { isElectronHost, isMobilePlatform, getHostPlatform, type HostPlatform } from "./platform";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { MobileStorageAdapter } from "./mobile-storage-adapter";
import { ElectronStorageAdapter } from "./electron-storage-adapter";
import { OpfsStorageAdapter } from "./web-adapter";

export function mobileDocumentsDirectory(platform: HostPlatform): Directory {
  return platform === "android" ? Directory.Data : Directory.Documents;
}

export function createStorage(): ProjectStorage {
  if (isMobilePlatform()) {
    return new MobileStorageAdapter(
      new DocumentsStorageAdapter(undefined, mobileDocumentsDirectory(getHostPlatform())),
    );
  }
  if (isElectronHost()) {
    return new ElectronStorageAdapter();
  }
  return new OpfsStorageAdapter();
}
