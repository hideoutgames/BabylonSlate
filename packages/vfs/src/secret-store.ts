export interface SecretStore {
  /** False on web production — source control stays hidden. */
  readonly available: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  readonly available = true;
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class UnavailableSecretStore implements SecretStore {
  readonly available = false;

  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string): Promise<void> {
    throw new Error("Secret store is not available on this host");
  }

  async delete(_key: string): Promise<void> {
    /* no-op */
  }
}
