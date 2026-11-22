import { Buffer } from "node:buffer";

export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  /** Linux only: the backend safeStorage picked (`basic_text` is a hard-coded key, so not secret). */
  getSelectedStorageBackend?(): string;
}

export interface SecretStoreFiles {
  /** Rejects with an `ENOENT` code when no secret file exists yet. */
  read(): Promise<string>;
  /** Replaces the whole file atomically, readable only by the current user. */
  write(contents: string): Promise<void>;
}

export function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * Whether safeStorage protects secrets with an operating system key. Linux's
 * `basic_text` backend encrypts with a key built into Chromium, and `unknown`
 * gives no assurance, so neither counts.
 */
export function secureEncryption(storage: SafeStorage): boolean {
  return storage.isEncryptionAvailable() &&
    !["basic_text", "unknown"].includes(storage.getSelectedStorageBackend?.() ?? "");
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class SecretDecryptionUnavailableError extends Error {
  constructor() {
    super("Encrypted secrets are temporarily unavailable");
    this.name = "SecretDecryptionUnavailableError";
  }
}

/**
 * Source control tokens and Android signing passwords. With secure OS
 * encryption they are stored as safeStorage ciphertext; without it they stay
 * in memory for this run only and nothing is written. Stored values are only
 * ever ciphertext: anything else in the file is ignored and dropped on the
 * next write.
 */
export class DesktopSecretStore {
  /** False when secrets last only until the app quits. */
  readonly persistent: boolean;
  private readonly memory = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly files: SecretStoreFiles,
    private readonly safeStorage: SafeStorage,
  ) {
    this.persistent = secureEncryption(safeStorage);
  }

  /**
   * Only a missing file is empty. Any other read failure rejects, so a later
   * write never replaces every stored secret with a one-entry file.
   */
  private async read(): Promise<Record<string, string>> {
    let json: string;
    try {
      json = await this.files.read();
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      // Unparseable contents hold nothing recoverable.
      return {};
    }
    const secrets = (parsed as { version?: unknown; secrets?: unknown } | null);
    if (!secrets || secrets.version !== 1 || !secrets.secrets || typeof secrets.secrets !== "object" || Array.isArray(secrets.secrets)) return {};
    return Object.fromEntries(Object.entries(secrets.secrets).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && BASE64.test(entry[1]),
    ));
  }

  /** Reads and writes share one queue, so a read observes every earlier call. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get(key: string): Promise<string | null> {
    if (!this.persistent) return Promise.resolve(this.memory.get(key) ?? null);
    return this.enqueue(async () => {
      const values = await this.read();
      if (!Object.hasOwn(values, key)) return null;
      if (!secureEncryption(this.safeStorage)) throw new SecretDecryptionUnavailableError();
      return this.safeStorage.decryptString(Buffer.from(values[key]!, "base64"));
    });
  }

  set(key: string, value: string): Promise<void> {
    if (!this.persistent) {
      this.memory.set(key, value);
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      if (!secureEncryption(this.safeStorage)) throw new SecretDecryptionUnavailableError();
      const values = await this.read();
      values[key] = Buffer.from(this.safeStorage.encryptString(value)).toString("base64");
      await this.files.write(JSON.stringify({ version: 1, secrets: values }));
    });
  }

  delete(key: string): Promise<void> {
    this.memory.delete(key);
    if (!this.persistent) return Promise.resolve();
    return this.enqueue(async () => {
      // Always rewritten, so whatever else the file held (never a secret) goes too.
      const values = await this.read();
      delete values[key];
      await this.files.write(JSON.stringify({ version: 1, secrets: values }));
    });
  }
}
