import { joystickAxesFromLocal } from "@babylonslate/render";

export function playJoystickAxesFromPointer(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  deadZone: number,
): { x: number; y: number } {
  return joystickAxesFromLocal(
    clientX - bounds.left,
    clientY - bounds.top,
    bounds.width,
    bounds.height,
    deadZone,
  );
}
