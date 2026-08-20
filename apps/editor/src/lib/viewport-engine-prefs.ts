import { useEffect, useState } from "react";
import { createAppSettingsStore } from "@babylonslate/vfs";
import {
  dispatchEngineSettingsChanged,
  ENGINE_SETTINGS_CHANGED_EVENT,
} from "./viewport-render-gate";

export function useEditorViewportPrefs(): {
  flySpeed: number;
  gridSize: number;
} {
  const [flySpeed, setFlySpeed] = useState(8);
  const [gridSize, setGridSize] = useState(1);

  useEffect(() => {
    const store = createAppSettingsStore();
    void store.load().then((settings) => {
      setFlySpeed(settings.viewportFlySpeed);
      setGridSize(settings.viewportGridSize);
    });
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        viewportFlySpeed?: number;
        viewportGridSize?: number;
      };
      if (typeof detail.viewportFlySpeed === "number") {
        setFlySpeed(detail.viewportFlySpeed);
      }
      if (typeof detail.viewportGridSize === "number") {
        setGridSize(detail.viewportGridSize);
      }
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () => {
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    };
  }, []);

  return { flySpeed, gridSize };
}

export async function patchEngineViewportPrefs(patch: {
  viewportFlySpeed?: number;
  viewportGridSize?: number;
}): Promise<void> {
  const store = createAppSettingsStore();
  const current = await store.load();
  const next = { ...current, ...patch };
  await store.save(next);
  dispatchEngineSettingsChanged({
    viewportFrameCap: next.viewportFrameCap,
    viewportFlySpeed: next.viewportFlySpeed,
    viewportGridSize: next.viewportGridSize,
    hardwareScalingLevel: next.hardwareScalingLevel,
    postProcessingEnabled: next.postProcessingEnabled,
    graphDefaultZoom: next.graphDefaultZoom,
    theme: next.appearance.theme,
  });
}
