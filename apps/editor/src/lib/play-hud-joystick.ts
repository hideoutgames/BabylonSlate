function joystickAxisValue(raw: number, deadZone: number): number {
  const zone = Math.max(0, Math.min(0.95, deadZone));
  const mag = Math.abs(raw);
  if (mag <= zone) return 0;
  const scaled = (mag - zone) / (1 - zone);
  return Math.max(-1, Math.min(1, Math.sign(raw) * scaled));
}

function joystickAxesFromLocal(
  localX: number,
  localY: number,
  width: number,
  height: number,
  deadZone: number,
): { x: number; y: number } {
  const halfW = width / 2;
  const halfH = height / 2;
  if (halfW <= 0 || halfH <= 0) return { x: 0, y: 0 };
  const nx = (localX - halfW) / halfW;
  const ny = -((localY - halfH) / halfH);
  return {
    x: joystickAxisValue(nx, deadZone),
    y: joystickAxisValue(ny, deadZone),
  };
}

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
