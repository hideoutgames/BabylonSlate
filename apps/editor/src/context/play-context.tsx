import { prepareSaveGameConfiguration } from "../services/save-game-configuration";
import { createSaveGameStorage } from "@babylonslate/vfs";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AbstractEngine } from "@babylonjs/core";
import { shouldPackKtx2ForPreviewBuild, webGpuMaterialCompatibilityReason } from "@babylonslate/render";
import {
  DEFAULT_INFINITE_LOOP_DETECTION,
  DEFAULT_LOOP_COUNT,
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  engineCommandBus,
  isErr,
  normalizeRenderingPipeline,
  renderEffectsAssetGuids,
  resolveGameInstanceClass,
} from "@babylonslate/core";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";
import { emptyPlayAudioLibrary, type PlayAudioLibrary, type PlayAudioSourceLoader } from "../lib/play-audio";
import { appendOutputLogLine } from "../lib/output-log-ring";
import { PlayPrepareDialog } from "../components/play-prepare-dialog";
import { PlayBlockedDialog } from "../components/play-blocked-dialog";
import { PlayOverlay } from "../components/play-overlay";
import { PreparingPreviewDialog, type PreviewPreparePhase } from "../components/preparing-preview-dialog";
import { PreviewBuildOverlay } from "../components/preview-build-overlay";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import {
  MISSING_STARTUP_SCENE_MESSAGE,
  isPreviewDiagnosticsMessage,
  isPreviewErrorMessage,
  isPreviewRequestPackMessage,
  previewPackFromFiles,
  PREVIEW_STOP_MESSAGE,
  PREVIEW_READY_MESSAGE,
  createPreviewSaveStorageHost,
} from "@babylonslate/exporter";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import {
  DEFAULT_PLAY_DEBUGGER_OVERLAY,
  playDebuggerOverlayFromSettings,
  type PlayDebuggerOverlaySettings,
} from "../lib/play-debugger-defaults";
import { loadPlayerDistFiles } from "../services/load-player-files";
import { playerPreviewSrc } from "../lib/player-host-url";
import { canSendPreviewPack, isExpectedPreviewMessage, previewTargetFromSrc } from "../lib/preview-build-handoff";
import { attachPreviewLifecycle } from "../lib/preview-lifecycle";
import {
  sessionEntriesFromPreviewDiagnostics,
  shouldClosePreviewOnDiagnostics,
} from "../lib/preview-diagnostics";
import { useDocuments } from "./document-context";
import { useValidation } from "./validation-context";
import { PreviewSessionReport } from "../components/preview-session-report";
import type { PlaySessionResult } from "../services/play-session";
import { PREVIEW_FIXTURE_NODE_ID } from "../services/play-session";
import {
  canonicalPlaySceneGuid,
  playPhysicsFromOpenDocuments,
  playPhysicsFromSceneSettings,
  playSceneFromOpenDocuments,
  playIsEnabled,
  resolvePlayScene,
  resolvePreviewStartupGuid,
  type PlaySceneLoad,
} from "../services/play-physics";
import { documentIdToRevealForDiagnostic, sessionReportNavigation } from "../services/diagnostic-navigation";
import type {
  PlayAnimGraphEntry,
  PlayBehaviourTreeEntry,
  PlayBlackboardEntry,
} from "../lib/play-content";
import {
  readPlaySceneBakes,
  modelSlotMaterialGuidsFromPayloads,
  overlayTextureGuidsFromScenes,
  playPrefabDependencyScene,
  skyboxFaceGuidsFromScene,
  environmentTextureGuidsFromScenes,
  postProcessTextureGuidsFromScenes,
} from "../lib/play-content";
import { fontMsdfMapsFromPairs } from "../lib/play-fonts";
import {
  emptyParticleLibrary,
  hydrateSpriteAnimationPixelSizes,
  particleLibraryMaterialGuids,
  type ParticleLibrary,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
  type ModelPayload,
  type RetargetAnimationLoad,
} from "@babylonslate/assets";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import { setEncodeQueuePauseReason } from "../services/encode-queue-pause";
import {
  EditorSchedulerRegistry,
  type EditorLoopHandle,
} from "../lib/editor-scheduler-registry";
import { planPlayPreviewPrepare, playBundlesNeedCollect } from "../services/play-preview-prepare";
import { projectHasBlockingErrors } from "../services/graph-validation";
import type { PlayPreparePhase } from "../components/play-prepare-dialog";
import { animClipCatalogFromAssets, modelClipAnimationGuidsFromAssets, retargetAnimationLoadsFromAssets } from "../lib/anim-clip-catalog";
import { useAppSettings } from "./app-settings-context";
import {
  isUsableEngine,
  nextRegisteredSharedEngine,
  nextSharedEngineGeneration,
} from "../lib/shared-engine-generation";
import { createProjectEngineController } from "../lib/project-engine";
import { waitForSceneLoadingPaint } from "../lib/scene-viewport-load";
import { ProjectRenderingDialog } from "../components/project-rendering-dialog";

type PlayOptions = { injectFixtureThrow?: boolean };

export type LiveBtState = {
  slotId: number;
  status: string;
  btNodeId: string | null;
  lastResults: Record<string, string>;
  blackboard: Record<string, unknown>;
  stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
};

interface PlayContextValue {
  playing: boolean;
  preparing: boolean;
  playAwaitingMigration: boolean;
  requestPlay: (options?: PlayOptions) => Promise<void>;
  canPlay: boolean;
  previewBuild: boolean;
  setPreviewBuild: (value: boolean) => void;
  playFromScene: boolean;
  setPlayFromScene: (value: boolean) => void;
  overlayStats: boolean;
  overlayConsole: boolean;
  overlayInspector: boolean;
  pauseOnPlay: boolean;
  setOverlayStats: (value: boolean) => void;
  setOverlayConsole: (value: boolean) => void;
  setOverlayInspector: (value: boolean) => void;
  setPauseOnPlay: (value: boolean) => void;
  launchPlay: (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => void;
  resumePlayAfterMigration: () => Promise<void>;
  cancelPlayMigration: () => void;
  registerSharedEngine: (engine: AbstractEngine | null) => void;
  ensureSharedEngine: () => AbstractEngine | null;
  sharedEngineGeneration: number;
  registerScheduler: (scheduler: EditorLoopHandle) => () => void;
  focusedNodeId: string | null;
  clearFocusedNode: () => void;
  appendLog: (line: string) => void;
  reportBtState: (state: LiveBtState | null) => void;
}

const PlayContext = createContext<PlayContextValue | null>(null);
const OutputLogContext = createContext<{ lines: string[] }>({ lines: [] });
const LiveBtStateContext = createContext<LiveBtState | null>(null);
const PlayDiagnosticsActionsContext = createContext<Pick<
  PlayContextValue, "appendLog" | "reportBtState"
> | null>(null);

/** High-frequency updates must not rerender the session owner or its overlays. */
function PlayDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [logLines, setLogLines] = useState<string[]>([]);
  const [liveBtState, setLiveBtState] = useState<LiveBtState | null>(null);
  const appendLog = useCallback((line: string) => {
    setLogLines((previous) => appendOutputLogLine(previous, line));
  }, []);
  const actions = useMemo(
    () => ({ appendLog, reportBtState: setLiveBtState }),
    [appendLog],
  );
  const outputLog = useMemo(() => ({ lines: logLines }), [logLines]);
  return (
    <PlayDiagnosticsActionsContext.Provider value={actions}>
      <OutputLogContext.Provider value={outputLog}>
        <LiveBtStateContext.Provider value={liveBtState}>
          {children}
        </LiveBtStateContext.Provider>
      </OutputLogContext.Provider>
    </PlayDiagnosticsActionsContext.Provider>
  );
}

