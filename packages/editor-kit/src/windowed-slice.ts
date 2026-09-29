export const WINDOWED_SLICE_OVERSCAN = 4;

export type WindowedSliceInput = {
  itemCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
  /** Row tops for variable heights (`itemCount + 1` entries); overrides `rowHeight`. */
  rowOffsets?: readonly number[];
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
  rowOffsets,
}: WindowedSliceInput): WindowedSlice {
  if (viewportHeight <= 0) {
    return { firstIndex: 0, lastIndex: itemCount };
  }
  if (rowOffsets) {
    const first = rowIndexAt(rowOffsets, itemCount, scrollTop);
    const last = rowIndexAt(rowOffsets, itemCount, scrollTop + viewportHeight) + 1;
    return {
      firstIndex: Math.max(0, first - overscan),
      lastIndex: Math.min(itemCount, last + overscan),
    };
  }
  return {
    firstIndex: Math.max(0, Math.floor(scrollTop / rowHeight) - overscan),
    lastIndex: Math.min(
      itemCount,
      Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
    ),
  };
}

/** Prefix sums of row heights: entry `i` is row `i`'s top; the last is the total. */
export function windowedRowOffsets(
  itemCount: number,
  rowHeight: (index: number) => number,
): number[] {
  const offsets = [0];
  for (let index = 0; index < itemCount; index++) {
    offsets.push(offsets[index]! + rowHeight(index));
  }
  return offsets;
}

/** Last row whose top is at or above `y`. */
function rowIndexAt(rowOffsets: readonly number[], itemCount: number, y: number): number {
  let low = 0;
  let high = Math.max(0, itemCount - 1);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (rowOffsets[mid]! <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}
