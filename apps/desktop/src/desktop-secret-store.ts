import { Buffer } from "node:buffer";

export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface SecretStoreFiles {
  read(): Promise<string>;
  write(contents: string): Promise<void>;
}

type StoredSecret =
  | { storage: "plaintext"; value: string }
  | { storage: "safeStorage"; ciphertext: string };

interface StoredSecrets {
  version: 1;
  secrets: Record<string, StoredSecret>;
}

const EMPTY_SECRETS: StoredSecrets = { version: 1, secrets: {} };

export class SecretDecryptionUnavailableError extends Error {
  constructor() {
    super("Encrypted secrets are temporarily unavailable");
    this.name = "SecretDecryptionUnavailableError";
  }
}

function isStoredSecret(value: unknown): value is StoredSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.storage === "plaintext" && typeof record.value === "string") ||
    (record.storage === "safeStorage" && typeof record.ciphertext === "string")
  );
}

function parseSecrets(json: string): StoredSecrets {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return structuredClone(EMPTY_SECRETS);
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !candidate.secrets ||
    typeof candidate.secrets !== "object" ||
    Array.isArray(candidate.secrets)
  ) {
    return structuredClone(EMPTY_SECRETS);
  }
  return {
    version: 1,
    secrets: Object.fromEntries(
      Object.entries(candidate.secrets).filter((entry) =>
        isStoredSecret(entry[1]),
      ),
    ),
  };
}

export class DesktopSecretStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly files: SecretStoreFiles,
    private readonly safeStorage: SafeStorage,
  ) {}

  private async read(): Promise<StoredSecrets> {
    try {
      return parseSecrets(await this.files.read());
    } catch {
      return structuredClone(EMPTY_SECRETS);
    }
  }

  private enqueue(mutation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(mutation);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  async get(key: string): Promise<string | null> {
    await this.mutationQueue;
    const secret = (await this.read()).secrets[key];
    if (!secret) return null;
    if (secret.storage === "plaintext") return secret.value;
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new SecretDecryptionUnavailableError();
    }
    return this.safeStorage.decryptString(
      Buffer.from(secret.ciphertext, "base64"),
    );
  }

  set(key: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.read();
      stored.secrets[key] = this.safeStorage.isEncryptionAvailable()
        ? {
            storage: "safeStorage",
            ciphertext: Buffer.from(
              this.safeStorage.encryptString(value),
            ).toString("base64"),
          }
        : { storage: "plaintext", value };
      await this.files.write(JSON.stringify(stored));
    });
  }

  delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.read();
      delete stored.secrets[key];
      await this.files.write(JSON.stringify(stored));
    });
  }
}
