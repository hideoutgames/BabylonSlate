export function presentLiveUiIfVisible(options: {
  panelVisible: boolean;
  documentActive: boolean;
  present: () => void;
}): void {
  if (!options.panelVisible || !options.documentActive) return;
  options.present();
}
