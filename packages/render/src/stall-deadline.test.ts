import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeldThreadBudget, createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { installTimerClock } from "./virtual-clock-test-fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A synchronous shader link (no KHR_parallel_shader_compile) keeps a unit from progressing for seconds, and the
// stall timer, due meanwhile, fires only once the thread is free again.
describe("createStallDeadline with a held-thread budget", () => {
  /** A deadline over work that never settles; `outcome()` is its rejection message, once it has one. */
  function stalledWork(held?: ReturnType<typeof createHeldThreadBudget>) {
    const deadline = createStallDeadline((unit) => `stalled at ${unit}`, SCENE_SHADER_WARM_TIMEOUT_MS, undefined, held);
    deadline.advance("material");
    let message: string | undefined;
    deadline.race(new Promise<void>(() => {})).catch((error: Error) => { message = error.message; });
    return { outcome: () => message };
  }

  it("starts a fresh window when the timer fires a held gap late", async () => {
    const clock = installTimerClock();
    const work = stalledWork(createHeldThreadBudget());
    clock.hold(15_000);
    await clock.run(SCENE_SHADER_WARM_TIMEOUT_MS);
    expect(work.outcome()).toBeUndefined();
    await clock.run(SCENE_SHADER_WARM_TIMEOUT_MS);
    expect(work.outcome()).toBe("stalled at material");
  });

  it("stops crediting once the budget is spent", async () => {
    const clock = installTimerClock();
    // Each firing is 15 s late: the first spends 15 s of the 20 s budget, the second the last 5 s, the third nothing.
    const work = stalledWork(createHeldThreadBudget(20_000));
    for (let late = 0; late < 2; late++) {
      clock.hold(15_000);
      await clock.run(SCENE_SHADER_WARM_TIMEOUT_MS);
      expect(work.outcome()).toBeUndefined();
    }
    clock.hold(15_000);
    await clock.run(SCENE_SHADER_WARM_TIMEOUT_MS);
    expect(work.outcome()).toBe("stalled at material");
  });

  it("rejects at the first firing when no budget is given", async () => {
    const clock = installTimerClock();
    const work = stalledWork();
    clock.hold(15_000);
    await clock.run(SCENE_SHADER_WARM_TIMEOUT_MS);
    expect(work.outcome()).toBe("stalled at material");
  });
});
