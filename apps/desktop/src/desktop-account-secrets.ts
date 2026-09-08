import { Buffer } from "node:buffer";
import type { SafeStorage, SecretStoreFiles } from "./desktop-secret-store";

type AccountSafeStorage = SafeStorage & {
  getSelectedStorageBackend?(): string;
};

function secureEncryption(storage: AccountSafeStorage): boolean {
  return (
    storage.isEncryptionAvailable() &&
    !["basic_text", "unknown"].includes(
      storage.getSelectedStorageBackend?.() ?? "",
    )
  );
}

function unavailable(): Error {
  return new Error("Account credentials are temporarily unavailable");
}

/** Account tokens never use the legacy source-control plaintext fallback. */
export class DesktopAccountSecretStore {
  private readonly persistent: boolean;
  private readonly memory = new Map<string, string>();
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly files: SecretStoreFiles,
    private readonly storage: AccountSafeStorage,
  ) {
    this.persistent = secureEncryption(storage);
  }

  private async read(): Promise<Record<string, string>> {
    let json: string;
    try {
      json = await this.files.read();
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return {};
      throw unavailable();
    }
    if (!json) return {};
    try {
      const value: unknown = JSON.parse(json);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw unavailable();
      const stored = value as { version?: unknown; secrets?: unknown };
      if (
        stored.version !== 1 ||
        !stored.secrets ||
        typeof stored.secrets !== "object" ||
        Array.isArray(stored.secrets)
      )
        throw unavailable();
      if (
        Object.values(stored.secrets).some(
          (value) =>
            typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value),
        )
      )
        throw unavailable();
      return stored.secrets as Record<string, string>;
    } catch {
      throw unavailable();
    }
  }

  private change(action: () => Promise<void>): Promise<void> {
    const next = this.mutations.then(action).catch(() => {
      throw unavailable();
    });
    this.mutations = next.catch(() => undefined);
    return next;
  }

  async get(key: string): Promise<string | null> {
    if (!this.persistent) return this.memory.get(key) ?? null;
    await this.mutations;
    if (!secureEncryption(this.storage)) throw unavailable();
    const values = await this.read();
    if (!Object.hasOwn(values, key)) return null;
    try {
      return this.storage.decryptString(Buffer.from(values[key]!, "base64"));
    } catch {
      throw unavailable();
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.persistent) {
      this.memory.set(key, value);
      return;
    }
    return this.change(async () => {
      if (!secureEncryption(this.storage)) throw unavailable();
      const values = await this.read();
      const ciphertext = this.storage.encryptString(value).toString("base64");
      await this.files.write(
        JSON.stringify({
          version: 1,
          secrets: { ...values, [key]: ciphertext },
        }),
      );
    });
  }

  async delete(key: string): Promise<void> {
    return this.change(async () => {
      const values = await this.read();
      // Remove an older encrypted token even when this run used memory fallback.
      // Deleting ciphertext does not need access to the OS encryption key.
      if (Object.hasOwn(values, key)) {
        delete values[key];
        await this.files.write(JSON.stringify({ version: 1, secrets: values }));
      }
      this.memory.delete(key);
    });
  }
}
