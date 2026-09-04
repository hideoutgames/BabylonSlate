import { describe, expect, it, vi } from "vitest";
import {
  createWorkerScheduler,
  type WorkerSchedulerHost,
} from "./worker-scheduler";

interface ScheduledCallback {
  callback: (now: number) => void;
  cancelled: boolean;
}

function createHost(withAnimationFrame: boolean) {
  let now = 100;
  let nextHandle = 1;
  const callbacks = new Map<number, ScheduledCallback>();
  const host: WorkerSchedulerHost = {
    performance: { now: () => now },
    setTimeout: (callback) => {
      const handle = nextHandle++;
      callbacks.set(handle, { callback, cancelled: false });
      return handle;
    },
    clearTimeout: (handle) => {
      const scheduled = callbacks.get(handle);
      if (scheduled) scheduled.cancelled = true;
    },
  };

  if (withAnimationFrame) {
    host.requestAnimationFrame = (callback) => {
      const handle = nextHandle++;
      callbacks.set(handle, { callback, cancelled: false });
      return handle;
    };
    host.cancelAnimationFrame = (handle) => {
      const scheduled = callbacks.get(handle);
      if (scheduled) scheduled.cancelled = true;
    };
  }

  const runNext = (advanceMs: number): void => {
    now += advanceMs;
    const entry = [...callbacks.entries()].find(
      ([, value]) => !value.cancelled,
    );
    if (!entry) throw new Error("No scheduled worker callback");
    callbacks.delete(entry[0]);
    entry[1].callback(now);
  };

  return {
    host,
    runNext,
    activeCount: () =>
      [...callbacks.values()].filter((item) => !item.cancelled).length,
  };
}

describe.each([
  ["requestAnimationFrame", true],
  ["monotonic timer fallback", false],
] as const)("worker entry scheduler with %s", (_label, withAnimationFrame) => {
  it("boots, repeatedly advances elapsed time, and stops cleanly", () => {
    const harness = createHost(withAnimationFrame);
    const advance = vi.fn();
    const scheduler = createWorkerScheduler(harness.host, advance);

    scheduler.start();
    scheduler.start();
    expect(harness.activeCount()).toBe(1);

    harness.runNext(16);
    harness.runNext(20);
    harness.runNext(25);
    expect(advance.mock.calls).toEqual([[0], [0.02], [0.025]]);
    expect(harness.activeCount()).toBe(1);

    scheduler.stop();
    expect(harness.activeCount()).toBe(0);
    expect(() => harness.runNext(16)).toThrow("No scheduled worker callback");
    expect(advance).toHaveBeenCalledTimes(3);
  });
});
