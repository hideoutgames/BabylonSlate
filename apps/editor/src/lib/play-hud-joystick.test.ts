import { describe, expect, it } from "vitest";
import { playJoystickAxesFromPointer } from "./play-hud-joystick";

describe("playJoystickAxesFromPointer", () => {
  const bounds = { left: 0, top: 0, width: 160, height: 160 };

  it("returns zero inside the dead zone", () => {
    expect(playJoystickAxesFromPointer(80, 80, bounds, 0.15)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("maps right of centre to +X and above centre to +Y", () => {
    const right = playJoystickAxesFromPointer(160, 80, bounds, 0.15);
    expect(right.x).toBeCloseTo(1, 5);
    expect(right.y).toBe(0);
    const up = playJoystickAxesFromPointer(80, 0, bounds, 0.15);
    expect(up.x).toBe(0);
    expect(up.y).toBeCloseTo(1, 5);
  });
});
