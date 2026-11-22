import { describe, expect, it } from "vitest";
import { normalizeProjectAppearance, projectCoverDataUrl, projectCoverFromDataUrl, storedProjectAppearance } from "./project-appearance";

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

describe("project cover pictures", () => {
  it("stores a picture as cover file bytes and loads it back, never storing the data URL", () => {
    const cover = projectCoverFromDataUrl("data:image/jpeg;base64,/9j/");
    expect(cover?.file).toBe("cover.jpg");
    expect(Array.from(cover!.bytes)).toEqual([0xff, 0xd8, 0xff]);
    expect(projectCoverDataUrl("cover.jpg", cover!.bytes)).toBe("data:image/jpeg;base64,/9j/");
    expect(projectCoverFromDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(storedProjectAppearance({ icon: "box", color: "mint", coverFile: "cover.jpg", image: "data:image/jpeg;base64,/9j/" }))
      .toEqual({ icon: "box", color: "mint", coverFile: "cover.jpg" });
    expect(normalizeProjectAppearance({ icon: "box", color: "mint", coverFile: "cover.gif" })).toEqual({ icon: "box", color: "mint" });
  });
});
