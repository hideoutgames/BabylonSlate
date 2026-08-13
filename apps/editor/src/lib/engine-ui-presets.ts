import { useEffect, useState } from "react";
import {
  createAppSettingsStore,
  type EngineSettings,
} from "@babylonslate/vfs";
import {
  DESIRED_CANVAS_ID,
  devicePresetById,
  type DevicePreset,
} from "@babylonslate/ui-runtime";
import { ENGINE_SETTINGS_CHANGED_EVENT } from "./viewport-render-gate";

/** Keep Desired; fall back when a custom (or unknown) id is no longer in the list. */
export function resolveDesignerCanvasId(
  presetId: string,
  extras: readonly DevicePreset[],
): string {
  if (presetId === DESIRED_CANVAS_ID) return DESIRED_CANVAS_ID;
  if (devicePresetById(presetId, extras)) return presetId;
  return "ipad-landscape";
}

/** Custom UserInterface designer presets from Engine Settings, live. */
export function useEngineUiDesignerPresets(): DevicePreset[] {
  const [extras, setExtras] = useState<DevicePreset[]>([]);
  useEffect(() => {
    const store = createAppSettingsStore();
    void store.load().then((settings) => {
      setExtras(settings.uiDesignerPresets);
    });
    const onSettings = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          uiDesignerPresets?: EngineSettings["uiDesignerPresets"];
        }>
      ).detail;
      if (detail && Array.isArray(detail.uiDesignerPresets)) {
        setExtras(detail.uiDesignerPresets);
      }
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () =>
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  }, []);
  return extras;
}
