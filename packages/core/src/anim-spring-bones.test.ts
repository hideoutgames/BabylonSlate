import { describe, expect, it } from "vitest";
import { animChainCurveAt, animWindGust, normalizeAnimChainCurve } from "./anim-spring-bones";

describe("chain curves", () => {
  it("multiply by 1 without keys, interpolate between keys and hold past the ends", () => {
    expect(animChainCurveAt([], 0.3)).toBe(1);
    const keys = normalizeAnimChainCurve([{ t: 1, value: 0 }, { t: 0.5, value: 1 }, { t: "x", value: 2 }]);
    expect(keys).toEqual([{ t: 0.5, value: 1 }, { t: 1, value: 0 }]);
    expect(animChainCurveAt(keys, 0)).toBe(1);
    expect(animChainCurveAt(keys, 0.75)).toBeCloseTo(0.5, 9);
    expect(animChainCurveAt(keys, 1)).toBe(0);
  });
});

describe("wind gusts", () => {
  it("are deterministic per seed and stay within a quarter and all of the strength", () => {
    expect(animWindGust(7, 1.25)).toBe(animWindGust(7, 1.25));
    expect(animWindGust(7, 1.25)).not.toBe(animWindGust(8, 1.25));
    for (let t = 0; t < 20; t += 0.37) {
      const gust = animWindGust(3, t);
      expect(gust).toBeGreaterThanOrEqual(0.25);
      expect(gust).toBeLessThanOrEqual(1);
    }
  });
});
