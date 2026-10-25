/**
 * An external store of per-project editor entries keyed by location: React reads it with
 * `useSyncExternalStore`, the project provider saves its changes. Entries keep the order they were
 * added in, and follow a Class asset that moves or is renamed.
 */
export class KeyedListStore<T extends { assetGuid: string }> {
  protected entries = new Map<string, T>();
  private snapshot: readonly T[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly changeListeners = new Set<(entries: readonly T[]) => void>();
  private readonly keyOf: (entry: T) => string;

  constructor(keyOf: (entry: T) => string) {
    this.keyOf = keyOf;
  }

  /** Every entry, in the order it was added. A new array after each change. */
  list = (): readonly T[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Runs after each change made here, not after `hydrate`: what saving needs. */
  onChange(listener: (entries: readonly T[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Replaces every entry with saved ones, without saving them again. */
  hydrate(entries: readonly T[]): void {
    this.entries = new Map(entries.map((entry) => [this.keyOf(entry), entry]));
    this.publish(false);
  }

  removeAll(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.publish();
  }

  /** A Class asset moved or was renamed: its entries follow it. */
  renameAsset(fromPath: string, toPath: string): void {
    this.rekey((entry) => entry.assetGuid === fromPath ? { ...entry, assetGuid: toPath } : entry);
  }

  /** Replaces entries through `change`, re-keying the ones it returns new; publishes only when one changed. */
  protected rekey(change: (entry: T) => T): void {
    let changed = false;
    const next = new Map<string, T>();
    for (const entry of this.entries.values()) {
      const updated = change(entry);
      if (updated !== entry) changed = true;
      next.set(this.keyOf(updated), updated);
    }
    if (!changed) return;
    this.entries = next;
    this.publish();
  }

  protected publish(save = true): void {
    this.snapshot = [...this.entries.values()];
    if (save) for (const listener of this.changeListeners) listener(this.snapshot);
    for (const listener of this.listeners) listener();
  }
}
