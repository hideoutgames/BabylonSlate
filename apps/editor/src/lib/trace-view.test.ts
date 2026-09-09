import { describe, expect, it } from "vitest";
import type { TracePayload } from "@babylonslate/debugger";
import {
  asTracePayload,
  collectTraceLogWindow,
  frameTickMs,
  filterTraceLogs,
  traceGraphBuckets,
} from "./trace-view";

const payload: TracePayload = {
  seed: 1,
  dt: 1 / 60,
  frames: [
    {
      tickIndex: 1,
      scriptMs: 1,
      physicsMs: 0.5,
      logs: [{ severity: "log", category: "game", message: "first" }],
      prints: [{ message: "print-a", key: "a" }],
    },
    {
      tickIndex: 2,
      scriptMs: 2,
      physicsMs: 1,
      logs: [{ severity: "log", category: "game", message: "second" }],
      prints: [],
    },
  ],
};

describe("trace view helpers", () => {
  it("accepts a TracePayload-shaped document", () => {
    expect(asTracePayload(payload)?.seed).toBe(1);
    expect(asTracePayload({ name: "nope" })).toBeNull();
  });

  it("filters logs and prints to a window ending at the scrubber", () => {
    expect(
      collectTraceLogWindow(payload, 0, 30).map((line) => line.text),
    ).toEqual(["first", "print-a"]);
    expect(
      collectTraceLogWindow(payload, 1, 1).map((line) => line.text),
    ).toEqual(["second"]);
    expect(
      collectTraceLogWindow(payload, 1, 30).map((line) => line.text),
    ).toEqual(["first", "print-a", "second"]);
  });

  it("sums script and physics for graph height", () => {
    expect(frameTickMs(payload.frames[1]!)).toBe(3);
  });

  it("retains log source metadata and filters severity, category and print keys", () => {
    const lines = collectTraceLogWindow(payload, 1);
    expect(lines[0]).toMatchObject({
      frameIndex: 0,
      tickIndex: 1,
      kind: "log",
      severity: "log",
      category: "game",
    });
    expect(
      filterTraceLogs(lines, "game", "log").map((line) => line.text),
    ).toEqual(["first", "second"]);
    expect(
      filterTraceLogs(lines, "a", "print").map((line) => line.key),
    ).toEqual(["a"]);
  });

  it("keeps each timing bucket's true spike and recorded-event marker", () => {
    const frames = [1, 50, 2, 4, 3].map((scriptMs, tickIndex) => ({
      tickIndex,
      scriptMs,
      physicsMs: 1,
      logs: [],
      prints: tickIndex === 0 ? [{ key: "a", message: "event" }] : [],
    }));
    const buckets = traceGraphBuckets({ ...payload, frames }, 0, 4, 2);
    expect(buckets).toEqual([
      {
        start: 0,
        end: 2,
        peak: 1,
        scriptMs: 50,
        physicsMs: 1,
        overBudget: true,
        hasEvents: true,
      },
      {
        start: 3,
        end: 4,
        peak: 3,
        scriptMs: 4,
        physicsMs: 1,
        overBudget: false,
        hasEvents: false,
      },
    ]);
  });

  it("rejects malformed frame content instead of crashing a dock", () => {
    expect(asTracePayload({ ...payload, frames: [null] })).toBeNull();
    expect(
      asTracePayload({
        ...payload,
        frames: [{ ...payload.frames[0], logs: [null] }],
      }),
    ).toBeNull();
  });
});
