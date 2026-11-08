import { describe, expect, it } from "vitest";
import {
  createFontPayload,
  MAX_FONT_PIXEL_SIZE,
  mergeFontAttachPayload,
  normalizeFontPayload,
  normalizeFontPixelSize,
} from "./font-payload";

describe("font payload", () => {
  it("fills family and representation flags", () => {
    const payload = createFontPayload("Display Face", {
      representations: { source: true, facetype: false, msdf: false },
      fallbackGuids: ["guid-b"],
    });
    expect(payload.family).toBe("Display Face");
    expect(payload.representations.source).toBe(true);
    expect(payload.representations.msdfJson).toBe(false);
    expect(payload.representations.msdfPng).toBe(false);
    expect(payload.representations.msdf).toBe(false);
    expect(normalizeFontPayload({}, "Fallback").family).toBe("Fallback");
  });

  it("treats MSDF as usable only when JSON and PNG flags are both true", () => {
    expect(
      createFontPayload("Ui", {
        representations: { msdfJson: true, msdfPng: false },
      }).representations,
    ).toMatchObject({ msdfJson: true, msdfPng: false, msdf: false });
    expect(
      createFontPayload("Ui", {
        representations: { msdfJson: true, msdfPng: true },
      }).representations.msdf,
    ).toBe(true);
  });

  it("ORs representation flags when attaching an MSDF chunk to a source Font", () => {
    const merged = mergeFontAttachPayload(
      createFontPayload("Ui", {
        representations: { source: true, facetype: false, msdf: false },
      }),
      createFontPayload("Ui", {
        representations: { source: false, msdfJson: true },
      }),
      "Ui",
    );
    expect(merged.representations).toMatchObject({
      source: true,
      msdfJson: true,
      msdfPng: false,
      msdf: false,
    });
  });

  it("keeps Pixel Size a whole number of pixels, 0 for an ordinary font", () => {
    expect(createFontPayload("Ui").pixelSize).toBe(0);
    expect(normalizeFontPayload({ pixelSize: 12 }, "Ark").pixelSize).toBe(12);
    expect(normalizeFontPixelSize(9.6)).toBe(10);
    expect(normalizeFontPixelSize(0.4)).toBe(0);
    expect(normalizeFontPixelSize(-3)).toBe(0);
    expect(normalizeFontPixelSize("12")).toBe(0);
    expect(normalizeFontPixelSize(1000)).toBe(MAX_FONT_PIXEL_SIZE);
  });

  it("keeps the open Font's Pixel Size when attaching a representation", () => {
    const merged = mergeFontAttachPayload(
      createFontPayload("Ark", { pixelSize: 10 }),
      createFontPayload("Ark", { representations: { msdfJson: true } }),
      "Ark",
    );
    expect(merged.pixelSize).toBe(10);
  });
});
