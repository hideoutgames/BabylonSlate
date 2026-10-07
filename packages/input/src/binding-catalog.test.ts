import { describe, expect, it } from "vitest";
import {
  bindingCodeLabel,
  bindingCodesForDevice,
} from "./binding-catalog";

function codesOf(
  device: Parameters<typeof bindingCodesForDevice>[0],
): string[] {
  return bindingCodesForDevice(device).map((entry) => entry.code);
}

describe("bindingCodesForDevice", () => {
  it("lists keyboard letters, Space, and F12 with browse groups", () => {
    const keys = codesOf("key");
    expect(keys).toContain("KeyW");
    expect(keys).toContain("Space");
    expect(keys).toContain("F12");
    expect(keys).toContain("F24");
    expect(
      bindingCodesForDevice("key").find((entry) => entry.code === "KeyW"),
    ).toMatchObject({ label: "W", group: "Letters" });
    expect(
      bindingCodesForDevice("key").find((entry) => entry.code === "Space"),
    ).toMatchObject({ label: "Space", group: "Other" });
    expect(
      bindingCodesForDevice("key").find((entry) => entry.code === "F12"),
    ).toMatchObject({ label: "F12", group: "Function" });
  });

  it("lists mouse buttons and primary pointer", () => {
    expect(codesOf("mouseButton")).toEqual(["0", "1", "2", "3", "4"]);
    expect(
      bindingCodesForDevice("mouseButton").find((entry) => entry.code === "0"),
    ).toMatchObject({ label: "Mouse Left", group: "Mouse" });
    expect(codesOf("pointer")).toEqual(["primary"]);
    expect(bindingCodesForDevice("pointer")[0]).toMatchObject({
      code: "primary",
      label: "Primary Pointer",
      group: "Pointer",
    });
  });

  it("lists standard gamepad buttons and axes across four pads", () => {
    const buttons = codesOf("gamepadButton");
    expect(buttons).toContain("0:0");
    expect(buttons).toContain("1:1");
    expect(buttons).toContain("3:16");
    expect(
      bindingCodesForDevice("gamepadButton").find(
        (entry) => entry.code === "0:0",
      ),
    ).toMatchObject({ label: "Face Button Down", group: "Gamepad 1" });
    expect(
      bindingCodesForDevice("gamepadButton").find(
        (entry) => entry.code === "1:1",
      ),
    ).toMatchObject({ label: "Face Button Right", group: "Gamepad 2" });
    expect(
      bindingCodesForDevice("gamepadButton").find(
        (entry) => entry.code === "0:10",
      ),
    ).toMatchObject({ label: "Left Stick Click", group: "Gamepad 1" });
    expect(
      bindingCodesForDevice("gamepadButton").find(
        (entry) => entry.code === "0:12",
      ),
    ).toMatchObject({ label: "D-Pad Up", group: "Gamepad 1" });

    const axes = codesOf("gamepadAxis");
    expect(axes).toContain("0:0");
    expect(axes).toContain("0:3");
    expect(axes).toContain("2:2");
    expect(
      bindingCodesForDevice("gamepadAxis").find((entry) => entry.code === "0:0"),
    ).toMatchObject({
      label: "Left Stick X",
      group: "Gamepad 1",
    });
  });

  it("offers built-in touch controls to typed input pickers", () => {
    expect(bindingCodesForDevice("touch").map((entry) => entry.code)).toEqual(["joystick-x", "joystick-y", "dpad-x", "dpad-y", "Jump"]);
  });
});

describe("bindingCodeLabel", () => {
  it("falls back when no catalog entry exists", () => {
    expect(bindingCodeLabel("key", "F13")).toBe("F13");
    expect(bindingCodeLabel("gamepadButton", "0:99")).toBe(
      "Gamepad 1 Button 99",
    );
    expect(bindingCodeLabel("touch", "custom-stick")).toBe("Custom Stick");
  });
});
