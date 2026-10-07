import { describe, expect, it } from "vitest";
import { InputResolver } from "./resolver";
import {
  InputRingBuffer,
  decodeInputEvents,
  encodeInputEvents,
  type RawInputEvent,
} from "./ring-buffer";

describe("input ring buffer", () => {
  it("round-trips large controllers and UTF-8 identifiers without truncation", () => {
    const events: RawInputEvent[] = [
      { kind: "gamepad", tick: 1, gamepadIndex: 0,
        axes: [0.5, -0.25, 0, 1, -1, 0.75], buttons: Array.from({ length: 32 }, (_, i) => i % 2) },
      { kind: "touchAxis", tick: 2, controlId: "操縦".repeat(90), value: 0.5 },
      { kind: "key", tick: 3, code: "KeyW", phase: "down" },
    ];
    expect(decodeInputEvents(encodeInputEvents(events))).toEqual(events);
    expect(decodeInputEvents(encodeInputEvents([events[0]!]))).toEqual([events[0]]);
  });

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
      { kind: "gamepadDisconnect", tick: 5, gamepadIndex: 3 },
      { kind: "touchAxis", tick: 5, controlId: "stick-x", value: 0.5 },
    ];
    const bytes = encodeInputEvents(events);
    expect(decodeInputEvents(bytes)).toEqual(events);
  });

  it("keeps pointer ids above 16 bits distinct and a hover move's button -1", () => {
    const pointer = (pointerId: number, phase: "down" | "move", button: number): RawInputEvent =>
      ({ kind: "pointer", tick: 1, pointerId, phase, x: 1, y: 2, button });
    const events = [pointer(70000, "down", 0), pointer(1, "down", 0), pointer(65537, "down", 0), pointer(1, "move", -1)];
    expect(decodeInputEvents(encodeInputEvents(events))).toEqual(events);
  });
});

describe("input ring buffer overflow", () => {
  const pad = (axis: number, button = 0): RawInputEvent =>
    ({ kind: "gamepad", tick: 2, gamepadIndex: 0, axes: [axis], buttons: [button] });
  const move = (x: number): RawInputEvent =>
    ({ kind: "pointer", tick: 2, pointerId: 1, phase: "move", x, y: 0, button: -1 });

  it("delivers a key release queued ahead of hundreds of samples and keeps the latest sample", () => {
    const resolver = new InputResolver({
      actions: [{ name: "Forward", bindings: [{ device: "key", code: "KeyW" }] }],
      axes: [{ name: "Steer", bindings: [{ device: "gamepadAxis", code: "0:0" }] }],
    });
    const ring = new InputRingBuffer(512);
    ring.push({ kind: "key", tick: 1, code: "KeyW", phase: "down" });
    expect(resolver.resolve(ring.drain()).actions.Forward.held).toBe(true);
    ring.push({ kind: "key", tick: 2, code: "KeyW", phase: "up" });
    for (let i = 0; i < 600; i++) {
      ring.push(pad(0.6 + (i % 3) / 10));
      ring.push(move(i));
    }
    const state = resolver.resolve(ring.drain());
    expect(state.actions.Forward).toEqual({ held: false, pressed: false, released: true });
    expect(state.axes.Steer).toBeCloseTo(0.8);
    expect(state.cursor.x).toBe(599);
  });

  it("keeps a gamepad button tap while coalescing the samples around it", () => {
    const resolver = new InputResolver({ actions: [{ name: "Jump", bindings: [{ device: "gamepadButton", code: "0:0" }] }], axes: [] });
    const ring = new InputRingBuffer(4);
    for (let i = 0; i < 10; i++) ring.push(pad(i / 100));
    ring.push(pad(0, 1));
    for (let i = 0; i < 10; i++) ring.push(pad(i / 100));
    expect(resolver.resolve(ring.drain()).actions.Jump).toEqual({ held: false, pressed: true, released: true });
  });

  it("grows for press and release edges, then drops the oldest presses before any release", () => {
    const key = (code: string, phase: "down" | "up"): RawInputEvent => ({ kind: "key", tick: 1, code, phase });
    const ring = new InputRingBuffer(2);
    for (const code of ["KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH"]) ring.push(key(code, "down"));
    for (const code of ["KeyA", "KeyB", "KeyC"]) ring.push(key(code, "up"));
    expect(ring.drain().map(event => event.kind === "key" ? `${event.phase} ${event.code}` : "")).toEqual([
      "down KeyD", "down KeyE", "down KeyF", "down KeyG", "down KeyH", "up KeyA", "up KeyB", "up KeyC",
    ]);
  });
});
