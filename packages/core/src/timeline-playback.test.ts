import { describe, expect, it } from "vitest";
import { advanceTimelinePlayback, createTimelinePlayback } from "./timeline-playback";
import type { TimelineLoopMode } from "./timeline-clips";

const playing = (loopMode: TimelineLoopMode, time = 0, direction: 1 | -1 = 1, playRate = 1) =>
  ({ ...createTimelinePlayback({ playRate, loopMode }), time, direction, playing: true });

describe("advanceTimelinePlayback", () => {
  it("starts at the clip's Play Rate and Loop Mode, never below 0", () => {
    expect(createTimelinePlayback({ playRate: 2, loopMode: "loop" })).toEqual({ time: 0, playing: false, direction: 1, rate: 2, loopMode: "loop" });
    expect(createTimelinePlayback({ playRate: -1, loopMode: "once" }).rate).toBe(0);
  });

  it("plays Once to the end, or to the start in reverse, and stops", () => {
    expect(advanceTimelinePlayback(playing("once", 1.5), 2, 0.25)).toEqual({ state: playing("once", 1.75), finished: false, cycles: 0 });
    expect(advanceTimelinePlayback(playing("once", 1.5), 2, 1)).toEqual({ state: { ...playing("once", 2), playing: false }, finished: true, cycles: 0 });
    expect(advanceTimelinePlayback(playing("once", 0.5, -1), 2, 1)).toMatchObject({ state: { time: 0, playing: false }, finished: true });
  });

  it("wraps a Loop and turns a Ping Pong at each end", () => {
    expect(advanceTimelinePlayback(playing("loop", 1.5), 2, 1)).toMatchObject({ state: { time: 0.5, playing: true }, cycles: 1 });
    expect(advanceTimelinePlayback(playing("loop", 0.25, -1), 2, 0.5)).toMatchObject({ state: { time: 1.75 }, cycles: 1 });
    expect(advanceTimelinePlayback(playing("pingPong", 1.5), 2, 1)).toMatchObject({ state: { time: 1.5, direction: -1 }, cycles: 1 });
    expect(advanceTimelinePlayback(playing("pingPong", 0.5, -1), 2, 1)).toMatchObject({ state: { time: 0.5, direction: 1 }, cycles: 1 });
  });

  it("moves at its Play Rate, and not at all while paused or at rate 0", () => {
    expect(advanceTimelinePlayback(playing("once", 0, 1, 0.5), 2, 0.5).state.time).toBe(0.25);
    const paused = { ...playing("loop", 1), playing: false };
    expect(advanceTimelinePlayback(paused, 2, 1).state).toBe(paused);
    const still = playing("loop", 1, 1, 0);
    expect(advanceTimelinePlayback(still, 2, 1).state).toBe(still);
  });
});
