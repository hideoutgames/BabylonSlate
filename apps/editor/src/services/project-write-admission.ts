import type { ProjectStorage } from "@haptic/core";

/** Passed explicitly through admitted bake/save work; never installed globally. */
export interface ProjectSceneWriter {
  writeSceneNavmeshChunk(path: string, bytes: Uint8Array, payload: Record<string, unknown>): Promise<void>;
  writeSceneAudioReverbChunk(path: string, bytes: Uint8Array, payload: Record<string, unknown>): Promise<void>;
}

export interface ProjectWriteLease {
  /** False if this owner released the lease before admitted writes settled. */
  readonly ready: Promise<boolean>;
  release(): void;
}

/**
 * A write refused because a lock holds the project's writes (Simulation, a
 * commit, Remove Unused Files): the write was never started, so a background
 * writer can wait for `ProjectWriteAdmission.whenUnlocked` and try again,
 * where any other error is a real failure. Tell it apart by type
 * (`isProjectWritesLocked`), never by message.
 */
export class ProjectWritesLockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProjectWritesLockedError";
  }
}

export function isProjectWritesLocked(error: unknown): error is ProjectWritesLockedError {
  return error instanceof ProjectWritesLockedError;
}

export interface ProjectWriteLockOptions {
  /**
   * Admissions that arrive once the lock holds the writes wait for its
   * release and then run, instead of being refused: for a short lock whose
   * end is near (a commit reading the changes and recording them), so an
   * explicit save waits rather than fails. While the lock still waits for
   * admitted operations to finish, new ones are admitted (one may be nested
   * in an operation it waits for), so the wait can never close a cycle.
   * Synchronous checks (`assertAdmission`) still refuse.
   */
  queueWrites?: boolean;
}

/**
 * An editor session closes new write admissions before capturing its baseline.
 * Already-admitted owner operations retain their entire async lifetime, including
 * rollback, before the storage barrier becomes active. This is not file rollback.
 */
export class ProjectWriteAdmission {
  private active = 0;
  private epoch = 0;
  private readonly locks = new Map<symbol, { reason: string; ready: (acquired: boolean) => void; queueWrites: boolean }>();
  private readonly listeners = new Set<() => void>();
  /** Told on every lock release: admissions waiting for a `queueWrites` lock check again. */
  private releaseWaiters: Array<() => void> = [];
  /** Told once no lock holds writes locked (`whenUnlocked`). */
  private unlockWaiters: Array<() => void> = [];
  private publishedState = "open";

  get blocked(): boolean { return this.locks.size > 0; }
  /**
   * Advances on every admitted owner operation and every write through a
   * guarded storage (`guardProjectStorage`), never on reads: equal values
   * before and after some work mean nothing wrote project files meanwhile,
   * except through `withExclusiveWriter`'s own storage.
   */
  get writeEpoch(): number { return this.epoch; }

  /** Counts a write made through a guarded storage. */
  noteWrite(): void { this.epoch++; }

  /**
   * The yielding hold a background owner (Clean Unused Project Storage) has
   * while it runs one small unit of work; null otherwise. Unlike `lock`, it
   * never refuses anyone: an admission (`run`) or a guarded write arriving
   * meanwhile waits for the unit to end (a few milliseconds), then goes on.
   */
  private yielding: Promise<void> | null = null;

  /**
   * Runs `unit` under a yielding hold, only when writes are idle (no lock
   * held, no admitted operation running, no other hold) and `stillValid()`
   * (checked in the same tick the hold starts); otherwise resolves false
   * without running it. While it runs, admissions and guarded writes wait
   * for it rather than fail, so a save is never refused because of it; the
   * owner checks `writeEpoch` before its next unit and stops when anything
   * wrote meanwhile.
   */
  async runYieldingUnit(stillValid: () => boolean, unit: () => Promise<void>): Promise<boolean> {
    if (this.blocked || this.active > 0 || this.yielding || !stillValid()) return false;
    let release!: () => void;
    this.yielding = new Promise<void>((resolve) => { release = resolve; });
    try {
      await unit();
    } finally {
      this.yielding = null;
      release();
    }
    return true;
  }

