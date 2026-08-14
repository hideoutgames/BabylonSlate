export function freezeLiveUiSurface(
  surface: { setFrozen: (frozen: boolean) => void } | null | undefined,
  options: { panelVisible: boolean; documentActive: boolean },
): void {
  surface?.setFrozen(!options.panelVisible || !options.documentActive);
}

export function presentLiveUiIfVisible(options: {
  panelVisible: boolean;
  documentActive: boolean;
  present: () => void;
}): void {
  if (!options.panelVisible || !options.documentActive) return;
  options.present();
}
