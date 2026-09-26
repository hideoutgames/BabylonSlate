/**
 * Burst schedule for Basic Particle Emitters. Babylon has no burst schedule, so the
 * render emission driver asks these pure helpers how many particles fall due in each
 * frame's window of the emitter cycle and writes them to `manualEmitCount`.
 */

/** Fires `count` particles at `time`, then `cycles − 1` more every `interval` s (0 = until the cycle ends). */
export type ParticleBurst = {
  time: number;
  count: number;
  cycles: number;
  interval: number;
};

/** True when the burst fires only once (`interval` is ignored). */
function singleFire(burst: ParticleBurst): boolean {
  return (
    burst.cycles === 1 || !(Number.isFinite(burst.interval) && burst.interval > 0)
  );
}

/** Smallest repeat index k ≥ 0 whose fire time `time + k·interval` is at or after `x`. */
function firstFireAtOrAfter(burst: ParticleBurst, x: number): number {
  if (x <= burst.time) return 0;
  let k = Math.ceil((x - burst.time) / burst.interval);
  // Correct floating-point drift so the index agrees with the fire time itself.
  while (k > 0 && burst.time + (k - 1) * burst.interval >= x) k -= 1;
  while (burst.time + k * burst.interval < x) k += 1;
  return k;
}

function firesInWindow(
  burst: ParticleBurst,
  duration: number,
  from: number,
  to: number,
): number {
  const end = Math.min(to, duration);
  if (!(end > from)) return 0;
  if (singleFire(burst)) {
    return from <= burst.time && burst.time < end ? 1 : 0;
  }
  const limit = burst.cycles > 0 ? burst.cycles : Number.POSITIVE_INFINITY;
  const first = Math.min(firstFireAtOrAfter(burst, from), limit);
  const after = Math.min(firstFireAtOrAfter(burst, end), limit);
  return Math.max(0, after - first);
}

/**
 * Particles fired by `bursts` at fire times f with `from ≤ f < to` and `f < duration`,
 * on the timeline of one emitter cycle. Callers split windows at cycle boundaries.
 */
export function burstParticlesInWindow(
  bursts: readonly ParticleBurst[],
  duration: number,
  from: number,
  to: number,
): number {
  let total = 0;
  for (const burst of bursts) {
    total += firesInWindow(burst, duration, from, to) * burst.count;
  }
  return total;
}

/** Fire times within one cycle, in order, capped at `limit` events. */
export function burstFireTimes(
  burst: ParticleBurst,
  duration: number,
  limit: number,
): number[] {
  const times: number[] = [];
  if (!(burst.time < duration)) return times;
  const count = singleFire(burst) ? 1 : burst.cycles > 0 ? burst.cycles : Infinity;
  for (let k = 0; k < count && times.length < limit; k += 1) {
    const time = k === 0 ? burst.time : burst.time + k * burst.interval;
    if (!(time < duration)) break;
    times.push(time);
  }
  return times;
}
