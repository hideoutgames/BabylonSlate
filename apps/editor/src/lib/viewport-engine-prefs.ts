import {
  updateActiveViewportPrefs,
  useAppSettings,
} from "../context/app-settings-context";

export function useEditorViewportPrefs(): {
  flySpeed: number;
  cameraPreviewFrameRate: number;
  dropDistance: number;
  placeOnSurfaces: boolean;
  placementDistance: number;
  gridSize: number;
  snapTranslate: number;
  snapRotateDeg: number;
  snapScale: number;
  editorTextureLodEnabled: boolean;
  editorTextureLodQuality: number;
  showFps: boolean;
} {
  const { settings } = useAppSettings();

  return {
    flySpeed: settings.viewportFlySpeed,
    cameraPreviewFrameRate: settings.cameraPreviewFrameRate,
    dropDistance: settings.viewportDropDistance,
    placeOnSurfaces: settings.viewportPlaceOnSurfaces,
    placementDistance: settings.viewportPlacementDistance,
    gridSize: settings.viewportGridSize,
    snapTranslate: settings.viewportSnapTranslate,
    snapRotateDeg: settings.viewportSnapRotateDeg,
    snapScale: settings.viewportSnapScale,
    editorTextureLodEnabled: settings.editorTextureLodEnabled,
    editorTextureLodQuality: settings.editorTextureLodQuality,
    showFps: settings.viewportShowFps,
  };
}

export async function patchEngineViewportPrefs(patch: {
  viewportFlySpeed?: number;
  viewportGridSize?: number;
  viewportSnapTranslate?: number;
  viewportSnapRotateDeg?: number;
  viewportSnapScale?: number;
  viewportShowFps?: boolean;
}): Promise<void> {
  await updateActiveViewportPrefs(patch);
}
