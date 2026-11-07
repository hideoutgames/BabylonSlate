import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

export type NativePreparationPriority = "gameplay" | "preload" | "background";
export interface NativePreparationLimits { maxConcurrent?: number; temporaryBytes?: number }
export interface NativePreparationRequest {
  label: string;
  temporaryBytes: number;
  priority?: NativePreparationPriority;
  signal?: AbortSignal;
}
type Work = { request: NativePreparationRequest; run: () => Promise<void>; cancel: () => void };
const rank = { gameplay: 0, preload: 1, background: 2 };

/** Admission only. Resource ownership and sharing remain in the existing caches. */
export class NativePreparationScheduler {
  private readonly concurrency: number;
  private readonly ceiling: number;
  private readonly queue: Work[] = [];
  private active = 0;
  private reserved = 0;
  private peak = 0;
  private disposed = false;

  constructor(limits: NativePreparationLimits = {}) {
    // Provisional limits are configurable; device measurements must tune them.
    this.concurrency = limits.maxConcurrent ?? 2;
    this.ceiling = limits.temporaryBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 ||
      !Number.isSafeInteger(this.ceiling) || this.ceiling < 1)
      throw new Error("Native preparation limits must be positive integers.");
  }

  snapshot() { return { active: this.active, queued: this.queue.length, temporaryBytes: this.reserved,
    peakTemporaryBytes: this.peak, byteCeiling: this.ceiling, maxConcurrent: this.concurrency }; }

  schedule<T>(request: NativePreparationRequest, prepare: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(`${request.label}: native preparation scheduler was disposed.`));
    if (request.signal?.aborted) return Promise.reject(request.signal.reason);
    if (!Number.isSafeInteger(request.temporaryBytes) || request.temporaryBytes < 0)
      return Promise.reject(new Error(`${request.label}: invalid temporary memory estimate.`));
    if (request.temporaryBytes > this.ceiling)
      return Promise.reject(new Error(`${request.label}: preparation needs ${request.temporaryBytes} temporary bytes; the budget is ${this.ceiling}. Reduce the asset or raise its preparation budget.`));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const detach = () => request.signal?.removeEventListener("abort", cancel);
      const cancel = () => {
        if (started) return; // Native work retains admission until it actually stops.
        const index = this.queue.indexOf(work);
        if (index < 0) return;
        this.queue.splice(index, 1);
        detach();
        reject(request.signal?.reason ?? new Error(`${request.label}: preparation cancelled.`));
        this.pump();
      };
      const work: Work = { request, cancel, run: async () => {
        started = true;
        detach();
        let value: T;
        try {
          request.signal?.throwIfAborted();
          value = await prepare();
        } catch (error) { reject(error); return; }
        finally {
          this.active--;
          this.reserved -= request.temporaryBytes;
          this.pump();
        }
        resolve(value);
      } };
      this.queue.push(work);
      request.signal?.addEventListener("abort", cancel, { once: true });
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const work of [...this.queue]) work.cancel();
  }

  private pump(): void {
    if (this.disposed) return;
    this.queue.sort((a, b) => rank[a.request.priority ?? "gameplay"] - rank[b.request.priority ?? "gameplay"]);
    while (this.active < this.concurrency) {
      const next = this.queue.findIndex((work) => this.reserved + work.request.temporaryBytes <= this.ceiling);
      if (next < 0) return;
      const [work] = this.queue.splice(next, 1);
      this.active++;
      this.reserved += work.request.temporaryBytes;
      this.peak = Math.max(this.peak, this.reserved);
      void work.run();
    }
  }
}

/**
 * Starts a group of preparation jobs at once, in order, so the queue's
 * concurrency and byte ceiling bound them rather than the caller. The first
 * failure aborts the signal the jobs schedule with, cancelling those still
 * queued, and is rethrown only once the whole group has settled, so nothing the
 * group started is still acquiring. `signal` cancels the group with its reason.
 * Results keep job order.
 */
export async function prepareTogether<T>(
  signal: AbortSignal | undefined,
  jobs: readonly ((signal: AbortSignal) => Promise<T>)[],
): Promise<T[]> {
  const group = new AbortController();
  const forward = () => group.abort(signal!.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  let failure: { error: unknown } | undefined;
  try {
    const settled = await Promise.allSettled(jobs.map(async (job) => {
      try {
        return await job(group.signal);
      } catch (error) {
        if (!failure) {
          failure = { error };
          group.abort(error);
        }
        throw error;
      }
    }));
    if (failure) throw failure.error;
    return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
  } finally {
    signal?.removeEventListener("abort", forward);
  }
}

const engineSchedulers = new WeakMap<AbstractEngine, NativePreparationScheduler>();
/** All Scenes and Play handles on an Engine share one admission queue. */
export function nativePreparationForEngine(engine: AbstractEngine, limits?: NativePreparationLimits): NativePreparationScheduler {
  let scheduler = engineSchedulers.get(engine);
  if (!scheduler) {
    scheduler = new NativePreparationScheduler(limits);
    engineSchedulers.set(engine, scheduler);
    const owned = scheduler;
    engine.onDisposeObservable.addOnce(() => { owned.dispose(); engineSchedulers.delete(engine); });
  }
  return scheduler;
}
