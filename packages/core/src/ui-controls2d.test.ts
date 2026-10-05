import { describe, expect, it } from "vitest";
import { clampUIControl2DValue, normalizeUIControl2DText, parseUIControl2DProperties, uiControl2DFraction, uiControl2DValueAt, uiControl2DVisualAsset } from "./ui-controls2d";

describe("SceneLayer controls", () => {
  it("snaps to steps relative to the minimum without losing the final partial step", () => {
    const properties = parseUIControl2DProperties("2DSliderComponent", { min: 0.2, max: 1, step: 0.3 });
    expect(clampUIControl2DValue(0.63, properties)).toBe(0.5);
    expect(clampUIControl2DValue(0.7, properties)).toBe(0.8);
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

  it("retains every visual override and prefers a material over a texture", () => {
    const properties = parseUIControl2DProperties("2DSliderComponent", {
      trackMaterialGuid: " track-material ", trackTextureGuid: "track-texture", thumbTextureGuid: "thumb-texture",
      fillMaterialGuid: " ", opacity: 5, tint: [-1, 0.5, 2, 0.5], textColor: "#zzzzzz",
    });
    expect(uiControl2DVisualAsset(properties, "track")).toEqual({ kind: "material", guid: "track-material" });
    expect(uiControl2DVisualAsset(properties, "thumb")).toEqual({ kind: "texture", guid: "thumb-texture" });
    expect(uiControl2DVisualAsset(properties, "fill")).toBeNull();
    expect(properties).toMatchObject({ opacity: 1, tint: [0, 0.5, 2, 0.5], textColor: "#ffffff" });
  });
});
