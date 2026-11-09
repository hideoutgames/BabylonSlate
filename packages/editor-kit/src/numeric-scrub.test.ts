import { describe, expect, it } from "vitest";
import { scrubValue } from "./numeric-scrub";

describe("scrubValue", () => {
  // Default field sensitivity: 0.01 per pixel, so 0.1 detents are 10px apart.
  it.each([
    ["moves linearly before the first detent", 0, 5, 0.05],
    ["lands on 0.1", 0, 10, 0.1],
    ["holds 0.1 for two pixels", 0, 12, 0.1],
    ["moves on after the 0.1 hold", 0, 13, 0.11],
    ["holds 0.25 for three pixels", 0.2, 8, 0.25],
    ["moves on after the 0.25 hold", 0.2, 9, 0.26],
    ["holds 1 for four pixels", 0.95, 9, 1],
    ["moves on after the 1 hold", 0.95, 10, 1.01],
    ["holds while dragging left", 0.15, -7, 0.1],
    ["moves on while dragging left", 0.15, -8, 0.09],
    ["does not hold the starting value", 1, 1, 1.01],
    ["holds every detent crossed", 0, 40, 0.31],
  ])("%s", (_name, start, deltaPx, expected) => {
    expect(scrubValue(start, deltaPx, 0.01)).toBeCloseTo(expected, 10);
  });

  it("returns detents exactly, without float noise", () => {
    expect(scrubValue(0, 38, 0.01)).toBe(0.3);
    expect(scrubValue(0.6, 18, 0.01)).toBe(0.75);
  });

  it("skips steps too close together on screen and caps the hold", () => {
    // One unit per pixel: 0.1, 0.25 and 1 are under 8px apart; 10s are 10px
    // apart, so their 5px hold is capped to a quarter of that.
    expect(scrubValue(5, 4, 1)).toBe(9);
    expect(scrubValue(5, 5, 1)).toBe(10);
    expect(scrubValue(5, 7.5, 1)).toBe(10);
    expect(scrubValue(5, 8, 1)).toBe(10.5);
    expect(scrubValue(95, 11, 1)).toBe(100);
  });

  it("keeps every value reachable: no jumps, never reversing", () => {
    let previous = scrubValue(0, 0, 0.01);
    for (let px = 0.5; px <= 400; px += 0.5) {
      const next = scrubValue(0, px, 0.01);
      expect(next).toBeGreaterThanOrEqual(previous);
      expect(next - previous).toBeLessThanOrEqual(0.005 + 1e-12);
      previous = next;
    }
    expect(previous).toBeGreaterThan(2);
  });

  it("scrubs linearly for huge magnitudes and invalid sensitivity", () => {
    expect(scrubValue(1e13, 10, 0.01)).toBe(1e13 + 0.1);
    expect(scrubValue(1, 10, 0)).toBe(1);
  });
});
