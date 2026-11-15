import { describe, expect, it } from "vitest";
import { AnimationPreviewClock, animationPreviewFrameAt } from "./animation-preview-clock";

describe("AnimationPreviewClock", () => {
  it("plays by real time × Speed, at most a tenth of a second a frame, and holds while paused", () => {
    const clock = new AnimationPreviewClock(1000);
    expect(clock.getPlayback()).toEqual({ playing: true, loop: true, speed: 1 });
    clock.advance(40);
    expect(clock.get()).toBe(40);
    clock.setSpeed(0.5);
    clock.advance(40);
    expect(clock.get()).toBe(60);
    clock.setSpeed(2);
    // A hidden tab's long frame.
    clock.advance(5000);
    expect(clock.get()).toBe(260);
    clock.setPlaying(false);
    clock.advance(100);
    expect(clock.get()).toBe(260);
    expect(clock.normalised()).toBeCloseTo(0.26, 6);
  });

  it("wraps a looping clip and stops a clip that does not loop on its last frame; Play then starts it again", () => {
    const clock = new AnimationPreviewClock(100);
    clock.advance(90);
    clock.advance(30);
    expect(clock.get()).toBe(20);
    expect(clock.getPlayback().playing).toBe(true);
    clock.setLoop(false);
    clock.advance(90);
    expect(clock.get()).toBe(100);
    expect(clock.getPlayback().playing).toBe(false);
    expect(clock.normalised()).toBe(1);
    clock.setPlaying(true);
    expect(clock.get()).toBe(0);
    expect(clock.getPlayback().playing).toBe(true);
  });

  it("seeks within the clip and pauses", () => {
    const clock = new AnimationPreviewClock(1000);
    clock.seek(400);
    expect(clock.get()).toBe(400);
    expect(clock.getPlayback().playing).toBe(false);
    clock.seek(-50);
    expect(clock.get()).toBe(0);
    clock.seek(5000);
    expect(clock.get()).toBe(1000);
  });

  it("steps one frame and pauses, wrapping to the start after the last", () => {
    const clock = new AnimationPreviewClock(100);
    clock.step(25);
    expect(clock.get()).toBe(25);
    expect(clock.getPlayback().playing).toBe(false);
    clock.seek(100);
    clock.step(25);
    expect(clock.get()).toBe(0);
  });

  it("restarts at 0 playing or paused as before", () => {
    const clock = new AnimationPreviewClock(1000);
    clock.advance(300);
    clock.restart();
    expect(clock.get()).toBe(0);
    expect(clock.getPlayback().playing).toBe(true);
    clock.seek(300);
    clock.restart();
    expect(clock.get()).toBe(0);
    expect(clock.getPlayback().playing).toBe(false);
  });

  it("keeps the playhead at the same point of the clip when the Duration changes", () => {
    const clock = new AnimationPreviewClock(1000);
    clock.seek(250);
    clock.setDuration(2000);
    expect(clock.get()).toBe(500);
    expect(clock.getDuration()).toBe(2000);
  });

  it("tells subscribers when the playhead or playback changes", () => {
    const clock = new AnimationPreviewClock(1000);
    let calls = 0;
    const unsubscribe = clock.subscribe(() => calls++);
    clock.advance(10);
    clock.setLoop(false);
    expect(calls).toBe(2);
    unsubscribe();
    clock.advance(10);
    expect(calls).toBe(2);
  });
});

describe("animationPreviewFrameAt", () => {
  it.each([
    [0, 0],
    [99, 0],
    [100, 1],
    [550, 5],
    [999, 9],
    [1000, 9],
  ])("shows frame index %d ms → %d of a 10-frame, 1000 ms clip", (timeMs, frame) => {
    expect(animationPreviewFrameAt(timeMs, 1000, 10)).toBe(frame);
  });

  it("shows the first frame of a clip with one frame or no length", () => {
    expect(animationPreviewFrameAt(500, 1000, 1)).toBe(0);
    expect(animationPreviewFrameAt(0, 0, 10)).toBe(0);
  });
});
