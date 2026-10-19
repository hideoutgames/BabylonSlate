/**
 * Maximum time a loading step may go without observable progress. A slow host
 * that keeps completing units stays within budget; a hung unit fails promptly.
 */
export const SCENE_SHADER_WARM_TIMEOUT_MS = 4_000;

/**
 * Longest one set of effects may stay pending on a parallel-compile driver
 * thread before a loading budget stops renewing for it (`DriverCompileWatch`).
 * Cold builds of the large Water shader measured 9 to 14 s each on D3D11
 * (ANGLE, RTX 2060); this leaves about four times that headroom.
 */
export const SCENE_DRIVER_COMPILE_TIMEOUT_MS = 60_000;

/**
 * Budget for a loading owner's first valid draw after its readiness gates pass.
 * One draw is not a progress unit a stall deadline can observe: on software GL
 * (SwiftShader) a heavy scene's first draw compiles its pipeline states inside
 * the GPU submission and can take several seconds before a validated frame.
 */
export const SCENE_FIRST_FRAME_TIMEOUT_MS = 20_000;

/**
 * A gap of at least this long between two checkpoints of a polling loading step
 * is time the step could neither spend nor observe. The loops step every 16 ms
 * and a probe on a healthy host takes milliseconds, so a longer gap means a
 * synchronous call held the thread, or the host did not run the step (garbage
 * collection, a decode, or a hidden page, whose timers browsers align to a
 * second or more). Without KHR_parallel_shader_compile (SwiftShader, WebKit
 * WebGL2) a readiness probe links every effect before it returns, and a cold
 * two-core runner held the thread for 13 to 15 s.
 */
export const SCENE_THREAD_HELD_MS = 1_000;

/**
 * The most one loading step (a `SceneRenderCoordinator.prepare` call, a forward
 * graph readiness loop, or the waits sharing one `HeldThreadBudget`: a one-shot
 * capture, a model instance's material preparation) credits back for held
 * time. Beyond it the wall-clock bounds run as usual, so a scene that never
 * becomes ready still fails; it matches the bound on a pending parallel compile.
 */
export const SCENE_THREAD_HELD_BUDGET_MS = 60_000;

/**
 * The part of a gap between two checkpoints that a wall-clock loading bound
 * must not charge: all of a gap that reaches `SCENE_THREAD_HELD_MS`, none of a
 * shorter one. The caller spends it from `SCENE_THREAD_HELD_BUDGET_MS`.
 */
export function heldThreadMs(elapsed: number): number {
  return elapsed >= SCENE_THREAD_HELD_MS ? elapsed : 0;
}

/** Held time that waits sharing it may still credit back. */
export interface HeldThreadBudget {
  /** Spend up to `ms` of the budget; the amount actually granted. */
  grant(ms: number): number;
}

/**
 * A fresh budget of `ms`. One loading owner (a one-shot capture, a model
 * instance) shares one across its sequential waits, so a capture that never
 * becomes ready cannot credit a full budget at every step.
 */
export function createHeldThreadBudget(ms: number = SCENE_THREAD_HELD_BUDGET_MS): HeldThreadBudget {
  let left = ms;
  return {
    grant(request) {
      const granted = Math.max(0, Math.min(request, left));
      left -= granted;
      return granted;
    },
  };
}

export interface HeldThreadBound {
  /**
   * Call once per polling step, after its probe. Credits the gap since the
   * previous call (or since the bound was created) when the thread was held,
   * then reports whether the bound has run out.
   */
  expired(): boolean;
}

/**
 * A wall-clock bound on a polling wait that does not charge the time a
 * synchronous probe held the thread (`heldThreadMs`), up to `budget` (a fresh
 * `SCENE_THREAD_HELD_BUDGET_MS` unless the caller shares one). A wait that never
 * becomes ready therefore fails after at most `boundMs` plus the budget, and a
 * slow host whose probes only link shaders does not time out spuriously. Uses
 * the monotonic `performance.now()`.
 */
export function createHeldThreadBound(
  boundMs: number,
  budget: HeldThreadBudget = createHeldThreadBudget(),
): HeldThreadBound {
  let checkpoint = performance.now();
  let deadline = checkpoint + boundMs;
  return {
    expired() {
      const now = performance.now();
      deadline += budget.grant(heldThreadMs(now - checkpoint));
      checkpoint = now;
      return now >= deadline;
    },
  };
}

export interface StallDeadline {
  /** Restart the deadline after one unit of progress; `unit` names the next one. */
  advance(unit: string): void;
  /** Settle with `work`, or reject once no progress is observed for the budget. */
  race(work: Promise<void>): Promise<void>;
}

/**
 * A deadline that measures stalls, not total duration. The rejection names the
 * unit in progress and how many settled before it. `renew` is asked when a
 * budget expires; true grants another budget (`DriverCompileWatch.renew`).
 * With a `held` budget, a timer that fires a held gap late (`heldThreadMs`: a
 * synchronous call kept the unit from progressing before the timer could run)
 * starts a fresh window, spending the lateness from the budget.
 */
export function createStallDeadline(
  describe: (stalled: string | null, completed: number) => string,
  ms: number,
  renew?: () => boolean,
  held?: HeldThreadBudget,
): StallDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: string | null = null;
  let completed = -1;
  let reject: ((error: Error) => void) | undefined;
  let armedAt = 0;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    armedAt = performance.now();
    timer = setTimeout(() => {
      const late = held ? held.grant(heldThreadMs(performance.now() - armedAt - ms)) : 0;
      if (late > 0 || renew?.()) arm();
      else reject?.(new Error(describe(current, Math.max(completed, 0))));
    }, ms);
  };
  return {
    advance(unit) {
      current = unit;
      completed++;
      if (reject) arm();
    },
    async race(work) {
      try {
        await Promise.race([
          work,
          new Promise<void>((_resolve, fail) => {
            reject = fail;
            arm();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        reject = undefined;
      }
    },
  };
}
