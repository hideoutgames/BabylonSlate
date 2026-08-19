/** Keyed on-screen Print HUD (editor overlay and packed player). */

export type PrintHudEntry = {
  key: string;
  message: string;
  color: string;
  expiresAt: number;
};

export type PrintHudColor = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type PrintHudCommand = {
  message: string;
  key?: string;
  duration?: number;
  color?: PrintHudColor;
};

/** One simulated frame when duration is missing-as-zero from old compiles. */
const ONE_FRAME_MS = 16;

export function printHudDurationMs(duration: number | undefined): number {
  if (duration === undefined) return 2000;
  if (duration <= 0) return ONE_FRAME_MS;
  return duration * 1000;
}

function channelByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round((Number(value) || 0) * 255)));
}

/** Missing or type-default transparent black becomes opaque white. */
export function printHudCssColor(color?: PrintHudColor): string {
  if (!color) return "rgba(255, 255, 255, 1)";
  const x = Number(color.x) || 0;
  const y = Number(color.y) || 0;
  const z = Number(color.z) || 0;
  const w = Number(color.w) || 0;
  if (x === 0 && y === 0 && z === 0 && w === 0) {
    return "rgba(255, 255, 255, 1)";
  }
  return `rgba(${channelByte(x)}, ${channelByte(y)}, ${channelByte(z)}, ${
    w > 0 ? w : 1
  })`;
}

export function applyPrintHudCommand(
  entries: readonly PrintHudEntry[],
  command: PrintHudCommand,
  now = Date.now(),
  random: () => number = Math.random,
): PrintHudEntry[] {
  const key = command.key?.trim() || `print_${now}_${random()}`;
  const next = entries.filter((entry) => entry.key !== key);
  next.push({
    key,
    message: command.message,
    color: printHudCssColor(command.color),
    expiresAt: now + printHudDurationMs(command.duration),
  });
  return next;
}

export function visiblePrintHudEntries(
  entries: readonly PrintHudEntry[],
  now = Date.now(),
): PrintHudEntry[] {
  return entries.filter((entry) => entry.expiresAt > now);
}

/** Delay until the soonest visible expiry, or `null` when nothing is showing. */
export function nextPrintHudTimeoutMs(
  entries: readonly PrintHudEntry[],
  now = Date.now(),
): number | null {
  const visible = visiblePrintHudEntries(entries, now);
  if (visible.length === 0) return null;
  const soonest = Math.min(...visible.map((entry) => entry.expiresAt));
  const delay = soonest - now;
  return delay > 0 ? delay : null;
}
