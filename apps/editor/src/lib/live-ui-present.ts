export function freezeLiveUiSurface(
  surface: { setFrozen: (frozen: boolean) => void } | null | undefined,
  options: {
    panelVisible: boolean;
    documentActive: boolean;
    requireDocumentActive?: boolean;
  },
): void {
  const documentOk =
    options.requireDocumentActive === false ? true : options.documentActive;
  surface?.setFrozen(!options.panelVisible || !documentOk);
}

export function presentLiveUiIfVisible(options: {
  panelVisible: boolean;
  documentActive: boolean;
  requireDocumentActive?: boolean;
  present: () => void;
}): void {
  const documentOk =
    options.requireDocumentActive === false ? true : options.documentActive;
  if (!options.panelVisible || !documentOk) return;
  options.present();
}
