import { describe, expect, it } from "vitest";
import { facingYawFromVelocity } from "./facing";

describe("facingYawFromVelocity", () => {
  it("uses Recast XZ so +Z is yaw 0", () => {
    expect(facingYawFromVelocity({ x: 0, y: 0, z: 2 }, 1)).toBeCloseTo(0);
  });

  it("uses atan2(x, z) for yaw around Recast Y", () => {
    expect(facingYawFromVelocity({ x: 1, y: 0, z: 0 }, 0)).toBeCloseTo(Math.PI / 2);
  });

  it("keeps the previous yaw when speed is below the guard", () => {
    expect(facingYawFromVelocity({ x: 0, y: 0, z: 0.0001 }, 0.4, 0.01)).toBe(0.4);
  });
});
