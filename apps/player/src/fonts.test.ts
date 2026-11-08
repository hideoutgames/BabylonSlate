import { describe, expect, it } from "vitest";
import { packedFontCssStacks } from "./fonts";

describe("packedFontCssStacks", () => {
  it("compiles Bitmap 2D Text CSS stacks from packed family names, ending in the Global Fallback", () => {
    expect(
      packedFontCssStacks(new Map([["font-1", "Display Face"]]), "serif"),
    ).toEqual({
      fontCssStack: "serif",
      fontCssStackByGuid: new Map([["font-1", '"Display Face", serif']]),
    });
  });
});
