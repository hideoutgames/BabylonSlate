import { useEffect, useState } from "react";
import { createAppSettingsStore } from "@babylonslate/vfs";
import { ENGINE_SETTINGS_CHANGED_EVENT } from "./viewport-render-gate";

export function useEditorViewportPrefs(): {
  flySpeed: number;
  gridSize: number;
  editorTextureLodEnabled: boolean;
  editorTextureLodQuality: number;
} {
  const [flySpeed, setFlySpeed] = useState(8);
  const [gridSize, setGridSize] = useState(1);
  const [editorTextureLodEnabled, setEditorTextureLodEnabled] = useState(true);
  const [editorTextureLodQuality, setEditorTextureLodQuality] = useState(0.5);

  useEffect(() => {
    const store = createAppSettingsStore();
    void store.load().then((settings) => {
      setFlySpeed(settings.viewportFlySpeed);
      setGridSize(settings.viewportGridSize);
      setEditorTextureLodEnabled(settings.editorTextureLodEnabled);
      setEditorTextureLodQuality(settings.editorTextureLodQuality);
    });
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        viewportFlySpeed?: number;
        viewportGridSize?: number;
        editorTextureLodEnabled?: boolean;
        editorTextureLodQuality?: number;
      };
      if (typeof detail.viewportFlySpeed === "number") {
        setFlySpeed(detail.viewportFlySpeed);
      }
      if (typeof detail.viewportGridSize === "number") {
        setGridSize(detail.viewportGridSize);
      }
      if (typeof detail.editorTextureLodEnabled === "boolean") {
        setEditorTextureLodEnabled(detail.editorTextureLodEnabled);
      }
      if (typeof detail.editorTextureLodQuality === "number") {
        setEditorTextureLodQuality(detail.editorTextureLodQuality);
      }
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () => {
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    };
  }, []);

  return {
    flySpeed,
    gridSize,
    editorTextureLodEnabled,
    editorTextureLodQuality,
  };
}

export async function patchEngineViewportPrefs(patch: {
  viewportFlySpeed?: number;
  viewportGridSize?: number;
}): Promise<void> {
  const store = createAppSettingsStore();
  await store.update((settings) => {
    Object.assign(settings, patch);
  });
}
