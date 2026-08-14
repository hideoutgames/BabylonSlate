import type { EdgeInsets } from "./types";
import { ZERO_INSETS } from "./types";

export interface DevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  safeArea: EdgeInsets;
}

/** Logical CSS pixels for common game HUD frames. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {
    id: "desktop-4-3",
    label: "4:3",
    width: 1600,
    height: 1200,
    safeArea: { ...ZERO_INSETS },
  },
  {
    id: "desktop-16-9",
    label: "16:9",
    width: 1920,
    height: 1080,
    safeArea: { ...ZERO_INSETS },
  },
  {
    id: "desktop-21-9",
    label: "Widescreen",
    width: 2560,
    height: 1080,
    safeArea: { ...ZERO_INSETS },
  },
];

export const DEFAULT_DEVICE_PRESET_ID = "desktop-16-9" as const;

export const DESIRED_CANVAS_ID = "desired" as const;

const BUILTIN_IDS = new Set(DEVICE_PRESETS.map((preset) => preset.id));

function defaultDevicePreset(): DevicePreset {
  return DEVICE_PRESETS.find((preset) => preset.id === DEFAULT_DEVICE_PRESET_ID)!;
}

export function mergeDevicePresets(
  custom: readonly DevicePreset[] = [],
): DevicePreset[] {
  const merged: DevicePreset[] = [...DEVICE_PRESETS];
  const seen = new Set<string>([...BUILTIN_IDS, DESIRED_CANVAS_ID]);
  for (const preset of custom) {
    const id = preset.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({
      ...preset,
      id,
      width: Math.max(1, preset.width),
      height: Math.max(1, preset.height),
      safeArea: {
        left: Math.max(0, preset.safeArea.left),
        right: Math.max(0, preset.safeArea.right),
        top: Math.max(0, preset.safeArea.top),
        bottom: Math.max(0, preset.safeArea.bottom),
      },
    });
  }
  return merged;
}

export function devicePresetById(
  id: string,
  extras: readonly DevicePreset[] = [],
): DevicePreset | undefined {
  return mergeDevicePresets(extras).find((preset) => preset.id === id);
}

/**
 * Closest device preset for a live viewport. Exact CSS-pixel matches first,
 * then aspect + size.
 */
export function devicePresetForViewport(
  width: number,
  height: number,
  extras: readonly DevicePreset[] = [],
): DevicePreset {
  const presets = mergeDevicePresets(extras);
  const exact = presets.find(
    (preset) => preset.width === width && preset.height === height,
  );
  if (exact) return exact;
  const aspect = height > 0 ? width / height : 1;
  let best = defaultDevicePreset();
  let bestAspect = Number.POSITIVE_INFINITY;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const preset of presets) {
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

export type DesignerCanvasId = string;

/** Viewport used by the UserInterface designer, including Desired mode (pass `contentDesiredSize`). */
export function designerViewport(
  presetId: string,
  desiredSize: { width: number; height: number },
  extras: readonly DevicePreset[] = [],
): { id: string; width: number; height: number; safeArea: EdgeInsets } {
  if (presetId === DESIRED_CANVAS_ID) {
    return {
      id: DESIRED_CANVAS_ID,
      width: Math.max(1, desiredSize.width),
      height: Math.max(1, desiredSize.height),
      safeArea: { ...ZERO_INSETS },
    };
  }
  const preset = devicePresetById(presetId, extras) ?? defaultDevicePreset();
  return {
    id: preset.id,
    width: preset.width,
    height: preset.height,
    safeArea: preset.safeArea,
  };
}
