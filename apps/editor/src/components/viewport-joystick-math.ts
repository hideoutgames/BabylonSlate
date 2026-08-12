export const VIEWPORT_JOYSTICK_RADIUS = 48;

export interface JoystickValue {
  x: number;
  y: number;
}

/**
 * Map a pointer to a unit-clamped stick: +x is right, +y is screen-up
 * (forward for the editor fly camera).
 */
export function joystickValueFromPointer(
  originX: number,
  originY: number,
  pointerX: number,
  pointerY: number,
  radius: number,
): JoystickValue {
  const dx = pointerX - originX;
  const dy = pointerY - originY;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6 || radius <= 0) return { x: 0, y: 0 };
  const scale = Math.min(1, length / radius);
  const x = (dx / length) * scale;
  const y = (-dy / length) * scale;
  return {
    x: x === 0 ? 0 : x,
    y: y === 0 ? 0 : y,
  };
}
