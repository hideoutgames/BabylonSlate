import type { EdgeInsets } from "./types";

export interface DevicePreset {
  id: "ipad-landscape" | "ipad-portrait" | "desktop-16-9";
  label: string;
  width: number;
  height: number;
  safeArea: EdgeInsets;
}

/** Logical CSS pixels matching Playwright iPad Pro 11 and a 16:9 desktop. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {
    id: "ipad-landscape",
    label: "iPad Landscape",
    width: 1194,
    height: 834,
    safeArea: { left: 0, right: 0, top: 24, bottom: 20 },
  },
  {
    id: "ipad-portrait",
    label: "iPad Portrait",
    width: 834,
    height: 1194,
    safeArea: { left: 0, right: 0, top: 24, bottom: 21 },
  },
  {
    id: "desktop-16-9",
    label: "Desktop 16:9",
    width: 1920,
    height: 1080,
    safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
  },
];

export function devicePresetById(
  id: DevicePreset["id"],
): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.id === id);
}
