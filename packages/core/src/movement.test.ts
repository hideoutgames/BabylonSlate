import { describe, expect, it } from "vitest";
import { parseMovementProperties } from "./movement";

describe("movement settings", () => {
  it("keeps malformed saved settings out of the capsule and input solvers", () => {
    const properties = parseMovementProperties({
      radius: 2, height: 1, maxSlopeAngle: 100, groundSnapDistance: -3,
      deadZone: 1, airControl: -1, acceleration: Number.NaN,
      braking: Number.POSITIVE_INFINITY, inputScale: -2,
      inputSpace: "camera",
      inputYaw: -90, coyoteTime: -1,
    });
    expect(properties).toMatchObject({
      radius: 2, height: 4, groundSnapDistance: 0, airControl: 0,
      acceleration: 30, braking: 40, inputScale: 0,
      inputSpace: "world",
      inputYaw: -90, coyoteTime: 0,
    });
    expect(properties.maxSlopeAngle).toBeLessThan(90);
    expect(properties.deadZone).toBeLessThan(1);
    const extreme = parseMovementProperties({ radius: Number.MAX_VALUE, height: Number.MAX_VALUE, maxSpeed: Number.MAX_VALUE, inputYaw: Number.MAX_VALUE });
    expect(Number.isFinite(extreme.radius * extreme.radius * extreme.height)).toBe(true);
    expect(Number.isFinite(extreme.maxSpeed * extreme.maxSpeed)).toBe(true);
    expect(Number.isFinite(extreme.inputYaw * Math.PI)).toBe(true);
  });

  it("preserves disabled controls and zero-valued tuning without mutating authored data", () => {
    const authored = Object.freeze({
      enabled: false, inputSpace: " Actor ",
      gravityScale: 0, jumpSpeed: 0, maxSpeed: 0, acceleration: 0,
      braking: 0, airControl: 0, coyoteTime: 0, jumpBufferTime: 0,
    });
    expect(parseMovementProperties(authored)).toMatchObject({ ...authored, inputSpace: "actor" });
    expect(parseMovementProperties(null).enabled).toBe(true);
  });
});
