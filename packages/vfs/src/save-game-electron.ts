import type { SaveGameStorage } from "@babylonslate/core";
import type { ElectronSaveGameBridge, SaveGameBridgeResult } from "./platform";
import { normalizeSaveGameStorageError } from "./save-game-path";

async function unwrap<T>(response: Promise<SaveGameBridgeResult<T>>): Promise<T> {
  const result = await response;
  if (result.ok) return result.value;
  const error = Object.assign(new Error(result.error.message), { name: result.error.name, code: result.error.code });
  return normalizeSaveGameStorageError(error);
}

export class ElectronSaveGameStorage implements SaveGameStorage {
  private readonly bridge: ElectronSaveGameBridge;
  constructor(bridge: ElectronSaveGameBridge) { this.bridge = bridge; }
  read(key: string): Promise<string | null> { return unwrap(this.bridge.read(key)); }
  write(key: string, text: string): Promise<void> { return unwrap(this.bridge.write(key, text)); }
  remove(key: string): Promise<void> { return unwrap(this.bridge.remove(key)); }
  list(prefix: string): Promise<string[]> { return unwrap(this.bridge.list(prefix)); }
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const token = await unwrap(this.bridge.acquireLock(key));
    try { return await operation(); } finally { await unwrap(this.bridge.releaseLock(token)); }
  }
}
