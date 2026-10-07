export type PlayDebuggerOverlaySettings = {
  overlayStats: boolean;
  overlayConsole: boolean;
  overlayInspector: boolean;
  overlayProfiler: boolean;
  pauseOnPlay: boolean;
};

export const DEFAULT_PLAY_DEBUGGER_OVERLAY: PlayDebuggerOverlaySettings = {
  overlayStats: true,
  overlayConsole: false,
  overlayInspector: false,
  overlayProfiler: false,
  pauseOnPlay: false,
};

/** Overlay Debug-menu flags. Missing keys show only Stats. */
export function playDebuggerOverlayFromSettings(
  defaults?: Partial<PlayDebuggerOverlaySettings> | null,
): PlayDebuggerOverlaySettings {
  return {
    overlayStats: defaults?.overlayStats !== false,
    overlayConsole: defaults?.overlayConsole === true,
    overlayInspector: defaults?.overlayInspector === true,
    overlayProfiler: defaults?.overlayProfiler === true,
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

/** Snapshot these local preferences when preparing a session; no active state is saved. */
export function simulationDefaultsFromSettings(defaults?: {
  keepSimulationChanges?: boolean;
} | null) {
  return Object.freeze({
    keepChanges: defaults?.keepSimulationChanges === true,
  });
}

export function profileDefaultsFromSettings(defaults?: {
  profileDurationSeconds?: number;
  profileByteBudget?: number;
  profileGpuTiming?: boolean;
} | null) {
  const finite = (value: number | undefined, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  return {
    durationMs: finite(defaults?.profileDurationSeconds, 10, 1, 60) * 1000,
    byteBudget: finite(defaults?.profileByteBudget, 16 * 1024 * 1024, 4 * 1024 * 1024, 64 * 1024 * 1024),
    gpuTiming: defaults?.profileGpuTiming === true,
  };
}
