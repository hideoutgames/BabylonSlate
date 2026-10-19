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
 * Absolute bound on one loading wait that renews while shaders keep compiling
 * (`DriverCompileWatch.renew`), from the start of the wait whatever it credits.
 * Renewals measure progress, so this only ends a wait that keeps compiling and
 * never becomes ready (a define churn that recompiles forever), with an error
 * instead of an endless loading screen. It leaves a cold load that links every
 * variant synchronously (WebKit WebGL2, SwiftShader) several times the longest
 * such load seen.
 */
export const SCENE_PREPARATION_CEILING_MS = 300_000;

/**
 * A gap of at least this long between two checkpoints of a polling loading step
 * is time the step could neither spend nor observe. The loops step every 16 ms
 * and a probe on a healthy host takes milliseconds, so a longer gap means a
 * synchronous call held the thread, or the host did not run the step (garbage
 * collection, a decode, or a hidden page, whose timers browsers align to a
 * second or more). Where links are synchronous (SwiftShader without
 * KHR_parallel_shader_compile; WebKit WebGL2, which exposes it but links inside
 * `linkProgram`) a readiness probe links every effect before it returns, and a
 * cold two-core runner held the thread for 13 to 15 s. Shorter links count as
 * polling here; `DriverCompileWatch` renews the bounds for them instead.
 */
export const SCENE_THREAD_HELD_MS = 1_000;

/**
 * The most one loading step (a `SceneRenderCoordinator.prepare` call, a forward
 * graph readiness loop) credits back for held time. Beyond it the wall-clock
 * bounds run as usual, so a scene that never becomes ready still fails; it
 * matches the bound on a pending parallel compile.
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
 */
export function createStallDeadline(
  describe: (stalled: string | null, completed: number) => string,
  ms: number,
  renew?: () => boolean,
): StallDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: string | null = null;
  let completed = -1;
  let reject: ((error: Error) => void) | undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (renew?.()) arm();
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
