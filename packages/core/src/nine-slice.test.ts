import { describe, expect, it } from "vitest";
import { overlayNineSliceCells } from "./nine-slice";

describe("overlayNineSliceCells", () => {
  it("keeps corners at pixel/ppu size and stretches the center on a 1x1 dest", () => {
    const cells = overlayNineSliceCells({
      destWidth: 1,
      destHeight: 1,
      srcWidthPx: 100,
      srcHeightPx: 100,
      marginLeft: 10,
      marginRight: 10,
      marginTop: 10,
      marginBottom: 10,
      pixelsPerUnit: 100,
    });
    expect(cells).toHaveLength(9);
    const center = cells[4]!;
    expect(center.width).toBeCloseTo(0.8);
    expect(center.height).toBeCloseTo(0.8);
    expect(center.u0).toBeCloseTo(0.1);
    expect(center.v0).toBeCloseTo(0.1);
    expect(center.u1).toBeCloseTo(0.9);
    expect(center.v1).toBeCloseTo(0.9);
    const topLeft = cells[6]!;
    expect(topLeft.width).toBeCloseTo(0.1);
    expect(topLeft.height).toBeCloseTo(0.1);
    expect(topLeft.u0).toBe(0);
    expect(topLeft.u1).toBeCloseTo(0.1);
  });

  it("clamps margins when they exceed the destination size", () => {
    const cells = overlayNineSliceCells({
      destWidth: 0.1,
      destHeight: 0.1,
      srcWidthPx: 100,
      srcHeightPx: 100,
      marginLeft: 40,
      marginRight: 40,
      marginTop: 40,
      marginBottom: 40,
      pixelsPerUnit: 100,
    });
    const widths = cells.map((cell) => cell.width);
    expect(widths.reduce((sum, width) => sum + width, 0) / 3).toBeCloseTo(0.1);
  });
});
