import { describe, expect, it } from "vitest";
import type { TracePayload } from "@babylonslate/debugger";
import {
  asTracePayload,
  collectTraceLogWindow,
  frameTickMs,
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
    expect(collectTraceLogWindow(payload, 0, 30).map((line) => line.text)).toEqual(
      ["first", "print-a"],
    );
    expect(collectTraceLogWindow(payload, 1, 1).map((line) => line.text)).toEqual(
      ["second"],
    );
    expect(collectTraceLogWindow(payload, 1, 30).map((line) => line.text)).toEqual(
      ["first", "print-a", "second"],
    );
  });

  it("sums script and physics for graph height", () => {
    expect(frameTickMs(payload.frames[1]!)).toBe(3);
  });
});
