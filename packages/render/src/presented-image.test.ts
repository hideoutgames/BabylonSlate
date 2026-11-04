import { describe, expect, it } from "vitest";
import { summarizePresentedPixels } from "./presented-image";

/** RGBA bytes of `pixels`, each `[r, g, b, a]`. */
const rgba = (pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

describe("summarizePresentedPixels", () => {
  it("counts a pixel as near-black up to a level of 12 in its brightest channel, and a transparent pixel as black", () => {
    const summary = summarizePresentedPixels(rgba([
      [12, 0, 5, 255], // black: brightest channel at the level
      [0, 13, 0, 255], // not black: one channel past it
      [200, 200, 200, 0], // black: transparent shows nothing of the frame
      [255, 128, 0, 102], // not black: 255 × 0.4 = 102
    ]), 2, 2);
    expect(summary).toEqual({ blackShare: 0.5, meanLevel: (12 + 13 + 0 + 102) / 4, width: 2, height: 2 });
  });

  it("calls an image with no pixels all black", () => {
    expect(summarizePresentedPixels(new Uint8ClampedArray(0), 0, 0).blackShare).toBe(1);
  });
});
