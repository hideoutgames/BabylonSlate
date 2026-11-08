import { describe, expect, it } from "vitest";
import { pixelFontLineRgba, pixelPreviewGlyphScale, pixelPreviewTexelSize } from "./pixel-font-preview";

describe("pixel font preview", () => {
  it("gives every font pixel a whole block of device pixels", () => {
    expect(pixelPreviewTexelSize(2, 1)).toBe(2);
    expect(pixelPreviewTexelSize(2, 2)).toBe(4);
    // A fractional ratio rounds to the nearest whole block rather than smearing pixels.
    expect(pixelPreviewTexelSize(1, 1.5)).toBe(2);
    expect(pixelPreviewTexelSize(3, 1.25)).toBe(4);
    expect(pixelPreviewTexelSize(0, 0)).toBe(1);
  });

  it("fits the glyph sheet's cells", () => {
    expect(pixelPreviewGlyphScale(12)).toBe(2);
    expect(pixelPreviewGlyphScale(10)).toBe(2);
    expect(pixelPreviewGlyphScale(8)).toBe(3);
    expect(pixelPreviewGlyphScale(32)).toBe(1);
  });

  it("expands each drawn font pixel into an opaque white block", () => {
    const { width, height, rgba } = pixelFontLineRgba({ width: 2, height: 1, baseline: 1, alpha: new Uint8Array([255, 0]) }, 2);
    expect({ width, height }).toEqual({ width: 4, height: 2 });
    const alphaAt = (x: number, y: number) => rgba[(y * width + x) * 4 + 3];
    expect([alphaAt(0, 0), alphaAt(1, 0), alphaAt(0, 1), alphaAt(1, 1)]).toEqual([255, 255, 255, 255]);
    expect([alphaAt(2, 0), alphaAt(3, 1)]).toEqual([0, 0]);
    expect([...rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
  });
});
