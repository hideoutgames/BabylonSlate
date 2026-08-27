import { describe, expect, it } from "vitest";
import {
  overlayNineSliceCells,
  overlayNineSliceSourceFractions,
  overlayPanelMarginToPx,
} from "./nine-slice";

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

  it("keeps source UV splits independent of dest scale", () => {
    const cells = overlayNineSliceCells({
      destWidth: 4,
      destHeight: 2,
      srcWidthPx: 100,
      srcHeightPx: 100,
      marginLeft: 10,
      marginRight: 10,
      marginTop: 10,
      marginBottom: 10,
      pixelsPerUnit: 100,
    });
    const center = cells[4]!;
    expect(center.u0).toBeCloseTo(0.1);
    expect(center.u1).toBeCloseTo(0.9);
    expect(center.v0).toBeCloseTo(0.1);
    expect(center.v1).toBeCloseTo(0.9);
    expect(center.width).toBeCloseTo(3.8);
    expect(center.height).toBeCloseTo(1.8);
  });

  it("treats 0-1 margins as source fractions and values above 1 as legacy pixels", () => {
    expect(overlayPanelMarginToPx(0.1, 100)).toBe(10);
    expect(overlayPanelMarginToPx(0.5, 50)).toBe(25);
    expect(overlayPanelMarginToPx(10, 100)).toBe(10);
    expect(overlayPanelMarginToPx(0, 100)).toBe(0);
  });

  it("keeps 0.1 source-fraction corners equal to 10px on a 100px source", () => {
    const cells = overlayNineSliceCells({
      destWidth: 1,
      destHeight: 1,
      srcWidthPx: 100,
      srcHeightPx: 100,
      marginLeft: 0.1,
      marginRight: 0.1,
      marginTop: 0.1,
      marginBottom: 0.1,
      pixelsPerUnit: 100,
    });
    const center = cells[4]!;
    expect(center.width).toBeCloseTo(0.8);
    expect(center.u0).toBeCloseTo(0.1);
    expect(center.u1).toBeCloseTo(0.9);
  });

  it("maps pixel margins onto source UV fractions for the Details overlay", () => {
    expect(
      overlayNineSliceSourceFractions({
        srcWidthPx: 100,
        srcHeightPx: 50,
        marginLeft: 10,
        marginRight: 20,
        marginTop: 5,
        marginBottom: 15,
      }),
    ).toEqual({
      left: 0.1,
      right: 0.8,
      top: 0.1,
      bottom: 0.7,
    });
  });

  it("scales source fractions when opposite margins exceed the image", () => {
    const splits = overlayNineSliceSourceFractions({
      srcWidthPx: 100,
      srcHeightPx: 100,
      marginLeft: 80,
      marginRight: 80,
      marginTop: 80,
      marginBottom: 80,
    });
    expect(splits.left).toBeCloseTo(0.5);
    expect(splits.right).toBeCloseTo(0.5);
    expect(splits.top).toBeCloseTo(0.5);
    expect(splits.bottom).toBeCloseTo(0.5);
  });

  it("maps 0-1 authored margins onto source UV fractions", () => {
    expect(
      overlayNineSliceSourceFractions({
        srcWidthPx: 100,
        srcHeightPx: 50,
        marginLeft: 0.1,
        marginRight: 0.2,
        marginTop: 0.1,
        marginBottom: 0.3,
      }),
    ).toEqual({
      left: 0.1,
      right: 0.8,
      top: 0.1,
      bottom: 0.7,
    });
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
