import { describe, expect, it } from "vitest";
import { DEVICE_PRESETS, devicePresetById } from "./presets";

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
});
