import { describe, expect, it } from "vitest";
import { findHardcodedRadii, findRadiusDeclarations } from "./style-audit";

describe("findRadiusDeclarations", () => {
  it("finds shorthand and per-corner radius declarations", () => {
    const css = `
      .a { border-radius: var(--radius-sm); }
      .b { border-top-left-radius: 4px; }
    `;
    expect(findRadiusDeclarations(css)).toEqual([
      "var(--radius-sm)",
      "4px",
    ]);
  });

  it("finds nothing in CSS with no radii", () => {
    expect(findRadiusDeclarations(".a { color: red; }")).toEqual([]);
  });
});

describe("findHardcodedRadii", () => {
  it("accepts every token on the radius scale", () => {
    const css = `
      .a { border-radius: var(--radius-sm); }
      .b { border-radius: var(--radius-md); }
      .c { border-radius: var(--radius-2xl); }
    `;
    expect(findHardcodedRadii(css)).toEqual([]);
  });

  it("accepts 0, circles and pills as deliberate shapes", () => {
    const css = `
      .a { border-radius: 0; }
      .b { border-radius: 50%; }
      .c { border-radius: 9999px; }
      .d { border-radius: inherit; }
    `;
    expect(findHardcodedRadii(css)).toEqual([]);
  });

  it("reports hardcoded pixel and rem radii", () => {
    const css = `
      .a { border-radius: 6px; }
      .b { border-radius: 0.5rem; }
    `;
    expect(findHardcodedRadii(css)).toEqual(["6px", "0.5rem"]);
  });

  it("reports a hardcoded value on a single corner", () => {
    expect(findHardcodedRadii(".a { border-bottom-right-radius: 3px; }")).toEqual(
      ["3px"],
    );
  });

  it("is case insensitive", () => {
    expect(findHardcodedRadii(".a { BORDER-RADIUS: 7PX; }")).toEqual(["7PX"]);
  });
});
