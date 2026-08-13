import { describe, expect, it } from "vitest";
import { familyFromAssetPayload, fontEditorStack } from "./font-preview";

describe("fontEditorStack", () => {
  it("includes fallbacks, the project default, and the generic terminator", () => {
    expect(
      fontEditorStack({
        family: "Display",
        fallbackGuids: ["fb-1"],
        defaultFontGuid: "def-1",
        globalFallback: "sans-serif",
        familyForGuid: (guid) =>
          guid === "fb-1" ? "Fallback One" : guid === "def-1" ? "Project Face" : null,
      }),
    ).toBe('"Display", "Fallback One", "Project Face", sans-serif');
  });

  it("reads a family from a font payload", () => {
    expect(familyFromAssetPayload({ family: "Ui" })).toBe("Ui");
    expect(familyFromAssetPayload({})).toBeNull();
  });
});
