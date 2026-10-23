/** `navigator.vibrate`, absent on iOS, desktop browsers and some embedded views. */
type Vibrator = { vibrate?: (pattern: number) => boolean } | undefined;

export type DeviceVibrationCommand = { durationMs: number };

/**
 * Vibrate the device for `durationMs`, or stop it at 0. Where the browser has
 * no vibration, or refuses it (no tap on the page yet, a cross-origin frame),
 * the command does nothing; it is never a game error.
 */
export function applyDeviceVibration(
  command: DeviceVibrationCommand,
  navigatorLike: Vibrator = typeof navigator === "undefined" ? undefined : (navigator as Vibrator),
): void {
  try {
    navigatorLike?.vibrate?.(command.durationMs);
  } catch {
    // Some embedded views throw instead of returning false.
  }
}
