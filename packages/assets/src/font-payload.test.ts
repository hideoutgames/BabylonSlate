import { describe, expect, it } from "vitest";
import { createFontPayload, normalizeFontPayload } from "./font-payload";

describe("font payload", () => {
  it("fills family and representation flags", () => {
    const payload = createFontPayload("Display Face", {
      representations: { source: true, facetype: false, msdf: false },
      fallbackGuids: ["guid-b"],
    });
    expect(payload.family).toBe("Display Face");
    expect(payload.representations.source).toBe(true);
    expect(normalizeFontPayload({}, "Fallback").family).toBe("Fallback");
  });
});
