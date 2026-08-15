import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultTilesetPayload } from "@babylonslate/assets";
import { TilesetEditor } from "./tileset-editor";

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
    assetRegistry: {
      list: () => [
        {
          header: { guid: "tex-1", name: "GroundAtlas", type: "Texture" },
          path: "assets/GroundAtlas.texture.babasset",
        },
      ],
    },
    projectDocument: {
      settings: { twoD: { sortingLayers: ["Default", "Foreground"] } },
    },
  }),
}));

afterEach(() => {
  cleanup();
});

describe("TilesetEditor", () => {
  it("authors per-tile collision, flags, and animation", async () => {
    const payload = {
      ...createDefaultTilesetPayload(),
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    };
    const onChange = vi.fn();
    render(
      <TilesetEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("tileset-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-flags-bit-0"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1, flags: 1 }),
        ]),
      }),
    );
    fireEvent.change(screen.getByTestId("property-animation"), {
      target: { value: "1, 2" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1, animation: [1, 2] }),
        ]),
      }),
    );
    fireEvent.click(screen.getByTestId("property-collision"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Chain" })).toBeTruthy();
    });
    expect(screen.getByRole("option", { name: "Full" })).toBeTruthy();
  });
});
