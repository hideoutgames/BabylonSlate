import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CatalogTile } from "./catalog-tile";
import { resolveTypeVisual } from "./type-visuals";

afterEach(() => {
  cleanup();
});

describe("CatalogTile", () => {
  it("selects on click and Enter/Space but not during IME composition", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <CatalogTile
        title="Mesh"
        description="Primitive or Model asset"
        visual={resolveTypeVisual({ classId: "MeshComponent" })}
        onSelect={onSelect}
      />,
    );
    const tile = getByRole("button", { name: /Mesh/ });
    fireEvent.click(tile);
    fireEvent.keyDown(tile, { key: "Enter" });
    fireEvent.keyDown(tile, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(tile, { key: "Enter", isComposing: true });
    fireEvent.keyDown(tile, { key: "a" });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});
