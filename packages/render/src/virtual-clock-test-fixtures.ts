import { vi } from "vitest";
import { SCENE_THREAD_HELD_MS } from "./stall-deadline";

/** The longest gap that still counts as polling rather than a held thread. */
export const POLL_MS = SCENE_THREAD_HELD_MS - 100;

/**
 * A virtual clock for waits bounded by the wall clock. `Date.now()` and
 * `performance.now()` read the same virtual time, which moves only when a test
 * advances it: from inside a probe, a gap of `POLL_MS` models one poll and a gap
 * of seconds models a synchronous call that held the thread. The real speed of
 * the runner therefore never changes what a gap looks like. Timers stay real
 * and take no virtual time. Undo with `vi.useRealTimers()` and
 * `vi.restoreAllMocks()`.
 */
export function installVirtualClock() {
  const origin = performance.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => origin + (Date.now() - start));
  return {
    advance: (ms: number) => { vi.setSystemTime(Date.now() + ms); },
    elapsed: () => Date.now() - start,
  };
}

/**
 * Virtual timers and a virtual `performance.now()` for waits driven by
 * `setTimeout`. `hold(ms)` models a synchronous call that held the thread: time
 * passes and the timers that fell due in it fire late, on the next `run`.
 * `run(ms)` lets time pass in 16 ms steps, firing timers as they fall due.
 * Undo with `vi.useRealTimers()` and `vi.restoreAllMocks()`.
 */
export function installTimerClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    hold: (ms: number) => { now += ms; },
    async run(ms: number) {
      for (let passed = 0; passed < ms; passed += 16) {
        const step = Math.min(16, ms - passed);
        now += step;
        await vi.advanceTimersByTimeAsync(step);
      }
    },
  };
}
