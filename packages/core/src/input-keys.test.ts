import { describe, expect, it } from "vitest";
import { inputControlFromKey, inputKeyFromControl } from "./input-keys";

describe("native Key controls", () => {
  it.each([
    ["KeyW", "key", "KeyW"],
    ["F24", "key", "F24"],
    ["IntlYen", "key", "IntlYen"],
    ["MouseBack", "mouseButton", "3"],
    ["Gamepad4Button16", "gamepadButton", "3:16"],
    ["Gamepad2Axis3", "gamepadAxis", "1:3"],
  ] as const)(
    "maps %s without confusing device or gamepad identity",
    (key, device, code) => {
      expect(inputControlFromKey(key)).toEqual({ device, code });
      expect(inputKeyFromControl(device, code)).toBe(key);
    },
  );

  it("leaves unbound and unknown enum values inactive", () => {
    expect(inputControlFromKey("None")).toBeNull();
    expect(inputControlFromKey("Gamepad1Button999")).toBeNull();
    expect(inputControlFromKey({ key: "Space" })).toBeNull();
    expect(inputKeyFromControl("key", "")).toBeNull();
    expect(inputKeyFromControl("pointer", "primary")).toBe("MouseLeft");
  });
});
