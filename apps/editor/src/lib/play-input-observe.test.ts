import { describe, expect, it } from "vitest";
import { observedMoveXFromEvents } from "./play-input-observe";

describe("observedMoveXFromEvents", () => {
  it("reads gamepad axis 0 as Move.x", () => {
    expect(
      observedMoveXFromEvents([
        {
          kind: "gamepad",
          tick: 1,
          gamepadIndex: 0,
          axes: [0.85, 0, 0, 0],
          buttons: [],
        },
      ]),
    ).toBe(0.85);
  });

  it("reads the default touch joystick as the same Move.x", () => {
    expect(
      observedMoveXFromEvents([
        { kind: "touchAxis", tick: 1, controlId: "joystick-x", value: 0.8 },
      ]),
    ).toBe(0.8);
  });

  it("keeps the previous sample when the tick has no Move.x", () => {
    expect(
      observedMoveXFromEvents(
        [{ kind: "key", tick: 1, code: "KeyW", phase: "down" }],
        0.5,
      ),
    ).toBe(0.5);
  });
});
