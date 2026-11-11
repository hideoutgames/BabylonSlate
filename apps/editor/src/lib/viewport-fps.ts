/** How often the counter changes: often enough to follow a drop, slow enough not to flicker. */
export const FPS_UPDATE_MS = 250;
/** The span each reading averages, so one long frame moves the number a little rather than a lot. */
export const FPS_WINDOW_MS = 1000;

export type FpsTone = "good" | "fair" | "poor" | "bad";

/** 55 and above is good, 25 to 54 fair, 15 to 24 poor, below 15 bad. */
export function fpsTone(fps: number): FpsTone {
  if (fps >= 55) return "good";
  if (fps >= 25) return "fair";
  if (fps >= 15) return "poor";
  return "bad";
}

export type FrameSample = { at: number; frames: number };

/**
 * Whole frames per second across the samples' window: frames rendered between the oldest and the newest sample over
 * the time between them. Null until two samples exist.
 */
export function framesPerSecond(samples: readonly FrameSample[]): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last.at <= first.at) return null;
  return Math.max(0, Math.round(((last.frames - first.frames) * 1000) / (last.at - first.at)));
}
