import { describe, expect, it } from "vitest";
import {
  compileFontStack,
  compileText2DFontStacks,
  glyphsFallingToFallback,
  quoteCssFamily,
} from "./font-stack";

describe("compileFontStack", () => {
  it("quotes families and terminates in a generic", () => {
    expect(
      compileFontStack({
        family: "Display Face",
        fallbackFamilies: ["Fallback One", "sans-serif"],
        projectDefaultFamily: "Project Default",
        globalFallback: "sans-serif",
      }),
    ).toBe(
      '"Display Face", "Fallback One", "Project Default", sans-serif',
    );
  });

  it("dedupes and always ends with a generic family", () => {
    expect(
      compileFontStack({
        family: "Only",
        fallbackFamilies: ["Only"],
        projectDefaultFamily: "Only",
      }),
    ).toBe('"Only", sans-serif');
  });

  it("quotes generic-looking custom names but not real generics", () => {
    expect(quoteCssFamily("sans-serif")).toBe("sans-serif");
    expect(quoteCssFamily("Comic Sans")).toBe('"Comic Sans"');
  });
});

describe("compileText2DFontStacks", () => {
  it("compiles a project default stack and per-Font stacks with fallbacks", () => {
    const { defaultStack, byGuid } = compileText2DFontStacks({
      fonts: [
        { guid: "display", family: "Display", fallbackGuids: ["body"] },
        { guid: "body", family: "Body" },
        { guid: "def", family: "Project Face" },
      ],
      defaultFontGuid: "def",
      globalFallback: "sans-serif",
    });
    expect(defaultStack).toBe('"Project Face", sans-serif');
    expect(byGuid.get("display")).toBe(
      '"Display", "Body", "Project Face", sans-serif',
    );
    expect(byGuid.get("body")).toBe('"Body", "Project Face", sans-serif');
  });

  it("uses the generic terminator when no Font or project default exists", () => {
    const { defaultStack, byGuid } = compileText2DFontStacks({ fonts: [] });
    expect(defaultStack).toBe("sans-serif");
    expect(byGuid.size).toBe(0);
  });
});

describe("glyphsFallingToFallback", () => {
  it("flags characters whose advance matches the generic-only stack", () => {
    const measure = (text: string, fontStack: string) => {
      if (fontStack.includes("Missing") && /[A-Z]/.test(text)) return 10;
      return 7;
    };
    expect(
      glyphsFallingToFallback("A字", "Missing", measure),
    ).toEqual(["字"]);
  });
});
