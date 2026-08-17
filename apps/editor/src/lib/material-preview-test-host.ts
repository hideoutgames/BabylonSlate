let readRadius: (() => number | null) | null = null;

/** Test-mode host for Material preview orbit/pinch assertions. */
export function registerMaterialPreviewCameraRadius(
  reader: (() => number | null) | null,
): void {
  readRadius = reader;
}

export function materialPreviewCameraRadius(): number | null {
  return readRadius?.() ?? null;
}
