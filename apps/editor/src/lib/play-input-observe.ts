import type { RawInputEvent } from "@babylonslate/input";

/**
 * Last Move.x observed from the Play ring. Gamepad axis 0 and the default
 * touch joystick share this so e2e can assert either path without a worker
 * round-trip.
 */
export function observedMoveXFromEvents(
  events: readonly RawInputEvent[],
  previous: number | null = null,
): number | null {
  let value = previous;
  for (const event of events) {
    if (event.kind === "gamepad" && typeof event.axes[0] === "number") {
      value = event.axes[0];
    }
    if (event.kind === "touchAxis" && event.controlId === "joystick-x") {
      value = event.value;
    }
  }
  return value;
}
