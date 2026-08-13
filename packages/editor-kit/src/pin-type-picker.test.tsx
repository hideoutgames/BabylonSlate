import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PinTypePicker } from "./pin-type-picker";
import { isPinPickerType } from "./pin-types";

if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    value: PointerEventPolyfill,
  });
}

describe("PinTypePicker", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the selected type with a pin color swatch", () => {
    render(<PinTypePicker value="float" onChange={() => {}} />);
    const trigger = screen.getByTestId("pin-type-picker");
    expect(trigger.textContent).toContain("Float");
    const swatch = trigger.querySelector("[data-type-color-swatch]");
    expect(swatch).not.toBeNull();
    expect((swatch as HTMLElement).style.backgroundColor).toBe(
      "var(--pin-float)",
    );
  });

  it("lists colored types in a searchable dropdown, not a toggle group", () => {
    const onChange = vi.fn();
    render(
      <PinTypePicker
        value="float"
        onChange={onChange}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByRole("radio")).toBeNull();
    const vec3 = screen.getByTestId("search-item-vec3");
    expect(vec3.textContent).toContain("Vector 3");
    expect(vec3.querySelector("[data-type-color-swatch]")).not.toBeNull();
    vec3.click();
    expect(onChange).toHaveBeenCalledWith("vec3");
  });

  it("narrows known pin picker types", () => {
    expect(isPinPickerType("bool")).toBe(true);
    expect(isPinPickerType("widget")).toBe(false);
  });
});
