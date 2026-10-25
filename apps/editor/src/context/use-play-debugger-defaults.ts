import { useCallback, useEffect, useState } from "react";
import type { EngineSettings } from "@haptic/vfs";
import {
  DEFAULT_PLAY_DEBUGGER_OVERLAY,
  playDebuggerOverlayFromSettings,
  type PlayDebuggerOverlaySettings,
} from "../lib/play-debugger-defaults";

/**
 * The Debug menu toggles and rendering overrides Play starts with: each follows
 * its saved default, and a toggle saves its new value as the default.
 */
export function usePlayDebuggerDefaults({
  appSettings,
  updateDebuggerDefaults,
}: {
  appSettings: EngineSettings;
  updateDebuggerDefaults: (patch: Partial<EngineSettings["debuggerDefaults"]>) => Promise<void>;
}) {
  const [previewBuild, setPreviewBuildState] = useState(false);
  const [playFromScene, setPlayFromSceneState] = useState(true);
  const [overlayStats, setOverlayStatsState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayStats,
  );
  const [overlayConsole, setOverlayConsoleState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayConsole,
  );
  const [overlayInspector, setOverlayInspectorState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayInspector,
  );
  const [overlayProfiler, setOverlayProfilerState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayProfiler,
  );
  const [pauseOnPlay, setPauseOnPlayState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.pauseOnPlay,
  );
  const [postProcessingEnabled, setPostProcessingEnabled] = useState(true);
  const [hardwareScalingLevel, setHardwareScalingLevel] = useState(1);

  // Saved Debug menu defaults apply field by field: a settings write re-applies only the fields it
  // changed, so it no longer reverts another field whose own write is still queued behind it.
  const savedDefaults = appSettings.debuggerDefaults;
  const savedPreviewBuild = savedDefaults.previewBuild === true;
  const savedPlayFromScene = savedDefaults.playFromScene !== false;
  const savedOverlay = playDebuggerOverlayFromSettings(savedDefaults);
  useEffect(() => setPreviewBuildState(savedPreviewBuild), [savedPreviewBuild]);
  useEffect(() => setPlayFromSceneState(savedPlayFromScene), [savedPlayFromScene]);
  useEffect(() => setOverlayStatsState(savedOverlay.overlayStats), [savedOverlay.overlayStats]);
  useEffect(() => setOverlayConsoleState(savedOverlay.overlayConsole), [savedOverlay.overlayConsole]);
  useEffect(() => setOverlayInspectorState(savedOverlay.overlayInspector), [savedOverlay.overlayInspector]);
  useEffect(() => setOverlayProfilerState(savedOverlay.overlayProfiler), [savedOverlay.overlayProfiler]);
  useEffect(() => setPauseOnPlayState(savedOverlay.pauseOnPlay), [savedOverlay.pauseOnPlay]);
  const savedPostProcessing = typeof appSettings.postProcessingEnabled === "boolean"
    ? appSettings.renderingOverridesEnabled !== true || appSettings.postProcessingEnabled
    : undefined;
  const savedScaling = typeof appSettings.hardwareScalingLevel === "number"
    ? (appSettings.renderingOverridesEnabled === true ? appSettings.hardwareScalingLevel : 1)
    : undefined;
  useEffect(() => { if (savedPostProcessing !== undefined) setPostProcessingEnabled(savedPostProcessing); }, [savedPostProcessing]);
  useEffect(() => { if (savedScaling !== undefined) setHardwareScalingLevel(savedScaling); }, [savedScaling]);

  const persistDebuggerDefaults = useCallback(
    async (patch: Partial<PlayDebuggerOverlaySettings> & {
      previewBuild?: boolean;
      playFromScene?: boolean;
    }) => {
      await updateDebuggerDefaults(patch);
    },
    [updateDebuggerDefaults],
  );

  const setPreviewBuild = useCallback((value: boolean) => {
    setPreviewBuildState(value);
    void persistDebuggerDefaults({ previewBuild: value });
  }, [persistDebuggerDefaults]);

  const setPlayFromScene = useCallback((value: boolean) => {
    setPlayFromSceneState(value);
    void persistDebuggerDefaults({ playFromScene: value });
  }, [persistDebuggerDefaults]);

  const setOverlayStats = useCallback((value: boolean) => {
    setOverlayStatsState(value);
    void persistDebuggerDefaults({ overlayStats: value });
  }, [persistDebuggerDefaults]);

  const setOverlayConsole = useCallback((value: boolean) => {
    setOverlayConsoleState(value);
    void persistDebuggerDefaults({ overlayConsole: value });
  }, [persistDebuggerDefaults]);

  const setOverlayInspector = useCallback((value: boolean) => {
    setOverlayInspectorState(value);
    void persistDebuggerDefaults({ overlayInspector: value });
  }, [persistDebuggerDefaults]);

  const setOverlayProfiler = useCallback((value: boolean) => {
    setOverlayProfilerState(value);
    void persistDebuggerDefaults({ overlayProfiler: value });
  }, [persistDebuggerDefaults]);

  const setPauseOnPlay = useCallback((value: boolean) => {
    setPauseOnPlayState(value);
    void persistDebuggerDefaults({ pauseOnPlay: value });
  }, [persistDebuggerDefaults]);

  return {
    previewBuild,
    setPreviewBuild,
    playFromScene,
    setPlayFromScene,
    overlayStats,
    overlayConsole,
    overlayInspector,
    overlayProfiler,
    pauseOnPlay,
    setOverlayStats,
    setOverlayConsole,
    setOverlayInspector,
    setOverlayProfiler,
    setPauseOnPlay,
    postProcessingEnabled,
    hardwareScalingLevel,
  };
}
