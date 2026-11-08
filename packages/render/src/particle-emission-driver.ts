import type { IParticleSystem } from "@babylonjs/core/Particles/IParticleSystem";
import {
  burstParticlesInWindow,
  sampleScalarCurve,
  type BasicEmissionSchedule,
} from "@haptic/assets";

export type EmissionTarget = Pick<IParticleSystem, "emitRate" | "minLifeTime" | "maxLifeTime" | "manualEmitCount">;

/**
 * Babylon's manual emission, shared by Basic bursts and Particle Graph bursts. A frame with
 * `manualEmitCount > -1` emits that many particles instead of its rate emission and leaves
 * 0, which mutes rate emission for good, so `restore` puts -1 back once the count was consumed.
 */
export type ManualEmission = {
  /** Once per rendered frame, before queueing: a consumed count gives rate emission back. */
  restore(): void;
  /** Emits `count` particles in the next simulated frame (`dt` seconds), plus the rate emission that frame skips. */
  queue(count: number, dt: number): void;
};

/** `rate` is the system's current rate per second (a graph computes it from its Emit Rate input). */
export function createManualEmission(target: Pick<IParticleSystem, "manualEmitCount">, rate: () => number): ManualEmission {
  let queued = false;
  return {
    restore() {
      // A still-positive count was not consumed (not ready, not drawn) and stays queued; later bursts add to it.
      if (queued && target.manualEmitCount === 0) {
        target.manualEmitCount = -1;
        queued = false;
      }
    },
    queue(count, dt) {
      if (!(count > 0)) return;
      const current = target.manualEmitCount;
      // A manual frame skips that frame's rate emission on both backends; add it back
      // only when nothing is pending, or unconsumed frames would add up to a false burst.
      const skipped = current === -1 || current === 0 ? Math.round(rate() * dt) : 0;
      target.manualEmitCount = Math.max(current, 0) + count + skipped;
      queued = true;
    },
  };
}

export type BasicEmissionDriver = {
  /** Once per rendered frame while the bundle plays and this emitter has not stopped; `dt` in simulated seconds. */
  advance(dt: number): void;
  /** Never write the target again (native stop, drain, retire), so drain muting holds. */
  halt(): void;
  /** Live edit: adopt a new schedule and keep the cycle clock (wrapped when the emitter loops). */
  setSchedule(schedule: BasicEmissionSchedule): void;
  /**
   * A scripted burst (Emit Particle Burst): emitted with the next advance that simulates time,
   * like an authored burst (one frame late, never during prewarm). Ignored once halted.
   */
  burst(count: number): void;
  /** How many times the driver has written the target's lifetime (a Lifetime curve): a reader of it rereads only after one. */
  readonly lifetimeWrites: number;
};

/**
 * Owner-driven emission for one Basic emitter. Babylon has no burst schedule and its
 * emitter-time gradients throw on looping systems, so the driver samples the Spawn Rate
 * and Lifetime curves over the emitter cycle and queues bursts through
 * `manualEmitCount`. A burst is queued after frame k renders and emitted in frame k + 1
 * (one frame late by design); bursts are not simulated during prewarm. GPU prewarm runs
 * inside the first ready render, so the service advances a prewarming GPU emitter's
 * driver only after its first draw.
 */
export function createBasicEmissionDriver(
  target: EmissionTarget,
  schedule: BasicEmissionSchedule,
): BasicEmissionDriver {
  let current = schedule;
  let cycleTime = 0;
  let halted = false;
  let requested = 0;
  let lifetimeWrites = 0;
  const manual = createManualEmission(target, () => target.emitRate);

  const writeCurves = () => {
    const x = Math.min(cycleTime, current.duration) / current.duration;
    if (current.rateCurve) target.emitRate = sampleScalarCurve(current.rateCurve, x);
    if (current.lifetimeCurve) {
      const lifetime = sampleScalarCurve(current.lifetimeCurve, x);
      target.minLifeTime = lifetime;
      target.maxLifeTime = lifetime;
      lifetimeWrites++;
    }
  };

  return {
    get lifetimeWrites() { return lifetimeWrites; },
    advance(dt) {
      if (halted) return;
      manual.restore();
      if (!(dt > 0)) return;
      const { loop, duration, bursts } = current;
      let from = cycleTime;
      let due = requested;
      requested = 0;
      cycleTime += dt;
      if (loop === "once") {
        due += burstParticlesInWindow(bursts, duration, from, Math.min(cycleTime, duration));
      } else {
        // Babylon clamps a frame to one second, which bounds the wraps per frame.
        while (cycleTime >= duration) {
          due += burstParticlesInWindow(bursts, duration, from, duration);
          from = 0;
          cycleTime -= duration;
        }
        due += burstParticlesInWindow(bursts, duration, from, cycleTime);
      }
      writeCurves();
      manual.queue(due, dt);
    },
    halt() {
      halted = true;
      requested = 0;
    },
    burst(count) {
      if (!halted && count > 0) requested += count;
    },
    setSchedule(next) {
      current = next;
      if (next.loop === "infinite") cycleTime %= next.duration;
      if (!halted) writeCurves();
    },
  };
}
