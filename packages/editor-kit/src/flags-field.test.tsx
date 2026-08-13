import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlagsField } from "./flags-field";

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

describe("FlagsField", () => {
  it("toggles named bits in a bitmask", () => {
    const onChange = vi.fn();
    render(
      <FlagsField
        value={1}
        bitCount={3}
        labels={["Default", "Player", "World"]}
        onChange={onChange}
        data-testid="physics-layers"
      />,
    );
    expect(screen.getByTestId("physics-layers-bit-0").textContent).toContain(
      "Default",
    );
    expect(screen.getByTestId("physics-layers-bit-0").getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByTestId("physics-layers-bit-2"));
    expect(onChange).toHaveBeenCalledWith(5);
  });
});
