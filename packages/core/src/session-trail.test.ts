import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markSessionTrail, markSessionTrailStatus, resetSessionTrail, SESSION_TRAIL_MARKS, sessionTrail, setSessionTrailSink,
  type SessionTrailMark,
} from "./session-trail";

afterEach(() => {
  resetSessionTrail();
  vi.useRealTimers();
});

const stages = (marks: readonly SessionTrailMark[]) => marks.map((mark) => mark.stage);

describe("the session trail", () => {
  it("hands every mark to the sink as it is made, with the time it was made at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const stored: SessionTrailMark[][] = [];
    setSessionTrailSink((marks) => stored.push(marks.map((mark) => ({ ...mark }))));
    markSessionTrail("play: starting");
    vi.setSystemTime(4_500);
    markSessionTrail("play: loaded");
    // The installed sink is given the trail so far (empty), then each mark.
    expect(stored).toEqual([
      [],
      [{ at: 1_000, stage: "play: starting" }],
      [{ at: 1_000, stage: "play: starting" }, { at: 4_500, stage: "play: loaded" }],
    ]);
  });

  it("gives a sink installed later the marks made before it", () => {
    markSessionTrail("app: started");
    let stored: readonly SessionTrailMark[] = [];
    setSessionTrailSink((marks) => { stored = marks; });
    expect(stages(stored)).toEqual(["app: started"]);
  });

  it("keeps the newest marks when more are made than it holds", () => {
    for (let index = 0; index < SESSION_TRAIL_MARKS + 3; index++) markSessionTrail(`stage ${index}`);
    expect(sessionTrail()).toHaveLength(SESSION_TRAIL_MARKS);
    expect(sessionTrail()[0]!.stage).toBe("stage 3");
    expect(sessionTrail().at(-1)!.stage).toBe(`stage ${SESSION_TRAIL_MARKS + 2}`);
  });

  it("replaces a repeating status instead of pushing the stages around it out", () => {
    markSessionTrail("play: loaded");
    markSessionTrailStatus("play", "play: running, 10 frames");
    markSessionTrail("graphics context lost");
    markSessionTrailStatus("play", "play: running, 20 frames");
    expect(stages(sessionTrail())).toEqual(["play: loaded", "graphics context lost", "play: running, 20 frames"]);
    // A status the trail dropped for room starts again.
    for (let index = 0; index < SESSION_TRAIL_MARKS; index++) markSessionTrail(`stage ${index}`);
    markSessionTrailStatus("play", "play: running, 30 frames");
    expect(stages(sessionTrail()).filter((stage) => stage.startsWith("play: running"))).toEqual(["play: running, 30 frames"]);
    expect(sessionTrail()).toHaveLength(SESSION_TRAIL_MARKS);
  });

  it("keeps marking when the sink throws", () => {
    setSessionTrailSink(() => { throw new Error("storage full"); });
    expect(() => markSessionTrail("play: starting")).not.toThrow();
    expect(stages(sessionTrail())).toEqual(["play: starting"]);
  });
});
