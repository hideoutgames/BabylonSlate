import { describe, expect, it } from "vitest";
import {
  ASSET_COLOR_TOKENS,
  ASSET_COLOR_VAR,
  PIN_COLOR_TOKENS,
  PIN_COLOR_VAR,
  assetColorVar,
  pinColorVar,
  typeColorThumbAccent,
} from "./data-types";

describe("data-types", () => {
  it("maps Unreal-style pin kinds to CSS variables", () => {
    expect(pinColorVar("bool")).toBe("var(--pin-bool)");
    expect(pinColorVar("int")).toBe("var(--pin-int)");
    expect(pinColorVar("float")).toBe("var(--pin-float)");
    expect(pinColorVar("string")).toBe("var(--pin-string)");
    expect(pinColorVar("vec3")).toBe("var(--pin-vector)");
    expect(pinColorVar("objectRef")).toBe("var(--pin-object)");
    expect(pinColorVar("unknown-kind")).toBe("var(--pin-wildcard)");
  });

  it("maps asset families including folder", () => {
    expect(assetColorVar("texture")).toBe("var(--asset-texture)");
    expect(assetColorVar("class")).toBe("var(--asset-class)");
    expect(assetColorVar("folder")).toBe("var(--asset-folder)");
    expect(assetColorVar("not-a-family")).toBe("var(--muted-foreground)");
  });

  it("exposes the full pin and asset token lists", () => {
    expect(PIN_COLOR_TOKENS).toContain("--pin-bool");
    expect(ASSET_COLOR_TOKENS).toContain("--asset-folder");
    expect(PIN_COLOR_VAR.bool).toBe("var(--pin-bool)");
    expect(ASSET_COLOR_VAR.folder).toBe("var(--asset-folder)");
  });

  it("builds a thumb-only type wash with an inset kind bar", () => {
    const colorVar = "var(--asset-texture)";
    expect(typeColorThumbAccent(colorVar)).toEqual({
      backgroundColor:
        "color-mix(in oklch, var(--asset-texture) 55%, var(--muted))",
      boxShadow: "inset 0 -3px 0 var(--asset-texture)",
    });
  });
});
