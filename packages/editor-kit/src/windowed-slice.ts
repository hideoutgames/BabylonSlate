export const WINDOWED_SLICE_OVERSCAN = 4;

export type WindowedSliceInput = {
  itemCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
};

export type WindowedSlice = {
  firstIndex: number;
  lastIndex: number;
};

/**
 * Inclusive-start exclusive-end window for a 1D list. A 0-height viewport
 * (jsdom / first paint) returns the full range so tests still see every row.
 */
export function windowedSlice({
  itemCount,
  rowHeight,
  scrollTop,
  viewportHeight,
  overscan = WINDOWED_SLICE_OVERSCAN,
}: WindowedSliceInput): WindowedSlice {
  if (viewportHeight <= 0) {
    return { firstIndex: 0, lastIndex: itemCount };
  }
  return {
    firstIndex: Math.max(0, Math.floor(scrollTop / rowHeight) - overscan),
    lastIndex: Math.min(
      itemCount,
      Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
    ),
  };
}
