import { describe, expect, it } from "vitest";
import {
  InputRingBuffer,
  decodeInputEvents,
  encodeInputEvents,
  type RawInputEvent,
} from "./ring-buffer";

describe("input ring buffer", () => {
  it("round-trips tick-stamped raw events", () => {
    const events: RawInputEvent[] = [
      {
        kind: "pointer",
        tick: 3,
        pointerId: 1,
        phase: "down",
        x: 10,
        y: 20,
        button: 0,
      },
      { kind: "key", tick: 3, code: "KeyW", phase: "down" },
      {
        kind: "gamepad",
        tick: 4,
        gamepadIndex: 0,
        axes: [0.5, -0.25, 0, 0],
        buttons: [1, 0, 0, 0],
      },
      {
        kind: "gamepadConnection",
        tick: 5,
        gamepadIndex: 0,
        connected: false,
      },
      { kind: "touchAxis", tick: 5, controlId: "stick-x", value: 0.5 },
    ];
    const bytes = encodeInputEvents(events);
    expect(decodeInputEvents(bytes)).toEqual(events);
  });

  it("ring drops oldest when over capacity", () => {
    const ring = new InputRingBuffer(2);
    ring.push({ kind: "key", tick: 1, code: "KeyA", phase: "down" });
    ring.push({ kind: "key", tick: 2, code: "KeyB", phase: "down" });
    ring.push({ kind: "key", tick: 3, code: "KeyC", phase: "down" });
    const drained = ring.drain();
    expect(drained.map((e) => (e.kind === "key" ? e.code : ""))).toEqual([
      "KeyB",
      "KeyC",
    ]);
  });
});
