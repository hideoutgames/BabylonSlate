import { describe, expect, it } from "vitest";
import { FEATURE_TEST_SPRITE_SHEET, featureTestSpriteSheetPixels } from "./imports";

describe("Feature Test sprite sheet", () => {
  it("computes a 4 × 4 sheet whose cells differ in colour and in disc size, on transparent corners", () => {
    const { columns, rows, cell } = FEATURE_TEST_SPRITE_SHEET;
    const sheet = featureTestSpriteSheetPixels();
    expect([sheet.width, sheet.height]).toEqual([columns * cell, rows * cell]);
    const pixel = (x: number, y: number) => Array.from(sheet.rgba.slice((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4));
    const centres = new Set<string>();
    const coverage: number[] = [];
    for (let index = 0; index < columns * rows; index += 1) {
      const left = (index % columns) * cell;
      const top = Math.floor(index / columns) * cell;
      const centre = pixel(left + cell / 2, top + cell / 2);
      expect(centre[3]).toBe(255);
      expect(pixel(left, top)[3]).toBe(0);
      centres.add(centre.join(","));
      let opaque = 0;
      for (let y = top; y < top + cell; y += 1) for (let x = left; x < left + cell; x += 1) if (pixel(x, y)[3] === 255) opaque += 1;
      coverage.push(opaque);
    }
    expect(centres.size).toBe(columns * rows);
    // The disc grows across each row of four cells.
    expect(coverage[1]).toBeGreaterThan(coverage[0]!);
    expect(coverage[3]).toBeGreaterThan(coverage[2]!);
    // Computed, so the same every time.
    expect(featureTestSpriteSheetPixels().rgba).toEqual(sheet.rgba);
  });
});
