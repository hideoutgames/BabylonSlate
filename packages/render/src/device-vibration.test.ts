import { describe, expect, it, vi } from "vitest";
import { applyDeviceVibration } from "./device-vibration";

describe("applyDeviceVibration", () => {
  it("vibrates for the command's duration, and stops at zero", () => {
    const vibrate = vi.fn(() => true);
    applyDeviceVibration({ durationMs: 120 }, { vibrate });
    applyDeviceVibration({ durationMs: 0 }, { vibrate });
    expect(vibrate.mock.calls).toEqual([[120], [0]]);
  });

  it("does nothing where the browser cannot vibrate or throws", () => {
    expect(() => applyDeviceVibration({ durationMs: 50 }, {})).not.toThrow();
    expect(() => applyDeviceVibration({ durationMs: 50 }, undefined)).not.toThrow();
    expect(() => applyDeviceVibration({ durationMs: 50 }, { vibrate: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});