  /** The running yielding unit's end, or null: writes wait for it before they start. */
  get yieldingUnit(): Promise<void> | null { return this.yielding; }
  get locked(): boolean { return this.blocked && this.active === 0; }
  get reason(): string | null { return this.locks.values().next().value?.reason ?? null; }
  /** Why a new admission is refused now; null when none is, or every lock lets admissions wait (`queueWrites`). */
  get refusal(): string | null {
    for (const lock of this.locks.values()) if (!lock.queueWrites) return lock.reason;
    return null;
  }

  /**
   * Resolves once no lock holds writes locked (`locked` is false): the
   * signal a background writer refused with `ProjectWritesLockedError` waits
   * for before it tries again, so it never retries in a loop.
   */
  whenUnlocked(): Promise<void> {
    if (!this.locked) return Promise.resolve();
    return new Promise<void>((resolve) => { this.unlockWaiters.push(resolve); });
  }

  /**
   * Resolves once an admission would not wait: no `queueWrites` lock holds
   * the writes (a refusing lock answers at once; the admission refuses).
   * Lets a caller wait for a commit before work that should not overlap the
   * wait, such as holding the viewports' frames.
   */
  async whenAdmitting(): Promise<void> {
    while (this.locked && this.refusal === null) await this.whenReleased();
  }

  private whenReleased(): Promise<void> {
    return new Promise<void>((resolve) => { this.releaseWaiters.push(resolve); });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  lock(reason: string, options: ProjectWriteLockOptions = {}): ProjectWriteLease {
    const key = Symbol();
    let ready!: (acquired: boolean) => void;
    const promise = new Promise<boolean>(resolve => { ready = resolve; });
    this.locks.set(key, { reason: reason.trim() || "Project authoring is read-only.", ready, queueWrites: options.queueWrites === true });
    this.changed();
    return {
      ready: promise,
      release: () => {
        if (!this.locks.delete(key)) return;
        ready(false);
        const waiting = this.releaseWaiters;
        this.releaseWaiters = [];
        for (const resume of waiting) resume();
        this.changed();
      },
    };
  }

  assertAdmission(): void {
    if (this.blocked) throw new ProjectWritesLockedError(this.reason!);
  }

  /** Last-line guard on internal storage after admitted owners have drained. */
  assertStorageWritable(): void {
    if (this.locked) throw new ProjectWritesLockedError(this.reason!);
  }

  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const refusal = this.refusal;
    if (refusal) return Promise.reject(new ProjectWritesLockedError(refusal));
    // Only `queueWrites` locks. Once one holds the writes, wait for a release, then ask again (a refusing
    // lock taken meanwhile refuses). While it still drains, admit: an operation admitted then may be nested
    // in one the lock is waiting for, and waiting would never end.
    if (this.locked) return this.whenReleased().then(() => this.run(operation));
    // A background unit yields: this operation waits for it, then is admitted (or refused by a lock taken meanwhile).
    const yielding = this.yielding;
    if (yielding) return yielding.then(() => this.run(operation));
    return this.continue(operation);
  }

  /** Internal continuations only; public callers must use run(). */
  continue<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    let finish: () => void;
    try { finish = this.retain(); }
    catch (error) { return Promise.reject(error); }
    try { return Promise.resolve(operation()).finally(finish); }
    catch (error) { finish(); return Promise.reject(error); }
  }

  /** Retain one engine-owned async continuation through its final file commit. */
  retain(): () => void {
    this.assertStorageWritable();
    this.active++;
    this.epoch++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.active--;
      this.changed();
    };
  }

  private changed(): void {
    if (this.locked) for (const { ready } of this.locks.values()) ready(true);
    else if (this.unlockWaiters.length > 0) {
      const waiting = this.unlockWaiters;
      this.unlockWaiters = [];
      for (const resume of waiting) resume();
    }
    const state = this.locked ? "locked" : this.blocked ? "draining" : "open";
    if (state === this.publishedState) return;
    this.publishedState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Only outward calls are admitted. Bound owner methods keep nested operations
 * inside the already-admitted lifetime, without any global async bypass flag.
 */
export function admitOwnerWrites<T extends object>(
  owner: T,
  admission: ProjectWriteAdmission,
  writingMethods: readonly (keyof T)[],
): T {
  const writers = new Set<PropertyKey>(writingMethods);
  const bound = new Map<PropertyKey, { original: unknown; method: unknown }>();
  return new Proxy(owner, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const cached = bound.get(key);
      if (cached?.original === value) return cached.method;
      const method = writers.has(key)
        ? (...args: unknown[]) => admission.run(() => Reflect.apply(value, target, args))
        : value.bind(target);
      bound.set(key, { original: value, method });
      return method;
    },
  });
}

