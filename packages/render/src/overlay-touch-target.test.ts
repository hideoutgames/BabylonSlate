import { describe, expect, it } from "vitest";
import {
  overlayMinTargetWorldSize,
  pointInInflatedWorldAabb,
} from "./overlay-touch-target";

describe("overlayMinTargetWorldSize", () => {
  it("converts screen pixels through the overlay frustum, not pixelsPerUnit", () => {
    expect(overlayMinTargetWorldSize(44, 900, 9)).toBeCloseTo(0.44);
    expect(overlayMinTargetWorldSize(44, 256, 9)).toBeCloseTo((44 / 256) * 9);
  });

  it("returns 0 when size inputs are not positive", () => {
    expect(overlayMinTargetWorldSize(44, 0, 9)).toBe(0);
    expect(overlayMinTargetWorldSize(0, 900, 9)).toBe(0);
  });
});

describe("pointInInflatedWorldAabb", () => {
  it("inflates a small quad out to the min world size and never shrinks a larger one", () => {
    expect(
      pointInInflatedWorldAabb(0.2, 0, 0, 0, 0.16, 0.16, 0.44),
    ).toBe(true);
    expect(
      pointInInflatedWorldAabb(0.3, 0, 0, 0, 0.16, 0.16, 0.44),
    ).toBe(false);
    expect(
      pointInInflatedWorldAabb(0.6, 0, 0, 0, 0.8, 0.8, 0.44),
    ).toBe(true);
  });
});
