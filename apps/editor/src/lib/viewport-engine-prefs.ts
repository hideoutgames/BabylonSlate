import {
  updateActiveViewportPrefs,
  useAppSettings,
} from "../context/app-settings-context";

export function useEditorViewportPrefs(): {
  flySpeed: number;
  gridSize: number;
  editorTextureLodEnabled: boolean;
  editorTextureLodQuality: number;
} {
  const { settings } = useAppSettings();

  return {
    flySpeed: settings.viewportFlySpeed,
    gridSize: settings.viewportGridSize,
    editorTextureLodEnabled: settings.editorTextureLodEnabled,
    editorTextureLodQuality: settings.editorTextureLodQuality,
  };
}

export async function patchEngineViewportPrefs(patch: {
  viewportFlySpeed?: number;
  viewportGridSize?: number;
}): Promise<void> {
  await updateActiveViewportPrefs(patch);
}
