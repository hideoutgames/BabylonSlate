import { describe, expect, it } from "vitest";
import { previewRect, roundRect } from "./preview-rect";
import { pinLayout, stretchLayout, ZERO_INSETS } from "./types";

const parent = { x: 0, y: 0, width: 800, height: 600 };

describe("previewRect", () => {
  it("pins a pixel size to the top-left with left/top offsets", () => {
    const rect = previewRect(
      parent,
      pinLayout("left", "top", 160, 40, 24, 16),
    );
    expect(roundRect(rect)).toEqual({
      x: 24,
      y: 16,
      width: 160,
      height: 40,
    });
  });

  it("centers a pixel size in the parent", () => {
    const rect = previewRect(parent, pinLayout("center", "center", 200, 100));
    expect(roundRect(rect)).toEqual({
      x: 300,
      y: 250,
      width: 200,
      height: 100,
    });
  });

  it("bottom-right pins from the far edges", () => {
    const rect = previewRect(parent, pinLayout("right", "bottom", 80, 32, 10, 20));
    expect(roundRect(rect)).toEqual({
      x: 800 - 80 + 10,
      y: 600 - 32 + 20,
      width: 80,
      height: 32,
    });
  });

  it("stretches with percent size and layout padding", () => {
    const rect = previewRect(
      parent,
      stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 }),
    );
    expect(roundRect(rect)).toEqual({
      x: 16,
      y: 8,
      width: 800 - 16 - 24,
      height: 600 - 8 - 12,
    });
  });

  it("treats percent width against the parent", () => {
    const rect = previewRect(parent, {
      ...pinLayout("left", "top", 50, 40),
      widthUnit: "percent",
    });
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(40);
  });

  it("uses transformCenter only as metadata, not the rect origin", () => {
    const layout = pinLayout("left", "top", 100, 40);
    layout.transformCenter = { x: 0, y: 0 };
    expect(previewRect(parent, layout)).toEqual(
      previewRect(parent, { ...layout, transformCenter: { x: 1, y: 1 } }),
    );
  });

  it("does not use Unity Y-up: top grows downward", () => {
    const a = previewRect(parent, pinLayout("left", "top", 10, 10, 0, 0));
    const b = previewRect(parent, pinLayout("left", "top", 10, 10, 0, 20));
    expect(b.y).toBe(a.y + 20);
  });

  it("accepts a zero-inset stretch as filling the parent", () => {
    expect(previewRect(parent, stretchLayout(ZERO_INSETS))).toEqual(parent);
  });
});
