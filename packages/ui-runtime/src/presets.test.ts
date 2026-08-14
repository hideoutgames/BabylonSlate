import { describe, expect, it } from "vitest";
import {
  DESIRED_CANVAS_ID,
  DEVICE_PRESETS,
  designerViewport,
  devicePresetById,
  devicePresetForViewport,
  mergeDevicePresets,
} from "./presets";

describe("device presets", () => {
  it("exposes iPad landscape, iPad portrait, and desktop 16:9", () => {
    expect(DEVICE_PRESETS.map((preset) => preset.id)).toEqual([
      "ipad-landscape",
      "ipad-portrait",
      "desktop-16-9",
    ]);
    expect(devicePresetById("ipad-landscape")?.width).toBeGreaterThan(
      devicePresetById("ipad-portrait")?.width ?? 0,
    );
    expect(devicePresetById("desktop-16-9")).toMatchObject({
      width: 1920,
      height: 1080,
    });
    expect(devicePresetById("ipad-landscape")?.safeArea.top).toBeGreaterThan(0);
  });

  it("matches Playwright iPad Pro 11 sizes exactly and picks desktop by aspect", () => {
    expect(devicePresetForViewport(1194, 834).id).toBe("ipad-landscape");
    expect(devicePresetForViewport(834, 1194).id).toBe("ipad-portrait");
    expect(devicePresetForViewport(1280, 720).id).toBe("desktop-16-9");
    expect(devicePresetForViewport(1194, 834).safeArea.top).toBeGreaterThan(0);
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
    expect(designerViewport("ipad-landscape", { width: 240, height: 64 }).id).toBe(
      "ipad-landscape",
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
      { ...phone, id: "ipad-landscape", label: "Hijack" },
      { ...phone, id: "desired", label: "Desired Clone" },
    ]);
    expect(merged.map((preset) => preset.id)).toEqual([
      "ipad-landscape",
      "ipad-portrait",
      "desktop-16-9",
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
