import { Buffer } from "node:buffer";
import {
  isMissingFile,
  type SafeStorage,
  type SecretStoreFiles,
} from "./desktop-secret-store";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

/** Account tokens never use the source-control plaintext fallback. */
export class DesktopAccountSecretStore {
  private readonly persistent: boolean;
  private readonly memory = new Map<string, string>();
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly files: SecretStoreFiles,
    private readonly storage: AccountSafeStorage,
  ) {
    this.persistent = secureEncryption(storage);
  }

  /**
   * This is a replaceable sign-in cache, never project data. An unreadable
   * record or a damaged entry requires fresh authentication for that entry
   * instead of a lockout; intact entries survive the next write.
   */
  private async read(): Promise<Record<string, string>> {
    let json: string;
    try {
      json = await this.files.read();
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw unavailable();
    }
    let stored: unknown;
    try {
      stored = JSON.parse(json);
    } catch {
      return {};
    }
    if (!isRecord(stored) || stored.version !== 1 || !isRecord(stored.secrets))
      return {};
    return Object.fromEntries(
      Object.entries(stored.secrets).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && BASE64.test(entry[1]),
      ),
    );
  }

  /** Reads and writes share one queue, so a read observes every earlier call. */
  private queued<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation).catch(() => {
      throw unavailable();
    });
    this.operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async get(key: string): Promise<string | null> {
    if (!this.persistent) return this.memory.get(key) ?? null;
    return this.queued(async () => {
      if (!secureEncryption(this.storage)) throw unavailable();
      const values = await this.read();
      if (!Object.hasOwn(values, key)) return null;
      return this.storage.decryptString(Buffer.from(values[key]!, "base64"));
    });
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.persistent) {
      this.memory.set(key, value);
      return;
    }
    return this.queued(async () => {
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
    return this.queued(async () => {
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
