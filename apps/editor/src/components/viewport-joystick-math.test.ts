import { describe, expect, it } from "vitest";
import { joystickValueFromPointer } from "./viewport-joystick-math";

describe("joystickValueFromPointer", () => {
  it("returns zero at the origin", () => {
    expect(joystickValueFromPointer(100, 100, 100, 100, 48)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("maps right of origin to +x and up of origin to +y", () => {
    expect(joystickValueFromPointer(100, 100, 148, 100, 48)).toEqual({
      x: 1,
      y: 0,
    });
    const up = joystickValueFromPointer(100, 100, 100, 52, 48);
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(1);
  });

  it("clamps values outside the radius to unit length", () => {
    const value = joystickValueFromPointer(0, 0, 100, 0, 48);
    expect(value.x).toBeCloseTo(1);
    expect(value.y).toBeCloseTo(0);
    expect(Math.hypot(value.x, value.y)).toBeCloseTo(1);
  });
});
