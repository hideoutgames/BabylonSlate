import { describe, expect, it } from "vitest";
import { shadowFilterFetches, shadowKernelRatio, shadowKernelTexels } from "./shadow-filter";

describe("shadow filter kernel", () => {
  it("holds the first cascade's width in the world: a view with coarser texels takes the nearest exact kernel no wider", () => {
    // [quality, texel ratio] → kernel width in texels: High aims at 7 × the ratio, Medium at 5 ×.
    const cases: ["medium" | "high", number, number][] = [
      ["high", 1, 7], ["high", 6 / 7, 7], ["high", 0.85, 5], ["high", 4 / 7, 5], ["high", 0.5, 3], ["high", 0.1, 3],
      ["medium", 1, 5], ["medium", 0.8, 5], ["medium", 0.79, 3], ["medium", 0.25, 3],
    ];
    expect(cases.map(([quality, ratio]) => shadowKernelTexels(quality, ratio))).toEqual(cases.map(([, , texels]) => texels));
    expect(shadowKernelTexels("low", 1)).toBeNull();
  });

  it("reads the ratio on the coarser axis, never above 1, and 1 for an unknown extent", () => {
    expect(shadowKernelRatio({ x: 0.01, y: 0.01 }, { x: 0.02, y: 0.04 })).toBe(0.25);
    expect(shadowKernelRatio({ x: 0.04, y: 0.04 }, { x: 0.01, y: 0.01 })).toBe(1);
    expect(shadowKernelRatio({ x: 0.01, y: 0.01 }, { x: 0, y: 0 })).toBe(1);
  });

  it("counts the taps the light block reads per view", () => {
    expect([
      shadowFilterFetches("low", 1, false), shadowFilterFetches("low", 1, true), shadowFilterFetches("medium", 1, true),
      shadowFilterFetches("high", 1, false), shadowFilterFetches("high", 0.7, false), shadowFilterFetches("high", 0.3, false),
    ]).toEqual([1, 4, 9, 16, 9, 4]);
  });
});
