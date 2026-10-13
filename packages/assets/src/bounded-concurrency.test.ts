import { describe, expect, it } from "vitest";
import { createLimiter, createReadAhead, mapBounded } from "./bounded-concurrency";

/** A task whose completion the test controls. */
function gate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createLimiter", () => {
  it("never runs more tasks than its limit and starts waiting tasks in submission order", async () => {
    const limit = createLimiter(2);
    const gates = Array.from({ length: 5 }, () => gate());
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const runs = gates.map((entry, index) => limit(async () => {
      started.push(index);
      peak = Math.max(peak, ++running);
      await entry.promise;
      running--;
    }));
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    for (const entry of gates) entry.resolve();
    await Promise.all(runs);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("frees the slot of a task that fails", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(limit(async () => "next")).resolves.toBe("next");
  });
});

describe("mapBounded", () => {
  it("keeps item order in the results while at most `limit` tasks run", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapBounded([30, 5, 20, 1, 10], 3, async (delay, index) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running--;
      return `${index}:${delay}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
    expect(peak).toBe(3);
  });

  it("throws the failure a sequential loop would have thrown and starts nothing after it", async () => {
    const started: number[] = [];
    const slow = gate();
    const result = mapBounded([0, 1, 2, 3, 4, 5], 3, async (item) => {
      started.push(item);
      // Item 1 fails first in time, but item 0 is earlier in order and fails later.
      if (item === 0) { await slow.promise; throw new Error("first in order"); }
      if (item === 1) throw new Error("fails first in time");
      return item;
    });
    result.catch(() => undefined);
    await tick();
    slow.resolve();
    await expect(result).rejects.toThrow("first in order");
    // Item 2 had already begun when item 1 failed; nothing after the failure was started.
    expect(Math.max(...started)).toBeLessThan(4);
  });

  it("stops before the next item once the signal aborts", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    await expect(mapBounded([0, 1, 2, 3], 1, async (item) => {
      seen.push(item);
      if (item === 1) controller.abort(new Error("cancelled"));
    }, controller.signal)).rejects.toThrow("cancelled");
    expect(seen).toEqual([0, 1]);
  });
});

describe("createReadAhead", () => {
  it("starts reads ahead of the consumer and hands results back in order", async () => {
    const order = ["a", "b", "c", "d", "e"];
    const reads = new Map(order.map((key) => [key, gate<string>()]));
    const started: string[] = [];
    const take = createReadAhead(3, async (key: string) => { started.push(key); return reads.get(key)!.promise; });
    const first = take(order, 0);
    expect(started).toEqual(["a", "b", "c"]);
    reads.get("c")!.resolve("C");
    reads.get("a")!.resolve("A");
    expect(await first).toBe("A");
    const second = take(order, 1);
    expect(started).toEqual(["a", "b", "c", "d"]);
    reads.get("b")!.resolve("B");
    expect(await second).toBe("B");
    expect(await take(order, 2)).toBe("C");
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("surfaces a failure only when the consumer reaches that key and tolerates one it never reaches", async () => {
    const order = ["ok", "bad", "late"];
    const take = createReadAhead(3, async (key: string) => {
      if (key !== "ok") throw new Error(`${key} failed`);
      return key;
    });
    expect(await take(order, 0)).toBe("ok");
    await expect(take(order, 1)).rejects.toThrow("bad failed");
    // "late" failed in the background and is never consumed; this must not become an unhandled rejection.
    await tick();
  });

  it("reads a key once however many times the window covers it", async () => {
    let reads = 0;
    const order = ["x", "y", "z"];
    const take = createReadAhead(5, async (key: string) => { reads++; return key; });
    await Promise.all([take(order, 0), take(order, 1), take(order, 2)]);
    expect(reads).toBe(3);
  });
});
