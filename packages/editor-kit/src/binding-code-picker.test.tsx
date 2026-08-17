import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BindingCodePicker } from "./binding-code-picker";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
});

describe("BindingCodePicker", () => {
  it("shows Choose Key when no code is set", () => {
    render(
      <BindingCodePicker device="key" code="" onChange={() => {}} />,
    );
    expect(screen.getByTestId("binding-code-picker").textContent).toContain(
      "Choose Key",
    );
  });

  it("shows the formatted label for a stored code", () => {
    render(
      <BindingCodePicker device="key" code="Space" onChange={() => {}} />,
    );
    expect(screen.getByTestId("binding-code-picker").textContent).toContain(
      "Space",
    );
  });

  it("opens a searchable dropdown of keyboard codes and reports the selection", () => {
    const onChange = vi.fn();
    render(
      <BindingCodePicker
        device="key"
        code=""
        onChange={onChange}
        open
        onOpenChange={() => {}}
      />,
    );
    const menu = screen.getByTestId("binding-code-picker-menu");
    expect(menu.getAttribute("data-slot")).toBe("dropdown-menu-content");
    expect(screen.getByTestId("search-item-KeyW")).toBeTruthy();
    expect(screen.queryByTestId("search-item-0:0")).toBeNull();

    fireEvent.change(screen.getByTestId("binding-code-picker-menu-query"), {
      target: { value: "space" },
    });
    expect(screen.queryByTestId("search-item-KeyW")).toBeNull();
    screen.getByTestId("search-item-Space").click();
    expect(onChange).toHaveBeenCalledWith("Space");
  });

  it("lists gamepad buttons, not keyboard codes", () => {
    render(
      <BindingCodePicker
        device="gamepadButton"
        code=""
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId("search-item-0:0").textContent).toContain(
      "Gamepad 1 A",
    );
    expect(screen.queryByTestId("search-item-KeyW")).toBeNull();
    expect(screen.getByTestId("binding-code-picker").textContent).toContain(
      "Choose Button",
    );
  });

  it("lists provided touch control ids", () => {
    const onChange = vi.fn();
    render(
      <BindingCodePicker
        device="touch"
        code="joystick-x"
        onChange={onChange}
        touchControlIds={["joystick-x", "Jump", "custom-stick"]}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId("search-item-Jump").textContent).toContain("Jump");
    screen.getByTestId("search-item-custom-stick").click();
    expect(onChange).toHaveBeenCalledWith("custom-stick");
  });
});
