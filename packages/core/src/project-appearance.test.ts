import { describe, expect, it } from "vitest";
import { normalizeProjectAppearance } from "./project-appearance";

describe("normalizeProjectAppearance", () => {
  it("keeps a portable raster badge while normalizing its catalog identifiers", () => {
    expect(
      normalizeProjectAppearance({
        icon: " rocket ",
        color: " lilac ",
        image: "data:image/webp;base64,AAAA",
        extra: true,
      }),
    ).toEqual({
      icon: "rocket",
      color: "lilac",
      image: "data:image/webp;base64,AAAA",
    });
  });

  it.each([
    { reason: "remote URL", image: "https://example.com/tracker.png" },
    { reason: "SVG", image: "data:image/svg+xml;base64,PHN2Zz4=" },
    { reason: "malformed base64", image: "data:image/png;base64,not base64" },
    { reason: "empty image", image: "data:image/png;base64," },
    {
      reason: "oversized image",
      image: `data:image/png;base64,${"A".repeat(131072)}`,
    },
  ])("discards $reason without losing the badge", ({ image }) => {
    expect(
      normalizeProjectAppearance({ icon: "box", color: "mint", image }),
    ).toEqual({ icon: "box", color: "mint" });
  });

  it.each([
    undefined,
    null,
    [],
    { icon: "box" },
    { icon: "", color: "mint" },
    { icon: "box", color: " " },
    { icon: 42, color: "mint" },
    { icon: "x".repeat(65), color: "mint" },
    { icon: "box", color: "x".repeat(65) },
  ])(
    "allows legacy and malformed metadata to fall back to the default badge",
    (value) => {
      expect(normalizeProjectAppearance(value)).toBeUndefined();
    },
  );
});
