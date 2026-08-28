import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VariableTypeFields } from "./variable-type-fields";
import { AssetOpenProvider } from "./asset-picker-control";

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
    expect(screen.getByTestId("inspector-member-container-array").textContent).toContain(
      "Array",
    );
    expect(
      screen
        .getByTestId("inspector-member-container-array")
        .querySelector('[data-pin-shape="list"]'),
    ).not.toBeNull();
    expect(screen.getByTestId("inspector-member-container-map").textContent).toContain(
      "Map",
    );
    expect(
      screen
        .getByTestId("inspector-member-container-map")
        .querySelector('[data-pin-shape="map"]'),
    ).not.toBeNull();
    expect(screen.queryByTestId("inspector-member-key-type")).toBeNull();

    rerender(
      <VariableTypeFields
        value={{ typeId: "float", container: "map", keyTypeId: "string" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("inspector-member-key-type")).toBeTruthy();
    const type = screen.getByTestId("inspector-member-type");
    const keyType = screen.getByTestId("inspector-member-key-type");
    const container = screen.getByTestId("inspector-member-container");
    expect(
      type.compareDocumentPosition(keyType) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(
      keyType.compareDocumentPosition(container) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
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

  it("shows Open Asset beside a Map key Structure picker", () => {
    const openAsset = vi.fn();
    render(
      <AssetOpenProvider
        value={{
          canOpen: (guid) => guid === "struct-stats",
          openAsset,
        }}
      >
        <VariableTypeFields
          value={{
            typeId: "float",
            container: "map",
            keyTypeId: "struct",
            keyTypeClassId: "struct-stats",
          }}
          onChange={() => {}}
          typeAssets={[
            { guid: "struct-stats", name: "Stats", type: "Structure" },
          ]}
        />
      </AssetOpenProvider>,
    );
    screen.getByTestId("inspector-member-key-type-asset-open").click();
    expect(openAsset).toHaveBeenCalledWith("struct-stats");
  });
});
