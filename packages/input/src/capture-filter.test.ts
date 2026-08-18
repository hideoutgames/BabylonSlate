import { describe, expect, it } from "vitest";
import { shouldPushRawInput } from "./capture-filter";

describe("shouldPushRawInput", () => {
  it("pushes every device in All and Game", () => {
    for (const mode of ["All", "Game"] as const) {
      expect(shouldPushRawInput(mode, "key")).toBe(true);
      expect(shouldPushRawInput(mode, "pointer")).toBe(true);
      expect(shouldPushRawInput(mode, "mouse")).toBe(true);
      expect(shouldPushRawInput(mode, "gamepad")).toBe(true);
      expect(shouldPushRawInput(mode, "touchAxis")).toBe(true);
    }
  });

  it("keeps only HUD touch axes in Interface mode", () => {
    expect(shouldPushRawInput("Interface", "touchAxis")).toBe(true);
    expect(shouldPushRawInput("Interface", "key")).toBe(false);
    expect(shouldPushRawInput("Interface", "pointer")).toBe(false);
    expect(shouldPushRawInput("Interface", "mouse")).toBe(false);
    expect(shouldPushRawInput("Interface", "gamepad")).toBe(false);
    expect(shouldPushRawInput("Interface", "gamepadConnection")).toBe(false);
  });
});
