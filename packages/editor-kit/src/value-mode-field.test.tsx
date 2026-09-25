import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  VALUE_MODE_CONSTANT,
  VALUE_MODE_CURVE,
  VALUE_MODE_RANGE,
  ValueModeField,
} from "./value-mode-field";

afterEach(() => {
  cleanup();
});

describe("ValueModeField", () => {
  it("names the current mode and picks another from its menu", () => {
    const onChange = vi.fn();
    render(
      <ValueModeField
        label="Lifetime"
        value="range"
        options={[VALUE_MODE_CONSTANT, VALUE_MODE_RANGE, VALUE_MODE_CURVE]}
        onChange={onChange}
        data-testid="value-mode-lifetime"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Lifetime Value Mode, Random Range" }),
    );
    expect(
      screen.getByTestId("value-mode-lifetime-range").getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("value-mode-lifetime-curve"));
    expect(onChange).toHaveBeenCalledWith("curve");
  });
});
