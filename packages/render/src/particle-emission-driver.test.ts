import { describe, expect, it } from "vitest";
import type { BasicEmissionSchedule, ParticleBurst } from "@babylonslate/assets";
import { createBasicEmissionDriver, type EmissionTarget } from "./particle-emission-driver";

function target(emitRate = 0): EmissionTarget {
  return { emitRate, minLifeTime: 1, maxLifeTime: 1, manualEmitCount: -1 };
}

function schedule(overrides: Partial<BasicEmissionSchedule> = {}): BasicEmissionSchedule {
  return { loop: "infinite", duration: 1, rateCurve: null, lifetimeCurve: null, bursts: [], ...overrides };
}

const burst = (time: number, count: number, cycles = 1, interval = 0.5): ParticleBurst => ({ time, count, cycles, interval });

/** Babylon consumes a manual count during the next render and leaves 0. */
function consume(native: EmissionTarget): number {
  const emitted = Math.max(native.manualEmitCount, 0);
  if (native.manualEmitCount > -1) native.manualEmitCount = 0;
  return emitted;
}

describe("Basic emission driver", () => {
  it("queues a burst after the first frame and restores rate emission once Babylon consumes it", () => {
    const native = target();
    const driver = createBasicEmissionDriver(native, schedule({ bursts: [burst(0, 10)] }));
    driver.advance(1 / 60);
    expect(native.manualEmitCount).toBe(10);
    consume(native);
    driver.advance(1 / 60);
    expect(native.manualEmitCount).toBe(-1);
  });

  it("keeps an unconsumed burst queued and never adds rate compensation twice", () => {
    const native = target(60);
    const driver = createBasicEmissionDriver(native, schedule({ bursts: [burst(0, 5), burst(0.05, 7)] }));
    driver.advance(1 / 30);
    // The burst frame skips Babylon's rate emission, so two rate particles are added back.
    expect(native.manualEmitCount).toBe(5 + 2);
    // Not consumed (for example a GPU system that was not ready): later bursts add only their count.
    driver.advance(1 / 30);
    expect(native.manualEmitCount).toBe(5 + 2 + 7);
  });

  it("fires bursts once per cycle while looping and once in total for a Once emitter", () => {
    const fired = (loop: BasicEmissionSchedule["loop"]) => {
      const native = target();
      const driver = createBasicEmissionDriver(native, schedule({ loop, duration: 0.5, bursts: [burst(0.125, 3)] }));
      let emitted = 0;
      for (let frame = 0; frame < 8; frame += 1) {
        driver.advance(0.125);
        emitted += consume(native);
      }
      return emitted;
    };
    expect(fired("infinite")).toBe(6);
    expect(fired("once")).toBe(3);
  });

  it("drives Spawn Rate and Lifetime curves over the emitter cycle", () => {
    const native = target(0);
    const driver = createBasicEmissionDriver(native, schedule({
      duration: 2,
      rateCurve: [{ t: 0, value: 0 }, { t: 1, value: 100 }],
      lifetimeCurve: [{ t: 0, value: 2 }, { t: 1, value: 1 }],
    }));
    driver.advance(0.5);
    expect(native.emitRate).toBeCloseTo(25);
    expect(native.minLifeTime).toBeCloseTo(1.75);
    expect(native.maxLifeTime).toBeCloseTo(1.75);
    // The looping cycle wraps back to the curve start.
    driver.advance(1.5);
    expect(native.emitRate).toBeCloseTo(0);
  });

  it("holds its clock on a zero step and never writes after halt, so a drain stays muted", () => {
    const native = target();
    const driver = createBasicEmissionDriver(native, schedule({ bursts: [burst(0, 4, 0, 0.1)] }));
    driver.advance(0);
    expect(native.manualEmitCount).toBe(-1);
    driver.advance(0.05);
    expect(native.manualEmitCount).toBe(4);
    consume(native);
    driver.halt();
    for (let frame = 0; frame < 10; frame += 1) driver.advance(0.05);
    expect(native.manualEmitCount).toBe(0);
  });

  it("keeps the cycle clock across a live schedule edit", () => {
    const native = target();
    const driver = createBasicEmissionDriver(native, schedule({ loop: "once", duration: 2 }));
    driver.advance(0.5);
    driver.setSchedule(schedule({ loop: "once", duration: 2, bursts: [burst(0.25, 3), burst(0.55, 5)] }));
    driver.advance(0.1);
    expect(native.manualEmitCount).toBe(5);
  });
});
