import type { SerializedTimelineClip } from "./timeline-clips";

/**
 * Where a playing Timeline Clip is: shared by Play and tests, so loop modes
 * and finishing behave the same everywhere. Time is in seconds within 0 and
 * the clip's Length; `direction` is 1 forwards, -1 in reverse.
 */
export interface TimelinePlaybackState {
  time: number;
  playing: boolean;
  direction: 1 | -1;
  /** Multiplies the clip's Play Rate; Set Play Rate changes it. */
  rate: number;
}

export interface TimelineAdvanceResult {
  state: TimelinePlaybackState;
  /** The clip reached its end (Once) on this step and stopped. */
  finished: boolean;
  /** Times the clip wrapped (Loop) or turned (Ping Pong) on this step. */
  cycles: number;
}

export function createTimelinePlayback(): TimelinePlaybackState {
  return { time: 0, playing: false, direction: 1, rate: 1 };
}

/**
 * Moves the playback on by `dt` seconds at the clip's Play Rate. Once stops at
 * the end it plays towards (the start in reverse); Loop wraps; Ping Pong turns
 * at each end. A paused or zero-length clip does not move.
 */
export function advanceTimelinePlayback(
  state: TimelinePlaybackState,
  clip: Pick<SerializedTimelineClip, "length" | "loopMode" | "playRate">,
  dt: number,
): TimelineAdvanceResult {
  const length = clip.length;
  const step = dt * clip.playRate * state.rate * state.direction;
  if (!state.playing || !(length > 0) || !Number.isFinite(step) || step === 0) return { state, finished: false, cycles: 0 };
  let time = state.time + step;
  if (clip.loopMode === "once") {
    if (time >= length && state.direction > 0) return { state: { ...state, time: length, playing: false }, finished: true, cycles: 0 };
    if (time <= 0 && state.direction < 0) return { state: { ...state, time: 0, playing: false }, finished: true, cycles: 0 };
    return { state: { ...state, time }, finished: false, cycles: 0 };
  }
  if (clip.loopMode === "loop") {
    const cycles = Math.floor(time / length);
    time -= cycles * length;
    return { state: { ...state, time }, finished: false, cycles: Math.abs(cycles) };
  }
  // Ping Pong: reflect off each end, turning around each time.
  let direction = state.direction;
  let cycles = 0;
  while (time > length || time < 0) {
    time = time > length ? 2 * length - time : -time;
    direction = direction > 0 ? -1 : 1;
    cycles += 1;
  }
  return { state: { ...state, time, direction }, finished: false, cycles };
}
