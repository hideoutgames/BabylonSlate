import { describe, expect, it } from "vitest";
import {
  WINDOWED_SLICE_OVERSCAN,
  windowedRowOffsets,
  windowedSlice,
} from "./windowed-slice";

describe("windowedSlice", () => {
  it("returns the full range when the viewport height is 0", () => {
    expect(
      windowedSlice({
        itemCount: 1000,
        rowHeight: 44,
        scrollTop: 0,
        viewportHeight: 0,
      }),
    ).toEqual({ firstIndex: 0, lastIndex: 1000 });
  });

  it("windows to the visible rows plus overscan of 4", () => {
    expect(WINDOWED_SLICE_OVERSCAN).toBe(4);
    expect(
      windowedSlice({
        itemCount: 1000,
        rowHeight: 44,
        scrollTop: 0,
        viewportHeight: 440,
      }),
    ).toEqual({ firstIndex: 0, lastIndex: 14 });
  });

  it("shifts the window when scrolled", () => {
    expect(
      windowedSlice({
        itemCount: 1000,
        rowHeight: 44,
        scrollTop: 440,
        viewportHeight: 440,
      }),
    ).toEqual({ firstIndex: 6, lastIndex: 24 });
  });

  it("windows variable-height rows by their offsets", () => {
    const rowOffsets = windowedRowOffsets(1000, (index) => (index === 0 ? 28 : 44));
    expect(rowOffsets.slice(0, 3)).toEqual([0, 28, 72]);
    expect(
      windowedSlice({
        itemCount: 1000,
        rowHeight: 44,
        rowOffsets,
        scrollTop: 28 + 44 * 10,
        viewportHeight: 440,
      }),
    ).toEqual({ firstIndex: 7, lastIndex: 26 });
  });
});
