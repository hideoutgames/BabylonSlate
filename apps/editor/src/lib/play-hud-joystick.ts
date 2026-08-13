import { joystickAxisValue } from "@babylonslate/render";

export function playJoystickAxesFromPointer(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  deadZone: number,
): { x: number; y: number } {
  const halfW = bounds.width / 2;
  const halfH = bounds.height / 2;
  if (halfW <= 0 || halfH <= 0) return { x: 0, y: 0 };
  const nx = (clientX - (bounds.left + halfW)) / halfW;
  const ny = -((clientY - (bounds.top + halfH)) / halfH);
  return {
    x: joystickAxisValue(nx, deadZone),
    y: joystickAxisValue(ny, deadZone),
  };
}
