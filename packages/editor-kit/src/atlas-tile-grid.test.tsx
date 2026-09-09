import { afterEach, describe, expect, it, vi } from "vitest";
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
  it.each([false, true])("selects an atlas rectangle at display scale, reversed=%s", (reverse) => {
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    render(<AtlasTileGrid
      tileset={ensureTilesetTiles(normalizeTilesetPayload({ atlasWidth: 48, atlasHeight: 32, tileWidth: 16, tileHeight: 16 }))}
      imageUrl={null} selectedId={1} onSelect={onSelect}
      onSelectionChange={onSelectionChange} panZoom tool="select" data-testid="atlas"
    />);
    const surface = screen.getByTestId("atlas-surface");
    const cell = screen.getByTestId("atlas-cell-1");
    cell.parentElement!.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 96, height: 64 }) as DOMRect;
    const start = reverse ? { clientX: 152, clientY: 102 } : { clientX: 104, clientY: 54 };
    const end = reverse ? { clientX: 104, clientY: 54 } : { clientX: 152, clientY: 102 };
    dispatchPointerEvent(cell, "pointerdown", { pointerId: 1, ...start });
    dispatchPointerEvent(surface, "pointermove", { pointerId: 1, ...end });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("atlas-cell-5").getAttribute("aria-pressed")).toBe("true");
    dispatchPointerEvent(surface, "pointerup", { pointerId: 1, ...end });
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([1, 2, 4, 5]);
    fireEvent.click(cell);
    expect(onSelect).not.toHaveBeenCalled();
    expect(surface.getAttribute("data-pan-x")).toBe("0");
  });

  it("cancels an in-progress selection when a second finger begins a pinch", () => {
    const onSelectionChange = vi.fn();
    render(<AtlasTileGrid tileset={twoTileSet()} imageUrl={null} selectedId={2}
      selectedIds={[2]} onSelect={() => {}} onSelectionChange={onSelectionChange}
      panZoom tool="select" data-testid="atlas" />);
    const surface = screen.getByTestId("atlas-surface");
    const cell = screen.getByTestId("atlas-cell-1");
    cell.parentElement!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 32, height: 16 }) as DOMRect;
    dispatchPointerEvent(cell, "pointerdown", { pointerId: 1, clientX: 2, clientY: 2 });
    dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 28, clientY: 12 });
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    dispatchPointerEvent(surface, "pointerdown", { pointerId: 2, clientX: 30, clientY: 12 });
    dispatchPointerEvent(surface, "pointerup", { pointerId: 1, clientX: 28, clientY: 12 });
    dispatchPointerEvent(surface, "pointerup", { pointerId: 2, clientX: 30, clientY: 12 });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(cell.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("atlas-cell-2").getAttribute("aria-pressed")).toBe("true");
  });

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

  it("defaults to Move and pans with one finger", async () => {
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
    expect(surface.getAttribute("data-tool")).toBe("move");
    expect(surface.getAttribute("data-pan-x")).toBe("0");
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 1,
      clientX: 80,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    await waitFor(() => {
      expect(Number(surface.getAttribute("data-pan-x") ?? "0")).toBe(40);
    });
  });

  it("selects a cell on a Move tap and ignores a drag", () => {
    const onSelect = vi.fn();
    HTMLElement.prototype.setPointerCapture = () => {};
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={onSelect}
        panZoom
        data-testid="atlas"
      />,
    );
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).toHaveBeenCalledWith(2);
    onSelect.mockClear();
    const surface = screen.getByTestId("atlas-surface");
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 1,
      clientX: 80,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointerup", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).not.toHaveBeenCalled();
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
