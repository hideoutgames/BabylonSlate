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
