import { describe, expect, it } from "vitest";
import { advanceTimelinePlayback, createTimelinePlayback } from "./timeline-playback";

const clip = (loopMode: "once" | "loop" | "pingPong", playRate = 1) => ({ length: 2, loopMode, playRate });
const playing = (time = 0, direction: 1 | -1 = 1) => ({ ...createTimelinePlayback(), time, direction, playing: true });

describe("advanceTimelinePlayback", () => {
  it("plays Once to the end, or to the start in reverse, and stops", () => {
    expect(advanceTimelinePlayback(playing(1.5), clip("once"), 0.25)).toEqual({ state: { ...playing(1.75) }, finished: false, cycles: 0 });
    expect(advanceTimelinePlayback(playing(1.5), clip("once"), 1)).toEqual({ state: { ...playing(2), playing: false }, finished: true, cycles: 0 });
    expect(advanceTimelinePlayback(playing(0.5, -1), clip("once"), 1)).toMatchObject({ state: { time: 0, playing: false }, finished: true });
  });

  it("wraps a Loop and turns a Ping Pong at each end", () => {
    expect(advanceTimelinePlayback(playing(1.5), clip("loop"), 1)).toMatchObject({ state: { time: 0.5, playing: true }, cycles: 1 });
    expect(advanceTimelinePlayback(playing(0.25, -1), clip("loop"), 0.5)).toMatchObject({ state: { time: 1.75 }, cycles: 1 });
    expect(advanceTimelinePlayback(playing(1.5), clip("pingPong"), 1)).toMatchObject({ state: { time: 1.5, direction: -1 }, cycles: 1 });
    expect(advanceTimelinePlayback(playing(0.5, -1), clip("pingPong"), 1)).toMatchObject({ state: { time: 0.5, direction: 1 }, cycles: 1 });
  });

  it("scales by the clip's Play Rate and the playback rate, and does not move while paused", () => {
    expect(advanceTimelinePlayback({ ...playing(0), rate: 2 }, clip("once", 0.5), 0.5).state.time).toBe(0.5);
    const paused = { ...playing(1), playing: false };
    expect(advanceTimelinePlayback(paused, clip("loop"), 1).state).toBe(paused);
  });
});
