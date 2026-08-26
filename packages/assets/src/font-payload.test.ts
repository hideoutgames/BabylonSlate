import { describe, expect, it } from "vitest";
import {
  createFontPayload,
  mergeFontAttachPayload,
  normalizeFontPayload,
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

  it("maps a legacy msdf:true flag to JSON-only until the PNG flag is set", () => {
    const normalized = normalizeFontPayload(
      { representations: { source: true, msdf: true } },
      "Ui",
    );
    expect(normalized.representations).toMatchObject({
      source: true,
      msdfJson: true,
      msdfPng: false,
      msdf: false,
    });
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
});
