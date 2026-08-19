import { WINDOWED_SLICE_OVERSCAN, windowedSlice } from "@babylonslate/editor-kit";

/** Matches `grid-cols-[repeat(auto-fill,9rem)]` at a 16px root. */
export const CONTENT_BROWSER_TILE_WIDTH_PX = 144;
/** Thumb square plus title, type line, and badges — taller than the 9rem well. */
export const CONTENT_BROWSER_TILE_HEIGHT_PX = 220;
/** Matches `gap-2`. */
export const CONTENT_BROWSER_GRID_GAP_PX = 8;
/** Matches `p-3`. */
export const CONTENT_BROWSER_GRID_PAD_PX = 12;

export type WindowedGridSliceInput = {
  itemCount: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
};

export type WindowedGridSlice = {
  firstIndex: number;
  lastIndex: number;
  columnCount: number;
};

export function contentBrowserColumnCount(viewportWidth: number): number {
  const inner =
    viewportWidth - CONTENT_BROWSER_GRID_PAD_PX * 2 + CONTENT_BROWSER_GRID_GAP_PX;
  const stride = CONTENT_BROWSER_TILE_WIDTH_PX + CONTENT_BROWSER_GRID_GAP_PX;
  return Math.max(1, Math.floor(inner / stride));
}

export function windowedGridSlice({
  itemCount,
  viewportWidth,
  viewportHeight,
  scrollTop,
  overscan = WINDOWED_SLICE_OVERSCAN,
}: WindowedGridSliceInput): WindowedGridSlice {
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return { firstIndex: 0, lastIndex: itemCount, columnCount: 1 };
  }
  const columnCount = contentBrowserColumnCount(viewportWidth);
  const rowCount = Math.ceil(itemCount / columnCount);
  const { firstIndex: firstRow, lastIndex: lastRow } = windowedSlice({
    itemCount: rowCount,
    rowHeight: CONTENT_BROWSER_TILE_HEIGHT_PX + CONTENT_BROWSER_GRID_GAP_PX,
    scrollTop,
    viewportHeight,
    overscan,
  });
  return {
    firstIndex: firstRow * columnCount,
    lastIndex: Math.min(itemCount, lastRow * columnCount),
    columnCount,
  };
}

export function contentBrowserGridHeight(
  itemCount: number,
  columnCount: number,
): number {
  const rows = Math.ceil(itemCount / Math.max(1, columnCount));
  if (rows === 0) return 0;
  return (
    CONTENT_BROWSER_GRID_PAD_PX * 2 +
    rows * CONTENT_BROWSER_TILE_HEIGHT_PX +
    (rows - 1) * CONTENT_BROWSER_GRID_GAP_PX
  );
}

export function contentBrowserTileStyle(
  index: number,
  columnCount: number,
): { position: "absolute"; left: number; top: number; width: number } {
  const columns = Math.max(1, columnCount);
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    position: "absolute",
    left:
      CONTENT_BROWSER_GRID_PAD_PX +
      col * (CONTENT_BROWSER_TILE_WIDTH_PX + CONTENT_BROWSER_GRID_GAP_PX),
    top:
      CONTENT_BROWSER_GRID_PAD_PX +
      row * (CONTENT_BROWSER_TILE_HEIGHT_PX + CONTENT_BROWSER_GRID_GAP_PX),
    width: CONTENT_BROWSER_TILE_WIDTH_PX,
  };
}
