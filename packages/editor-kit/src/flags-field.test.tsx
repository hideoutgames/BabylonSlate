import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlagsField, hasFlagBit, setFlagBit } from "./flags-field";

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

  it("keeps bit 31 as an unsigned mask and shows at most 32 bits", () => {
    expect(setFlagBit(0, 31, true)).toBe(2 ** 31);
    expect(setFlagBit(0xffffffff, 0, false)).toBe(0xfffffffe);
    expect(hasFlagBit(2 ** 31, 31)).toBe(true);
    expect(hasFlagBit(2 ** 31, 0)).toBe(false);
    expect(() => setFlagBit(1, 32, true)).toThrow(RangeError);

    const onChange = vi.fn();
    render(
      <FlagsField
        value={0xffffffff}
        bitCount={40}
        onChange={onChange}
        data-testid="mask"
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(32);
    fireEvent.click(screen.getByTestId("mask-bit-31"));
    expect(onChange).toHaveBeenCalledWith(0x7fffffff);
  });
});
