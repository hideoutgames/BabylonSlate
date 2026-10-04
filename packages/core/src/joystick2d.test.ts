import { expect, it } from "vitest";
import { joystick2DValue, parseJoystick2DProperties } from "./joystick2d";

it("keeps malformed authored dimensions and dead zones from producing invalid or stuck axes", () => {
  const joystick = parseJoystick2DProperties({ radius: -1, joystickRadius: Infinity, deadZone: 1, horizontalControl: " " });
  const result = joystick2DValue(100, 0, joystick);
  expect(result.x).toBe(1);
  expect(result.y).toBe(0);
  expect(result.offsetX).toBeGreaterThan(0);
  expect(result.offsetX).toBeLessThan(joystick.radius);
  expect(joystick2DValue(NaN, Infinity, joystick)).toEqual({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const oversized = parseJoystick2DProperties({ radius: 1, joystickRadius: 5, deadZone: -1 });
  expect(joystick2DValue(1, 0, oversized).x).toBe(1);
});
