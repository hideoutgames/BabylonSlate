import { describe, expect, it } from "vitest";
import {
  burstFireTimes,
  burstParticlesInWindow,
  type ParticleBurst,
} from "./particle-schedule";

const burst = (overrides: Partial<ParticleBurst>): ParticleBurst => ({
  time: 0,
  count: 10,
  cycles: 1,
  interval: 0.5,
  ...overrides,
});

describe("burst schedule", () => {
  it("fires a burst at t = 0 in the first frame window only", () => {
    const bursts = [burst({ count: 25 })];
    expect(burstParticlesInWindow(bursts, 2, 0, 1 / 60)).toBe(25);
    expect(burstParticlesInWindow(bursts, 2, 1 / 60, 2 / 60)).toBe(0);
  });

  it("repeats a burst for its cycles at its interval", () => {
    const bursts = [burst({ time: 0.2, cycles: 3, interval: 0.5 })];
    expect(burstParticlesInWindow(bursts, 5, 0, 5)).toBe(30);
    expect(burstParticlesInWindow(bursts, 5, 0.7, 1.2)).toBe(10);
    expect(burstFireTimes(bursts[0]!, 5, 10)).toEqual([0.2, 0.7, 1.2]);
  });

  it("repeats a zero-cycle burst until the cycle ends and never at or after duration", () => {
    const endless = [burst({ cycles: 0, interval: 0.25, count: 1 })];
    expect(burstParticlesInWindow(endless, 1, 0, 10)).toBe(4);
    expect(burstParticlesInWindow([burst({ time: 2 })], 2, 0, 10)).toBe(0);
  });

  it("counts every fire exactly once however the cycle is split into frames", () => {
    const bursts = [
      burst({ time: 0, cycles: 0, interval: 0.1, count: 1 }),
      burst({ time: 0.05, cycles: 4, interval: 0.3, count: 2 }),
    ];
    const whole = burstParticlesInWindow(bursts, 1, 0, 1);
    for (const frame of [1 / 60, 1 / 30, 0.1, 0.07]) {
      let split = 0;
      for (let from = 0; from < 1; from += frame) {
        split += burstParticlesInWindow(bursts, 1, from, Math.min(1, from + frame));
      }
      expect(split).toBe(whole);
    }
    expect(whole).toBe(10 + 4 * 2);
  });

  it("caps listed fire times at the requested limit", () => {
    expect(
      burstFireTimes(burst({ cycles: 0, interval: 0.01 }), 600, 5),
    ).toHaveLength(5);
  });
});
