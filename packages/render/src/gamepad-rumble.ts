/** The Gamepad API haptics a pad may expose (`Gamepad.vibrationActuator`). */
type RumbleActuator = {
  playEffect?: (
    type: "dual-rumble",
    params: { startDelay: number; duration: number; strongMagnitude: number; weakMagnitude: number },
  ) => Promise<unknown>;
  reset?: () => Promise<unknown>;
};

type RumblePad = { index: number; vibrationActuator?: RumbleActuator | null } | null;

export type GamepadRumbleCommand = {
  gamepadIndex: number;
  intensity: number;
  durationMs: number;
};

function connectedGamepads(): readonly RumblePad[] {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  return Array.from(navigator.getGamepads() as ArrayLike<RumblePad>);
}

/**
 * Start a pad's dual rumble (both motors at `intensity`) for `durationMs`, or
 * stop it when either is zero. A pad that is gone or has no vibration actuator
 * ignores the command, and a rejected effect is not a game error.
 */
export function applyGamepadRumble(
  command: GamepadRumbleCommand,
  gamepads: readonly RumblePad[] = connectedGamepads(),
): void {
  const actuator = gamepads.find((pad) => pad?.index === command.gamepadIndex)?.vibrationActuator;
  if (!actuator) return;
  const effect = command.intensity > 0 && command.durationMs > 0
    ? actuator.playEffect?.("dual-rumble", {
        startDelay: 0,
        duration: command.durationMs,
        strongMagnitude: command.intensity,
        weakMagnitude: command.intensity,
      })
    : actuator.reset?.();
  effect?.catch(() => {});
}
