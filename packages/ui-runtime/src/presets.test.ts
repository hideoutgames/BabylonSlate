import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_PRESET_ID,
  DESIRED_CANVAS_ID,
  DEVICE_PRESETS,
  designerViewport,
  devicePresetById,
  devicePresetForViewport,
  mergeDevicePresets,
} from "./presets";

const ZERO = { left: 0, right: 0, top: 0, bottom: 0 };

describe("device presets", () => {
  it("exposes 4:3, 16:9, and widescreen canvases with zero safe area", () => {
    expect(DEVICE_PRESETS.map((preset) => preset.id)).toEqual([
      "desktop-4-3",
      "desktop-16-9",
      "desktop-21-9",
    ]);
    expect(DEFAULT_DEVICE_PRESET_ID).toBe("desktop-16-9");
    expect(devicePresetById("desktop-4-3")).toMatchObject({
      label: "4:3",
      width: 1600,
      height: 1200,
      safeArea: ZERO,
    });
    expect(devicePresetById("desktop-16-9")).toMatchObject({
      label: "16:9",
      width: 1920,
      height: 1080,
      safeArea: ZERO,
    });
    expect(devicePresetById("desktop-21-9")).toMatchObject({
      label: "Widescreen",
      width: 2560,
      height: 1080,
      safeArea: ZERO,
    });
  });

  it("matches exact sizes and nearest aspect when the viewport is not a built-in", () => {
    expect(devicePresetForViewport(1600, 1200).id).toBe("desktop-4-3");
    expect(devicePresetForViewport(1920, 1080).id).toBe("desktop-16-9");
    expect(devicePresetForViewport(2560, 1080).id).toBe("desktop-21-9");
    expect(devicePresetForViewport(1280, 720).id).toBe("desktop-16-9");
    expect(devicePresetForViewport(1194, 834).id).toBe("desktop-4-3");
    expect(devicePresetForViewport(834, 1194).id).toBe("desktop-4-3");
    expect(devicePresetForViewport(1280, 720).safeArea.top).toBe(0);
  });

  it("uses content size with zero safe area for reusable-element design", () => {
    const viewport = designerViewport(DESIRED_CANVAS_ID, {
      width: 240,
      height: 64,
    });
    expect(viewport).toMatchObject({
      id: "desired",
      width: 240,
      height: 64,
      safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
    });
    expect(designerViewport("desktop-16-9", { width: 240, height: 64 }).id).toBe(
      "desktop-16-9",
    );
    expect(designerViewport("gone", { width: 240, height: 64 }).id).toBe(
      DEFAULT_DEVICE_PRESET_ID,
    );
  });

  it("merges custom presets after builtins and skips reserved ids", () => {
    const phone = {
      id: "custom-phone",
      label: "Phone",
      width: 390,
      height: 844,
      safeArea: { left: 0, right: 0, top: 47, bottom: 34 },
    };
    const merged = mergeDevicePresets([
      phone,
      { ...phone, id: "desktop-16-9", label: "Hijack" },
      { ...phone, id: "desired", label: "Desired Clone" },
    ]);
    expect(merged.map((preset) => preset.id)).toEqual([
      "desktop-4-3",
      "desktop-16-9",
      "desktop-21-9",
      "custom-phone",
    ]);
    expect(merged.find((preset) => preset.id === "custom-phone")).toEqual(phone);
  });

  it("looks up and matches custom presets when extras are provided", () => {
    const phone = {
      id: "custom-phone",
      label: "Phone",
      width: 390,
      height: 844,
      safeArea: { left: 0, right: 0, top: 47, bottom: 34 },
    };
    expect(devicePresetById("custom-phone", [phone])?.label).toBe("Phone");
    expect(devicePresetForViewport(390, 844, [phone]).id).toBe("custom-phone");
    expect(devicePresetForViewport(390, 844, [phone]).safeArea.top).toBe(47);
    expect(
      designerViewport("custom-phone", { width: 240, height: 64 }, [phone]),
    ).toMatchObject({
      id: "custom-phone",
      width: 390,
      height: 844,
      safeArea: { top: 47, bottom: 34 },
    });
  });
});
