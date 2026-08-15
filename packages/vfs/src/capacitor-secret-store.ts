import { registerPlugin } from "@capacitor/core";
import type { SecretStore } from "./secret-store";

interface BabylonSlateSecretsPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const BabylonSlateSecrets = registerPlugin<BabylonSlateSecretsPlugin>(
  "BabylonSlateSecrets",
);

/**
 * iOS Keychain / Android Keystore via the first-party Capacitor plugin.
 */
export class CapacitorSecretStore implements SecretStore {
  readonly available = true;
  private readonly plugin: BabylonSlateSecretsPlugin;

  constructor(plugin: BabylonSlateSecretsPlugin = BabylonSlateSecrets) {
    this.plugin = plugin;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.plugin.get({ key });
    return result.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.plugin.set({ key, value });
  }

  async delete(key: string): Promise<void> {
    await this.plugin.remove({ key });
  }
}