export function PlayProvider({ children }: { children: ReactNode }) {
  return (
    <PlayDiagnosticsProvider>
      <PlaySessionProvider>{children}</PlaySessionProvider>
    </PlayDiagnosticsProvider>
  );
}

function PlaySessionProvider({ children }: { children: ReactNode }) {
  const { appendLog, reportBtState } = useContext(PlayDiagnosticsActionsContext)!;
  const { settings: appSettings, updateDebuggerDefaults } = useAppSettings();
  const engineRef = useRef<AbstractEngine | null>(null);
  const ownedEngineRef = useRef<AbstractEngine | null>(null);
  const [projectEngine] = useState(createProjectEngineController);
  const projectEngineState = useSyncExternalStore(projectEngine.subscribe, projectEngine.getSnapshot);
  const [renderingFailureDismissed, setRenderingFailureDismissed] = useState(false);
  const schedulerRegistryRef = useRef(new EditorSchedulerRegistry());
  const preparingRef = useRef(false);
  const pendingPlayOptionsRef = useRef<PlayOptions | undefined>(undefined);
  const pendingScriptsRef = useRef<ScriptBundleEntry[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playSaveGame, setPlaySaveGame] = useState<import("@babylonslate/core").SaveGameConfiguration>();
  const playingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [playAwaitingMigration, setPlayAwaitingMigration] = useState(false);
  const [playResumeRequested, setPlayResumeRequested] = useState(false);
  const [prepareState, setPrepareState] = useState<{
    phase: PlayPreparePhase;
    dirtyNames: string[];
  } | null>(null);
  const [playBlockedOpen, setPlayBlockedOpen] = useState(false);
  const [blockedDiagnostics, setBlockedDiagnostics] = useState<Diagnostic[]>([]);
  const [injectThrow, setInjectThrow] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportEntries, setReportEntries] = useState<SessionReportEntry[]>([]);
  const [dropped, setDropped] = useState(0);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [sharedEngineGeneration, setSharedEngineGeneration] = useState(0);
  const [lastRuntimeMode, setLastRuntimeMode] = useState<
    "worker" | "in-process" | null
  >(null);
  const [scripts, setScripts] = useState<ScriptBundleEntry[]>([]);
  const [previewBuild, setPreviewBuildState] = useState(false);
  const [playFromScene, setPlayFromSceneState] = useState(true);
  const [sessionPlayScene, setSessionPlayScene] = useState<PlaySceneLoad | null>(
    null,
  );
  const [overlayStats, setOverlayStatsState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayStats,
  );
  const [overlayConsole, setOverlayConsoleState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayConsole,
  );
  const [overlayInspector, setOverlayInspectorState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayInspector,
  );
  const [pauseOnPlay, setPauseOnPlayState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.pauseOnPlay,
  );
  const [startupAlertOpen, setStartupAlertOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewOpenRef = useRef(false);
  const initialPreviewTarget = useMemo(
    () => previewTargetFromSrc(playerPreviewSrc(0), window.location.href),
    [],
  );
  const [previewSrc, setPreviewSrc] = useState(initialPreviewTarget.src);
  const previewOriginRef = useRef(initialPreviewTarget.origin);
  const [previewPhase, setPreviewPhase] = useState<PreviewPreparePhase | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPreparationError, setPreviewPreparationError] = useState<string | null>(null);
  const [previewCanCancel, setPreviewCanCancel] = useState(true);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewSaveHostRef = useRef<ReturnType<typeof createPreviewSaveStorageHost> | null>(null);
  const previewFilesRef = useRef<Map<string, Uint8Array> | null>(null);
  const previewTraceByteBudgetRef = useRef<number | undefined>(undefined);
  const previewRequestRef = useRef(0);
  const previewClosingRef = useRef(false);
  const previewDiagnosticsRef = useRef<SessionReportEntry[]>([]);
  playingRef.current = playing;
  previewOpenRef.current = previewOpen;
  const [playAnimGraphs, setPlayAnimGraphs] = useState<PlayAnimGraphEntry[]>(
    [],
  );
  const [playBehaviourTrees, setPlayBehaviourTrees] = useState<
    PlayBehaviourTreeEntry[]
  >([]);
  const [playBlackboards, setPlayBlackboards] = useState<PlayBlackboardEntry[]>(
    [],
  );
  const [playSpritePayloads, setPlaySpritePayloads] = useState<
    Map<string, SpritePayload>
  >(() => new Map());
  const [playSpriteAnimationPayloads, setPlaySpriteAnimationPayloads] = useState<
    Map<string, SpriteAnimationPayload>
  >(() => new Map());
  const [playRenderTargets, setPlayRenderTargets] = useState<{ renderTargets: Map<string, import("@babylonslate/core").RenderTargetPayload>; renderTargetTextures: Map<string, import("@babylonslate/core").RenderTargetTexturePayload> }>({ renderTargets: new Map(), renderTargetTextures: new Map() });
  const [playWaters, setPlayWaters] = useState<Map<string, import("@babylonslate/core").WaterDefinition>>(new Map());
  const [playTilemaps, setPlayTilemaps] = useState<Map<string, TilemapPayload>>(
    () => new Map(),
  );
  const [playTilesets, setPlayTilesets] = useState<Map<string, TilesetPayload>>(
    () => new Map(),
  );
  const [playTextureBytes, setPlayTextureBytes] = useState<
    Map<string, Uint8Array>
  >(() => new Map());
  const [playTexturePixelSizes, setPlayTexturePixelSizes] = useState<
    Map<string, { width: number; height: number }>
  >(() => new Map());
  const [playFontFacetypeBytes, setPlayFontFacetypeBytes] = useState<
    Map<string, Uint8Array>
  >(() => new Map());
  const [playAreaEmissions, setPlayAreaEmissions] = useState<Map<string, import("@babylonslate/assets").AreaEmissionPixels>>(() => new Map());
  const [playFontMsdfJson, setPlayFontMsdfJson] = useState<
    Map<string, Uint8Array>
  >(() => new Map());
  const [playFontMsdfPng, setPlayFontMsdfPng] = useState<
    Map<string, Uint8Array>
  >(() => new Map());
  const [playFontFaceEntries, setPlayFontFaceEntries] = useState<
    import("@babylonslate/render").FontAssetEntry[]
  >([]);
  const [playFontCssStack, setPlayFontCssStack] = useState("sans-serif");
  const [playFontCssStackByGuid, setPlayFontCssStackByGuid] = useState<
    Map<string, string>
  >(() => new Map());
  const [playModelBytes, setPlayModelBytes] = useState<Map<string, Uint8Array>>(
    () => new Map(),
  );
  const [playModelPayloads, setPlayModelPayloads] = useState<
    Map<string, ModelPayload>
  >(() => new Map());
  const [playModelClipAnimationGuids, setPlayModelClipAnimationGuids] = useState<
    Map<string, Map<string, string>>
  >(() => new Map());
  const [playRetargetAnimationLoads, setPlayRetargetAnimationLoads] = useState<
    Map<string, RetargetAnimationLoad[]>
  >(() => new Map());
  const [playAudioSourceLoader, setPlayAudioSourceLoader] =
    useState<PlayAudioSourceLoader | undefined>(undefined);
  const [playInputAssets, setPlayInputAssets] = useState<import("@babylonslate/core").InputAssetDefinition[]>([]);
  const [playDataAssets, setPlayDataAssets] = useState<import("@babylonslate/core").DataAssetCatalogEntry[]>([]);
  const [playAudioLibrary, setPlayAudioLibrary] = useState<PlayAudioLibrary>(
    () => emptyPlayAudioLibrary(),
  );
  const [playParticleLibrary, setPlayParticleLibrary] =
    useState<ParticleLibrary>(() => emptyParticleLibrary());
  const [playMaterialDocuments, setPlayMaterialDocuments] = useState<
    Map<string, MaterialDocument>
  >(() => new Map());
  const [playMaterialFunctions, setPlayMaterialFunctions] = useState<
    Map<string, MaterialFunctionDocument>
  >(() => new Map());
  const [postProcessingEnabled, setPostProcessingEnabled] = useState(true);
  const [hardwareScalingLevel, setHardwareScalingLevel] = useState(1);
  const [playNavmeshBytes, setPlayNavmeshBytes] = useState<Uint8Array | null>(
    null,
  );
  const [playSceneNavmeshBytes, setPlaySceneNavmeshBytes] = useState<ReadonlyMap<string, Uint8Array>>(() => new Map());
  const [playAudioReverbByScene, setPlayAudioReverbByScene] = useState<ReadonlyMap<string, Uint8Array>>(() => new Map());
  const [playAudioReverbBytes, setPlayAudioReverbBytes] = useState<Uint8Array | null>(
    null,
  );
  const [playSceneLibrary, setPlaySceneLibrary] = useState<
    Array<{ guid: string; scene: import("@babylonslate/core").SerializedScene }>
  >([]);
  const [playSceneLayers, setPlaySceneLayers] = useState<
    Array<{
      guid: string;
      layer: import("@babylonslate/core").SerializedSceneLayer;
    }>
  >([]);
  const documents = useDocuments();
  const {
    activeDocumentId,
    assetRegistry,
    collectPlayMaterialLibrary,
    migrationPending,
    onSessionDiagnostic,
    openDocument,
    openDocuments,
    openRecordedTrace,
    projectDocument,
    projectGuid,
    registryEpoch,
    setActiveDocument,
  } = documents;
  const projectOpen = projectDocument != null;
  const requestedBackend = normalizeRenderingPipeline(projectDocument?.settings.render).gpuBackend;
  const projectOpenRef = useRef(projectOpen);
  projectOpenRef.current = projectOpen;
  const { setDiagnostics, setFocusDiagnostic } = useValidation();
  // First indexed asset per path; rebuilt only when the registry reports a change.
  const guidByPath = useMemo(() => {
    void registryEpoch;
    const guids = new Map<string, string>();
    for (const asset of assetRegistry?.list() ?? []) {
      if (!guids.has(asset.path)) guids.set(asset.path, asset.header.guid);
    }
    return guids;
  }, [assetRegistry, registryEpoch]);
  const guidForPath = (path: string) => guidByPath.get(path) ?? null;
  const openPlayScene = playSceneFromOpenDocuments(
    openDocuments,
    activeDocumentId,
  );
  const openPlaySceneGuid = openPlayScene
    ? canonicalPlaySceneGuid(openPlayScene, guidForPath)
    : null;
  const projectStartupGuid =
    projectDocument?.settings.startupSceneGuid?.trim() ?? "";
  const startupAsset = projectStartupGuid
    ? assetRegistry?.getByGuid(projectStartupGuid)
    : undefined;
  const hasStartupScene = startupAsset?.header.type === "Scene";
  const playScene =
    sessionPlayScene ??
    resolvePlayScene({
      documents: openDocuments,
      activeDocumentId,
      playFromScene,
    });
  const playSceneGuid = playScene
    ? canonicalPlaySceneGuid(playScene, guidForPath)
    : undefined;
  const canPlay = playIsEnabled(openDocuments, activeDocumentId, {
    previewBuild,
    playFromScene,
    hasStartupScene,
  });
  const playPhysics = playScene
    ? playPhysicsFromSceneSettings(playScene.scene.settings)
    : playPhysicsFromOpenDocuments(openDocuments, activeDocumentId);

  // Play requests read documents, dirty state and collectors as they are when
  // Play is pressed. Keeping that per-edit state out of the callbacks'
  // dependencies keeps the Play context value stable while documents change.
  const playRequestInputs = { documents, openPlaySceneGuid, hasStartupScene };
  const playRequestInputsRef = useRef(playRequestInputs);
  useLayoutEffect(() => {
    playRequestInputsRef.current = playRequestInputs;
  });

  useEffect(() => {
    const applyOverlay = (defaults?: Partial<PlayDebuggerOverlaySettings>) => {
      const overlay = playDebuggerOverlayFromSettings(defaults);
      setOverlayStatsState(overlay.overlayStats);
      setOverlayConsoleState(overlay.overlayConsole);
      setOverlayInspectorState(overlay.overlayInspector);
      setPauseOnPlayState(overlay.pauseOnPlay);
    };
    const apply = (settings: {
      renderingOverridesEnabled?: boolean;
      postProcessingEnabled?: boolean;
      hardwareScalingLevel?: number;
      debuggerDefaults?: {
        previewBuild?: boolean;
        playFromScene?: boolean;
      } & Partial<PlayDebuggerOverlaySettings>;
    }) => {
      if (typeof settings.debuggerDefaults?.previewBuild === "boolean") {
        setPreviewBuildState(settings.debuggerDefaults.previewBuild);
      }
      if (typeof settings.debuggerDefaults?.playFromScene === "boolean") {
        setPlayFromSceneState(settings.debuggerDefaults.playFromScene);
      }
      if (settings.debuggerDefaults) {
        applyOverlay(settings.debuggerDefaults);
      }
      if (typeof settings.postProcessingEnabled === "boolean") {
        setPostProcessingEnabled(settings.renderingOverridesEnabled !== true || settings.postProcessingEnabled);
      }
      if (typeof settings.hardwareScalingLevel === "number") {
        setHardwareScalingLevel(settings.renderingOverridesEnabled === true ? settings.hardwareScalingLevel : 1);
      }
    };
    setPreviewBuildState(appSettings.debuggerDefaults.previewBuild === true);
    setPlayFromSceneState(appSettings.debuggerDefaults.playFromScene !== false);
    applyOverlay(appSettings.debuggerDefaults);
    apply(appSettings);
  }, [appSettings]);

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

  const setPauseOnPlay = useCallback((value: boolean) => {
    setPauseOnPlayState(value);
    void persistDebuggerDefaults({ pauseOnPlay: value });
  }, [persistDebuggerDefaults]);

  useEffect(
    () => onSessionDiagnostic(appendLog),
    [appendLog, onSessionDiagnostic],
  );

  useEffect(() => {
    return engineCommandBus.subscribe((command) => {
      if (command.type === "log") {
        appendLog(`[Engine] ${command.message}`);
      }
    });
  }, [appendLog]);

  const registerSharedEngine = useCallback((engine: AbstractEngine | null) => {
    const previous = engineRef.current;
    const next = projectOpenRef.current && projectEngine.getSnapshot().phase !== "ready" ? null : nextRegisteredSharedEngine({
      incoming: engine,
      previous,
      owned: ownedEngineRef.current,
      overlayPlaying: playingRef.current && !previewOpenRef.current,
    });
    engineRef.current = isUsableEngine(next) ? next : null;
    setSharedEngineGeneration((current) =>
      nextSharedEngineGeneration(current, engineRef.current, previous),
    );
  }, [projectEngine]);

  const registerScheduler = useCallback((scheduler: EditorLoopHandle) => {
    return schedulerRegistryRef.current.register(scheduler);
  }, []);

  useEffect(() => {
    return attachLifecyclePause((paused) => {
      schedulerRegistryRef.current.setPaused(paused);
      setEncodeQueuePauseReason("visibility", paused);
    });
  }, []);

  useEffect(() => {
    if (projectDocument) return;
    setScripts([]);
    setPlaying(false);
    setSessionPlayScene(null);
    setPrepareState(null);
    setPlayBlockedOpen(false);
    setBlockedDiagnostics([]);
    setPlayAwaitingMigration(false);
    pendingScriptsRef.current = null;
    pendingPlayOptionsRef.current = undefined;
  }, [projectDocument]);

  const renderingRequest = useMemo(() => projectOpen && projectGuid ? {
    projectGuid,
    backend: requestedBackend,
    async prepare(signal: AbortSignal) {
      await waitForSceneLoadingPaint(signal);
      if (requestedBackend !== "webgpu") return undefined;
      const materialGuids = (assetRegistry?.list() ?? [])
        .filter((asset) => asset.header.type === "Material")
        .map((asset) => asset.header.guid);
      const library = await collectPlayMaterialLibrary(null, [], materialGuids);
      signal.throwIfAborted();
      return webGpuMaterialCompatibilityReason(library.documents, library.functions);
    },
  } : null, [projectOpen, projectGuid, requestedBackend, assetRegistry, collectPlayMaterialLibrary]);

  useEffect(() => {
    // A running simulation keeps its Engine. Apply the authored change after Stop.
    if (renderingRequest && (playing || previewOpen)) return;
    setRenderingFailureDismissed(false);
    void projectEngine.sync(renderingRequest);
  }, [projectEngine, renderingRequest, playing, previewOpen]);

  useEffect(() => {
    const engine = projectEngineState.session?.engine ?? null;
    ownedEngineRef.current = engine;
    const previous = engineRef.current;
    const next = isUsableEngine(engine) ? engine : null;
    engineRef.current = next;
    setSharedEngineGeneration((current) =>
      nextSharedEngineGeneration(current, next, previous),
    );
  }, [projectEngineState]);

  useEffect(() => {
    return () => {
      projectEngine.dispose();
      ownedEngineRef.current = null;
      engineRef.current = null;
    };
  }, [projectEngine]);

  const ensureEngine = useCallback((): AbstractEngine | null => {
    const engine = projectEngine.getSnapshot().session?.engine;
    return isUsableEngine(engine) ? engine! : null;
  }, [projectEngine]);

  const launchPlay = useCallback(
    (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => {
      if (!ensureEngine()) {
        appendLog("Play failed: could not create Engine.");
        return;
      }
      setEncodeQueuePauseReason("play", true);
      setInjectThrow(Boolean(options?.injectFixtureThrow));
      if (options?.scripts) {
        setScripts(options.scripts);
      }
      setPlaying(true);
    },
    [appendLog, ensureEngine],
  );

  const closePreview = useCallback(() => {
    previewClosingRef.current = true;
    previewSaveHostRef.current?.dispose();
    previewSaveHostRef.current = null;
    const frame = previewIframeRef.current;
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ type: PREVIEW_STOP_MESSAGE }, previewOriginRef.current);
    }
    previewFilesRef.current = null;
    previewTraceByteBudgetRef.current = undefined;
    setPreviewOpen(false);
    setPreviewPhase(null);
    setPreviewError(null);
    setPreviewCanCancel(true);
    setPlaying(false);
    setSessionPlayScene(null);
    setEncodeQueuePauseReason("play", false);
    window.setTimeout(() => {
      previewClosingRef.current = false;
      const diagnostics = previewDiagnosticsRef.current;
      previewDiagnosticsRef.current = [];
      if (diagnostics.length > 0) {
        setDropped(0);
        setReportEntries(diagnostics);
        setReportOpen(true);
      }
    }, 100);
  }, []);

  const sendPreviewPack = useCallback(() => {
    const files = previewFilesRef.current;
    const frame = previewIframeRef.current?.contentWindow;
    const handoff = { files, closing: previewClosingRef.current };
    if (!canSendPreviewPack(handoff) || !frame) {
      return;
    }
    try {
      frame.postMessage(previewPackFromFiles(handoff.files, {
        traceByteBudget: previewTraceByteBudgetRef.current,
      }), previewOriginRef.current);
    } catch (error) {
      setPreviewError(
        `Preview Build could not send the game data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isExpectedPreviewMessage(
        event,
        previewIframeRef.current?.contentWindow,
        previewOriginRef.current,
      )) return;
      previewSaveHostRef.current?.receive(event);
      if (event.data?.type === PREVIEW_READY_MESSAGE) {
        lifecycle.sync();
        return;
      }
      // The player asks once its listener exists, which removes the race
      // between iframe `load` and the player module evaluating.
      if (isPreviewRequestPackMessage(event.data)) {
        sendPreviewPack();
        return;
      }
      if (isPreviewErrorMessage(event.data)) {
        setPreviewError(event.data.message);
        appendLog(`Preview Build failed: ${event.data.message}`);
        return;
      }
      if (!isPreviewDiagnosticsMessage(event.data)) return;
      const entries = sessionEntriesFromPreviewDiagnostics(
        event.data.diagnostics,
      );
      previewDiagnosticsRef.current = entries;
      if (shouldClosePreviewOnDiagnostics(entries) && !previewClosingRef.current) {
        closePreview();
      }
    };
    const lifecycle = attachPreviewLifecycle(() => {
      if (previewClosingRef.current || previewOriginRef.current !== window.location.origin) return null;
      const frame = previewIframeRef.current?.contentWindow;
      try {
        return frame && frame.location.origin === window.location.origin ? frame : null;
      } catch {
        return null;
      }
    });
    window.addEventListener("message", onMessage);
    return () => {
      previewSaveHostRef.current?.dispose();
      previewSaveHostRef.current = null;
      lifecycle.dispose();
      window.removeEventListener("message", onMessage);
    };
  }, [appendLog, closePreview, sendPreviewPack]);

  const requestPreviewBuild = useCallback(async () => {
    if (playing || preparingRef.current) return;
    // Read at call time (see playRequestInputsRef); shadows the render values.
    const {
      documents: {
        assetRegistry,
        dirtyDocuments,
        exportGameArtifact,
        migrationPending,
        projectDirty,
        projectDocument,
        saveAll,
      },
      openPlaySceneGuid,
    } = playRequestInputsRef.current;
    const effectiveStartup = resolvePreviewStartupGuid({
      playFromScene,
      openSceneGuid: openPlaySceneGuid,
      startupSceneGuid: projectDocument?.settings.startupSceneGuid ?? null,
    });
    const asset = effectiveStartup
      ? assetRegistry?.getByGuid(effectiveStartup)
      : undefined;
    if (!effectiveStartup || asset?.header.type !== "Scene") {
      setStartupAlertOpen(true);
      return;
    }
    setPreviewPreparationError(null);
    const needsSave = dirtyDocuments.length > 0 || projectDirty;
    if (needsSave && migrationPending.length > 0) {
      setPlayAwaitingMigration(true);
      return;
    }
    const requestId = ++previewRequestRef.current;
    const traceByteBudget = appSettings.traceByteBudget;
    const isCurrentRequest = () => previewRequestRef.current === requestId;
    const fail = (message: string) => {
      const reason = message || "Preview Build could not prepare the game.";
      setPreviewPreparationError(reason);
      appendLog(`Preview Build failed: ${reason}`);
    };
    previewClosingRef.current = false;
    preparingRef.current = true;
    setPreparing(true);
    setPreviewCanCancel(true);
    setPreviewPhase("Saving");
    try {
      if (needsSave) {
        const saved = await saveAll();
        if (!isCurrentRequest()) return;
        if (!saved) {
          setPlayAwaitingMigration(true);
          return;
        }
      }
      if (!isCurrentRequest()) return;
      await prepareSaveGameConfiguration({
        projectId: playRequestInputsRef.current.documents.projectGuid,
        settings: projectDocument?.settings.saveGame,
        loadDefinition: async (guid) => {
          const current = playRequestInputsRef.current.documents;
          const asset = current.assetRegistry?.getByGuid(guid);
          if (!asset) throw new Error("The default Save Game definition is missing.");
          return current.loadAssetDocument("save-game", asset.path);
        },
      });
      setPreviewPhase("Collecting Assets");
      const playerFiles = await loadPlayerDistFiles();
      if (!isCurrentRequest()) return;
      const packed = await exportGameArtifact({
        previewBuild: true,
        playerFiles,
        startupSceneGuid: effectiveStartup,
        transcoderAvailable: shouldPackKtx2ForPreviewBuild(),
        onPhase: (phase) => {
          if (isCurrentRequest()) setPreviewPhase(phase);
        },
      });
      if (!isCurrentRequest()) return;
      if (isErr(packed)) {
        if (packed.error === MISSING_STARTUP_SCENE_MESSAGE) {
          setStartupAlertOpen(true);
        } else {
          fail(packed.error);
        }
        return;
      }
      for (const warning of packed.value.warnings) {
        appendLog(`Preview Build warning: ${warning}`);
      }
      const previewTarget = previewTargetFromSrc(playerPreviewSrc(Date.now()), window.location.href);
      previewFilesRef.current = packed.value.files;
      previewTraceByteBudgetRef.current = traceByteBudget;
      setPreviewCanCancel(false);
      setPreviewPhase("Launching");
      setEncodeQueuePauseReason("play", true);
      setPlaying(true);
      setPreviewError(null);
      previewOriginRef.current = previewTarget.origin;
      previewSaveHostRef.current?.dispose();
      const previewProjectId = playRequestInputsRef.current.documents.projectGuid;
      previewSaveHostRef.current = previewProjectId ? createPreviewSaveStorageHost(createSaveGameStorage(), previewProjectId, {
        source: () => previewIframeRef.current?.contentWindow,
        origin: () => previewOriginRef.current,
        send: (message) => previewIframeRef.current?.contentWindow?.postMessage(message, previewOriginRef.current),
      }) : null;
      setPreviewSrc(previewTarget.src);
      setPreviewOpen(true);
    } catch (error) {
      if (isCurrentRequest()) {
        previewFilesRef.current = null;
        fail(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (isCurrentRequest()) {
        preparingRef.current = false;
        setPreparing(false);
        setPreviewPhase(null);
      }
    }
  }, [appendLog, appSettings.traceByteBudget, playFromScene, playing]);

  const requestPlay = useCallback(
    async (options?: PlayOptions) => {
      if (previewBuild) {
        await requestPreviewBuild();
        return;
      }
      if (playing || preparingRef.current) return;
      // Read at call time (see playRequestInputsRef); shadows the render values.
      const {
        documents: {
          activeDocumentId,
          assetRegistry,
          collectPlayAnimGraphs,
          collectPlayAreaEmissions,
          collectPlayAudio,
          collectPlayBehaviourTrees,
          collectPlayBlackboards,
          collectPlayFontCssStacks,
          collectPlayFontFaceEntries,
          collectPlayFontFacetypeBytes,
          collectPlayFontMsdfPair,
          collectPlayInputAssets,
          collectPlayMaterialLibrary,
          collectPlayModelBytes,
          collectPlayModelPayloads,
          collectPlayParticles,
          collectPlayPreviewScripts,
          collectPlayRenderTargets,
          collectPlayDataAssets,
          collectPlaySceneLayers,
          collectPlaySceneLibrary,
          collectPlaySpriteAnimationPayloads,
          collectPlaySpritePayloads,
          collectPlayTextureBytes,
          collectPlayTexturePixelSizes,
          collectPlayTilemapContent,
          collectPlayWaterContent,
          currentGraphSignature,
          dirtyDocuments,
          graphsNeedCompile,
          migrationPending,
          openDocuments,
          playLoadedSignature,
          playPreviewBundles,
          playPreviewDiagnostics,
          projectDirty,
          projectDocument,
          readAssetChunk,
          saveAll,
        },
        hasStartupScene,
        openPlaySceneGuid,
      } = playRequestInputsRef.current;
      if (
        !playIsEnabled(openDocuments, activeDocumentId, {
          playFromScene,
          hasStartupScene,
        })
      ) {
        if (!hasStartupScene) setStartupAlertOpen(true);
        return;
      }
      pendingPlayOptionsRef.current = options;
      const inject = Boolean(options?.injectFixtureThrow);
      const plan = planPlayPreviewPrepare({
        dirtyDocuments: [
          ...dirtyDocuments.map((doc) => ({ label: doc.ref.label })),
          ...(projectDirty ? [{ label: "Project Settings" }] : []),
        ],
        scriptsStale: graphsNeedCompile,
        migrationPending: migrationPending.length > 0,
      });

      if (plan.action === "migrate") {
        setPlayAwaitingMigration(true);
        return;
      }

      preparingRef.current = true;
      setPreparing(true);
      try {
        if (plan.action === "prepare") {
          setPrepareState({
            phase: plan.needsSave ? "saving" : "compiling",
            dirtyNames: plan.dirtyNames,
          });
          if (plan.needsSave) {
            const saved = await saveAll();
            if (!saved) {
              setPrepareState(null);
              setPlayAwaitingMigration(true);
              return;
            }
          }
          setPrepareState({
            phase: "compiling",
            dirtyNames: plan.dirtyNames,
          });
        }

        const shouldCompile = playBundlesNeedCollect({
          playLoadedSignature,
          currentGraphSignature,
          scriptsLength: playPreviewBundles.length,
        });
        let nextScripts = playPreviewBundles;
        let nextDiagnostics = playPreviewDiagnostics;
        if (shouldCompile) {
          const result = await collectPlayPreviewScripts();
          nextScripts = result.bundles;
          nextDiagnostics = result.diagnostics;
        }
        setScripts(nextScripts);
        setDiagnostics(nextDiagnostics);
        // Snapshot saved and open data once for both worker and in-process Play.
        setPlayDataAssets(await collectPlayDataAssets());
        let playLibrary: Array<{
          guid: string;
          scene: import("@babylonslate/core").SerializedScene;
        }> = [];
        try {
          playLibrary = await collectPlaySceneLibrary();
          setPlaySceneLibrary(playLibrary);
        } catch (error) {
          appendLog(
            `Scene library failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlaySceneLibrary([]);
        }
        const effectiveGuid = resolvePreviewStartupGuid({
          playFromScene,
          openSceneGuid: openPlaySceneGuid,
          startupSceneGuid: projectDocument?.settings.startupSceneGuid ?? null,
        });
        const fromLibrary = effectiveGuid
          ? playLibrary.find((entry) => entry.guid === effectiveGuid)
          : undefined;
        const resolvedScene = resolvePlayScene({
          documents: openDocuments,
          activeDocumentId,
          playFromScene,
          fallback: fromLibrary
            ? {
                sceneAssetGuid: fromLibrary.guid,
                scene: fromLibrary.scene,
                path: assetRegistry?.getByGuid(fromLibrary.guid)?.path,
              }
            : null,
        });
        setSessionPlayScene(resolvedScene);
        if (!resolvedScene) {
          setStartupAlertOpen(true);
          return;
        }
        const prefabScene = playPrefabDependencyScene(nextScripts);
        const prefabScenes = prefabScene ? [prefabScene] : [];
        let overlayScenes: import("@babylonslate/core").SerializedScene[] = [];
        let overlayGraphMaterials: string[] = [];
        try {
          const collected = await collectPlaySceneLayers([
            resolvedScene.scene,
            ...playLibrary.map((entry) => entry.scene),
            ...prefabScenes,
          ]);
          setPlaySceneLayers(collected.layers);
          overlayScenes = collected.overlayScenes;
          overlayGraphMaterials = collected.graphMaterialGuids;
        } catch (error) {
          appendLog(
            `SceneLayer library failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlaySceneLayers([]);
        }
        const resourceScenes = [...overlayScenes, ...prefabScenes];
        const skyboxTextureGuids = [resolvedScene.scene, ...resourceScenes]
          .flatMap(skyboxFaceGuidsFromScene);
        // Project effect textures (the grading LUT) load with scene environment cubes.
        const environmentTextureGuids = [...new Set([
          ...environmentTextureGuidsFromScenes([
            resolvedScene.scene, ...playLibrary.map((entry) => entry.scene), ...resourceScenes,
          ]),
          ...renderEffectsAssetGuids(projectDocument?.settings.render.effects),
        ])];
        const postProcessTextureGuids = postProcessTextureGuidsFromScenes([
          resolvedScene.scene, ...playLibrary.map((entry) => entry.scene), ...resourceScenes,
        ]);
        let playGraphs: typeof playAnimGraphs = [];
        try {
          playGraphs = await collectPlayAnimGraphs(
            resolvedScene?.scene,
            resourceScenes,
          );
          setPlayAnimGraphs(playGraphs);
        } catch (error) {
          appendLog(
            `AnimationGraph load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayAnimGraphs([]);
        }
        let playTrees: typeof playBehaviourTrees = [];
        try {
          playTrees = await collectPlayBehaviourTrees(
            resolvedScene?.scene,
            resourceScenes,
          );
          setPlayBehaviourTrees(playTrees);
        } catch (error) {
          appendLog(
            `BehaviourTree load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayBehaviourTrees([]);
        }
        try {
          setPlayBlackboards(
            await collectPlayBlackboards(resolvedScene?.scene, resourceScenes),
          );
        } catch (error) {
          appendLog(
            `Blackboard load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayBlackboards([]);
        }
        let sprites = new Map<string, SpritePayload>();
        let spriteAnimations = new Map<string, SpriteAnimationPayload>();
        let tilesets = new Map<string, TilesetPayload>();
        let textureBytes = new Map<string, Uint8Array>();
        let texturePixelSizes = new Map<string, { width: number; height: number }>();
        try {
          sprites = await collectPlaySpritePayloads(
            resolvedScene?.scene,
            playGraphs,
            resourceScenes,
          );
          setPlaySpritePayloads(sprites);
        } catch (error) {
          appendLog(
            `Sprite payload load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlaySpritePayloads(new Map());
        }
        try {
          spriteAnimations = await collectPlaySpriteAnimationPayloads(
            playGraphs,
            playTrees,
          );
          setPlaySpriteAnimationPayloads(spriteAnimations);
        } catch (error) {
          appendLog(
            `Sprite Animation load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlaySpriteAnimationPayloads(new Map());
        }
        try {
          const tileContent = await collectPlayTilemapContent(
            resolvedScene?.scene,
            resourceScenes,
          );
          setPlayTilemaps(tileContent.tilemaps);
          setPlayTilesets(tileContent.tilesets);
          tilesets = tileContent.tilesets;
        } catch (error) {
          appendLog(
            `Tilemap load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayTilemaps(new Map());
          setPlayTilesets(new Map());
        }
        let modelPayloads = new Map<string, ModelPayload>();
        try {
          setPlayModelBytes(
            await collectPlayModelBytes(resolvedScene?.scene, resourceScenes),
          );
          modelPayloads = await collectPlayModelPayloads(
            resolvedScene?.scene,
            resourceScenes,
          );
          setPlayModelPayloads(modelPayloads);
          setPlayModelClipAnimationGuids(
            modelClipAnimationGuidsFromAssets(assetRegistry?.list() ?? []),
          );
          setPlayRetargetAnimationLoads(
            retargetAnimationLoadsFromAssets(assetRegistry?.list() ?? []),
          );
        } catch (error) {
          appendLog(
            `Model load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayModelBytes(new Map());
          setPlayModelPayloads(new Map());
          setPlayModelClipAnimationGuids(new Map());
          setPlayRetargetAnimationLoads(new Map());
        }

        try {
          setPlayRenderTargets(await collectPlayRenderTargets());
          const waters = await collectPlayWaterContent();
          setPlayWaters(waters);
          const particles = await collectPlayParticles();
          setPlayParticleLibrary(particles);
          const materials = await collectPlayMaterialLibrary(
            resolvedScene?.scene,
            [
              ...playLibrary.map((entry) => entry.scene),
              ...resourceScenes,
            ],
            [
              ...[...waters.values()].flatMap((water) => water.materialGuid ? [water.materialGuid] : []),
              ...particleLibraryMaterialGuids(particles),
              ...modelSlotMaterialGuidsFromPayloads(modelPayloads),
              ...overlayGraphMaterials,
            ],
          );
          setPlayMaterialDocuments(materials.documents);
          setPlayMaterialFunctions(materials.functions);
          textureBytes = await collectPlayTextureBytes(
            sprites,
            tilesets,
            [
              ...materials.textureGuids,
              ...skyboxTextureGuids,
              ...environmentTextureGuids,
              ...overlayTextureGuidsFromScenes(resourceScenes),
              ...postProcessTextureGuids,
            ],
            spriteAnimations,
            true,
          );
          texturePixelSizes = collectPlayTexturePixelSizes(
            sprites,
            tilesets,
            [
              ...materials.textureGuids,
              ...skyboxTextureGuids,
              ...environmentTextureGuids,
              ...overlayTextureGuidsFromScenes(resourceScenes),
              ...postProcessTextureGuids,
            ],
            spriteAnimations,
          );
          setPlayTextureBytes(textureBytes);
          setPlayTexturePixelSizes(texturePixelSizes);
        } catch (error) {
          appendLog(
            `Material load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayWaters(new Map());
          setPlayRenderTargets({ renderTargets: new Map(), renderTargetTextures: new Map() });
          setPlayMaterialDocuments(new Map());
          setPlayMaterialFunctions(new Map());
          setPlayParticleLibrary(emptyParticleLibrary());
          try {
            textureBytes = await collectPlayTextureBytes(
              sprites,
              tilesets,
              [
                ...skyboxTextureGuids,
                ...environmentTextureGuids,
                ...overlayTextureGuidsFromScenes(resourceScenes),
                ...postProcessTextureGuids,
              ],
              spriteAnimations,
              true,
            );
            texturePixelSizes = collectPlayTexturePixelSizes(
              sprites,
              tilesets,
              [
                ...skyboxTextureGuids,
                ...environmentTextureGuids,
                ...overlayTextureGuidsFromScenes(resourceScenes),
                ...postProcessTextureGuids,
              ],
              spriteAnimations,
            );
            setPlayTextureBytes(textureBytes);
            setPlayTexturePixelSizes(texturePixelSizes);
          } catch (textureError) {
            appendLog(
              `Texture load failed: ${textureError instanceof Error ? textureError.message : String(textureError)}`,
            );
            setPlayTextureBytes(new Map());
            setPlayTexturePixelSizes(new Map());
          }
        }
        spriteAnimations = hydrateSpriteAnimationPixelSizes(
          spriteAnimations,
          textureBytes,
        );
        setPlaySpriteAnimationPayloads(spriteAnimations);

        const fontScenes = [
            resolvedScene?.scene,
            ...playLibrary.map((entry) => entry.scene),
            ...resourceScenes,
          ];
        try {
          // Do not let a failed new session reuse the previous session's data.
          setPlayAreaEmissions(new Map());
          setPlayAreaEmissions(await collectPlayAreaEmissions(fontScenes, true));
        } catch (error) {
          appendLog(`Area-light emission load failed: ${error instanceof Error ? error.message : String(error)}`);
          setPrepareState(null);
          return;
        }
        try {
          setPlayFontFacetypeBytes(
            await collectPlayFontFacetypeBytes(
              resolvedScene?.scene,
              [
                ...playLibrary.map((entry) => entry.scene),
                ...resourceScenes,
              ],
            ),
          );
          const msdf = fontMsdfMapsFromPairs(
            await collectPlayFontMsdfPair(resolvedScene?.scene, fontScenes.slice(1)),
          );
          setPlayFontMsdfJson(msdf.json);
          setPlayFontMsdfPng(msdf.png);
          setPlayFontFaceEntries(await collectPlayFontFaceEntries());
          const fontCss = collectPlayFontCssStacks();
          setPlayFontCssStack(fontCss.fontCssStack);
          setPlayFontCssStackByGuid(fontCss.fontCssStackByGuid);
        } catch (error) {
          appendLog(
            `3D Text font load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayFontFacetypeBytes(new Map());
          setPlayFontMsdfJson(new Map());
          setPlayFontMsdfPng(new Map());
          setPlayFontFaceEntries([]);
          setPlayFontCssStack("sans-serif");
          setPlayFontCssStackByGuid(new Map());
        }

        setPlayInputAssets(await collectPlayInputAssets());
        try {
          const audio = await collectPlayAudio();
          setPlayAudioSourceLoader(() => audio.loadSourceBytes);
          setPlayAudioLibrary(audio.library);
        } catch (error) {
          appendLog(
            `Audio load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayAudioSourceLoader(undefined);
          setPlayAudioLibrary(emptyPlayAudioLibrary());
        }
        const bakedSceneGuid = canonicalPlaySceneGuid(resolvedScene, (path) =>
          assetRegistry?.list().find((asset) => asset.path === path)?.header.guid ?? null);
        const sceneBakes = await readPlaySceneBakes([
          ...playLibrary.map(({ guid }) => ({ guid, path: assetRegistry?.getByGuid(guid)?.path })),
          { guid: bakedSceneGuid, path: resolvedScene.path },
        ], readAssetChunk, (guid, chunkId, error) => {
          appendLog(`${chunkId} load failed for ${guid}: ${error instanceof Error ? error.message : String(error)}`);
        });
        setPlaySceneNavmeshBytes(sceneBakes.navmeshes);
        setPlayAudioReverbByScene(sceneBakes.audioReverbs);
        setPlayNavmeshBytes(sceneBakes.navmeshes.get(bakedSceneGuid) ?? null);
        setPlayAudioReverbBytes(sceneBakes.audioReverbs.get(bakedSceneGuid) ?? null);

        setPlaySaveGame(await prepareSaveGameConfiguration({
          projectId: playRequestInputsRef.current.documents.projectGuid,
          settings: projectDocument?.settings.saveGame,
          loadDefinition: async (guid) => {
            const current = playRequestInputsRef.current.documents;
            const asset = current.assetRegistry?.getByGuid(guid);
            if (!asset) throw new Error("The default Save Game definition is missing.");
            return current.loadAssetDocument("save-game", asset.path);
          },
        }));
        setPrepareState(null);

        if (!inject && projectHasBlockingErrors(nextDiagnostics)) {
          pendingScriptsRef.current = nextScripts;
          setBlockedDiagnostics(nextDiagnostics);
          setPlayBlockedOpen(true);
          return;
        }

        launchPlay({ injectFixtureThrow: inject, scripts: nextScripts });
      } catch (error) {
        appendLog(
          `Script compile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        setPrepareState(null);
        setScripts([]);
        if (inject) {
          launchPlay({ injectFixtureThrow: true, scripts: [] });
        }
      } finally {
        preparingRef.current = false;
        setPreparing(false);
      }
    },
    [
      appendLog,
      launchPlay,
      playFromScene,
      playing,
      previewBuild,
      requestPreviewBuild,
      setDiagnostics,
    ],
  );

  const resumePlayAfterMigration = useCallback(async () => {
    setPlayAwaitingMigration(false);
    setPlayResumeRequested(true);
  }, []);

  useEffect(() => {
    if (!playResumeRequested || migrationPending.length > 0) return;
    // Resume only after the cleared migrations and current project reach this
    // render; requestPlay reads them from the inputs its layout effect stored.
    setPlayResumeRequested(false);
    void requestPlay(pendingPlayOptionsRef.current);
  }, [migrationPending.length, playResumeRequested, requestPlay]);

  const cancelPlayMigration = useCallback(() => {
    setPlayAwaitingMigration(false);
    setPlayResumeRequested(false);
    pendingPlayOptionsRef.current = undefined;
  }, []);

  const handleClose = useCallback(
    (result: PlaySessionResult) => {
      setPlaying(false);
      setSessionPlayScene(null);
      setEncodeQueuePauseReason("play", false);
      reportBtState(null);
      setDropped(result.droppedDiagnostics);
      setReportEntries(result.diagnostics);
      setLastRuntimeMode(result.runtimeMode);
      if (result.diagnostics.length > 0) {
        setReportOpen(true);
      }
      appendLog(
        `Play ended (${result.runtimeMode}; textures ${result.textureCountBefore}→pending)`,
      );
      void result.released.then(({ textureCountAfter, textureLeak }) => {
        appendLog(
          `Play textures ${result.textureCountBefore}→${textureCountAfter}`,
        );
        if (textureLeak) {
          appendLog(
            `Texture leak detected: ${result.textureCountBefore} → ${textureCountAfter}`,
          );
        }
      });
      if (result.lastTrace) {
        void openRecordedTrace(result.lastTrace);
      }
    },
    [appendLog, openRecordedTrace, reportBtState],
  );

  const value = useMemo<PlayContextValue>(
    () => ({
      playing,
      preparing,
      playAwaitingMigration,
      requestPlay,
      canPlay,
      previewBuild,
      setPreviewBuild,
      playFromScene,
      setPlayFromScene,
      overlayStats,
      overlayConsole,
      overlayInspector,
      pauseOnPlay,
      setOverlayStats,
      setOverlayConsole,
      setOverlayInspector,
      setPauseOnPlay,
      launchPlay,
      resumePlayAfterMigration,
      cancelPlayMigration,
      registerSharedEngine,
      ensureSharedEngine: ensureEngine,
      sharedEngineGeneration,
      registerScheduler,
      focusedNodeId,
      clearFocusedNode: () => setFocusedNodeId(null),
      appendLog,
      reportBtState,
    }),
    [
      playing,
      preparing,
      playAwaitingMigration,
      requestPlay,
      canPlay,
      previewBuild,
      setPreviewBuild,
      playFromScene,
      setPlayFromScene,
      overlayStats,
      overlayConsole,
      overlayInspector,
      pauseOnPlay,
      setOverlayStats,
      setOverlayConsole,
      setOverlayInspector,
      setPauseOnPlay,
      launchPlay,
      resumePlayAfterMigration,
      cancelPlayMigration,
      registerSharedEngine,
      ensureEngine,
      sharedEngineGeneration,
      registerScheduler,
      focusedNodeId,
      appendLog,
      reportBtState,
    ],
  );

  return (
    <PlayContext.Provider value={value}>
        {children}
        {projectOpen && (projectEngineState.phase === "preparing" || projectEngineState.phase === "initializing" ||
          (projectEngineState.phase === "failed" && !renderingFailureDismissed)) ? (
          <ProjectRenderingDialog state={projectEngineState}
            onRetry={() => { setRenderingFailureDismissed(false); void projectEngine.sync(renderingRequest, true); }}
            onDismiss={() => setRenderingFailureDismissed(true)} />
        ) : null}
        {previewPhase || previewPreparationError ? (
          <PreparingPreviewDialog
            open
            phase={previewPhase}
            error={previewPreparationError}
            canCancel={previewCanCancel}
            onRetry={() => { void requestPreviewBuild(); }}
            onCancel={() => {
              previewRequestRef.current += 1;
              setPreviewPhase(null);
              setPreviewPreparationError(null);
              preparingRef.current = false;
              setPreparing(false);
            }}
          />
        ) : null}
        <AlertDialog open={startupAlertOpen} onOpenChange={setStartupAlertOpen}>
          <AlertDialogContent data-testid="startup-scene-alert">
            <AlertDialogHeader>
              <AlertDialogTitle>Startup Scene Required</AlertDialogTitle>
              <AlertDialogDescription>
                {MISSING_STARTUP_SCENE_MESSAGE}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction
                data-testid="startup-scene-alert-ok"
                onClick={() => setStartupAlertOpen(false)}
              >
                OK
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {prepareState ? (
          <PlayPrepareDialog
            open
            phase={prepareState.phase}
            dirtyNames={prepareState.dirtyNames}
          />
        ) : null}
        <PlayBlockedDialog
          open={playBlockedOpen}
          diagnostics={blockedDiagnostics}
          onOpenChange={setPlayBlockedOpen}
          onNavigate={(d) => {
            setFocusDiagnostic(d);
            const revealId = documentIdToRevealForDiagnostic(
              d,
              openDocuments.map((doc) => doc.id),
            );
            if (revealId) setActiveDocument(revealId);
            setPlayBlockedOpen(false);
          }}
          onPlayAnyway={() => {
            setPlayBlockedOpen(false);
            launchPlay({
              injectFixtureThrow: pendingPlayOptionsRef.current?.injectFixtureThrow,
              scripts: pendingScriptsRef.current ?? scripts,
            });
          }}
        />
        {playing && !previewOpen && engineRef.current ? (
          <PlayOverlay
            sharedEngine={engineRef.current}
            injectFixtureThrow={injectThrow}
            scripts={scripts}
            physics={playPhysics}
            sceneAssetGuid={playSceneGuid}
            scene={playScene?.scene}
            project={projectDocument?.metadata}
            saveGame={playSaveGame}
            gameInstanceClass={resolveGameInstanceClass(
              projectDocument?.settings,
              playScene?.scene,
            )}
            scenes={playSceneLibrary}
            sceneLayers={playSceneLayers}
            animGraphs={playAnimGraphs}
            behaviourTrees={playBehaviourTrees}
            blackboards={playBlackboards}
            spritePayloads={playSpritePayloads}
            spriteAnimationPayloads={playSpriteAnimationPayloads}
            waterPayloads={playWaters}
            renderTargets={playRenderTargets.renderTargets}
            renderTargetTextures={playRenderTargets.renderTargetTextures}
            tilemapPayloads={playTilemaps}
            tilesetPayloads={playTilesets}
            textureBytes={playTextureBytes}
            texturePixelSizes={playTexturePixelSizes}
            fontFacetypeBytes={playFontFacetypeBytes}
            areaEmissions={playAreaEmissions}
            fontMsdfJson={playFontMsdfJson}
            fontMsdfPng={playFontMsdfPng}
            fontFaceEntries={playFontFaceEntries}
            fontCssStack={playFontCssStack}
            fontCssStackByGuid={playFontCssStackByGuid}
            modelBytes={playModelBytes}
            modelPayloads={playModelPayloads}
            modelClipAnimationGuids={playModelClipAnimationGuids}
            retargetAnimationLoads={playRetargetAnimationLoads}
            loadAudioSourceBytes={playAudioSourceLoader}
            audioLibrary={playAudioLibrary}
            animClipCatalog={animClipCatalogFromAssets(assetRegistry?.list() ?? [])}
            particleLibrary={playParticleLibrary}
            materialDocuments={playMaterialDocuments}
            materialFunctions={playMaterialFunctions}
            postProcessingEnabled={postProcessingEnabled}
            hardwareScalingLevel={hardwareScalingLevel}
            pauseOnPlay={pauseOnPlay}
            navmeshBytes={playNavmeshBytes}
            sceneNavmeshBytes={playSceneNavmeshBytes}
            audioReverbByScene={playAudioReverbByScene}
            audioReverbBytes={playAudioReverbBytes}
            audioProjectSettings={projectDocument?.settings.audio}
            inputAssets={playInputAssets}
            dataAssets={playDataAssets}
            inputMappings={projectDocument?.settings.input}
            focusNavigation={projectDocument?.settings.focusNavigation}
            sortingLayers={projectDocument?.settings.twoD.sortingLayers}
            pixelsPerUnit={
              projectDocument?.settings.twoD.pixelsPerUnit ?? 100
            }
            pixelPerfect={projectDocument?.settings.twoD.pixelPerfect === true}
            touchMinTargetPx={
              projectDocument?.settings.touchMinTargetPx ?? 44
            }
            frameCap={
              projectDocument?.settings.playFrameCap ?? DEFAULT_PLAY_FRAME_CAP
            }
            infiniteLoopDetection={
              projectDocument?.settings.infiniteLoopDetection ??
              DEFAULT_INFINITE_LOOP_DETECTION
            }
            loopCount={
              projectDocument?.settings.loopCount ?? DEFAULT_LOOP_COUNT
            }
            playPreview={
              projectDocument?.settings.playPreview ??
              DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS
            }
            render={projectDocument?.settings.render}
            onClose={handleClose}
          />
        ) : null}
        {previewOpen ? (
          <PreviewBuildOverlay
            src={previewSrc}
            iframeRef={previewIframeRef}
            error={previewError}
            onClose={closePreview}
            onLoad={sendPreviewPack}
            onTrace={(trace) => void openRecordedTrace(trace)}
          />
        ) : null}
        <PreviewSessionReport
          open={reportOpen}
          entries={reportEntries}
          dropped={dropped}
          onOpenChange={setReportOpen}
          onNavigate={(entry) => {
            const nav = sessionReportNavigation(entry, {
              getByGuid: (guid) => assetRegistry?.getByGuid(guid),
            });
            setFocusedNodeId(nav.focusedNodeId || PREVIEW_FIXTURE_NODE_ID);
            setFocusDiagnostic({
              severity: entry.severity,
              code: entry.code,
              message: entry.message,
              assetGuid: entry.assetGuid ?? "",
              graphId: entry.graphId ?? "",
              nodeId: nav.focusedNodeId || undefined,
              bodyLine: nav.bodyLine ?? entry.bodyLine,
            });
            if (nav.document) {
              void openDocument(nav.document);
            }
            setReportOpen(false);
            appendLog(
              `Navigate to node ${nav.focusedNodeId || PREVIEW_FIXTURE_NODE_ID}`,
            );
          }}
        />
        {/* Focus marker for Playwright / graph navigation hook. */}
        {focusedNodeId ? (
          <span
            className="sr-only"
            data-testid="focused-graph-node"
            data-node-id={focusedNodeId}
          >
            {focusedNodeId}
          </span>
        ) : null}
        {lastRuntimeMode ? (
          <span
            className="sr-only"
            data-testid="play-last-runtime"
            data-mode={lastRuntimeMode}
          >
            {lastRuntimeMode}
          </span>
        ) : null}
    </PlayContext.Provider>
  );
}

export function usePlay(): PlayContextValue {
  const ctx = useContext(PlayContext);
  if (!ctx) {
    throw new Error("usePlay requires PlayProvider");
  }
  return ctx;
}

export function useOptionalPlay(): PlayContextValue | null {
  return useContext(PlayContext);
}

/**
 * Output Log and live BT writers only. Stable for the provider's lifetime, so
 * a caller that only logs does not re-render when Play state changes.
 */
export function usePlayDiagnosticsActions(): Pick<
  PlayContextValue,
  "appendLog" | "reportBtState"
> {
  const actions = useContext(PlayDiagnosticsActionsContext);
  if (!actions) {
    throw new Error("usePlayDiagnosticsActions requires PlayProvider");
  }
  return actions;
}

export function useOutputLog(): { lines: string[] } {
  return useContext(OutputLogContext);
}

/** Subscribe only the behaviour-tree debugger to live snapshots. */
export function useLiveBtState(): LiveBtState | null {
  return useContext(LiveBtStateContext);
}
