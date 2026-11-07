import { describe, expect, it, vi } from "vitest";
import { NativePreparationScheduler, prepareTogether } from "./native-preparation";

function gate() { let resolve!: () => void; return { promise: new Promise<void>((done) => { resolve = done; }), open: () => resolve() }; }

describe("native preparation admission", () => {
  it("bounds concurrent memory across consumers and admits gameplay before queued preloads", async () => {
    const scheduler = new NativePreparationScheduler({ maxConcurrent: 2, temporaryBytes: 10 });
    const first = gate();
    const order: string[] = [];
    const a = scheduler.schedule({ label: "live scene", temporaryBytes: 7 }, () => first.promise);
    const b = scheduler.schedule({ label: "preload", temporaryBytes: 4, priority: "preload" }, async () => { order.push("preload"); });
    const c = scheduler.schedule({ label: "actor", temporaryBytes: 4 }, async () => { order.push("actor"); });
    expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 2, temporaryBytes: 7 });
    first.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["actor", "preload"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, temporaryBytes: 0, peakTemporaryBytes: 8 });
  });

  it("rejects oversized work, cancels queued consumers, and holds active reservations until native work finishes", async () => {
    const scheduler = new NativePreparationScheduler({ maxConcurrent: 1, temporaryBytes: 10 });
    await expect(scheduler.schedule({ label: "model huge", temporaryBytes: 11 }, async () => undefined)).rejects.toThrow("model huge: preparation needs 11");
    const active = new AbortController();
    const queued = new AbortController();
    const first = gate();
    const a = scheduler.schedule({ label: "decoding", temporaryBytes: 8, signal: active.signal }, () => first.promise);
    let entered = false;
    const b = scheduler.schedule({ label: "cancelled scene", temporaryBytes: 1, signal: queued.signal }, async () => { entered = true; });
    queued.abort(new Error("scene unloaded"));
    await expect(b).rejects.toThrow("scene unloaded");
    active.abort();
    expect(scheduler.snapshot()).toMatchObject({ active: 1, temporaryBytes: 8, queued: 0 });
    first.open();
    await a;
    expect(entered).toBe(false);
    const retry = await scheduler.schedule({ label: "retry", temporaryBytes: 10 }, async () => "ready");
    expect(retry).toBe("ready");
  });

  it("admits a group together, cancels its queued jobs at the first failure and rethrows only once the group settles", async () => {
    const scheduler = new NativePreparationScheduler({ maxConcurrent: 2, temporaryBytes: 10 });
    const decoding = gate();
    const next = gate();
    const entered: string[] = [];
    const job = (label: string, prepare: () => Promise<unknown>) => (signal: AbortSignal) =>
      scheduler.schedule({ label, temporaryBytes: 1, signal }, () => { entered.push(label); return prepare(); });
    let settled = false;
    const group = prepareTogether(undefined, [
      job("decoding", () => decoding.promise),
      job("broken", async () => { throw new Error("broken: unsupported content"); }),
      // Admitted into the slot the failure frees, before the group learns of it.
      job("next", () => next.promise),
      job("queued", async () => undefined),
    ]).finally(() => { settled = true; });
    const failure = expect(group).rejects.toThrow("broken: unsupported content");
    // Both slots fill at once: the caller does not wait for one job before scheduling the next.
    expect(entered).toEqual(["decoding", "broken"]);
    await vi.waitFor(() => expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 0 }));
    // The failure is not reported while jobs the group started are still running.
    expect(settled).toBe(false);
    decoding.open();
    next.open();
    await failure;
    expect(entered).toEqual(["decoding", "broken", "next"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, temporaryBytes: 0 });
  });

  it("keeps job order in its results and cancels with the caller's reason", async () => {
    const shared = new NativePreparationScheduler({ maxConcurrent: 2, temporaryBytes: 10 });
    const slow = gate();
    const results = prepareTogether(undefined, [
      (signal) => shared.schedule({ label: "slow", temporaryBytes: 1, signal }, async () => { await slow.promise; return "slow"; }),
      (signal) => shared.schedule({ label: "fast", temporaryBytes: 1, signal }, async () => "fast"),
    ]);
    await vi.waitFor(() => expect(shared.snapshot().active).toBe(1));
    slow.open();
    await expect(results).resolves.toEqual(["slow", "fast"]);

    const single = new NativePreparationScheduler({ maxConcurrent: 1, temporaryBytes: 10 });
    const caller = new AbortController();
    const running = gate();
    let queuedRan = false;
    const cancelled = prepareTogether(caller.signal, [
      (signal) => single.schedule({ label: "running", temporaryBytes: 1, signal }, () => running.promise),
      (signal) => single.schedule({ label: "queued", temporaryBytes: 1, signal }, async () => { queuedRan = true; }),
    ]);
    const rejection = expect(cancelled).rejects.toThrow("scene unloaded");
    caller.abort(new Error("scene unloaded"));
    running.open();
    await rejection;
    expect(queuedRan).toBe(false);
  });
});
