import { describe, expect, it, vi } from "vitest";
import { applyGamepadRumble } from "./gamepad-rumble";

function pad(index: number) {
  const actuator = {
    playEffect: vi.fn(() => Promise.resolve("complete")),
    reset: vi.fn(() => Promise.resolve("complete")),
  };
  return { pad: { index, vibrationActuator: actuator }, actuator };
}

describe("applyGamepadRumble", () => {
  it("rumbles both motors of the pad with the command's index", () => {
    const first = pad(0);
    const second = pad(2);
    applyGamepadRumble({ gamepadIndex: 2, intensity: 0.5, durationMs: 300 }, [first.pad, null, second.pad]);
    expect(first.actuator.playEffect).not.toHaveBeenCalled();
    expect(second.actuator.playEffect).toHaveBeenCalledWith("dual-rumble", {
      startDelay: 0, duration: 300, strongMagnitude: 0.5, weakMagnitude: 0.5,
    });
  });

  it("stops the rumble for zero intensity or duration", () => {
    const { pad: gamepad, actuator } = pad(0);
    applyGamepadRumble({ gamepadIndex: 0, intensity: 0, durationMs: 300 }, [gamepad]);
    applyGamepadRumble({ gamepadIndex: 0, intensity: 1, durationMs: 0 }, [gamepad]);
    expect(actuator.reset).toHaveBeenCalledTimes(2);
    expect(actuator.playEffect).not.toHaveBeenCalled();
  });

  it("ignores pads without haptics and effects the browser rejects", async () => {
    expect(() => applyGamepadRumble({ gamepadIndex: 0, intensity: 1, durationMs: 100 }, [{ index: 0 }])).not.toThrow();
    const { pad: gamepad, actuator } = pad(0);
    // An unhandled rejection would fail the run.
    actuator.playEffect.mockImplementationOnce(() => Promise.reject(new Error("NotAllowedError")));
    applyGamepadRumble({ gamepadIndex: 0, intensity: 1, durationMs: 100 }, [gamepad]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actuator.playEffect).toHaveBeenCalledOnce();
  });
});
