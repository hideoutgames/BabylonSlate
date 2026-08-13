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

/**
 * Closest device preset for a live viewport. Exact CSS-pixel matches first
 * (Playwright iPad Pro 11 is 1194×834 / 834×1194), then aspect + size.
 */
export function devicePresetForViewport(
  width: number,
  height: number,
): DevicePreset {
  const exact = DEVICE_PRESETS.find(
    (preset) => preset.width === width && preset.height === height,
  );
  if (exact) return exact;
  const aspect = height > 0 ? width / height : 1;
  let best = DEVICE_PRESETS[0]!;
  let bestAspect = Number.POSITIVE_INFINITY;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const preset of DEVICE_PRESETS) {
    const presetAspect = preset.height > 0 ? preset.width / preset.height : 1;
    const aspectDelta = Math.abs(presetAspect - aspect);
    const sizeDelta = Math.hypot(preset.width - width, preset.height - height);
    if (
      aspectDelta < bestAspect - 1e-6 ||
      (Math.abs(aspectDelta - bestAspect) < 1e-6 && sizeDelta < bestSize)
    ) {
      best = preset;
      bestAspect = aspectDelta;
      bestSize = sizeDelta;
    }
  }
  return best;
}
