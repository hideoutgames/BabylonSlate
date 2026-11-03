import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeldThreadBudget, createHeldThreadTimer, createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { installTimerClock } from "./virtual-clock-test-fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A synchronous shader link (no KHR_parallel_shader_compile) keeps a unit from progressing for seconds, and the
// stall timer, due meanwhile, fires only once the thread is free again.
describe("createStallDeadline with a held-thread budget", () => {
  /** A deadline over work that never settles; `outcome()` is its rejection message, once it has one. */
  function stalledWork(held?: ReturnType<typeof createHeldThreadBudget>, renew?: () => boolean) {
    const deadline = createStallDeadline((unit) => `stalled at ${unit}`, SCENE_SHADER_WARM_TIMEOUT_MS, renew, held);
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

  // `renew` reports progress since its previous call, as `DriverCompileWatch.renew` does.
  it("spends progress seen during a held window there, so it renews no later window", async () => {
    const clock = installTimerClock();
    let finished = false;
    const work = stalledWork(createHeldThreadBudget(), () => { const progressed = finished; finished = false; return progressed; });
    // A shader finishes inside the call that held the thread.
    finished = true;
    clock.hold(15_000);
    await clock.run(SCENE_SHADER_WARM_TIMEOUT_MS);
    expect(work.outcome()).toBeUndefined();
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

// A first frame whose programs are already linked shows no compile progress, and its first draw can hold the thread
// for longer than the whole first-frame budget on software GL.
describe("createHeldThreadTimer", () => {
  const BOUND_MS = 20_000;

  it("does not charge a hold that outlasts the bound, and expires after a whole bound the thread was free", async () => {
    const clock = installTimerClock();
    const expired = vi.fn();
    createHeldThreadTimer(BOUND_MS, expired);
    await clock.run(500);
    // One synchronous call, past the bound's due time; the timer can only fire once it returns.
    await clock.block(21_000);
    await clock.run(BOUND_MS - 1_000);
    expect(expired).not.toHaveBeenCalled();
    await clock.run(1_500);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("charges time the thread was free, and stops crediting holds once its budget is spent", async () => {
    const clock = installTimerClock();
    const expired = vi.fn();
    createHeldThreadTimer(BOUND_MS, expired, undefined, createHeldThreadBudget(5_000));
    await clock.run(BOUND_MS - 2_000);
    expect(expired).not.toHaveBeenCalled();
    await clock.block(10_000);
    // 5 s of the 10 s hold credited: the bound ran out 3 s before the thread was free again.
    expect(expired).toHaveBeenCalledOnce();
  });

  it("asks renew when the bound runs out, and restarts with a fresh bound", async () => {
    const clock = installTimerClock();
    const expired = vi.fn();
    const renew = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const timer = createHeldThreadTimer(BOUND_MS, expired, renew);
    await clock.run(BOUND_MS + 300);
    expect(renew).toHaveBeenCalledOnce();
    expect(expired).not.toHaveBeenCalled();
    await clock.run(BOUND_MS - 1_000);
    timer.restart(5_000);
    await clock.run(4_500);
    expect(expired).not.toHaveBeenCalled();
    await clock.run(1_000);
    expect(expired).toHaveBeenCalledOnce();
    timer.cancel();
  });
});
