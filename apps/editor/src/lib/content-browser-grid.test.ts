import { describe, expect, it } from "vitest";
import {
  CONTENT_BROWSER_GRID_GAP_PX,
  CONTENT_BROWSER_GRID_PAD_PX,
  CONTENT_BROWSER_TILE_HEIGHT_PX,
  CONTENT_BROWSER_TILE_WIDTH_PX,
  windowedGridSlice,
} from "./content-browser-grid";

describe("windowedGridSlice", () => {
  it("returns the full range when the viewport is 0", () => {
    expect(
      windowedGridSlice({
        itemCount: 300,
        viewportWidth: 0,
        viewportHeight: 0,
        scrollTop: 0,
      }),
    ).toEqual({ firstIndex: 0, lastIndex: 300, columnCount: 1 });
  });

  it("windows a large folder to viewport-near tiles plus row overscan", () => {
    expect(CONTENT_BROWSER_TILE_WIDTH_PX).toBe(144);
    expect(CONTENT_BROWSER_GRID_GAP_PX).toBe(8);
    expect(CONTENT_BROWSER_GRID_PAD_PX).toBe(12);
    expect(CONTENT_BROWSER_TILE_HEIGHT_PX).toBeGreaterThan(
      CONTENT_BROWSER_TILE_WIDTH_PX,
    );

    const viewportWidth =
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
      CONTENT_BROWSER_TILE_WIDTH_PX * 4 +
      CONTENT_BROWSER_GRID_GAP_PX * 3;
    const viewportHeight =
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
      CONTENT_BROWSER_TILE_HEIGHT_PX * 2 +
      CONTENT_BROWSER_GRID_GAP_PX;

    const slice = windowedGridSlice({
      itemCount: 300,
      viewportWidth,
      viewportHeight,
      scrollTop: 0,
    });

    expect(slice.columnCount).toBe(4);
    expect(slice.firstIndex).toBe(0);
    expect(slice.lastIndex).toBeGreaterThan(0);
    expect(slice.lastIndex).toBeLessThan(80);
    expect(slice.lastIndex - slice.firstIndex).toBeLessThan(80);
  });

  it("shifts the window when the grid is scrolled", () => {
    const viewportWidth =
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
      CONTENT_BROWSER_TILE_WIDTH_PX * 4 +
      CONTENT_BROWSER_GRID_GAP_PX * 3;
    const viewportHeight =
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
      CONTENT_BROWSER_TILE_HEIGHT_PX * 2 +
      CONTENT_BROWSER_GRID_GAP_PX;
    const stride = CONTENT_BROWSER_TILE_HEIGHT_PX + CONTENT_BROWSER_GRID_GAP_PX;

    const slice = windowedGridSlice({
      itemCount: 300,
      viewportWidth,
      viewportHeight,
      scrollTop: stride * 10,
    });

    expect(slice.firstIndex).toBeGreaterThan(0);
    expect(slice.lastIndex).toBeLessThan(300);
    expect(slice.lastIndex - slice.firstIndex).toBeLessThan(80);
  });
});
