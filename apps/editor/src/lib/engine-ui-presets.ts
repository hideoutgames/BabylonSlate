import { useEffect, useState } from "react";
import {
  createAppSettingsStore,
  type EngineSettings,
} from "@babylonslate/vfs";
import {
  DEFAULT_DEVICE_PRESET_ID,
  DESIRED_CANVAS_ID,
  devicePresetById,
  type DevicePreset,
} from "@babylonslate/ui-runtime";
import { ENGINE_SETTINGS_CHANGED_EVENT } from "./viewport-render-gate";

type LooseDesignerPreset = {
  id: string;
  label: string;
  width?: number;
  height?: number;
  safeArea?: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  };
};

/** Normalize Engine Settings rows into ui-runtime device presets. */
export function asDevicePresets(
  presets: readonly LooseDesignerPreset[] | undefined,
): DevicePreset[] {
  if (!presets) return [];
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    width: Math.max(1, preset.width ?? 1),
    height: Math.max(1, preset.height ?? 1),
    safeArea: {
      left: Math.max(0, preset.safeArea?.left ?? 0),
      right: Math.max(0, preset.safeArea?.right ?? 0),
      top: Math.max(0, preset.safeArea?.top ?? 0),
      bottom: Math.max(0, preset.safeArea?.bottom ?? 0),
    },
  }));
}

/** Keep Desired; fall back when a custom (or unknown) id is no longer in the list. */
export function resolveDesignerCanvasId(
  presetId: string,
  extras: readonly DevicePreset[],
): string {
  if (presetId === DESIRED_CANVAS_ID) return DESIRED_CANVAS_ID;
  if (devicePresetById(presetId, extras)) return presetId;
  return DEFAULT_DEVICE_PRESET_ID;
}

/** Custom UserInterface designer presets from Engine Settings, live. */
export function useEngineUiDesignerPresets(): DevicePreset[] {
  const [extras, setExtras] = useState<DevicePreset[]>([]);
  useEffect(() => {
    const store = createAppSettingsStore();
    void store.load().then((settings) => {
      setExtras(asDevicePresets(settings.uiDesignerPresets));
    });
    const onSettings = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          uiDesignerPresets?: EngineSettings["uiDesignerPresets"];
        }>
      ).detail;
      if (detail && Array.isArray(detail.uiDesignerPresets)) {
        setExtras(asDevicePresets(detail.uiDesignerPresets));
      }
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () =>
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  }, []);
  return extras;
}
