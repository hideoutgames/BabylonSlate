import { describe, expect, it } from "vitest";
import type { TracePayload } from "@haptic/debugger";
import {
  asTracePayload,
  collectTraceLogWindow,
  frameTickMs,
  filterTraceLogs,
} from "./trace-view";

const payload: TracePayload = {
  seed: 1,
  dt: 1 / 60,
  retention: { byteBudget: 1024, droppedFrames: 0, complete: true, stopReason: "requested" },
  frames: [
    {
      tickIndex: 1,
      timeDilation: 1,
      scriptMs: 1,
      physicsMs: 0.5,
      logs: [{ severity: "log", category: "game", message: "first" }],
      prints: [{ message: "print-a", key: "a" }],
    },
    {
      tickIndex: 2,
      timeDilation: 1,
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

  it("requires valid retention metadata and per-frame time dilation", () => {
    const retention = {
      byteBudget: 1024,
      droppedFrames: 1,
      complete: false,
      stopReason: "oversized-frame",
    };
    expect(asTracePayload({ ...payload, retention })?.retention).toEqual(retention);
    expect(asTracePayload({ ...payload, retention: null })).toBeNull();
    expect(asTracePayload({ ...payload, retention: undefined })).toBeNull();
    expect(asTracePayload({ ...payload, frames: [{ ...payload.frames[0]!, timeDilation: undefined }] })).toBeNull();
    for (const invalid of [
      { byteBudget: -1 },
      { droppedFrames: 0.5 },
      { complete: "false" },
      { stopReason: "unknown" },
      { complete: true },
    ]) {
      expect(asTracePayload({ ...payload, retention: { ...retention, ...invalid } })).toBeNull();
    }
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
