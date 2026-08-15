import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultTilemapPayload } from "@babylonslate/assets";
import { TilemapDetails } from "./tilemap-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: { list: () => [] },
    openDocuments: [],
    projectDocument: {
      settings: {
        twoD: { sortingLayers: ["Background", "Default", "Foreground", "UI"] },
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
});

describe("TilemapDetails", () => {
  it("adds a second layer and exposes visibility, sorting, and parallax", () => {
    const payload = createDefaultTilemapPayload();
    const onChange = vi.fn();
    render(
      <TilemapDetails
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("tilemap-details")).toBeTruthy();
    expect(screen.getByTestId("property-layer-visible")).toBeTruthy();
    expect(screen.getByTestId("property-layer-collision")).toBeTruthy();
    expect(screen.getByTestId("property-layer-sorting")).toBeTruthy();
    expect(screen.getByTestId("property-vector3-layer-parallax")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tilemap-layers-add"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        layers: expect.arrayContaining([
          expect.objectContaining({ name: "Ground" }),
          expect.objectContaining({ name: "Layer" }),
        ]),
      }),
    );
  });
});
