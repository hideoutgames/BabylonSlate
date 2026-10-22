import type { SaveGameStorage } from "@haptic/core";
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
  /**
   * The operation's outcome is the result. A release the host refuses means
   * the lease is already gone (the host drops a window's leases on reload,
   * crash or close), so it must not report a completed write as failed or
   * replace the write's own error.
   */
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const token = await unwrap(this.bridge.acquireLock(key));
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try { outcome = { ok: true, value: await operation() }; }
    catch (error) { outcome = { ok: false, error }; }
    await unwrap(this.bridge.releaseLock(token)).catch((error: unknown) => console.warn("Save lock release failed", error));
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
