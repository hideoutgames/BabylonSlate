import { describe, expect, it } from "vitest";
import { packedFontCssStacks } from "./fonts";

describe("packedFontCssStacks", () => {
  it("compiles Bitmap 2D Text CSS stacks from packed family names", () => {
    expect(
      packedFontCssStacks(new Map([["font-1", "Display Face"]])),
    ).toEqual({
      fontCssStack: "sans-serif",
      fontCssStackByGuid: new Map([["font-1", '"Display Face", sans-serif']]),
    });
  });
});
