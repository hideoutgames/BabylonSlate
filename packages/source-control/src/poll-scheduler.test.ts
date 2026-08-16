import { describe, expect, it, vi } from "vitest";
import { LockPollScheduler } from "./poll-scheduler";

describe("LockPollScheduler", () => {
  it("ticks immediately on start and then on the interval", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const scheduler = new LockPollScheduler({
      intervalMs: 60_000,
      tick,
    });
    scheduler.start();
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(59_999);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(2);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("does not tick while paused and ticks on resume", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const scheduler = new LockPollScheduler({
      intervalMs: 1_000,
      tick,
    });
    scheduler.start();
    scheduler.pause();
    tick.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(tick).not.toHaveBeenCalled();
    scheduler.resume();
    expect(tick).toHaveBeenCalledTimes(1);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("requestImmediate ticks even when a timer is pending", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const scheduler = new LockPollScheduler({
      intervalMs: 60_000,
      tick,
    });
    scheduler.start();
    tick.mockClear();
    scheduler.requestImmediate();
    expect(tick).toHaveBeenCalledTimes(1);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("does not tick after stop", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const scheduler = new LockPollScheduler({
      intervalMs: 100,
      tick,
    });
    scheduler.start();
    scheduler.stop();
    tick.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(tick).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
