import type { ProjectStorage } from "@babylonslate/core";
import { isMobilePlatform } from "./platform";
import { MobileStorageAdapter } from "./mobile-storage-adapter";
import { OpfsStorageAdapter } from "./web-adapter";

export function createStorage(): ProjectStorage {
  if (isMobilePlatform()) {
    const adapter = new MobileStorageAdapter();
    void adapter.init();
    return adapter;
  }
  return new OpfsStorageAdapter();
}
