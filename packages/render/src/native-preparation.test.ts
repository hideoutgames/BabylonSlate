import { describe, expect, it } from "vitest";
import { NativePreparationScheduler } from "./native-preparation";

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
});
