import type { ProjectStorage } from "@babylonslate/core";
import { isMobilePlatform } from "./platform";
import { ScopedStorageAdapter } from "./scoped-storage-adapter";
import { WebStorageAdapter } from "./web-adapter";

export function createStorage(): ProjectStorage {
  if (isMobilePlatform()) {
    const adapter = new ScopedStorageAdapter();
    void adapter.init();
    return adapter;
  }
  return new WebStorageAdapter();
}
