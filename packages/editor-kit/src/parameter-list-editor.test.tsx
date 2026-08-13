import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ParameterListEditor,
  type ParameterRow,
} from "./parameter-list-editor";

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

const rows: ParameterRow[] = [
  { id: "a", name: "amount", type: "float" },
  {
    id: "b",
    name: "mode",
    type: "enum",
    optional: true,
    defaultValue: "a",
    enumValues: ["a", "b"],
  },
];

describe("ParameterListEditor", () => {
  afterEach(() => {
    cleanup();
  });

  it("changes a row type, optional flag, default, and enum values", () => {
    const onChange = vi.fn();
    render(
      <ParameterListEditor rows={rows.slice(0, 1)} onChange={onChange} />,
    );

    screen.getByTestId("parameter-a-type-string").click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", name: "amount", type: "string" }),
    ]);

    onChange.mockClear();
    fireEvent.click(screen.getByTestId("parameter-a-optional"));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", optional: true }),
    ]);

    onChange.mockClear();
    fireEvent.change(screen.getByTestId("parameter-a-default"), {
      target: { value: "1.5" },
    });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", defaultValue: "1.5" }),
    ]);
  });

  it("paints parameter type toggles with DataTypes pin colors", () => {
    render(
      <ParameterListEditor rows={rows.slice(0, 1)} onChange={() => {}} />,
    );
    const floatToggle = screen.getByTestId("parameter-a-type-float");
    const swatch = floatToggle.querySelector("[data-type-color-swatch]");
    expect(swatch).not.toBeNull();
    expect((swatch as HTMLElement).style.backgroundColor).toBe(
      "var(--pin-float)",
    );
    expect(floatToggle.textContent).toContain("Float");
  });

  it("edits enum values as a named list", () => {
    const onChange = vi.fn();
    render(
      <ParameterListEditor rows={rows.slice(1)} onChange={onChange} />,
    );
    expect(screen.getByTestId("parameter-b-enum-values")).toBeTruthy();
    fireEvent.change(screen.getByTestId("parameter-b-enum-values-0-value"), {
      target: { value: "low" },
    });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "b",
        enumValues: ["low", "b"],
      }),
    ]);
  });

  it("moves a row up and down with 44px targets", () => {
    const onChange = vi.fn();
    render(<ParameterListEditor rows={rows} onChange={onChange} />);
    const up = screen.getByTestId("parameter-b-move-up");
    expect(up.className).toMatch(/touch-icon|min-h|size-\[var\(--touch-target/);
    up.click();
    expect(onChange.mock.calls[0]![0].map((row: ParameterRow) => row.id)).toEqual(
      ["b", "a"],
    );

    onChange.mockClear();
    screen.getByTestId("parameter-a-move-down").click();
    expect(onChange.mock.calls[0]![0].map((row: ParameterRow) => row.id)).toEqual(
      ["b", "a"],
    );
  });

  it("adds a named row and removes it", () => {
    const onChange = vi.fn();
    render(<ParameterListEditor rows={[]} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "health" },
    });
    screen.getByRole("button", { name: "Add" }).click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "health", type: "float" }),
    ]);

    onChange.mockClear();
    render(
      <ParameterListEditor
        rows={[{ id: "x", name: "health", type: "float" }]}
        onChange={onChange}
      />,
    );
    screen.getByRole("button", { name: "Remove health" }).click();
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
