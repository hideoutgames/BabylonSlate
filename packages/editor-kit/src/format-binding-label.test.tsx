import { describe, expect, it } from "vitest";
import { formatBindingLabel } from "./format-binding-label";

describe("formatBindingLabel", () => {
  it("formats keyboard codes and modifiers", () => {
    expect(formatBindingLabel("key", "Space")).toBe("Space");
    expect(formatBindingLabel("key", "KeyW")).toBe("W");
    expect(formatBindingLabel("key", "Digit1")).toBe("1");
    expect(formatBindingLabel("key", "ArrowUp")).toBe("Up");
    expect(
      formatBindingLabel("key", "KeyW", { shift: true, ctrl: true }),
    ).toBe("Ctrl+Shift+W");
  });

  it("formats mouse, pointer, gamepad, and touch codes", () => {
    expect(formatBindingLabel("mouseButton", "0")).toBe("Mouse Left");
    expect(formatBindingLabel("mouseButton", "2")).toBe("Mouse Right");
    expect(formatBindingLabel("pointer", "primary")).toBe("Primary Pointer");
    expect(formatBindingLabel("gamepadButton", "0:0")).toBe("Gamepad 1 A");
    expect(formatBindingLabel("gamepadButton", "1:1")).toBe("Gamepad 2 B");
    expect(formatBindingLabel("gamepadAxis", "0:0")).toBe(
      "Gamepad 1 Left Stick X",
    );
    expect(formatBindingLabel("gamepadAxis", "0:3")).toBe(
      "Gamepad 1 Right Stick Y",
    );
    expect(formatBindingLabel("touch", "joystick-x")).toBe("Joystick X");
    expect(formatBindingLabel("touch", "dpad-y")).toBe("D-Pad Y");
  });

  it("falls back to the raw code when no label is known", () => {
    expect(formatBindingLabel("key", "F13")).toBe("F13");
    expect(formatBindingLabel("gamepadButton", "0:99")).toBe(
      "Gamepad 1 Button 99",
    );
    expect(formatBindingLabel("touch", "custom-stick")).toBe("Custom Stick");
  });
});
