import { describe, expect, it } from "vitest";
import { parseEasingCurve, sampleEasingCurve } from "./easing";

describe("engine easing", () => {
  it("uses saved numeric enum choices and falls back to Linear for unsupported values", () => {
    expect(sampleEasingCurve(parseEasingCurve(2), 0.25)).toBeCloseTo(0.4375);
    expect(sampleEasingCurve(parseEasingCurve("sineIn"), 0.5)).toBeCloseTo(0.2928932188);
    for (const invalid of [undefined, -1, 31, 1.5, "unknown"]) {
      expect(sampleEasingCurve(parseEasingCurve(invalid), 0.25)).toBe(0.25);
    }
  });

  it("clamps elapsed time while retaining Back and Elastic output overshoot", () => {
    expect(sampleEasingCurve("expoIn", -0.1)).toBe(0);
    expect(sampleEasingCurve("expoOut", 1.1)).toBe(1);
    expect(sampleEasingCurve("elasticOut", 0.15)).toBeGreaterThan(1);
    expect(sampleEasingCurve("backIn", 0.25)).toBeLessThan(0);
    expect(sampleEasingCurve("backOut", 0.75)).toBeGreaterThan(1);
  });
});
