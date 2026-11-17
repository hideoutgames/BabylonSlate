import { describe, expect, it } from "vitest";
import { clampUIControl2DValue, normalizeUIControl2DText, parseUIControl2DProperties, uiControl2DDisplayText, uiControl2DFraction, uiControl2DValueAt } from "./ui-controls2d";

describe("SceneLayer controls", () => {
  it("snaps to steps relative to the minimum without losing the final partial step", () => {
    const properties = parseUIControl2DProperties("2DSliderComponent", { min: 0.2, max: 1, step: 0.3 });
    expect(clampUIControl2DValue(0.63, properties)).toBe(0.5);
    expect(clampUIControl2DValue(0.7, properties)).toBe(0.8);
    // Nearer the maximum than the last whole step.
    expect(clampUIControl2DValue(0.92, properties)).toBe(1);
    expect(clampUIControl2DValue(5, properties)).toBe(1);
    expect(clampUIControl2DValue(-3, properties)).toBe(0.2);
    expect(clampUIControl2DValue(NaN, properties)).toBe(0.2);
  });

  it("repairs invalid dimensions and range state before pointer interaction", () => {
    const properties = parseUIControl2DProperties("2DRangeSliderComponent", {
      width: 0, height: -1, min: 10, max: -10, lowerValue: 20, upperValue: -30, step: Infinity,
    });
    expect(properties).toMatchObject({ min: -10, max: 10, lowerValue: -10, upperValue: 10 });
    expect(uiControl2DValueAt(-properties.width, 0, properties)).toBe(-10);
    expect(uiControl2DValueAt(properties.width, 0, properties)).toBe(10);
    expect(uiControl2DValueAt(0, 0, properties)).toBe(0);
    const vertical = { ...properties, orientation: "vertical" as const };
    expect(uiControl2DValueAt(100, -vertical.height / 2, vertical)).toBe(-10);
    expect(uiControl2DValueAt(-100, vertical.height / 2, vertical)).toBe(10);
  });

  it("keeps a collapsed or extreme range finite", () => {
    const collapsed = parseUIControl2DProperties("2DProgressBarComponent", { min: 7, max: 7, value: 99 });
    expect(collapsed.value).toBe(7);
    expect(uiControl2DFraction(7, collapsed)).toBe(0);
    const extreme = parseUIControl2DProperties("2DSliderComponent", { min: -Number.MAX_VALUE, max: Number.MAX_VALUE });
    expect(uiControl2DFraction(0, extreme)).toBe(0.5);
    expect(uiControl2DValueAt(0, 0, extreme)).toBe(0);
    expect(parseUIControl2DProperties("2DProgressBarComponent", { value: 0.12345 }).value).toBe(0.12345);
  });

  it("normalizes single-line input without splitting surrogate pairs and bounds selection", () => {
    expect(normalizeUIControl2DText("A🙂B\nC", { maxLength: 2 })).toBe("A🙂");
    expect(normalizeUIControl2DText("First\r\nSecond", { maxLength: 0 })).toBe("First Second");
    expect(parseUIControl2DProperties("2DDropdownComponent", { options: ["Easy", 4, "Hard"], selectedIndex: 10 })).toMatchObject({ options: ["Easy", "Hard"], selectedIndex: 1 });
    expect(parseUIControl2DProperties("2DDropdownComponent", { options: [], selectedIndex: 0 }).selectedIndex).toBe(-1);
  });

  it("retains every visual override", () => {
    const properties = parseUIControl2DProperties("2DSliderComponent", {
      trackMaterialGuid: " track-material ", trackTextureGuid: "track-texture", thumbTextureGuid: "thumb-texture",
      fillMaterialGuid: " ", opacity: 5, tint: [-1, 0.5, 2, 0.5], textColor: "#zzzzzz",
    });
    expect(properties).toMatchObject({
      trackMaterialGuid: "track-material", trackTextureGuid: "track-texture", thumbTextureGuid: "thumb-texture",
      fillMaterialGuid: null, fillTextureGuid: null, opacity: 1, tint: [0, 0.5, 2, 0.5], textColor: "#ffffff",
    });
  });

  it.each([
    { inputType: "text", typed: " a1-b.2, +(3) ", kept: " a1-b.2, +(3) " },
    // One sign, only in front; one decimal point, and a comma counts as it.
    { inputType: "number", typed: "-1a2,5.7-", kept: "-12.57" },
    { inputType: "number", typed: "1-2", kept: "12" },
    { inputType: "integer", typed: "-1a2,5.7-", kept: "-1257" },
    { inputType: "email", typed: " a b@c .d\te ", kept: "ab@c.de" },
    { inputType: "url", typed: "https://a b.c /d", kept: "https://ab.c/d" },
    { inputType: "phone", typed: "+47 (0) 12-34 ext.5", kept: "+47 (0) 12-34 5" },
    { inputType: "password", typed: " p@ss w0rd ", kept: " p@ss w0rd " },
  ] as const)("keeps the characters of an $inputType input", ({ inputType, typed, kept }) => {
    expect(normalizeUIControl2DText(typed, { maxLength: 0, inputType })).toBe(kept);
  });

  it("applies Max Length after the Input Type's filter and reads the type from the properties", () => {
    // Five characters are typed but only the three digits count toward the limit of two.
    expect(normalizeUIControl2DText("a1b2c3", { maxLength: 2, inputType: "integer" })).toBe("12");
    expect(parseUIControl2DProperties("2DTextInputComponent", { text: "a1b2", inputType: "integer" })).toMatchObject({ text: "12", inputType: "integer" });
    for (const unknown of ["Number", "", 3, undefined]) {
      expect(parseUIControl2DProperties("2DTextInputComponent", { text: "a1", inputType: unknown })).toMatchObject({ text: "a1", inputType: "text" });
    }
  });

  it("shows a Password as one bullet per character and every other type as typed", () => {
    expect(uiControl2DDisplayText("a b\u{1F642}", "password")).toBe("\u2022\u2022\u2022\u2022");
    expect(uiControl2DDisplayText("", "password")).toBe("");
    expect(uiControl2DDisplayText("12.5", "number")).toBe("12.5");
  });
});
