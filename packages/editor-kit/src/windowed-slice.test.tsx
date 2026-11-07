import { describe, expect, it } from "vitest";
import {
  WINDOWED_SLICE_OVERSCAN,
  windowedRowOffsets,
  windowedScrollTop,
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

describe("windowedScrollTop", () => {
  // Ten 28px rows fill the viewport.
  const fixed = { itemCount: 500, rowHeight: 28, viewportHeight: 280 };

  it.each([
    { previous: 30, next: 50, kept: 30, why: "same first row and slice" },
    { previous: 30, next: 55, kept: 30, why: "same first row and slice, up to the row's last pixel" },
    { previous: 30, next: 56, kept: 56, why: "the first visible row moves" },
    { previous: 30, next: 20, kept: 20, why: "the first visible row moves back" },
    { previous: 140, next: 150, kept: 150, why: "same first row, but the last mounted row moves" },
    { previous: 141, next: 150, kept: 141, why: "same first and last rows" },
  ])("keeps $kept for a scroll from $previous to $next: $why", ({ previous, next, kept }) => {
    expect(windowedScrollTop(previous, next, fixed)).toBe(kept);
  });

  it("follows the first visible row while an unmeasured viewport mounts every row", () => {
    const unmeasured = { ...fixed, viewportHeight: 0 };
    expect(windowedScrollTop(10, 20, unmeasured)).toBe(10);
    expect(windowedScrollTop(10, 30, unmeasured)).toBe(30);
  });

  it("compares variable-height rows by their offsets", () => {
    // Row tops 0, 20, 64, 84, 128, 148; 192 in all.
    const variable = {
      itemCount: 6,
      rowHeight: 0,
      viewportHeight: 50,
      overscan: 1,
      rowOffsets: windowedRowOffsets(6, (index) => (index % 2 ? 44 : 20)),
    };
    expect(windowedScrollTop(25, 30, variable)).toBe(25);
    expect(windowedScrollTop(25, 60, variable)).toBe(60);
    expect(windowedScrollTop(25, 64, variable)).toBe(64);
  });
});
