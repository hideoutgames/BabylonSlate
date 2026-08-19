import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VariableTypeFields } from "./variable-type-fields";

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

describe("VariableTypeFields", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows Type, Container Single/Array/Map, and Key Type only for Map", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <VariableTypeFields
        value={{ typeId: "float", container: "single" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("inspector-member-type")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-container")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-container-single").textContent).toBe(
      "Single",
    );
    expect(screen.getByTestId("inspector-member-container-array").textContent).toBe(
      "Array",
    );
    expect(screen.getByTestId("inspector-member-container-map").textContent).toBe(
      "Map",
    );
    expect(screen.queryByTestId("inspector-member-key-type")).toBeNull();

    rerender(
      <VariableTypeFields
        value={{ typeId: "float", container: "map", keyTypeId: "string" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("inspector-member-key-type")).toBeTruthy();
  });

  it("commits Array from the container ToggleGroup", () => {
    const onChange = vi.fn();
    render(
      <VariableTypeFields
        value={{ typeId: "rotator", container: "single" }}
        onChange={onChange}
      />,
    );
    screen.getByTestId("inspector-member-container-array").click();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ typeId: "rotator", container: "array" }),
    );
  });
});
