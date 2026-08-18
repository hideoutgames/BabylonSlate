export type PlayDebuggerOverlaySettings = {
  overlayStats: boolean;
  overlayConsole: boolean;
  overlayInspector: boolean;
  pauseOnPlay: boolean;
};

export const DEFAULT_PLAY_DEBUGGER_OVERLAY: PlayDebuggerOverlaySettings = {
  overlayStats: true,
  overlayConsole: true,
  overlayInspector: true,
  pauseOnPlay: false,
};

/** Overlay Debug-menu flags. Missing keys keep Stats/Console/Inspector on. */
export function playDebuggerOverlayFromSettings(
  defaults?: Partial<PlayDebuggerOverlaySettings> | null,
): PlayDebuggerOverlaySettings {
  return {
    overlayStats: defaults?.overlayStats !== false,
    overlayConsole: defaults?.overlayConsole !== false,
    overlayInspector: defaults?.overlayInspector !== false,
    pauseOnPlay: defaults?.pauseOnPlay === true,
  };
}

/** Inspector dialog stays open only while Debug Overlay Inspector is enabled. */
export function nextPlayInspectorOpen(
  inspectorOpen: boolean,
  overlayInspector: boolean,
): boolean {
  return inspectorOpen && overlayInspector;
}
