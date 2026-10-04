/** Authored SceneLayer joystick dimensions are in layer units. */
export interface Joystick2DProperties {
  enabled: boolean;
  radius: number;
  joystickRadius: number;
  deadZone: number;
  horizontalControl: string;
  verticalControl: string;
  backgroundMaterialGuid: string | null;
  joystickMaterialGuid: string | null;
}

export function parseJoystick2DProperties(source: Partial<Joystick2DProperties> | Record<string, unknown> = {}): Joystick2DProperties {
  const positive = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const radius = positive(source.radius, 1.5);
  const control = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.trim() : fallback;
  const material = (value: unknown) => typeof value === "string" && value ? value : null;
  return {
    enabled: source.enabled !== false,
    radius,
    joystickRadius: Math.min(positive(source.joystickRadius, 0.6), radius * 0.95),
    deadZone: typeof source.deadZone === "number" && Number.isFinite(source.deadZone) ? Math.max(0, Math.min(0.99, source.deadZone)) : 0.1,
    horizontalControl: control(source.horizontalControl, "joystick-x"),
    verticalControl: control(source.verticalControl, "joystick-y"),
    backgroundMaterialGuid: material(source.backgroundMaterialGuid),
    joystickMaterialGuid: material(source.joystickMaterialGuid),
  };
}

/** Clamp circular travel; remap the radial dead zone continuously to full input. */
export function joystick2DValue(x: number, y: number, properties: Joystick2DProperties): {
  x: number; y: number; offsetX: number; offsetY: number;
} {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0, offsetX: 0, offsetY: 0 };
  const travel = properties.radius - properties.joystickRadius;
  const distance = Math.hypot(x, y);
  if (distance === 0) return { x: 0, y: 0, offsetX: 0, offsetY: 0 };
  const fraction = Math.min(1, distance / travel);
  const value = Math.max(0, (fraction - properties.deadZone) / (1 - properties.deadZone));
  return { x: x / distance * value, y: y / distance * value,
    offsetX: x / distance * fraction * travel, offsetY: y / distance * fraction * travel };
}
