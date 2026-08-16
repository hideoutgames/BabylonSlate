import { err, ok } from "@babylonslate/core";
import type {
  FileLock,
  LockProvider,
  LockResult,
  UnlockOptions,
} from "./types";

export interface FakeLockProviderOptions {
  selfName?: string;
  now?: () => string;
}

export class FakeLockProvider implements LockProvider {
  private readonly selfName: string;
  private readonly now: () => string;
  private readonly byId = new Map<string, FileLock>();
  private nextId = 1;
  createCount = 0;

  constructor(options: FakeLockProviderOptions = {}) {
    this.selfName = options.selfName ?? "Me";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  addTheirs(path: string, ownerName: string, lockedAt?: string): FileLock {
    const lock: FileLock = {
      id: `fake-${this.nextId++}`,
      path,
      ownerName,
      lockedAt: lockedAt ?? this.now(),
      ours: false,
    };
    this.byId.set(lock.id, lock);
    return lock;
  }

  snapshot(): FileLock[] {
    return [...this.byId.values()];
  }

  async create(path: string): Promise<LockResult<FileLock>> {
    this.createCount += 1;
    const existing = this.findByPath(path);
    if (existing) {
      return err({
        kind: "conflict",
        message: "already created lock",
        lock: existing,
      });
    }
    const lock: FileLock = {
      id: `fake-${this.nextId++}`,
      path,
      ownerName: this.selfName,
      lockedAt: this.now(),
      ours: true,
    };
    this.byId.set(lock.id, lock);
    return ok(lock);
  }

  async list(): Promise<LockResult<FileLock[]>> {
    return ok(this.snapshot());
  }

  async verify(): Promise<LockResult<{ ours: FileLock[]; theirs: FileLock[] }>> {
    const ours: FileLock[] = [];
    const theirs: FileLock[] = [];
    for (const lock of this.byId.values()) {
      if (lock.ours) ours.push(lock);
      else theirs.push(lock);
    }
    return ok({ ours, theirs });
  }

  async unlock(id: string, options?: UnlockOptions): Promise<LockResult<void>> {
    const lock = this.byId.get(id);
    if (!lock) {
      return err({ kind: "http", message: "lock not found", status: 404 });
    }
    if (!lock.ours && !options?.force) {
      return err({
        kind: "http",
        message: "not the lock holder",
        status: 403,
        lock,
      });
    }
    this.byId.delete(id);
    return ok(undefined);
  }

  private findByPath(path: string): FileLock | undefined {
    for (const lock of this.byId.values()) {
      if (lock.path === path) return lock;
    }
    return undefined;
  }
}
