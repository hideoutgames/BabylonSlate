import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PropertyGrid, type PropertyRow } from "./property-grid";

afterEach(() => {
  cleanup();
});

function assetRow(
  overrides: Partial<Extract<PropertyRow, { kind: "asset" }>> = {},
): PropertyRow {
  return {
    kind: "asset",
    id: "texture",
    label: "Texture",
    value: "guid-1",
    displayLabel: "red",
    displayType: "Material",
    visual: { assetType: "Material" },
    onPick: () => {},
    onChange: () => {},
    ...overrides,
  };
}

describe("PropertyGrid asset row open-in-tab button", () => {
  it("renders the square open button when path and callback are set", () => {
    const onOpenAsset = vi.fn();
    render(
      <PropertyGrid
        rows={[
          assetRow({
            path: "assets/red.material.babasset",
            onOpenAsset: onOpenAsset,
          }),
        ]}
      />,
    );
    const open = screen.getByTestId("property-texture-open");
    expect(open.className).toContain("aspect-square");
    expect(open.className).toContain("self-stretch");
    expect(open.getAttribute("aria-label")).toBe("Open in tab");
    open.click();
    expect(onOpenAsset).toHaveBeenCalledOnce();
    // The picker button shares the row with the square button.
    expect(screen.getByTestId("property-texture").className).toContain("flex-1");
    expect(screen.getByTestId("property-texture-control")).toBeTruthy();
  });

  it("stays hidden without a path, an empty value, or a disabled row", () => {
    const { rerender } = render(
      <PropertyGrid rows={[assetRow({ onOpenAsset: () => {} })]} />,
    );
    expect(screen.queryByTestId("property-texture-open")).toBeNull();

    rerender(
      <PropertyGrid
        rows={[
          assetRow({
            value: null,
            path: "assets/red.material.babasset",
            onOpenAsset: () => {},
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("property-texture-open")).toBeNull();

    rerender(
      <PropertyGrid
        rows={[
          assetRow({
            path: "assets/red.material.babasset",
            onOpenAsset: () => {},
            disabled: true,
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("property-texture-open")).toBeNull();
  });

  it("hides the button for types that do not open as documents", () => {
    render(
      <PropertyGrid
        rows={[
          assetRow({
            displayType: "CameraComponent",
            path: "assets/camera.babasset",
            onOpenAsset: () => {},
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("property-texture-open")).toBeNull();
    // Layout falls back to the plain full-width picker button.
    expect(screen.getByTestId("property-texture").className).toContain("w-full");
    expect(screen.queryByTestId("property-texture-control")).toBeNull();
  });
});
