import { DiagnosticResultsProvider } from "./diagnostic-results-context";
import { createPortal } from "react-dom";
import { SimulationInspectionProvider } from "./simulation-inspection-context";
import { playAssetCatalog } from "../services/asset-catalog";
import { prepareSaveGameConfiguration } from "../services/save-game-configuration";
import { createSaveGameStorage, isTestModeEnabled } from "@babylonslate/vfs";
import { acquirePlayAssetSources, createMergedPlaySourceControls, playDocumentOverrides, requiredProjectAssets, type PlayAssetSourceHost } from "../services/play-asset-sources";
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
  documentId,
  engineCommandBus,
  isErr,
  normalizeRenderingPipeline,
  type CollisionTriangleMesh,
} from "@babylonslate/core";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";
import { emptyPlayAudioLibrary, type PlayAudioLibrary, type PlayAudioSourceLoader } from "../lib/play-audio";
import { appendOutputLogLines, OUTPUT_LOG_RING_CAP } from "../lib/output-log-ring";
import { createBtStateObservers, type BtStateObservers } from "../lib/bt-state-observers";
import { createFrameFlush } from "../lib/use-debug-console-logs";
import { classIdFromClassAsset } from "../lib/content-browser-helpers";
import { PlayFailedDialog, PlayPrepareDialog } from "../components/play-prepare-dialog";
import { PlayUnsavedDialog, type PlayUnsavedChoice } from "../components/play-unsaved-dialog";
import { PlayBlockedDialog } from "../components/play-blocked-dialog";
import { SimulationControlsProvider } from "./simulation-controls-context";
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
  simulationDefaultsFromSettings,
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
import type { SessionReportLocationSources } from "../lib/session-report-locations";
import type { PlaySessionResult } from "../services/play-session";
import { SimulationSession } from "../services/simulation-session";
import { simulationSceneDocument, type SimulationViewport } from "../services/simulation-viewport";
import { GameSessionOwner, transitionClosesSessionSource, type GameSessionState, type GameSessionTicket } from "../services/game-session-owner";
import { automatedSessionReportingHeld, publishPlaySessionClosed } from "../services/runtime-probes";
import { PREVIEW_FIXTURE_NODE_ID } from "../services/play-session";
import {
  canonicalPlaySceneGuid,
  playPhysicsFromOpenDocuments,
  playPhysicsFromSceneSettings,
  playSceneFromOpenDocuments,
  playSceneRefFromOpenDocuments,
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
  readStoredAssetDocument,
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
import { RenderingRetryError, retryProjectRendering, stopGameOnDeviceLoss } from "../lib/project-rendering-recovery";
import { waitForSceneLoadingPaint } from "../lib/scene-viewport-load";
import { ProjectRenderingDialog } from "../components/project-rendering-dialog";
import { RenderingFallbackNotice } from "../components/rendering-fallback-notice";

type PlayOptions = {
  /** Internal until the Simulation Inspector and authoring gates are qualified. */
  mode?: "play" | "simulate";
  injectFixtureThrow?: boolean;
  /** Answer from the Unsaved Changes prompt; unset means ask when dirty. */
  saveChoice?: PlayUnsavedChoice;
};

export type LiveBtState = {
  slotId: number;
  status: string;
  btNodeId: string | null;
  lastResults: Record<string, string>;
  blackboard: Record<string, unknown>;
  stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
};

interface PlayContextValue {
  sessionState: GameSessionState;
  sessionOwner: GameSessionOwner<PlaySessionResult>;
  requestSimulate: () => Promise<void>;
  canSimulate: boolean;
  simulationUnavailableReason: string | null;
  simulationDocumentId: string | null;
  registerSimulationViewport: (viewport: SimulationViewport) => () => void;
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
  overlayProfiler: boolean;
  pauseOnPlay: boolean;
  setOverlayStats: (value: boolean) => void;
  setOverlayConsole: (value: boolean) => void;
  setOverlayInspector: (value: boolean) => void;
  setOverlayProfiler: (value: boolean) => void;
  setPauseOnPlay: (value: boolean) => void;
  launchPlay: (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => void;
  resumePlayAfterMigration: () => Promise<void>;
  cancelPlayMigration: () => void;
  registerSharedEngine: (engine: AbstractEngine | null) => void;
  ensureSharedEngine: () => AbstractEngine | null;
  sharedEngineGeneration: number;
  registerScheduler: (scheduler: EditorLoopHandle) => () => void;
  /** A Scene viewport is in a blocking load; Play waits for it to finish. */
  sceneViewportLoading: boolean;
  reportSceneViewportLoading: (documentId: string, loading: boolean) => void;
  focusedNodeId: string | null;
  clearFocusedNode: () => void;
  appendLog: (line: string) => void;
  reportBtState: (state: LiveBtState | null) => void;
  /** Behaviour Tree editor panels showing live state; the running session publishes `btState` only while one does. */
  btStateObservers: BtStateObservers;
}

const PlayContext = createContext<PlayContextValue | null>(null);
// Single values of the Play state, each in a context of its own: a reader
// re-renders only when that value changes, not for every `PlayContext` change.
const PlaySimulationDocumentIdContext = createContext<string | null>(null);
const PlayFocusedNodeIdContext = createContext<string | null>(null);
const OutputLogContext = createContext<{ lines: string[] }>({ lines: [] });
const LiveBtStateContext = createContext<LiveBtState | null>(null);
type PlayDiagnosticsActions = Pick<PlayContextValue, "appendLog" | "reportBtState" | "btStateObservers"> & {
  /** Counts a visible Output Log window until the returned release runs. */
  showOutputLogWindow: () => () => void;
  outputLogWindowVisible: () => boolean;
};
const PlayDiagnosticsActionsContext = createContext<PlayDiagnosticsActions | null>(null);

/** High-frequency updates must not rerender the session owner or its overlays. */
function PlayDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [logLines, setLogLines] = useState<string[]>([]);
  const [liveBtState, setLiveBtState] = useState<LiveBtState | null>(null);
  const outputLogWindows = useRef(0);
  const [btStateObservers] = useState(createBtStateObservers);
  // A burst of lines (engine logs, session diagnostics) commits once per frame, in arrival order.
  const [logFeed] = useState(() => {
    let pending: string[] = [];
    const commit = () => {
      const batch = pending;
      pending = [];
      if (batch.length > 0) setLogLines((previous) => appendOutputLogLines(previous, batch));
    };
    const frame = createFrameFlush(commit);
    return {
      push(line: string) {
        pending.push(line);
        // Only the newest lines can show, and a hidden tab flushes slowly.
        if (pending.length > OUTPUT_LOG_RING_CAP * 2) pending.splice(0, pending.length - OUTPUT_LOG_RING_CAP);
        frame.schedule();
      },
      flush() {
        frame.cancel();
        commit();
      },
    };
  });
  useEffect(() => () => logFeed.flush(), [logFeed]);
  const appendLog = logFeed.push;
  const actions = useMemo<PlayDiagnosticsActions>(
    () => ({
      appendLog,
      reportBtState: setLiveBtState,
      btStateObservers,
      showOutputLogWindow: () => {
        outputLogWindows.current += 1;
        return () => { outputLogWindows.current -= 1; };
      },
      outputLogWindowVisible: () => outputLogWindows.current > 0,
    }),
    [appendLog, btStateObservers],
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

function PlayValueContexts({
  simulationDocumentId,
  focusedNodeId,
  children,
}: {
  simulationDocumentId: string | null;
  focusedNodeId: string | null;
  children: ReactNode;
}) {
  return (
    <PlaySimulationDocumentIdContext.Provider value={simulationDocumentId}>
      <PlayFocusedNodeIdContext.Provider value={focusedNodeId}>
        {children}
      </PlayFocusedNodeIdContext.Provider>
    </PlaySimulationDocumentIdContext.Provider>
  );
}

export function PlayProvider({ children }: { children: ReactNode }) {
  return (
    <DiagnosticResultsProvider>
      <PlayDiagnosticsProvider>
        <PlaySessionProvider>{children}</PlaySessionProvider>
      </PlayDiagnosticsProvider>
    </DiagnosticResultsProvider>
  );
}

function PlaySessionProvider({ children }: { children: ReactNode }) {
  const { appendLog, reportBtState, btStateObservers, outputLogWindowVisible } = useContext(PlayDiagnosticsActionsContext)!;
  const { settings: appSettings, updateDebuggerDefaults } = useAppSettings();
  const engineRef = useRef<AbstractEngine | null>(null);
  const providerMountRef = useRef(0);
  const ownedEngineRef = useRef<AbstractEngine | null>(null);
  const [projectEngine] = useState(createProjectEngineController);
  const projectEngineState = useSyncExternalStore(projectEngine.subscribe, projectEngine.getSnapshot);
  const [renderingFailureDismissed, setRenderingFailureDismissed] = useState(false);
  const [renderingRetrying, setRenderingRetrying] = useState(false);
  const [renderingRetryFailure, setRenderingRetryFailure] = useState<{ error: unknown; retryable: boolean } | null>(null);
  const schedulerRegistryRef = useRef(new EditorSchedulerRegistry());
  const preparingRef = useRef(false);
  const pendingPlayOptionsRef = useRef<PlayOptions | undefined>(undefined);
  const pendingScriptsRef = useRef<ScriptBundleEntry[] | null>(null);
  const [sessionOwner] = useState(() => new GameSessionOwner<PlaySessionResult>());
  const sessionState = useSyncExternalStore(sessionOwner.subscribe, sessionOwner.getSnapshot);
  const sessionTicketRef = useRef<GameSessionTicket | null>(null);
  /** The open Scene document the current session was started from, if any. */
  const sessionSourceDocumentRef = useRef<string | null>(null);
  const [playOpen, setPlayOpen] = useState(false);
  const simulationViewports = useRef(new Map<string, SimulationViewport>());
  const [simulationViewportRevision, setSimulationViewportRevision] = useState(0);
  const [simulationHost, setSimulationHost] = useState<HTMLElement | null>(null);
  const simulationRef = useRef<SimulationSession | null>(null);
  // Presentation may close immediately; editor owners remain held until release.
  const playing = playOpen || sessionState.lifecycle === "running" || sessionState.lifecycle === "paused" ||
    sessionState.lifecycle === "stopping" || sessionState.quarantined;
  const [simulationAssetGuids, setSimulationAssetGuids] = useState<readonly string[] | undefined>();
  const [playSaveGame, setPlaySaveGame] = useState<import("@babylonslate/core").SaveGameConfiguration>();
  const [preparing, setPreparing] = useState(false);
  const [playAwaitingMigration, setPlayAwaitingMigration] = useState(false);
  const [playResumeRequested, setPlayResumeRequested] = useState(false);
  const [prepareState, setPrepareState] = useState<{
    phase: PlayPreparePhase;
    dirtyNames: string[];
  } | null>(null);
  const [playBlockedOpen, setPlayBlockedOpen] = useState(false);
  const [blockedDiagnostics, setBlockedDiagnostics] = useState<Diagnostic[]>([]);
  const [playFailure, setPlayFailure] = useState<{ simulating: boolean; reason: string } | null>(null);
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
  const [overlayProfiler, setOverlayProfilerState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.overlayProfiler,
  );
  const [pauseOnPlay, setPauseOnPlayState] = useState(
    DEFAULT_PLAY_DEBUGGER_OVERLAY.pauseOnPlay,
  );
  const [startupAlertOpen, setStartupAlertOpen] = useState(false);
  const [unsavedPrompt, setUnsavedPrompt] = useState<{
    dirtyNames: string[];
    previewBuild: boolean;
    options?: PlayOptions;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
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
  const previewReleaseRef = useRef<(() => void) | null>(null);
  const previewSaveHostRef = useRef<ReturnType<typeof createPreviewSaveStorageHost> | null>(null);
  const previewAssetHostRef = useRef<ReturnType<typeof createPreviewAssetServer> | null>(null);
  const playSourceHostRef = useRef<PlayAssetSourceHost | null>(null);
  const playSourceLifetimeRef = useRef<AbortController | null>(null);
  const playSourceSetsRef = useRef(new Set<Awaited<ReturnType<typeof acquirePlayAssetSources>>>());
  /** Merged Play source controls, rebuilt only when the live source sets change. */
  const mergedSourceControls = useMemo(() => createMergedPlaySourceControls(() => playSourceSetsRef.current), []);
  const initialPlaySourceRef = useRef<Awaited<ReturnType<typeof acquirePlayAssetSources>> | null>(null);
  const [sessionSources, setSessionSources] = useState<SceneSourceAssets>();
  const acquireAssetSources = useCallback(async (
    guids: readonly string[],
    options: { consumer: string; signal: AbortSignal; priority?: import("@babylonslate/assets").AssetLoadPriority; onProgress?: (progress: number) => void; fontModes?: import("@babylonslate/render").CommandFontModes },
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
      getControls: mergedSourceControls,
      release: () => { playSourceSetsRef.current.delete(prepared); prepared.release(); },
      controlsAfterRelease: mergedSourceControls,
    };
  }, [mergedSourceControls]);
  const acquireSceneSources = useCallback(async (guid: string, options: { consumer: string; signal: AbortSignal }) => {
    const prepared = await acquireAssetSources([guid], options);
    const scene = prepared.game.scenes.get(guid);
    if (!scene) { prepared.release(); throw new Error(`Scene ${guid} could not be prepared.`); }
    return { ...prepared, scene, audioReverb: prepared.game.audioReverbBytes.get(guid) ?? null };
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
    setPlayAssetCatalog([]);
    setPlaySpritePayloads(new Map());
    setPlaySpriteAnimationPayloads(new Map());
    setPlayTilemaps(new Map());
    setPlayTilesets(new Map());
    setPlayModelBytes(new Map());
    setPlayComplexMeshes(new Map());
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
  /** On-demand Complex Collision: cook from whichever retained source set holds the Model. */
  const cookPlayComplexCollision = useCallback(async (guid: string) => {
    for (const prepared of playSourceSetsRef.current)
      if (prepared.game.modelBytes.has(guid)) return prepared.cookComplexCollision(guid);
    return null;
  }, []);
  const releasePlaySources = useCallback(() => {
    playSourceLifetimeRef.current?.abort();
    playSourceLifetimeRef.current = null;
    playSourceHostRef.current = null;
    releaseInitialSources();
    for (const sources of playSourceSetsRef.current) sources.release();
    playSourceSetsRef.current.clear();
    mergedSourceControls.reset();
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
  const [playComplexMeshes, setPlayComplexMeshes] = useState<
    ReadonlyMap<string, CollisionTriangleMesh>
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
  const [playCatalog, setPlayAssetCatalog] = useState<import("@babylonslate/core").RuntimeAssetCatalogEntry[]>([]);
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
    registerBeforeTransition,
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
  // Session report names: open tabs supply working content, closed assets are read on demand.
  const reportLocationSources = useMemo<SessionReportLocationSources>(() => {
    const indexed = (ref: string) => {
      const asset = assetRegistry?.getByGuid(ref) ?? assetRegistry?.getByPath(ref);
      return asset && !asset.placeholder ? asset : undefined;
    };
    return {
      findAsset: (ref) => {
        const asset = indexed(ref);
        return asset
          ? { guid: asset.header.guid, path: asset.path, name: asset.header.name, type: asset.header.type }
          : undefined;
      },
      openContent: (asset) =>
        openDocuments.find((doc) => doc.ref.path === asset.path)?.content ?? undefined,
      readContent: async (asset) => {
        const found = indexed(asset.guid);
        if (!assetRegistry || !found) throw new Error(`Asset is unavailable: ${asset.guid}`);
        const document = await readStoredAssetDocument(assetRegistry.storageFor(found.rootId), found.path, {
          blobs: assetRegistry.blobsFor(found.rootId),
        });
        return document.payload;
      },
    };
  }, [assetRegistry, openDocuments]);
  // This provider renders for every document edit, so it identifies the Scene
  // Play would run without normalizing it (every actor, on every render); the
  // Scene itself is read only while a game is presented.
  const openPlayScene = playSceneRefFromOpenDocuments(
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
  // A running session's own Scene, else the open one while Play from Scene is on.
  const playSceneRef = sessionPlayScene ?? (playFromScene ? openPlayScene : null);
  const playSceneGuid = playSceneRef
    ? canonicalPlaySceneGuid(playSceneRef, guidForPath)
    : undefined;
  const canPlay = !sessionState.quarantined && playIsEnabled(openDocuments, activeDocumentId, {
    previewBuild,
    playFromScene,
    hasStartupScene,
  });
  const simulationDocument = simulationSceneDocument(openDocuments, activeDocumentId);
  const simulationUnavailableReason = !simulationDocument ? "Open a world Scene to simulate" :
    !simulationViewports.current.has(simulationDocument.id) ? "Open the Scene Viewport to simulate" :
    sessionState.quarantined ? "Reload the editor after the previous session release failure" : null;
  const simulationDocumentId = simulationRef.current?.baseline.id ?? (sessionState.mode === "simulate" ? simulationDocument?.id ?? null : null);
  const canSimulate = simulationUnavailableReason === null && sessionOwner.canStart();

  useEffect(() => registerBeforeTransition?.((transition) => {
    if (sessionOwner.canStart()) return true;
    // Keyed to the session's own source: the resolved Play scene follows the active tab once boot sources are released.
    const sourceId = simulationRef.current?.baseline.id ?? sessionSourceDocumentRef.current;
    if (!transitionClosesSessionSource(transition, sourceId)) return true;
    return sessionOwner.stop().then(async result => {
      if (result) await result.released;
      return sessionOwner.canStart();
    }).catch(error => { appendLog(`Could not release the game session before changing documents: ${String(error)}`); return false; });
  }), [registerBeforeTransition, sessionOwner, appendLog]);
  void simulationViewportRevision;
  // The game's Scene and physics, normalized only while it is presented. A
  // session carries its own Scene, so its props depend on that alone and keep
  // their identity across unrelated edits (the memoized overlay then skips
  // them); only a game presented without a session Scene follows the open
  // documents, and re-renders with them by design.
  const sessionPresentation = useMemo(
    () =>
      sessionPlayScene
        ? {
            scene: sessionPlayScene.scene,
            physics: playPhysicsFromSceneSettings(sessionPlayScene.scene.settings),
          }
        : null,
    [sessionPlayScene],
  );
  const openPresentation = useMemo(() => {
    if (!playOpen || sessionPlayScene) return null;
    const scene = resolvePlayScene({
      documents: openDocuments,
      activeDocumentId,
      playFromScene,
    });
    return {
      scene: scene?.scene,
      physics: scene
        ? playPhysicsFromSceneSettings(scene.scene.settings)
        : playPhysicsFromOpenDocuments(openDocuments, activeDocumentId),
    };
  }, [activeDocumentId, openDocuments, playFromScene, playOpen, sessionPlayScene]);
  const presentedPlay = sessionPresentation ?? openPresentation;

  // Play requests read documents, dirty state and collectors as they are when
  // Play is pressed. Keeping that per-edit state out of the callbacks'
  // dependencies keeps the Play context value stable while documents change.
  const playRequestInputs = { documents, openPlaySceneGuid, openPlaySceneDocumentId: openPlayScene?.sceneAssetGuid ?? null, hasStartupScene };
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
      setOverlayProfilerState(overlay.overlayProfiler);
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

  const setOverlayProfiler = useCallback((value: boolean) => {
    setOverlayProfilerState(value);
    void persistDebuggerDefaults({ overlayProfiler: value });
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
    });
    engineRef.current = isUsableEngine(next) ? next : null;
    setSharedEngineGeneration((current) =>
      nextSharedEngineGeneration(current, engineRef.current, previous),
    );
  }, [projectEngine]);

  const registerScheduler = useCallback((scheduler: EditorLoopHandle) => {
    return schedulerRegistryRef.current.register(scheduler);
  }, []);

  const [loadingSceneViewports, setLoadingSceneViewports] = useState<ReadonlySet<string>>(() => new Set());
  const reportSceneViewportLoading = useCallback((documentId: string, loading: boolean) => {
    setLoadingSceneViewports((current) => {
      if (current.has(documentId) === loading) return current;
      const next = new Set(current);
      if (loading) next.add(documentId);
      else next.delete(documentId);
      return next;
    });
  }, []);
  const sceneViewportLoading = loadingSceneViewports.size > 0;

  useEffect(() => {
    return attachLifecyclePause((paused) => {
      schedulerRegistryRef.current.setPaused(paused);
      setEncodeQueuePauseReason("visibility", paused);
    });
  }, []);

  useEffect(() => {
    if (projectDocument) return;
    void sessionOwner.stop();
    previewRequestRef.current += 1;
    preparingRef.current = false;
    setPreparing(false);
    setPreviewOpen(false);
    setPreviewPhase(null);
    setScripts([]);
    setPlayOpen(false);
    setSessionPlayScene(null);
    setPrepareState(null);
    setPlayBlockedOpen(false);
    setBlockedDiagnostics([]);
    setPlayAwaitingMigration(false);
    pendingScriptsRef.current = null;
    pendingPlayOptionsRef.current = undefined;
  }, [projectDocument, sessionOwner]);

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
    if (!sessionOwner.canStart()) return;
    setRenderingFailureDismissed(false);
    void projectEngine.sync(renderingRequest);
  }, [projectEngine, renderingRequest, sessionOwner, sessionState]);

  // A lost device stops the game at once; Retry then only replaces the Engine.
  useEffect(() => stopGameOnDeviceLoss(projectEngine, sessionOwner, {
    simulation: () => simulationRef.current,
    log: appendLog,
  }), [appendLog, projectEngine, sessionOwner]);

  // A retry failure belongs to the controller state it was shown over, and
  // ends once the game it waited for has released.
  useEffect(() => { setRenderingRetryFailure(null); }, [projectEngineState]);
  useEffect(() => {
    if (sessionOwner.canStart()) setRenderingRetryFailure(null);
  }, [sessionOwner, sessionState]);

  const retryRendering = useCallback(async () => {
    setRenderingFailureDismissed(false);
    setRenderingRetryFailure(null);
    setRenderingRetrying(true);
    try {
      await retryProjectRendering({ projectEngine, sessionOwner, request: renderingRequest });
    } catch (error) {
      appendLog(`Rendering could not restart: ${error instanceof Error ? error.message : String(error)}`);
      setRenderingRetryFailure({ error, retryable: !(error instanceof RenderingRetryError) || error.retryable });
    } finally {
      setRenderingRetrying(false);
    }
  }, [appendLog, projectEngine, renderingRequest, sessionOwner]);

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
    const mount = ++providerMountRef.current;
    return () => {
      queueMicrotask(() => {
        if (providerMountRef.current !== mount) return;
        simulationRef.current?.discardChanges("Simulation host closed; changes discarded.");
        void sessionOwner.stop().then(async (result) => {
          if (result) await result.released;
          if (!sessionOwner.canStart()) return;
          releasePlaySources();
          const simulation = simulationRef.current;
          simulationRef.current = null;
          simulation?.dispose(false);
          if (sessionOwner.getSnapshot().quarantined) return;
          projectEngine.dispose();
          ownedEngineRef.current = null;
          engineRef.current = null;
        });
      });
    };
  }, [projectEngine, sessionOwner, releasePlaySources]);

  const ensureEngine = useCallback((): AbstractEngine | null => {
    const engine = projectEngine.getSnapshot().session?.engine;
    return isUsableEngine(engine) ? engine! : null;
  }, [projectEngine]);

  useEffect(() => {
    if (sessionOwner.canStart()) {
      releasePlaySources();
      setEncodeQueuePauseReason("play", false);
      if (sessionState.mode === null) {
        setPlayOpen(false);
        preparingRef.current = false;
        setPreparing(false);
        setPrepareState(null);
      }
    }
  }, [sessionOwner, sessionState, releasePlaySources]);

  const registerSimulationViewport = useCallback((viewport: SimulationViewport) => {
    simulationViewports.current.set(viewport.documentId, viewport);
    setSimulationViewportRevision((revision) => revision + 1);
    return () => {
      if (simulationViewports.current.get(viewport.documentId) !== viewport) return;
      simulationViewports.current.delete(viewport.documentId);
      setSimulationViewportRevision((revision) => revision + 1);
      if (simulationRef.current?.viewport === viewport) void sessionOwner.stop(simulationRef.current.ticket);
    };
  }, [sessionOwner]);

  useEffect(() => {
    const simulation = simulationRef.current;
    if (!simulation || !sessionOwner.canStart()) return;
    simulationRef.current = null;
    simulation.dispose(!sessionState.quarantined);
    setSimulationHost(null);
  }, [sessionOwner, sessionState]);

  const launchPlay = useCallback(
    (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => {
      let ticket = sessionTicketRef.current;
      if (!ticket || !sessionOwner.isCurrent(ticket)) ticket = sessionOwner.begin("play");
      if (!ticket || ticket.mode === "preview" || sessionOwner.getSnapshot().lifecycle !== "preparing") return;
      sessionTicketRef.current = ticket;
      if (!ensureEngine()) {
        appendLog("Play failed: could not create Engine.");
        sessionOwner.fail(ticket, "Play could not create Engine.");
        releasePlaySources();
        return;
      }
      setEncodeQueuePauseReason("play", true);
      setInjectThrow(Boolean(options?.injectFixtureThrow));
      if (options?.scripts) setScripts(options.scripts);
      if (ticket.mode === "simulate") setSimulationHost(simulationRef.current?.viewport.host ?? null);
      setPlayOpen(true);
    },
    [appendLog, ensureEngine, sessionOwner, releasePlaySources],
  );

  const finishPreviewPresentation = useCallback(() => {
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
    setPlayOpen(false);
    setSessionPlayScene(null);
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

  const closePreview = useCallback(() => {
    if (sessionTicketRef.current?.mode === "preview") void sessionOwner.stop(sessionTicketRef.current);
  }, [sessionOwner]);

  const registerPreviewBeforeStop = useCallback((beforeStop: () => Promise<void>) => {
    const ticket = sessionTicketRef.current;
    if (!ticket || ticket.mode !== "preview") return () => {};
    const attached = sessionOwner.setBeforeStop(ticket, async () => { await beforeStop(); return true; });
    return () => { if (attached) sessionOwner.setBeforeStop(ticket, async () => true); };
  }, [sessionOwner]);

  const sendPreviewPack = useCallback(() => {
    const files = previewFilesRef.current;
    const frame = previewIframeRef.current?.contentWindow;
    const traceByteBudget = previewTraceByteBudgetRef.current;
    const handoff = { files, closing: previewClosingRef.current };
    if (!canSendPreviewPack(handoff) || !frame || traceByteBudget === undefined) {
      return;
    }
    try {
      previewAssetHostRef.current?.dispose();
      previewAssetHostRef.current = createPreviewAssetServer({
        files: handoff.files,
        send: (message, transfer) => frame.postMessage(message, previewOriginRef.current, transfer),
      });
      frame.postMessage(previewPackFromFiles(handoff.files, traceByteBudget), previewOriginRef.current);
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

  const requestPreviewBuild = useCallback(async (saveConfirmed = false) => {
    if (!sessionOwner.canStart() || preparingRef.current) return;
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
      openPlaySceneDocumentId,
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
    if (needsSave && !saveConfirmed) {
      setUnsavedPrompt({
        dirtyNames: [
          ...dirtyDocuments.map((doc) => doc.ref.label),
          ...(projectDirty ? ["Project Settings"] : []),
        ],
        previewBuild: true,
      });
      return;
    }
    if (needsSave && migrationPending.length > 0) {
      setPlayAwaitingMigration(true);
      return;
    }
    const ticket = sessionOwner.begin("preview");
    if (!ticket) return;
    sessionTicketRef.current = ticket;
    sessionSourceDocumentRef.current = playFromScene ? openPlaySceneDocumentId : null;
    const requestId = ++previewRequestRef.current;
    const traceByteBudget = appSettings.traceByteBudget;
    const isCurrentRequest = () => previewRequestRef.current === requestId && sessionOwner.isCurrent(ticket);
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
      if (!isCurrentRequest()) return;
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
      setPlayOpen(true);
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
      sessionOwner.attach(ticket, () => {
        // The iframe owns a separate Engine. Its passive unmount callback
        // confirms browsing-context destruction; a timer does not.
        const frame = previewIframeRef.current;
        const released = new Promise<{ textureCountAfter: number; textureLeak: boolean; quarantined: boolean }>((resolve) => {
          const detached = () => resolve({ textureCountAfter: 0, textureLeak: false, quarantined: false });
          if (!frame?.isConnected) detached();
          else previewReleaseRef.current = detached;
        });
        finishPreviewPresentation();
        return {
          diagnostics: [], droppedDiagnostics: 0, textureCountBefore: 0,
          released,
          runtimeMode: "in-process", lastTrace: null,
        };
      });
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
        if (sessionOwner.getSnapshot().lifecycle === "preparing") void sessionOwner.stop(ticket);
      }
    }
  }, [appendLog, appSettings.traceByteBudget, playFromScene, sessionOwner, finishPreviewPresentation]);

  const requestPlay = useCallback(
    async (options?: PlayOptions) => {
      const simulating = options?.mode === "simulate";
      if (previewBuild && !simulating) {
        await requestPreviewBuild(options?.saveChoice === "save");
        return;
      }
      if (!sessionOwner.canStart() || preparingRef.current) return;
      // Read at call time (see playRequestInputsRef); shadows the render values.
      const {
        documents: {
          activeDocumentId, assetRegistry, collectPlayInputAssets, collectPlayPreviewScripts,
          dirtyDocuments, graphsNeedCompile, migrationPending, openDocuments,
          projectDirty, projectDocument, saveAll,
        },
        hasStartupScene,
        openPlaySceneGuid,
        openPlaySceneDocumentId,
      } = playRequestInputsRef.current;
      const simulationTarget = simulating ? simulationSceneDocument(openDocuments, activeDocumentId) : null;
      const simulationViewport = simulationTarget ? simulationViewports.current.get(simulationTarget.id) : undefined;
      if (simulating && (!simulationTarget || !simulationViewport)) {
        appendLog("Open a world Scene and its Scene Viewport to simulate.");
        return;
      }
      if (!simulating && (
        !playIsEnabled(openDocuments, activeDocumentId, {
          playFromScene,
          hasStartupScene,
        })
      )) {
        if (!hasStartupScene) setStartupAlertOpen(true);
        return;
      }
      pendingPlayOptionsRef.current = options;
      const inject = Boolean(options?.injectFixtureThrow);
      // Play Without Saving runs the open in-memory documents as they are.
      const skipSave = simulating || options?.saveChoice === "skip";
      const plan = planPlayPreviewPrepare({
        dirtyDocuments: skipSave ? [] : [
          ...dirtyDocuments.map((doc) => ({ label: doc.ref.label })),
          ...(projectDirty ? [{ label: "Project Settings" }] : []),
        ],
        scriptsStale: graphsNeedCompile,
        migrationPending: migrationPending.length > 0,
      });

      const dirtyNames = plan.action === "prepare" ? plan.dirtyNames : [
        ...dirtyDocuments.map((doc) => doc.ref.label),
        ...(projectDirty ? ["Project Settings"] : []),
      ];
      // Ask before writing anything (including a migrate-on-save) to disk.
      if (!skipSave && options?.saveChoice !== "save" && dirtyNames.length > 0) {
        setUnsavedPrompt({ dirtyNames, previewBuild: false, options });
        return;
      }
      if (plan.action === "migrate") {
        setPlayAwaitingMigration(true);
        return;
      }

      const ticket = sessionOwner.begin(simulating ? "simulate" : "play");
      if (!ticket) return;
      sessionTicketRef.current = ticket;
      sessionSourceDocumentRef.current = simulating ? simulationTarget?.id ?? null : playFromScene ? openPlaySceneDocumentId : null;
      pendingScriptsRef.current = null;
      let presentationRequested = false;
      if (!simulating) setSimulationAssetGuids(undefined);
      const current = <T,>(pending: Promise<T>) => sessionOwner.awaitCurrent(ticket, pending);
      preparingRef.current = true;
      setPreparing(true);
      try {
        if (simulating && simulationTarget && simulationViewport) {
          setPrepareState({ phase: "compiling", dirtyNames: [] });
          const source = playRequestInputsRef.current.documents;
          const simulation = await SimulationSession.prepare({
            ticket, viewport: simulationViewport, source, backingStorage: createSaveGameStorage(),
            keepChanges: simulationDefaultsFromSettings(appSettings.debuggerDefaults).keepChanges,
          });
          if (!sessionOwner.isCurrent(ticket)) { simulation.dispose(false); return; }
          simulationRef.current = simulation;
          setSimulationAssetGuids((source.assetRegistry?.list() ?? []).map(asset => asset.header.guid));
          source.setActiveDocument(simulation.baseline.id);
        }
        if (plan.action === "prepare") {
          setPrepareState({
            phase: plan.needsSave ? "saving" : "compiling",
            dirtyNames: plan.dirtyNames,
          });
          if (plan.needsSave) {
            const saved = await current(saveAll());
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
        const baselineScene = simulating && simulationRef.current
          ? playSceneFromOpenDocuments([simulationRef.current.baseline], simulationRef.current.baseline.id) : null;
        const effectiveGuid = resolvePreviewStartupGuid({
          playFromScene: simulating || playFromScene,
          openSceneGuid: baselineScene ? canonicalPlaySceneGuid(baselineScene, path => assetRegistry.list().find(asset => asset.path === path)?.header.guid ?? null) : openPlaySceneGuid,
          startupSceneGuid: projectDocument.settings.startupSceneGuid ?? null,
        });
        if (!effectiveGuid) { setStartupAlertOpen(true); return; }
        releasePlaySources();
        const lifetime = new AbortController();
        const sourceSignal = AbortSignal.any([lifetime.signal, ticket.signal]);
        playSourceLifetimeRef.current = lifetime;
        const sourceDocuments = playRequestInputsRef.current.documents.getOpenDocuments().map(document => ({
          ...(simulationRef.current?.baseline.id === document.id ? simulationRef.current.baseline : document),
        }));
        const sourceHost: PlayAssetSourceHost = {
          registry: assetRegistry,
          documentOverrides: playDocumentOverrides(assetRegistry, sourceDocuments),
          project: projectDocument,
          createScope: playRequestInputsRef.current.documents.createAssetLoadScope,
          compile: required => collectPlayPreviewScripts(required, sourceDocuments, projectDocument),
        };
        playSourceHostRef.current = sourceHost;
        const projectAssets = requiredProjectAssets(assetRegistry, projectDocument);
        if (projectAssets.length) {
          const persistent = await acquirePlayAssetSources(sourceHost, projectAssets,
            { consumer: "Play Project Systems", signal: sourceSignal });
          if (!sessionOwner.isCurrent(ticket) || playSourceHostRef.current !== sourceHost) { persistent.release(); throw new DOMException("Session changed during asset preparation", "AbortError"); }
          playSourceSetsRef.current.add(persistent);
          setSessionSources(persistent.sources);
        }
        const prepared = await acquirePlayAssetSources(sourceHost,
          [effectiveGuid, ...projectAssets],
          { consumer: `Play Scene ${effectiveGuid}`, signal: sourceSignal, allowCompileErrors: true });
        if (!sessionOwner.isCurrent(ticket) || playSourceHostRef.current !== sourceHost) { prepared.release(); throw new DOMException("Session changed during Play preparation", "AbortError"); }
        playSourceSetsRef.current.add(prepared);
        initialPlaySourceRef.current = prepared;
        const { game, content, sources } = prepared;
        if (requestedBackend === "webgpu") {
          const reason = webGpuMaterialCompatibilityReason(content.materialDocuments, content.materialFunctions);
          if (reason) {
            await current(projectEngine.sync({ projectGuid: playRequestInputsRef.current.documents.projectGuid!, backend: requestedBackend,
              prepare: async (signal) => { signal.throwIfAborted(); return reason; },
            }, true));
            sourceSignal.throwIfAborted();
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
        setPlayAssetCatalog(playAssetCatalog({ registry: assetRegistry, settings: projectDocument.settings, sceneGuid: effectiveGuid }));
        setPlayAnimGraphs(content.animGraphs);
        setPlayBehaviourTrees(content.behaviourTrees);
        setPlayBlackboards(content.blackboards);
        setPlaySpritePayloads(content.spritePayloads);
        setPlaySpriteAnimationPayloads(content.spriteAnimationPayloads);
        setPlayTilemaps(content.tilemapPayloads);
        setPlayTilesets(content.tilesetPayloads);
        setPlayModelBytes(game.modelBytes);
        setPlayModelPayloads(content.modelPayloads);
        // Already cooked by source preparation; Play installs these instead of cooking again.
        setPlayComplexMeshes(content.complexMeshes);
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
        setPlayInputAssets(await current(collectPlayInputAssets(prepared.required)));
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
        setPlaySaveGame(await current(prepareSaveGameConfiguration({
          storage: simulating ? simulationRef.current?.storage : undefined,
          projectId: playRequestInputsRef.current.documents.projectGuid,
          settings: projectDocument?.settings.saveGame,
          loadDefinition: async (guid) => {
            const current = playRequestInputsRef.current.documents;
            const asset = current.assetRegistry?.getByGuid(guid);
            if (!asset) throw new Error("The default Save Game definition is missing.");
            return current.loadAssetDocument("save-game", asset.path);
          },
        })));
        setPrepareState(null);

        if (!inject && projectHasBlockingErrors(nextDiagnostics)) {
          if (simulating) {
            appendLog("Simulation could not start because the project has compile errors.");
            return;
          }
          pendingScriptsRef.current = nextScripts;
          setBlockedDiagnostics(nextDiagnostics);
          setPlayBlockedOpen(true);
          return;
        }

        if (simulating) {
          setPrepareState({ phase: "releasing", dirtyNames: [] });
          await simulationRef.current!.suspendAuthoring(sessionOwner);
        }
        setPrepareState(null);
        presentationRequested = true;
        launchPlay({ injectFixtureThrow: inject, scripts: nextScripts });
      } catch (error) {
        if (!sessionOwner.isCurrent(ticket)) return;
        const reason = error instanceof Error ? error.message : String(error);
        appendLog(`Play preparation failed: ${reason}`);
        // With no Output Log window visible, the log line alone would go unseen.
        if (!outputLogWindowVisible()) setPlayFailure({ simulating, reason });
        setPrepareState(null);
        setScripts([]);
      } finally {
        if (sessionOwner.owns(ticket)) {
          preparingRef.current = false;
          setPreparing(false);
          if (!presentationRequested && !pendingScriptsRef.current) void sessionOwner.stop(ticket);
        }
      }
    },
    [
      appendLog,
      outputLogWindowVisible,
      launchPlay,
      playFromScene,
      sessionOwner,
      previewBuild,
      requestPreviewBuild,
      appSettings.debuggerDefaults,
      releasePlaySources,
      requestedBackend,
      projectEngine,
      registerSharedEngine,
      setDiagnostics,
    ],
  );

  const requestSimulate = useCallback(() => requestPlay({ mode: "simulate", saveChoice: "skip" }), [requestPlay]);

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    const host = globalThis as typeof globalThis & {
      __babylonslateSimulationTest?: { start: () => Promise<void>; stop: () => Promise<unknown>; state: () => GameSessionState };
    };
    host.__babylonslateSimulationTest = { start: requestSimulate, stop: () => sessionOwner.stop(), state: sessionOwner.getSnapshot };
    return () => { delete host.__babylonslateSimulationTest; };
  }, [requestSimulate, sessionOwner]);

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
    (result: PlaySessionResult, ticket?: GameSessionTicket) => {
      if (ticket && sessionOwner.getSnapshot().generation !== ticket.generation) return;
      playSourceLifetimeRef.current?.abort();
      setPlayOpen(false);
      setSessionPlayScene(null);
      reportBtState(null);
      setDropped(result.droppedDiagnostics);
      setReportEntries(result.diagnostics);
      setLastRuntimeMode(result.runtimeMode);
      if (result.diagnostics.length > 0 && !automatedSessionReportingHeld()) {
        setReportOpen(true);
      }
      publishPlaySessionClosed(result);
      appendLog(`Play ended (${result.runtimeMode})`);
      void result.released.then(({ textureCountAfter, textureLeak, quarantined, textureLeakDetail }) => {
        if (quarantined) appendLog("Game resources did not confirm release. Reload the editor before starting another session.");
        appendLog(
          `Play textures ${result.textureCountBefore}→${textureCountAfter}`,
        );
        if (textureLeak && !quarantined) {
          appendLog(
            `Texture leak detected: ${result.textureCountBefore} → ${textureCountAfter}${textureLeakDetail ? `: ${textureLeakDetail}` : ""}`,
          );
        }
      });
      if (result.lastTrace) {
        void openRecordedTrace(result.lastTrace);
      }
    },
    [appendLog, openRecordedTrace, reportBtState, sessionOwner],
  );

  const value = useMemo<PlayContextValue>(
    () => ({
      sessionState,
      sessionOwner,
      requestSimulate,
      canSimulate,
      simulationUnavailableReason,
      simulationDocumentId,
      registerSimulationViewport,
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
      overlayProfiler,
      pauseOnPlay,
      setOverlayStats,
      setOverlayConsole,
      setOverlayInspector,
      setOverlayProfiler,
      setPauseOnPlay,
      launchPlay,
      resumePlayAfterMigration,
      cancelPlayMigration,
      registerSharedEngine,
      ensureSharedEngine: ensureEngine,
      sharedEngineGeneration,
      registerScheduler,
      sceneViewportLoading,
      reportSceneViewportLoading,
      focusedNodeId,
      clearFocusedNode: () => setFocusedNodeId(null),
      appendLog,
      reportBtState,
      btStateObservers,
    }),
    [
      sessionState,
      sessionOwner,
      requestSimulate,
      canSimulate,
      simulationUnavailableReason,
      simulationDocumentId,
      registerSimulationViewport,
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
      overlayProfiler,
      pauseOnPlay,
      setOverlayStats,
      setOverlayConsole,
      setOverlayInspector,
      setOverlayProfiler,
      setPauseOnPlay,
      launchPlay,
      resumePlayAfterMigration,
      cancelPlayMigration,
      registerSharedEngine,
      ensureEngine,
      sharedEngineGeneration,
      registerScheduler,
      sceneViewportLoading,
      reportSceneViewportLoading,
      focusedNodeId,
      appendLog,
      reportBtState,
      btStateObservers,
    ],
  );

  // The running game's registry lists: rebuilt when the registry changes, not
  // on every render of this provider, and only while a game is open.
  const playRegistryViews = useMemo(() => {
    if (!playOpen) return null;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const assets = assetRegistry?.list() ?? [];
    return {
      sceneCatalog: assets
        .filter((asset) => asset.header.type === "Scene")
        .map((asset) => ({ guid: asset.header.guid, name: asset.header.name })),
      classAssetGuids: Object.fromEntries(
        assets
          .filter((asset) => asset.header.type === "Class")
          .map((asset) => [classIdFromClassAsset(asset), asset.header.guid]),
      ),
      consoleCommands: assets.flatMap((asset) =>
        asset.header.consoleCommand
          ? [{
              ...asset.header.consoleCommand,
              classId: classIdFromClassAsset(asset),
              assetGuid: asset.header.guid,
              name: asset.header.consoleCommand.name || classIdFromClassAsset(asset).toLowerCase(),
            }]
          : [],
      ),
      audioAssetGuids: assets
        .filter((asset) => asset.header.type === "Audio")
        .map((asset) => asset.header.guid),
      animClipCatalog: animClipCatalogFromAssets(assets),
    };
  }, [assetRegistry, playOpen, registryEpoch]);

  const gamePresentation = playOpen && !previewOpen && engineRef.current && sessionTicketRef.current && sessionTicketRef.current.mode !== "preview" ? (
          <PlayOverlay
            sessionOwner={sessionOwner}
            sessionTicket={sessionTicketRef.current}
            btStateObservers={btStateObservers}
            simulationSaveStorage={simulationRef.current?.storage}
            simulationSession={simulationRef.current ?? undefined}
            simulationAssetGuids={simulationAssetGuids}
            embedded={sessionTicketRef.current.mode === "simulate"}
            sharedEngine={engineRef.current}
            injectFixtureThrow={injectThrow}
            scripts={scripts}
            physics={presentedPlay?.physics}
            sceneAssetGuid={playSceneGuid}
            scene={presentedPlay?.scene}
            project={projectDocument?.metadata}
            saveGame={playSaveGame}
            gameInstanceClass={projectDocument?.settings.gameInstanceClass ?? undefined}
            scenes={playSceneLibrary}
            sceneCatalog={playRegistryViews?.sceneCatalog}
            classAssetGuids={playRegistryViews?.classAssetGuids}
            consoleCommands={playRegistryViews?.consoleCommands}
            audioAssetGuids={playRegistryViews?.audioAssetGuids}
            getAssetLoadState={documents.getAssetLoadState}
            getSourceControls={mergedSourceControls}
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
            complexMeshes={playComplexMeshes}
            cookComplexCollision={cookPlayComplexCollision}
            modelClipAnimationGuids={playModelClipAnimationGuids}
            retargetAnimationLoads={playRetargetAnimationLoads}
            loadAudioSourceBytes={playAudioSourceLoader}
            audioLibrary={playAudioLibrary}
            animClipCatalog={playRegistryViews?.animClipCatalog}
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
            assetCatalog={playCatalog}
            focusNavigation={projectDocument?.settings.focusNavigation}
            sortingLayers={projectDocument?.settings.twoD.sortingLayers}
            pixelsPerUnit={
              projectDocument?.settings.twoD.pixelsPerUnit ?? 100
            }
            collisionMatrix={projectDocument?.settings.physics.collisionMatrix}
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
  ) : null;

  return (
    <PlayContext.Provider value={value}>
      <SimulationInspectionProvider>
        <SimulationControlsProvider>
        <PlayValueContexts simulationDocumentId={simulationDocumentId} focusedNodeId={focusedNodeId}>
          {children}
        </PlayValueContexts>
        {projectOpen && (projectEngineState.phase === "preparing" || projectEngineState.phase === "initializing" ||
          ((projectEngineState.phase === "failed" || renderingRetryFailure) && !renderingFailureDismissed)) ? (
          <ProjectRenderingDialog
            state={renderingRetryFailure
              ? { ...projectEngineState, phase: "failed", error: renderingRetryFailure.error, retryable: renderingRetryFailure.retryable }
              : projectEngineState}
            retrying={renderingRetrying}
            onRetry={() => { void retryRendering(); }}
            onDismiss={() => setRenderingFailureDismissed(true)} />
        ) : null}
        {projectOpen ? <RenderingFallbackNotice state={projectEngineState} /> : null}
        {previewPhase || previewPreparationError ? (
          <PreparingPreviewDialog
            open
            phase={previewPhase}
            error={previewPreparationError}
            canCancel={previewCanCancel}
            onRetry={() => { void requestPreviewBuild(); }}
            onCancel={() => {
              previewRequestRef.current += 1;
              void sessionOwner.stop(sessionTicketRef.current ?? undefined);
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
        <PlayUnsavedDialog
          open={unsavedPrompt !== null}
          dirtyNames={unsavedPrompt?.dirtyNames ?? []}
          previewBuild={unsavedPrompt?.previewBuild ?? false}
          onCancel={() => setUnsavedPrompt(null)}
          onChoose={(saveChoice) => {
            const prompt = unsavedPrompt;
            setUnsavedPrompt(null);
            if (!prompt) return;
            if (prompt.previewBuild) {
              // A migrate-on-save approval resumes through requestPlay.
              pendingPlayOptionsRef.current = { saveChoice };
              void requestPreviewBuild(saveChoice === "save");
            }
            else void requestPlay({ ...prompt.options, saveChoice });
          }}
        />
        {prepareState ? (
          <PlayPrepareDialog
            open
            phase={prepareState.phase}
            dirtyNames={prepareState.dirtyNames}
            title={sessionState.mode === "simulate" ? "Preparing Simulation" : undefined}
            onCancel={() => {
              void sessionOwner.stop(sessionTicketRef.current ?? undefined);
              preparingRef.current = false;
              setPreparing(false);
              setPrepareState(null);
            }}
          />
        ) : null}
        {playFailure ? (
          <PlayFailedDialog
            title={playFailure.simulating ? "Simulation Failed" : "Play Failed"}
            reason={playFailure.reason}
            onClose={() => setPlayFailure(null)}
          />
        ) : null}
        <PlayBlockedDialog
          open={playBlockedOpen}
          diagnostics={blockedDiagnostics}
          onOpenChange={(open) => {
            setPlayBlockedOpen(open);
            if (!open && pendingScriptsRef.current) {
              pendingScriptsRef.current = null;
              void sessionOwner.stop(sessionTicketRef.current ?? undefined);
            }
          }}
          onNavigate={(d) => {
            const revealId = documentIdToRevealForDiagnostic(
              d,
              openDocuments.map((doc) => doc.id),
            );
            setFocusDiagnostic(d, revealId ?? undefined);
            if (revealId) setActiveDocument(revealId);
            setPlayBlockedOpen(false);
            pendingScriptsRef.current = null;
            void sessionOwner.stop(sessionTicketRef.current ?? undefined);
          }}
          onPlayAnyway={() => {
            setPlayBlockedOpen(false);
            const preparedScripts = pendingScriptsRef.current ?? scripts;
            pendingScriptsRef.current = null;
            launchPlay({
              injectFixtureThrow: pendingPlayOptionsRef.current?.injectFixtureThrow,
              scripts: preparedScripts,
            });
          }}
        />
        {sessionTicketRef.current?.mode === "simulate"
          ? simulationHost && gamePresentation ? createPortal(gamePresentation, simulationHost) : null
          : gamePresentation}
        {previewOpen ? (
          <PreviewBuildOverlay
            src={previewSrc}
            iframeRef={previewIframeRef}
            onDetached={() => { previewReleaseRef.current?.(); previewReleaseRef.current = null; }}
            error={previewError}
            onClose={closePreview}
            registerBeforeStop={registerPreviewBeforeStop}
            onTrace={(trace) => void openRecordedTrace(trace)}
            onOutputLog={appendLog}
            showStats={overlayStats}
            showConsole={overlayConsole}
            showProfiler={overlayProfiler}
          />
        ) : null}
        <PreviewSessionReport
          open={reportOpen}
          entries={reportEntries}
          dropped={dropped}
          onOpenChange={setReportOpen}
          locationSources={reportLocationSources}
          onNavigate={(entry) => {
            const nav = sessionReportNavigation(entry, {
              getByGuid: (guid) => assetRegistry?.getByGuid(guid),
              getByPath: (path) => assetRegistry?.getByPath(path),
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
            }, nav.document ? documentId(nav.document) : undefined);
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
        </SimulationControlsProvider>
      </SimulationInspectionProvider>
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
 * The Scene document a Simulate session runs from, or null (also without a
 * PlayProvider). Unlike `usePlay()`, a reader re-renders only when this
 * changes, not for every Play state change.
 */
export function usePlaySimulationDocumentId(): string | null {
  return useContext(PlaySimulationDocumentIdContext);
}

/**
 * The graph node Play diagnostics asked to focus, or null (also without a
 * PlayProvider). Re-renders its reader only when the focused node changes.
 */
export function usePlayFocusedNodeId(): string | null {
  return useContext(PlayFocusedNodeIdContext);
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

/**
 * Marks an Output Log window as visible while the caller is mounted and
 * `visible`. Play reports a preparation failure in a dialog only while no
 * Output Log window is visible.
 */
export function useOutputLogWindow(visible: boolean): void {
  const actions = useContext(PlayDiagnosticsActionsContext);
  useEffect(() => (visible ? actions?.showOutputLogWindow() : undefined), [actions, visible]);
}

/** Subscribe only the behaviour-tree debugger to live snapshots. */
export function useLiveBtState(): LiveBtState | null {
  return useContext(LiveBtStateContext);
}

/**
 * Counts the caller as showing live behaviour tree state while it is mounted and `shown`. The
 * Play runtime publishes `btState` only while at least one caller does, and sends every tree's
 * current state when the first one starts.
 */
export function useObserveBtState(shown: boolean): void {
  const actions = useContext(PlayDiagnosticsActionsContext);
  useEffect(() => (shown ? actions?.btStateObservers.observe() : undefined), [actions, shown]);
}
