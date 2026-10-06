import { prepareSaveGameConfiguration } from "../services/save-game-configuration";
import { acquirePlayAssetSources, emptyPlaySourceControls, mergePreparedPlaySources, requiredProjectAssets, type PlayAssetSourceHost } from "../services/play-asset-sources";
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
import type { SceneSourceAssets } from "@babylonslate/render";
import { shouldPackKtx2ForPreviewBuild, webGpuMaterialCompatibilityReason } from "@babylonslate/render";
import {
  DEFAULT_INFINITE_LOOP_DETECTION,
  DEFAULT_LOOP_COUNT,
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  engineCommandBus,
  isErr,
  normalizeRenderingPipeline,
  resolveGameInstanceClass,
} from "@babylonslate/core";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";
import { emptyPlayAudioLibrary, type PlayAudioLibrary, type PlayAudioSourceLoader } from "../lib/play-audio";
import { appendOutputLogLine } from "../lib/output-log-ring";
import { classIdFromClassAsset } from "../lib/content-browser-helpers";
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
  createPreviewAssetServer,
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
  emptyParticleLibrary,
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
import { planPlayPreviewPrepare } from "../services/play-preview-prepare";
import { projectHasBlockingErrors } from "../services/graph-validation";
import type { PlayPreparePhase } from "../components/play-prepare-dialog";
import { animClipCatalogFromAssets } from "../lib/anim-clip-catalog";
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
  const previewAssetHostRef = useRef<ReturnType<typeof createPreviewAssetServer> | null>(null);
  const playSourceHostRef = useRef<PlayAssetSourceHost | null>(null);
  const playSourceLifetimeRef = useRef<AbortController | null>(null);
  const playSourceSetsRef = useRef(new Set<Awaited<ReturnType<typeof acquirePlayAssetSources>>>());
  const initialPlaySourceRef = useRef<Awaited<ReturnType<typeof acquirePlayAssetSources>> | null>(null);
  const [sessionSources, setSessionSources] = useState<SceneSourceAssets>();
  const acquireAssetSources = useCallback(async (
    guids: readonly string[],
    options: { consumer: string; signal: AbortSignal; onProgress?: (progress: number) => void; fontModes?: import("@babylonslate/render").CommandFontModes },
  ) => {
    const host = playSourceHostRef.current;
    const lifetime = playSourceLifetimeRef.current;
    if (!host || !lifetime) throw new Error("The Play asset session is closed.");
    const prepared = await acquirePlayAssetSources(host, guids, {
      ...options, signal: AbortSignal.any([options.signal, lifetime.signal]),
      onProgress: ({ completed, total }) => options.onProgress?.(total ? completed / total : 1),
    });
    if (playSourceHostRef.current !== host) { prepared.release(); throw new Error("The project changed during asset preparation."); }
    playSourceSetsRef.current.add(prepared);
    return {
      ...prepared,
      controls: mergePreparedPlaySources(playSourceSetsRef.current)?.controls ?? emptyPlaySourceControls(),
      getControls: () => mergePreparedPlaySources(playSourceSetsRef.current)?.controls ?? emptyPlaySourceControls(),
      release: () => { playSourceSetsRef.current.delete(prepared); prepared.release(); },
      controlsAfterRelease: () => mergePreparedPlaySources(playSourceSetsRef.current)?.controls ?? emptyPlaySourceControls(),
    };
  }, []);
  const acquireSceneSources = useCallback(async (guid: string, options: { consumer: string; signal: AbortSignal }) => {
    const prepared = await acquireAssetSources([guid], options);
    const scene = prepared.game.scenes.get(guid);
    if (!scene) { prepared.release(); throw new Error(`Scene ${guid} could not be prepared.`); }
    return { ...prepared, scene };
  }, [acquireAssetSources]);
  const releaseInitialSources = useCallback(() => {
    const prepared = initialPlaySourceRef.current;
    if (prepared) {
      playSourceSetsRef.current.delete(prepared);
      prepared.release();
      initialPlaySourceRef.current = null;
    }
    setSessionPlayScene(null);
    setPlaySceneLibrary([]);
    setPlaySceneLayers([]);
    setPlayAnimGraphs([]);
    setPlayBehaviourTrees([]);
    setPlayBlackboards([]);
    setPlayDataAssets([]);
    setPlaySpritePayloads(new Map());
    setPlaySpriteAnimationPayloads(new Map());
    setPlayTilemaps(new Map());
    setPlayTilesets(new Map());
    setPlayModelBytes(new Map());
    setPlayModelPayloads(new Map());
    setPlayModelClipAnimationGuids(new Map());
    setPlayRetargetAnimationLoads(new Map());
    setPlayTextureBytes(new Map());
    setPlayTexturePixelSizes(new Map());
    setPlayAreaEmissions(new Map());
    setPlayFontFacetypeBytes(new Map());
    setPlayFontMsdfJson(new Map());
    setPlayFontMsdfPng(new Map());
    setPlayFontFaceEntries([]);
    setPlayFontCssStackByGuid(new Map());
    setPlayMaterialDocuments(new Map());
    setPlayMaterialFunctions(new Map());
    setPlayRenderTargets({ renderTargets: new Map(), renderTargetTextures: new Map() });
    setPlayWaters(new Map());
    setPlayAudioLibrary(emptyPlayAudioLibrary());
    setPlayParticleLibrary(emptyParticleLibrary());
    setPlaySceneNavmeshBytes(new Map());
    setPlayAudioReverbByScene(new Map());
    setPlayNavmeshBytes(null);
    setPlayAudioReverbBytes(null);
  }, []);
  const releasePlaySources = useCallback(() => {
    playSourceLifetimeRef.current?.abort();
    playSourceLifetimeRef.current = null;
    playSourceHostRef.current = null;
    releaseInitialSources();
    for (const sources of playSourceSetsRef.current) sources.release();
    playSourceSetsRef.current.clear();
    setSessionSources(undefined);
    setPlayInputAssets([]);
    setPlayAudioSourceLoader(undefined);
    setScripts([]);
    pendingScriptsRef.current = null;
  }, [releaseInitialSources]);
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
    releasePlaySources();
    setScripts([]);
    setPlaying(false);
    setSessionPlayScene(null);
    setPrepareState(null);
    setPlayBlockedOpen(false);
    setBlockedDiagnostics([]);
    setPlayAwaitingMigration(false);
    pendingScriptsRef.current = null;
    pendingPlayOptionsRef.current = undefined;
  }, [projectDocument, releasePlaySources]);

  useEffect(() => () => releasePlaySources(), [projectGuid, releasePlaySources]);

  const renderingRequest = useMemo(() => projectOpen && projectGuid ? {
    projectGuid,
    backend: requestedBackend,
    async prepare(signal: AbortSignal) {
      await waitForSceneLoadingPaint(signal);
      signal.throwIfAborted();
      return undefined;
    },
  } : null, [projectOpen, projectGuid, requestedBackend]);

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
        releasePlaySources();
        return;
      }
      setEncodeQueuePauseReason("play", true);
      setInjectThrow(Boolean(options?.injectFixtureThrow));
      if (options?.scripts) {
        setScripts(options.scripts);
      }
      setPlaying(true);
    },
    [appendLog, ensureEngine, releasePlaySources],
  );

  const closePreview = useCallback(() => {
    previewClosingRef.current = true;
    previewAssetHostRef.current?.dispose();
    previewAssetHostRef.current = null;
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
      previewAssetHostRef.current?.dispose();
      previewAssetHostRef.current = createPreviewAssetServer({
        files: handoff.files,
        send: (message, transfer) => frame.postMessage(message, previewOriginRef.current, transfer),
      });
      frame.postMessage(previewPackFromFiles(handoff.files, {
        traceByteBudget: previewTraceByteBudgetRef.current,
        onDemand: true,
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
      if (previewAssetHostRef.current?.receive(event.data)) return;
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
      previewAssetHostRef.current?.dispose();
      previewAssetHostRef.current = null;
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
          activeDocumentId, assetRegistry, collectPlayInputAssets, collectPlayPreviewScripts,
          dirtyDocuments, graphsNeedCompile, migrationPending, openDocuments,
          projectDirty, projectDocument, saveAll,
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

        if (!assetRegistry || !projectDocument) throw new Error("No project catalog is available.");
        const effectiveGuid = resolvePreviewStartupGuid({
          playFromScene,
          openSceneGuid: openPlaySceneGuid,
          startupSceneGuid: projectDocument.settings.startupSceneGuid ?? null,
        });
        if (!effectiveGuid) { setStartupAlertOpen(true); return; }
        releasePlaySources();
        const lifetime = new AbortController();
        playSourceLifetimeRef.current = lifetime;
        const sourceHost: PlayAssetSourceHost = {
          registry: assetRegistry,
          project: projectDocument,
          createScope: playRequestInputsRef.current.documents.createAssetLoadScope,
          compile: collectPlayPreviewScripts,
        };
        playSourceHostRef.current = sourceHost;
        const projectAssets = requiredProjectAssets(assetRegistry, projectDocument);
        if (projectAssets.length) {
          const persistent = await acquirePlayAssetSources(sourceHost, projectAssets,
            { consumer: "Play Project Systems", signal: lifetime.signal });
          playSourceSetsRef.current.add(persistent);
          setSessionSources(persistent.sources);
        }
        const prepared = await acquirePlayAssetSources(sourceHost,
          [effectiveGuid, ...projectAssets],
          { consumer: `Play Scene ${effectiveGuid}`, signal: lifetime.signal, allowCompileErrors: true });
        if (playSourceHostRef.current !== sourceHost) { prepared.release(); throw new DOMException("Project changed during Play preparation", "AbortError"); }
        playSourceSetsRef.current.add(prepared);
        initialPlaySourceRef.current = prepared;
        const { game, content, sources } = prepared;
        if (requestedBackend === "webgpu") {
          const reason = webGpuMaterialCompatibilityReason(content.materialDocuments, content.materialFunctions);
          if (reason) {
            await projectEngine.sync({ projectGuid: playRequestInputsRef.current.documents.projectGuid!, backend: requestedBackend,
              prepare: async (signal) => { signal.throwIfAborted(); return reason; },
            }, true);
            lifetime.signal.throwIfAborted();
            registerSharedEngine(projectEngine.getSnapshot().session?.engine ?? null);
          }
        }
        const scene = game.scenes.get(effectiveGuid);
        if (!scene) throw new Error(`Scene ${effectiveGuid} did not produce a document.`);
        const resolvedScene = { sceneAssetGuid: effectiveGuid, scene, path: assetRegistry.getByGuid(effectiveGuid)?.path };
        setSessionPlayScene(resolvedScene);
        setPlaySceneLibrary([...game.scenes].map(([guid, scene]) => ({ guid, scene })));
        setPlaySceneLayers([...game.sceneLayers].map(([guid, layer]) => ({ guid, layer })));
        const nextScripts = game.scripts;
        const nextDiagnostics: Diagnostic[] = [...prepared.diagnostics];
        setScripts(nextScripts);
        setDiagnostics(nextDiagnostics);
        setPlayDataAssets(content.dataAssets);
        setPlayAnimGraphs(content.animGraphs);
        setPlayBehaviourTrees(content.behaviourTrees);
        setPlayBlackboards(content.blackboards);
        setPlaySpritePayloads(content.spritePayloads);
        setPlaySpriteAnimationPayloads(content.spriteAnimationPayloads);
        setPlayTilemaps(content.tilemapPayloads);
        setPlayTilesets(content.tilesetPayloads);
        setPlayModelBytes(game.modelBytes);
        setPlayModelPayloads(content.modelPayloads);
        setPlayModelClipAnimationGuids(content.modelClipAnimationGuids);
        setPlayRetargetAnimationLoads(content.retargetAnimationLoads);
        setPlayRenderTargets({ renderTargets: content.renderTargets, renderTargetTextures: content.renderTargetTextures });
        setPlayWaters(content.waterPayloads);
        setPlayParticleLibrary(content.particleLibrary);
        setPlayMaterialDocuments(content.materialDocuments);
        setPlayMaterialFunctions(content.materialFunctions);
        setPlayTextureBytes(game.textureBytes);
        setPlayTexturePixelSizes(content.texturePixelSizes);
        setPlayAreaEmissions(game.areaEmissions);
        setPlayFontFacetypeBytes(game.fontFacetypeBytes);
        setPlayFontMsdfJson(game.fontMsdfJson);
        setPlayFontMsdfPng(game.fontMsdfPng);
        setPlayFontFaceEntries([...(sources.fonts ?? [])]);
        setPlayFontCssStack(sources.assets?.fontCssStack ?? "sans-serif");
        setPlayFontCssStackByGuid(new Map(sources.assets?.fontCssStackByGuid ?? []));
        setPlayInputAssets(await collectPlayInputAssets(prepared.required));
        setPlayAudioLibrary(content.audioLibrary);
        setPlayAudioSourceLoader(() => async ({ assetGuid, chunkId }: Parameters<PlayAudioSourceLoader>[0]) => {
          for (const entry of playSourceSetsRef.current) {
            const bytes = entry.audioChunks.get(assetGuid)?.get(chunkId);
            if (bytes) return bytes;
          }
          throw new Error(`Audio ${assetGuid} (${chunkId}) is not prepared for an active consumer.`);
        });
        setPlaySceneNavmeshBytes(game.navmeshBytes);
        setPlayAudioReverbByScene(game.audioReverbBytes);
        setPlayNavmeshBytes(game.navmeshBytes.get(effectiveGuid) ?? null);
        setPlayAudioReverbBytes(game.audioReverbBytes.get(effectiveGuid) ?? null);
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
        releasePlaySources();
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
      releasePlaySources,
      requestedBackend,
      projectEngine,
      registerSharedEngine,
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
      releasePlaySources();
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
    [appendLog, openRecordedTrace, reportBtState, releasePlaySources],
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
          onOpenChange={(open) => {
            setPlayBlockedOpen(open);
            if (!open && pendingScriptsRef.current) releasePlaySources();
          }}
          onNavigate={(d) => {
            setFocusDiagnostic(d);
            const revealId = documentIdToRevealForDiagnostic(
              d,
              openDocuments.map((doc) => doc.id),
            );
            if (revealId) setActiveDocument(revealId);
            releasePlaySources();
            setPlayBlockedOpen(false);
          }}
          onPlayAnyway={() => {
            const preparedScripts = pendingScriptsRef.current ?? scripts;
            pendingScriptsRef.current = null;
            setPlayBlockedOpen(false);
            launchPlay({
              injectFixtureThrow: pendingPlayOptionsRef.current?.injectFixtureThrow,
              scripts: preparedScripts,
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
            sceneCatalog={(assetRegistry?.list() ?? []).filter((asset) => asset.header.type === "Scene").map((asset) => ({ guid: asset.header.guid, name: asset.header.name }))}
            classAssetGuids={Object.fromEntries((assetRegistry?.list() ?? []).filter((asset) => asset.header.type === "Class").map((asset) => [classIdFromClassAsset(asset), asset.header.guid]))}
            audioAssetGuids={(assetRegistry?.list() ?? []).filter((asset) => asset.header.type === "Audio").map((asset) => asset.header.guid)}
            getAssetLoadState={documents.getAssetLoadState}
            getSourceControls={() => mergePreparedPlaySources(playSourceSetsRef.current)?.controls ?? emptyPlaySourceControls()}
            acquireSceneSources={acquireSceneSources}
            acquireAssetSources={acquireAssetSources}
            releaseInitialSources={releaseInitialSources}
            sessionSources={sessionSources}
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
