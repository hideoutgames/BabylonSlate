import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markSessionTrail, markSessionTrailStatus, recordSessionTrailEvent, resetSessionTrail, SESSION_TRAIL_EVENTS,
  SESSION_TRAIL_MARKS, sessionTrail, sessionTrailEvents, setSessionTrailSink,
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

describe("the session trail's events", () => {
  it("hands a new event to the sink at once, and counts a repeat without writing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let writes = 0;
    setSessionTrailSink(() => { writes += 1; });
    writes = 0;
    recordSessionTrailEvent("error", "TypeError: x is undefined");
    expect(writes).toBe(1);
    vi.setSystemTime(2_000);
    recordSessionTrailEvent("reload", "a failed chunk import");
    vi.setSystemTime(3_000);
    recordSessionTrailEvent("error", "TypeError: x is undefined");
    recordSessionTrailEvent("error", "TypeError: x is undefined");
    expect(writes).toBe(2);
    // The repeat moved to the end, with its first and latest times.
    expect(sessionTrailEvents()).toEqual([
      { at: 2_000, first: 2_000, kind: "reload", detail: "a failed chunk import", count: 1 },
      { at: 3_000, first: 1_000, kind: "error", detail: "TypeError: x is undefined", count: 3 },
    ]);
  });

  it("writes a burst of varying errors only a few at a time, and drops errors before a reload for room", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let writes = 0;
    setSessionTrailSink(() => { writes += 1; });
    writes = 0;
    recordSessionTrailEvent("reload", "a failed chunk import");
    for (let frame = 0; frame < 100; frame++) recordSessionTrailEvent("uncaught error", `TypeError at frame ${frame}`);
    // The reload, then four errors of the burst; the rest wait for the host's next write.
    expect(writes).toBe(5);
    // A new window writes again, and a reload is never held back.
    vi.setSystemTime(15_000);
    recordSessionTrailEvent("uncaught error", "TypeError at frame 100");
    recordSessionTrailEvent("context lost", "play: loss 1 of this view");
    expect(writes).toBe(7);
    expect(sessionTrailEvents()).toHaveLength(SESSION_TRAIL_EVENTS);
    expect(sessionTrailEvents().filter((event) => event.kind !== "uncaught error").map((event) => event.kind)).toEqual(["reload", "context lost"]);
  });

  it("keeps the newest events, each cut to a bounded length, and survives many marks", () => {
    recordSessionTrailEvent("error", "x".repeat(5_000));
    for (let index = 0; index < SESSION_TRAIL_EVENTS + 2; index++) recordSessionTrailEvent("error", `error ${index}`);
    for (let index = 0; index < SESSION_TRAIL_MARKS * 2; index++) markSessionTrail(`stage ${index}`);
    expect(sessionTrailEvents()).toHaveLength(SESSION_TRAIL_EVENTS);
    expect(sessionTrailEvents()[0]!.detail).toBe("error 2");
    recordSessionTrailEvent("error", "y".repeat(5_000));
    expect(sessionTrailEvents().at(-1)!.detail.length).toBeLessThanOrEqual(600);
  });
});
