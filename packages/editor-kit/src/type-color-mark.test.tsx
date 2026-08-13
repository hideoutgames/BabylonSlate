import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PIN_COLOR_VAR } from "@babylonslate/ui/lib/data-types";
import { TypeColorMark } from "./type-color-mark";

describe("TypeColorMark", () => {
  afterEach(() => {
    cleanup();
  });

  it("paints a swatch from a pin color token and shows the label", () => {
    render(
      <TypeColorMark
        colorVar={PIN_COLOR_VAR.float}
        label="Float"
        data-testid="mark"
      />,
    );
    const mark = screen.getByTestId("mark");
    expect(mark.textContent).toContain("Float");
    const swatch = mark.querySelector("[data-type-color-swatch]");
    expect(swatch).not.toBeNull();
    expect((swatch as HTMLElement).style.backgroundColor).toBe(
      "var(--pin-float)",
    );
  });
});
