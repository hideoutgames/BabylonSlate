/** Authoring settings shared by the editor, runtime and exported player. */
export interface MovementProperties {
  enabled: boolean;
  inputSpace: "world" | "actor";
  /** Additional input heading around world +Y, in degrees. */
  inputYaw: number;
  inputScale: number;
  deadZone: number;
  maxSpeed: number;
  acceleration: number;
  braking: number;
  airControl: number;
  gravityScale: number;
  jumpSpeed: number;
  maxFallSpeed: number;
  radius: number;
  height: number;
  maxSlopeAngle: number;
  groundSnapDistance: number;
  coyoteTime: number;
  jumpBufferTime: number;
}

export const DEFAULT_MOVEMENT_PROPERTIES: Readonly<MovementProperties> = {
  enabled: true,
  inputSpace: "world",
  inputYaw: 0,
  inputScale: 1,
  deadZone: 0.1,
  maxSpeed: 5,
  acceleration: 30,
  braking: 40,
  airControl: 0.35,
  gravityScale: 1,
  jumpSpeed: 6,
  maxFallSpeed: 40,
  radius: 0.4,
  height: 1.8,
  maxSlopeAngle: 50,
  groundSnapDistance: 0.1,
  coyoteTime: 0.1,
  jumpBufferTime: 0.1,
};

function finiteNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_VALUE): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** Normalize saved values and script edits before they reach the movement solver. */
export function parseMovementProperties(value?: unknown): MovementProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaults = DEFAULT_MOVEMENT_PROPERTIES;
  const radius = finiteNumber(source.radius, defaults.radius, 0.001, Number.MAX_VALUE / 2);
  return {
    enabled: source.enabled !== false,
    inputSpace: source.inputSpace === "actor" ? "actor" : "world",
    inputYaw: finiteNumber(source.inputYaw, defaults.inputYaw, -Number.MAX_VALUE),
    inputScale: finiteNumber(source.inputScale, defaults.inputScale),
    deadZone: finiteNumber(source.deadZone, defaults.deadZone, 0, 0.999),
    maxSpeed: finiteNumber(source.maxSpeed, defaults.maxSpeed),
    acceleration: finiteNumber(source.acceleration, defaults.acceleration),
    braking: finiteNumber(source.braking, defaults.braking),
    airControl: finiteNumber(source.airControl, defaults.airControl, 0, 1),
    gravityScale: finiteNumber(source.gravityScale, defaults.gravityScale),
    jumpSpeed: finiteNumber(source.jumpSpeed, defaults.jumpSpeed),
    maxFallSpeed: finiteNumber(source.maxFallSpeed, defaults.maxFallSpeed),
    radius,
    height: Math.max(radius * 2, finiteNumber(source.height, defaults.height)),
    maxSlopeAngle: finiteNumber(source.maxSlopeAngle, defaults.maxSlopeAngle, 0, 89.9),
    groundSnapDistance: finiteNumber(source.groundSnapDistance, defaults.groundSnapDistance),
    coyoteTime: finiteNumber(source.coyoteTime, defaults.coyoteTime),
    jumpBufferTime: finiteNumber(source.jumpBufferTime, defaults.jumpBufferTime),
  };
}
