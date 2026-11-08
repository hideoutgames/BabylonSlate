import { describe, expect, it } from "vitest";
import { packedFontCssStacks } from "./fonts";

describe("packedFontCssStacks", () => {
  it("compiles Bitmap 2D Text CSS stacks from packed family names, ending in the Global Fallback", () => {
    expect(
      packedFontCssStacks(new Map([["font-1", "Display Face"]]), "serif"),
    ).toEqual({
      fontCssStack: "serif",
      fontCssStackByGuid: new Map([["font-1", '"Display Face", serif']]),
      fontPixelSize: 0,
      fontPixelSizeByGuid: new Map(),
    });
  });

  it("carries the packed pixel Fonts' Pixel Sizes, the default Font's included", () => {
    const fonts = packedFontCssStacks(
      new Map([["ark", "Ark Pixel"], ["body", "Body"]]),
      "sans-serif",
      "ark",
      undefined,
      new Map([["ark", 12]]),
    );
    expect(fonts.fontPixelSize).toBe(12);
    expect(fonts.fontPixelSizeByGuid).toEqual(new Map([["ark", 12]]));
  });
});