const STORAGE_WRITES = new Set<PropertyKey>([
  "writeText", "writeBinary", "mkdir", "remove", "pickProjectFolder",
  "openDocumentsProject", "openKnownFolder", "releaseFolder", "reconnectFolder", "deleteProject",
]);

/** Reads remain available; public handles never inherit an owner's admitted scope. */
export function guardProjectStorage(
  storage: ProjectStorage,
  admission: ProjectWriteAdmission,
  internal = false,
): ProjectStorage {
  const methods = new Map<PropertyKey, { original: unknown; method: unknown }>();
  return new Proxy(storage, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached?.original === value) return cached.method;
      const method = STORAGE_WRITES.has(key)
        ? (...args: unknown[]) => {
          if (!internal) return admission.run(() => { admission.noteWrite(); return Reflect.apply(value, target, args); });
          const write = () => {
            admission.assertStorageWritable();
            admission.noteWrite();
            return Reflect.apply(value, target, args) as unknown;
          };
          // A background unit yields: the write starts once it ends, never failing because of it.
          const yielding = admission.yieldingUnit;
          if (yielding) return yielding.then(write);
          try {
            return write();
          } catch (error) { return Promise.reject(error); }
        }
        : value.bind(target);
      methods.set(key, { original: value, method });
      return method;
    },
  });
}

/**
 * Runs `work` as the project's only writer: new admissions are refused with
 * `reason` (or, with `queueWrites`, wait for it and run after), admitted owner operations (saves, imports, copies, encodes, each
 * admitted for its whole span) finish first, then `work` writes through
 * `storage` (unguarded) until it returns; that handle refuses writes
 * afterwards. Refused while another lock holds project writes (Simulation),
 * whose barrier would otherwise count as this one's; `signal` ends the wait.
 */
export async function withExclusiveWriter<T>(
  admission: ProjectWriteAdmission,
  storage: ProjectStorage,
  reason: string,
  work: (storage: ProjectStorage) => Promise<T>,
  signal?: AbortSignal,
  options: ProjectWriteLockOptions = {},
): Promise<T> {
  if (admission.blocked) throw new ProjectWritesLockedError(admission.reason!);
  signal?.throwIfAborted();
  return exclusively(admission.lock(reason, options), storage, work, signal);
}

async function exclusively<T>(
  lease: ProjectWriteLease,
  storage: ProjectStorage,
  work: (storage: ProjectStorage) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    let stopWaiting = noop;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      stopWaiting = () => signal?.removeEventListener("abort", onAbort);
    });
    try {
      if (!(await Promise.race([lease.ready, aborted]))) throw new Error("The project's writes were released before they drained.");
    } finally {
      stopWaiting();
    }
    let open = true;
    const own = new Proxy(storage, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (!STORAGE_WRITES.has(key)) return value.bind(target);
        return (...args: unknown[]) => open
          ? Reflect.apply(value, target, args)
          : Promise.reject(new Error("The exclusive project write scope has closed."));
      },
    });
    try {
      return await work(own);
    } finally {
      open = false;
    }
  } finally {
    lease.release();
  }
}

function noop(): void {}

/** Revocable writer capability: late callbacks cannot reuse an earlier save lane. */
export function withProjectWriter<TWriter extends object, TResult>(
  admission: ProjectWriteAdmission,
  writer: TWriter,
  operation: (writer: TWriter) => Promise<TResult>,
): Promise<TResult> {
  return admission.run(async () => {
    let open = true;
    const pending = new Set<Promise<unknown>>();
    const failures: unknown[] = [];
    const scoped = new Proxy(writer, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!open) return Promise.reject(new Error("The admitted project write scope has closed."));
          const work = admission.continue(() => Reflect.apply(value, target, args));
          pending.add(work);
          void work.then(
            () => { pending.delete(work); },
            error => { pending.delete(work); failures.push(error); },
          );
          return work;
        };
      },
    });
    try {
      const result = await operation(scoped);
      open = false;
      await Promise.allSettled([...pending]);
      if (failures.length) throw failures[0];
      return result;
    } finally {
      open = false;
      await Promise.allSettled([...pending]);
    }
  });
}
