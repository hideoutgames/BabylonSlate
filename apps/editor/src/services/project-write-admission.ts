import type { ProjectStorage } from "@babylonslate/core";

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
 * An editor session closes new write admissions before capturing its baseline.
 * Already-admitted owner operations retain their entire async lifetime, including
 * rollback, before the storage barrier becomes active. This is not file rollback.
 */
export class ProjectWriteAdmission {
  private active = 0;
  private readonly locks = new Map<symbol, { reason: string; ready: (acquired: boolean) => void }>();
  private readonly listeners = new Set<() => void>();
  private publishedState = "open";

  get blocked(): boolean { return this.locks.size > 0; }
  get locked(): boolean { return this.blocked && this.active === 0; }
  get pendingOperations(): number { return this.active; }
  get reason(): string | null { return this.locks.values().next().value?.reason ?? null; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  lock(reason: string): ProjectWriteLease {
    const key = Symbol();
    let ready!: (acquired: boolean) => void;
    const promise = new Promise<boolean>(resolve => { ready = resolve; });
    this.locks.set(key, { reason: reason.trim() || "Project authoring is read-only.", ready });
    this.changed();
    return {
      ready: promise,
      release: () => {
        if (!this.locks.delete(key)) return;
        ready(false);
        this.changed();
      },
    };
  }

  assertAdmission(): void {
    if (this.blocked) throw new Error(this.reason!);
  }

  /** Last-line guard on internal storage after admitted owners have drained. */
  assertStorageWritable(): void {
    if (this.locked) throw new Error(this.reason!);
  }

  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    try { this.assertAdmission(); }
    catch (error) { return Promise.reject(error); }
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
          if (!internal) return admission.run(() => Reflect.apply(value, target, args));
          try {
            admission.assertStorageWritable();
            return Reflect.apply(value, target, args);
          } catch (error) { return Promise.reject(error); }
        }
        : value.bind(target);
      methods.set(key, { original: value, method });
      return method;
    },
  });
}

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
