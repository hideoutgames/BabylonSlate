import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ensureTilesetTiles, normalizeTilesetPayload } from "@babylonslate/assets";
import { AtlasTileGrid } from "./atlas-tile-grid";
import { dispatchPointerEvent } from "./test-support/pointer-events";

afterEach(() => {
  cleanup();
});

function twoTileSet() {
  return ensureTilesetTiles(
    normalizeTilesetPayload({
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tiles: [
        { id: 1, collision: "full" },
        { id: 2, collision: "none" },
      ],
    }),
  );
}

describe("AtlasTileGrid", () => {
  it("renders a cell for every atlas tile and selects on tap", () => {
    const onSelect = vi.fn();
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={1}
        onSelect={onSelect}
        data-testid="tileset-preview"
      />,
    );
    expect(screen.getByTestId("tileset-preview-cell-1")).toBeTruthy();
    expect(screen.getByTestId("tileset-preview-cell-2")).toBeTruthy();
    expect(screen.getByTestId("tileset-preview-cell-1").getAttribute("data-collision")).toBe(
      "full",
    );
    fireEvent.click(screen.getByTestId("tileset-preview-cell-2"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("shows an empty state when no texture is assigned", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={1}
        onSelect={() => {}}
        emptyLabel="No Texture"
      />,
    );
    expect(screen.getByText("No Texture")).toBeTruthy();
  });

  it("zooms the atlas surface from the wheel", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    fireEvent.wheel(surface, { deltaY: -120, clientX: 10, clientY: 10 });
    expect(Number(surface.getAttribute("data-zoom") ?? "1")).toBeGreaterThan(1);
  });

  it("pans the atlas when two fingers translate without changing spread", async () => {
    HTMLElement.prototype.setPointerCapture = () => {
      throw new DOMException("No active pointer with the given id is found.");
    };
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    surface.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    expect(surface.getAttribute("data-pan-x")).toBe("0");
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 1,
      clientX: 80,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 2,
      clientX: 120,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 2,
      clientX: 160,
      clientY: 80,
    });
    await waitFor(() => {
      expect(Number(surface.getAttribute("data-pan-x") ?? "0")).toBe(40);
    });
    expect(Number(surface.getAttribute("data-zoom") ?? "1")).toBe(1);
  });

  it("contains the atlas image in the preview box", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        data-testid="atlas"
      />,
    );
    const img = document.querySelector("img");
    expect(img?.className).toContain("object-contain");
  });
});
