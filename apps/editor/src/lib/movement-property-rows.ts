import {
  DEFAULT_MOVEMENT_PROPERTIES,
  parseMovementProperties,
  type MovementProperties,
  type SerializedComponent,
} from "@babylonslate/core";
import type { PropertyRow } from "@babylonslate/editor-kit";
import type { ComponentPropertyContext } from "./component-property-rows";

type NumericProperty = {
  [Key in keyof MovementProperties]: MovementProperties[Key] extends number ? Key : never;
}[keyof MovementProperties];

/** Shared Movement controls for Scene Details and the Class/Prefab Inspector. */
export function movementPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const properties = parseMovementProperties(component.properties);
  const defaults = DEFAULT_MOVEMENT_PROPERTIES;
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const number = (
    key: NumericProperty,
    label: string,
    min: number,
    description?: string,
    max?: number,
    unit?: string,
  ): PropertyRow => ({
    kind: "number", id: id(key), label, value: properties[key], defaultValue: defaults[key],
    min, max, unit, description, sensitivity: 0.01,
    onChange: (value) => update(key, Math.max(min, Math.min(max ?? Infinity, value))),
  });
  return [
    {
      kind: "boolean", id: id("enabled"), label: "Enabled", value: properties.enabled, defaultValue: defaults.enabled,
      description: "Connect a 2D Input Axis Held pin through Convert Input to Set Movement Input, and send zero on Released. Connect Input Action Started to Jump. Turning this off stops movement but keeps the capsule.",
      onChange: (value) => update("enabled", value),
    },
    number("maxSpeed", "Max Speed", 0, "Maximum speed from movement input.", undefined, "units/s"),
    number("acceleration", "Acceleration", 0, "How quickly movement reaches its target speed.", undefined, "units/s²"),
    number("braking", "Braking", 0, "How quickly horizontal movement slows when input stops.", undefined, "units/s²"),
    number("jumpSpeed", "Jump Speed", 0, "Upward speed when a jump begins.", undefined, "units/s"),
    number("gravityScale", "Gravity Scale", 0, "Multiplier for the scene's gravity."),
    number("airControl", "Air Control", 0, "Horizontal steering strength while airborne; 0 keeps momentum and 1 gives full control.", 1),
    number("maxFallSpeed", "Max Fall Speed", 0, "Maximum downward speed.", undefined, "units/s"),
    ...(context.physicsWorld === "3d" ? [{
      kind: "enum" as const, id: id("inputSpace"), label: "Input Space", value: properties.inputSpace, defaultValue: defaults.inputSpace,
      options: [{ value: "world", label: "World" }, { value: "actor", label: "Actor" }],
      description: "Convert Input uses fixed world directions or directions relative to the actor.",
      onChange: (value: string) => update("inputSpace", value),
    }, number("inputYaw", "Input Yaw", -Number.MAX_VALUE, "Convert Input turns directions around world Y. Set this from a graph for camera-relative controls.", undefined, "°")] : []),
    number("inputScale", "Input Scale", 0, "Convert Input scales input strength before limiting it to full movement."),
    number("deadZone", "Dead Zone", 0, "Convert Input ignores small values, then remaps the remaining range smoothly.", 0.999),
    number("radius", "Radius", 0.001, "Capsule radius in world units, centered on the actor. Actor scale and component transforms do not change it.", properties.height / 2),
    number("height", "Height", properties.radius * 2, "Total capsule height in world units, including its rounded ends. World Y is up in both 2D and 3D."),
    number("maxSlopeAngle", "Max Slope Angle", 0, "Steepest surface treated as ground.", 89.9, "°"),
    number("groundSnapDistance", "Ground Snap Distance", 0, "Stay attached to nearby ground when walking down shallow changes in height."),
    number("coyoteTime", "Coyote Time", 0, "Allow a jump briefly after walking off an edge.", undefined, "s"),
    number("jumpBufferTime", "Jump Buffer Time", 0, "Remember a jump pressed just before landing.", undefined, "s"),
  ];
}
