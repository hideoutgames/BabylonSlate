import type { IParticleSystem } from "@babylonjs/core";
import {
  burstParticlesInWindow,
  sampleScalarCurve,
  type BasicEmissionSchedule,
} from "@babylonslate/assets";

export type EmissionTarget = Pick<IParticleSystem, "emitRate" | "minLifeTime" | "maxLifeTime" | "manualEmitCount">;

export type BasicEmissionDriver = {
  /** Once per rendered frame while the bundle plays and this emitter has not stopped; `dt` in simulated seconds. */
  advance(dt: number): void;
  /** Never write the target again (native stop, drain, retire), so drain muting holds. */
  halt(): void;
  /** Live edit: adopt a new schedule and keep the cycle clock (wrapped when the emitter loops). */
  setSchedule(schedule: BasicEmissionSchedule): void;
};

/**
 * Owner-driven emission for one Basic emitter. Babylon has no burst schedule and its
 * emitter-time gradients throw on looping systems, so the driver samples the Spawn Rate
 * and Lifetime curves over the emitter cycle and queues bursts through
 * `manualEmitCount`. A burst is queued after frame k renders and emitted in frame k + 1
 * (one frame late by design, so GPU prewarm inside the first render never consumes it);
 * bursts are not simulated during prewarm.
 */
export function createBasicEmissionDriver(
  target: EmissionTarget,
  schedule: BasicEmissionSchedule,
): BasicEmissionDriver {
  let current = schedule;
  let cycleTime = 0;
  let queued = false;
  let halted = false;

  const writeCurves = () => {
    const x = Math.min(cycleTime, current.duration) / current.duration;
    if (current.rateCurve) target.emitRate = sampleScalarCurve(current.rateCurve, x);
    if (current.lifetimeCurve) {
      const lifetime = sampleScalarCurve(current.lifetimeCurve, x);
      target.minLifeTime = lifetime;
      target.maxLifeTime = lifetime;
    }
  };

  return {
    advance(dt) {
      if (halted) return;
      // Babylon leaves 0 after consuming a manual count, which mutes rate emission
      // forever. A still-positive count was not consumed (not ready, not drawn) and
      // stays queued; later bursts add to it.
      if (queued && target.manualEmitCount === 0) {
        target.manualEmitCount = -1;
        queued = false;
      }
      if (!(dt > 0)) return;
      const { loop, duration, bursts } = current;
      let from = cycleTime;
      let due = 0;
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
      if (due <= 0) return;
      const count = target.manualEmitCount;
      // A manual frame skips that frame's rate emission on both backends; add it back
      // only when nothing is pending, or unconsumed frames would add up to a false burst.
      const rate = count === -1 || count === 0 ? Math.round(target.emitRate * dt) : 0;
      target.manualEmitCount = Math.max(count, 0) + due + rate;
      queued = true;
    },
    halt() {
      halted = true;
    },
    setSchedule(next) {
      current = next;
      if (next.loop === "infinite") cycleTime %= next.duration;
      if (!halted) writeCurves();
    },
  };
}
