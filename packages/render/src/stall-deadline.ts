/**
 * Maximum time a loading step may go without observable progress. A slow host
 * that keeps completing units stays within budget; a hung unit fails promptly.
 */
export const SCENE_SHADER_WARM_TIMEOUT_MS = 4_000;

export interface StallDeadline {
  /** Restart the deadline after one unit of progress; `unit` names the next one. */
  advance(unit: string): void;
  /** Settle with `work`, or reject once no progress is observed for the budget. */
  race(work: Promise<void>): Promise<void>;
}

/**
 * A deadline that measures stalls, not total duration. The rejection names the
 * unit in progress and how many settled before it.
 */
export function createStallDeadline(
  describe: (stalled: string | null, completed: number) => string,
  ms: number,
): StallDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: string | null = null;
  let completed = -1;
  let reject: ((error: Error) => void) | undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => reject?.(new Error(describe(current, Math.max(completed, 0)))), ms);
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
