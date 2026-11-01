import type { SerializedTimelineClip, TimelineEventTrack, TimelineLoopMode } from "./timeline-clips";

/**
 * Where a playing Timeline Clip is: shared by Play and tests, so loop modes,
 * finishing and event keys behave the same everywhere. Time is in seconds
 * within 0 and the clip's Length; `direction` is 1 forwards, -1 in reverse.
 * Play Rate and Loop Mode start as the clip's and scripts can change them.
 */
export interface TimelinePlaybackState {
  time: number;
  playing: boolean;
  direction: 1 | -1;
  /** Never negative; Reverse plays backwards. */
  rate: number;
  loopMode: TimelineLoopMode;
}

/**
 * A stretch of time one step passed over, in travel order (`from` > `to` in
 * reverse). Its start counts and its end does not, so a key on the boundary
 * between two steps fires once; an end of the clip the step reached counts.
 */
export interface TimelineSweep {
  from: number;
  to: number;
  includeFrom: boolean;
  includeTo: boolean;
}

export interface TimelineAdvanceResult {
  state: TimelinePlaybackState;
  /** The clip reached its end (Once) on this step and stopped. */
  finished: boolean;
  /** Times the clip wrapped (Loop) or turned (Ping Pong) on this step. */
  cycles: number;
  /** What the step passed over, for event keys. */
  sweeps: TimelineSweep[];
}

export function createTimelinePlayback(clip: Pick<SerializedTimelineClip, "playRate" | "loopMode">): TimelinePlaybackState {
  return { time: 0, playing: false, direction: 1, rate: Math.max(0, clip.playRate), loopMode: clip.loopMode };
}

/** A runaway Loop (a huge step on a tiny clip) stops wrapping after this many cycles in one step. */
const MAX_CYCLES_PER_STEP = 1000;

/**
 * Moves the playback on by `dt` seconds at its Play Rate. Once stops at the
 * end it plays towards (the start in reverse); Loop wraps; Ping Pong turns at
 * each end. A paused or zero-length clip does not move.
 */
export function advanceTimelinePlayback(state: TimelinePlaybackState, length: number, dt: number): TimelineAdvanceResult {
  const distance = dt * state.rate;
  if (!state.playing || !(length > 0) || !Number.isFinite(distance) || distance <= 0) {
    return { state, finished: false, cycles: 0, sweeps: [] };
  }
  const sweeps: TimelineSweep[] = [];
  let remaining = distance;
  let time = Math.min(length, Math.max(0, state.time));
  let direction = state.direction;
  let includeFrom = true;
  let cycles = 0;
  for (;;) {
    const boundary = direction > 0 ? length : 0;
    const toBoundary = Math.abs(boundary - time);
    if (remaining < toBoundary) {
      const to = time + direction * remaining;
      sweeps.push({ from: time, to, includeFrom, includeTo: false });
      return { state: { ...state, time: to, direction }, finished: false, cycles, sweeps };
    }
    sweeps.push({ from: time, to: boundary, includeFrom, includeTo: true });
    remaining -= toBoundary;
    if (state.loopMode === "once") {
      return { state: { ...state, time: boundary, direction, playing: false }, finished: true, cycles, sweeps };
    }
    cycles += 1;
    if (state.loopMode === "loop") {
      // The other end is the same instant: its keys fire too.
      time = direction > 0 ? 0 : length;
      includeFrom = true;
    } else {
      // Ping Pong turns at the end it reached, whose keys already fired.
      direction = direction > 0 ? -1 : 1;
      time = boundary;
      includeFrom = false;
    }
    if (remaining <= 0 || cycles >= MAX_CYCLES_PER_STEP) {
      return { state: { ...state, time, direction }, finished: false, cycles, sweeps };
    }
  }
}

export interface TimelineEventFiring {
  track: TimelineEventTrack;
  key: TimelineEventTrack["keys"][number];
}

function inSweep(time: number, sweep: TimelineSweep): boolean {
  const low = Math.min(sweep.from, sweep.to);
  const high = Math.max(sweep.from, sweep.to);
  if (time < low || time > high) return false;
  if (time === sweep.from && !sweep.includeFrom) return false;
  if (time === sweep.to && !sweep.includeTo && sweep.to !== sweep.from) return false;
  return true;
}

/**
 * The event keys `sweeps` pass over, in the order playback reaches them: by
 * time in each sweep's direction, then by track order.
 */
export function timelineEventKeysInSweeps(
  tracks: readonly TimelineEventTrack[],
  sweeps: readonly TimelineSweep[],
): TimelineEventFiring[] {
  const firings: TimelineEventFiring[] = [];
  for (const sweep of sweeps) {
    const reverse = sweep.to < sweep.from;
    const hits: Array<TimelineEventFiring & { order: number }> = [];
    tracks.forEach((track, order) => {
      for (const key of track.keys) if (inSweep(key.time, sweep)) hits.push({ track, key, order });
    });
    hits.sort((a, b) => (reverse ? b.key.time - a.key.time : a.key.time - b.key.time) || a.order - b.order);
    for (const { track, key } of hits) firings.push({ track, key });
  }
  return firings;
}
