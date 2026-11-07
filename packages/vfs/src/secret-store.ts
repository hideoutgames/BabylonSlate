export interface SecretStore {
  /** False on web production — source control stays hidden. */
  readonly available: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class UnavailableSecretStore implements SecretStore {
  readonly available = false;

  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {
    throw new Error("Secret store is not available on this host");
  }

  async delete(): Promise<void> {
    /* no-op */
  }
}
