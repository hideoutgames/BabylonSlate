import { describe, expect, it } from "vitest";
import { celBandReference, celHighlightReference } from "./cel-reference";

describe("celBandReference", () => {
  it("steps exactly once at every band threshold for 2..8 bands", () => {
    for (let bands = 2; bands <= 8; bands++) {
      const levels = bands - 1;
      for (let step = 0; step < levels; step++) {
        // floor(shifted + 0.5001) increments when shifted crosses step + 0.4999.
        const threshold = (step + 0.4999) / levels;
        const below = celBandReference(threshold - 0.0002, bands, 0.5);
        const above = celBandReference(threshold + 0.0002, bands, 0.5);
        expect(below, `bands=${bands} step=${step}`).toBe(step / levels);
        expect(above, `bands=${bands} step=${step}`).toBe((step + 1) / levels);
      }
    }
  });

  it("produces only band quantum values and clamps the endpoints", () => {
    for (let bands = 2; bands <= 8; bands++) {
      const levels = bands - 1;
      const allowed = new Set(
        Array.from({ length: bands }, (_, i) => i / levels),
      );
      for (let i = 0; i <= 200; i++) {
        const result = celBandReference(i / 200, bands, 0.5);
        expect(allowed.has(result), `bands=${bands} value=${i / 200}`).toBe(
          true,
        );
      }
      expect(celBandReference(-0.5, bands, 0.5)).toBe(0);
      expect(celBandReference(1.5, bands, 0.5)).toBe(1);
    }
  });

  it("keeps the midpoint exposure curve on the input", () => {
    // The authored midpoint maps to the middle of the ramp, shifting every
    // threshold without smoothing the steps.
    const midpoint = 0.3;
    const center = celBandReference(midpoint, 4, midpoint);
    expect(center).toBe(Math.floor(0.5 * 3 + 0.5001) / 3);
    // A darker midpoint pulls thresholds down: the same input lands higher.
    expect(celBandReference(0.4, 4, midpoint)).toBeGreaterThan(
      celBandReference(0.4, 4, 0.5),
    );
    // Boundaries still solve shifted = step + 0.4999 under the curve.
    const levels = 3;
    const threshold =
      Math.pow((0 + 0.4999) / levels, Math.log(midpoint) / Math.log(0.5));
    expect(celBandReference(threshold - 0.0005, 4, midpoint)).toBe(0);
    expect(celBandReference(threshold + 0.0005, 4, midpoint)).toBe(1 / levels);
  });
});

describe("celHighlightReference", () => {
  it("emits only zero or the full strength across the edge", () => {
    const strength = 0.35;
    const size = 0.2;
    const edge = 1 - size;
    for (let ndh = 0; ndh <= 1; ndh += 0.001) {
      const result = celHighlightReference(ndh, 0.5, size, strength);
      expect(result === 0 || result === strength, `ndh=${ndh}`).toBe(true);
      expect(result).toBe(
        ndh >= edge - 0.00001 ? strength : 0,
      );
    }
  });

  it("requires lit shading: no highlight on the dark side", () => {
    expect(celHighlightReference(1, 0, 0.2, 0.5)).toBe(0);
    expect(celHighlightReference(1, 0.00001, 0.2, 0.5)).toBe(0.5);
    expect(celHighlightReference(1, 0.000005, 0.2, 0.5)).toBe(0);
  });

  it("widens the highlight as size grows", () => {
    expect(celHighlightReference(0.5, 1, 0.2, 1)).toBe(0);
    expect(celHighlightReference(0.5, 1, 0.6, 1)).toBe(1);
  });
});
