import { Capacitor } from "@capacitor/core";
import type { ProjectStorage } from "@babylonslate/core";
import { ScopedStorageAdapter } from "./scoped-storage-adapter";
import { WebStorageAdapter } from "./web-adapter";

export function createStorage(): ProjectStorage {
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") {
    const adapter = new ScopedStorageAdapter();
    void adapter.init();
    return adapter;
  }
  return new WebStorageAdapter();
}
