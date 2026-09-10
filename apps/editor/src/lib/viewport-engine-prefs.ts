import {
  updateActiveViewportPrefs,
  useAppSettings,
} from "../context/app-settings-context";

export function useEditorViewportPrefs(): {
  flySpeed: number;
  dropDistance: number;
  gridSize: number;
  snapRotateDeg: number;
  snapScale: number;
  editorTextureLodEnabled: boolean;
  editorTextureLodQuality: number;
} {
  const { settings } = useAppSettings();

  return {
    flySpeed: settings.viewportFlySpeed,
    dropDistance: settings.viewportDropDistance,
    gridSize: settings.viewportGridSize,
    snapRotateDeg: settings.viewportSnapRotateDeg,
    snapScale: settings.viewportSnapScale,
    editorTextureLodEnabled: settings.editorTextureLodEnabled,
    editorTextureLodQuality: settings.editorTextureLodQuality,
  };
}

export async function patchEngineViewportPrefs(patch: {
  viewportFlySpeed?: number;
  viewportGridSize?: number;
  viewportSnapRotateDeg?: number;
  viewportSnapScale?: number;
}): Promise<void> {
  await updateActiveViewportPrefs(patch);
}
