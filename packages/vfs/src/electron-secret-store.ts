import type { SecretStore } from "./secret-store";
import {
  getElectronSecretsBridge,
  type ElectronSecretsBridge,
} from "./platform";

export class ElectronSecretStore implements SecretStore {
  readonly available: boolean;
  private readonly bridge: ElectronSecretsBridge | null;

  constructor(
    bridge: ElectronSecretsBridge | null = getElectronSecretsBridge(),
  ) {
    this.bridge = bridge;
    this.available = bridge !== null;
  }

  async get(key: string): Promise<string | null> {
    if (!this.bridge) return null;
    return this.bridge.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.bridge) {
      throw new Error("Electron secrets bridge is not installed");
    }
    await this.bridge.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.delete(key);
  }
}
