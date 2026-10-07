import type { SaveGameStorage } from "./save-game";

export interface SessionSaveStorageOptions {
  /** Retained UTF-16 key/value bytes, not a browser heap limit. */
  byteBudget?: number;
  entryLimit?: number;
  pendingLockLimit?: number;
}

/**
 * Copy-on-write save namespace for a disposable game session. Untouched reads
 * see the backing namespace; no operation writes, deletes, locks, or requests
 * persistence from it. Call dispose on every session exit, including Keep.
 */
export function createSessionSaveStorage(
  backing: SaveGameStorage,
  options: SessionSaveStorageOptions = {},
): SaveGameStorage & { dispose(): void; retainedBytes(): number } {
  const byteBudget = options.byteBudget ?? 16 * 1024 * 1024;
  const entryLimit = options.entryLimit ?? 4096;
  const pendingLockLimit = options.pendingLockLimit ?? 256;
  for (const value of [byteBudget, entryLimit, pendingLockLimit]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Invalid session save storage limit");
  }
  const entries = new Map<string, string | null>();
  const locks = new Map<string, Promise<void>>();
  const cancellations = new Set<() => void>();
  let bytes = 0;
  let lockBytes = 0;
  let pendingLocks = 0;
  let closed = false;
  const closedError = () => new Error("Simulation save storage session closed");
  const assertOpen = () => { if (closed) throw closedError(); };
  const size = (key: string, value: string | null) => 2 * (key.length + (value?.length ?? 0));
  const store = (key: string, value: string | null) => {
    assertOpen();
    const oldSize = entries.has(key) ? size(key, entries.get(key)!) : 0;
    const nextBytes = bytes - oldSize + size(key, value);
    if (nextBytes + lockBytes > byteBudget || (!entries.has(key) && entries.size >= entryLimit)) {
      throw Object.assign(new Error("Simulation save storage retained-data budget exceeded"), { code: "ENOSPC" });
    }
    entries.set(key, value);
    bytes = nextBytes;
  };
  return {
    async read(key) {
      assertOpen();
      if (entries.has(key)) return entries.get(key)!;
      const value = await backing.read(key);
      assertOpen();
      // An accepted write/delete may have completed during backing I/O.
      return entries.has(key) ? entries.get(key)! : value;
    },
    async write(key, text) { store(key, text); },
    async remove(key) { store(key, null); },
    async list(prefix) {
      assertOpen();
      const sourceKeys = await backing.list(prefix);
      assertOpen();
      // Bound the returned list before allocating a second key collection.
      if (sourceKeys.length > entryLimit) throw new Error("Simulation save storage list exceeds its entry limit");
      const keys = new Set(sourceKeys);
      for (const [key, value] of entries) {
        if (!key.startsWith(prefix)) continue;
        if (value === null) keys.delete(key);
        else keys.add(key);
      }
      if (keys.size > entryLimit) throw new Error("Simulation save storage list exceeds its entry limit");
      return [...keys].sort();
    },
    async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
      assertOpen();
      if (pendingLocks >= pendingLockLimit) throw new Error("Simulation save storage has too many pending transactions");
      const retainedKeyBytes = size(key, null);
      if (retainedKeyBytes + bytes + lockBytes > byteBudget) throw new Error("Simulation save storage lock data exceeds its budget");
      lockBytes += retainedKeyBytes;
      pendingLocks++;
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      locks.set(key, current);
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(closedError()); });
      cancellations.add(cancel);
      try {
        await Promise.race([previous, cancelled]);
        assertOpen();
        const value = await Promise.race([operation(), cancelled]);
        assertOpen();
        return value;
      } finally {
        pendingLocks--;
        lockBytes -= retainedKeyBytes;
        cancellations.delete(cancel);
        release();
        if (locks.get(key) === current) locks.delete(key);
      }
    },
    async requestPersistence() { assertOpen(); return false; },
    retainedBytes: () => bytes + lockBytes,
    dispose() {
      closed = true;
      entries.clear();
      bytes = 0;
      for (const cancel of cancellations) cancel();
      cancellations.clear();
      locks.clear();
      // In-flight callbacks may finish, but assertOpen prevents their next write
      // or stale result from escaping. Their finally blocks release local locks.
    },
  };
}
