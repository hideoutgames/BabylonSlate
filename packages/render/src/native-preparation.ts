import type { AbstractEngine } from "@babylonjs/core";

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
