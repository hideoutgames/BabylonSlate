import { DiagnosticResultsProvider, useDiagnosticResultsStore } from "./diagnostic-results-context";
import { createPortal } from "react-dom";
import { SimulationInspectionProvider } from "./simulation-inspection-context";
import { prepareSaveGameConfiguration } from "../services/save-game-configuration";
import { projectTypeSchemas, requireSaveGameDefinition } from "../lib/save-game-catalog";
import { createSaveGameStorage, isTestModeEnabled } from "@haptic/vfs";
import { acquirePlayAssetSources, playDocumentOverrides, requiredProjectAssets, type PlayAssetSourceHost } from "../services/play-asset-sources";
import {
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
import { setNearestTextures, webGpuMaterialCompatibilityReason } from "@haptic/render";
import {
  DEFAULT_INFINITE_LOOP_DETECTION,
  DEFAULT_LOOP_COUNT,
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  engineCommandBus,
  nearestTextureFiltering,
  normalizeRenderingPipeline,
  type ExtensionGameLibrary,
} from "@haptic/core";
import type { SessionReportEntry } from "@haptic/runtime";
import { BREAKPOINT_PAUSE_CODE, type ScriptBundleEntry, type SessionPauseCause } from "@haptic/bridge";
import type { Diagnostic } from "@haptic/scripting";
import type { PlayAudioSourceLoader } from "../lib/play-audio";
import { appendOutputLogLines, OUTPUT_LOG_RING_CAP } from "../lib/output-log-ring";
import { createFrameFlush } from "../lib/use-debug-console-logs";
import { PlayFailedDialog, PlayPrepareDialog } from "../components/play-prepare-dialog";
import { PlayUnsavedDialog } from "../components/play-unsaved-dialog";
import { PlayBlockedDialog } from "../components/play-blocked-dialog";
import { SimulationControlsProvider } from "./simulation-controls-context";
import { GraphDebugProvider } from "./graph-debug-context";
import { PlayOverlay, type PlayOverlayProps } from "../components/play-overlay";
import { PreparingPreviewDialog } from "../components/preparing-preview-dialog";
import { PreviewBuildOverlay } from "../components/preview-build-overlay";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { MISSING_STARTUP_SCENE_MESSAGE } from "@haptic/exporter";
import { simulationDefaultsFromSettings } from "../lib/play-debugger-defaults";
import {
  useActiveDocumentId,
  useCompileState,
  useDocumentActions,
  useEditorShellState,
  useProjectState,
  useRegistryState,
  useSaveState,
} from "./document-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { useValidation } from "./validation-context";
import { PreviewSessionReport } from "../components/preview-session-report";
import type { SessionReportLocationSources } from "../lib/session-report-locations";
import type { PlaySessionResult } from "../services/play-session";
import { SimulationSession } from "../services/simulation-session";
import { simulationSceneDocument, type SimulationViewport } from "../services/simulation-viewport";
import { GameSessionOwner, transitionClosesSessionSource, type GameSessionState, type GameSessionTicket } from "../services/game-session-owner";
import { automatedSessionReportingHeld, publishPlaySessionClosed } from "../services/runtime-probes";
import { preloadPrewarmedGameWorkerPhysics, prewarmGameWorker } from "../services/game-worker-host";
import {
  canonicalPlaySceneGuid,
  editorHavokWasmUrl,
  playPhysicsFromOpenDocuments,
  playPhysicsFromSceneSettings,
  playSceneFromOpenDocuments,
  playSceneRefFromOpenDocuments,
  playIsEnabled,
  resolvePlayScene,
  resolvePreviewStartupGuid,
  type PlaySceneLoad,
} from "../services/play-physics";
import {
  documentIdToRevealForDiagnostic,
  navigateToSessionReportEntry,
  type SessionReportNavigationHost,
  type SessionReportNavigationResult,
} from "../services/diagnostic-navigation";
import { requestDocumentFocus } from "../lib/document-focus-request";
import { readStoredAssetDocument } from "@haptic/assets";
import { attachLifecyclePause } from "@haptic/render/lifecycle-pause";
import { setEncodeQueuePauseReason } from "../services/encode-queue-pause";
import { setEditorQuiet } from "../lib/editor-quiet";
import { subscribeEditorViewportFrameHold } from "../lib/editor-frame-hold";
import {
  EditorSchedulerRegistry,
  type EditorLoopHandle,
} from "../lib/editor-scheduler-registry";
import { planPlayPreviewPrepare } from "../services/play-preview-prepare";
import { projectHasBlockingErrors } from "../services/graph-validation";
import type { PlayPreparePhase } from "../components/play-prepare-dialog";
import { playRegistryViews } from "../lib/play-registry-views";
import { useAppSettings } from "./app-settings-context";
import { ProjectRenderingDialog } from "../components/project-rendering-dialog";
import { RenderingFallbackNotice } from "../components/rendering-fallback-notice";
import {
  OutputLogContext,
  PlayContext,
  PlayDiagnosticsActionsContext,
  PlayFocusedNodeIdContext,
  PlaySimulationDocumentIdContext,
  dirtyDocumentLabels,
  type PlayContextValue,
  type PlayDiagnosticsActions,
  type PlayOptions,
  type PlayRequestInputs,
  type PlayUnsavedPrompt,
} from "./play-context-hooks";
import { usePlayDebuggerDefaults } from "./use-play-debugger-defaults";
import { playAudioAndNavigation, preparedPlayContent, usePlayContent, type PlayContent } from "./use-play-content";
import { usePlayAssetSources } from "./use-play-asset-sources";
import { usePreviewBuild } from "./use-preview-build";
import { useProjectRendering } from "./use-project-rendering";

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export {
  useOptionalPlay,
  useOutputLog,
  useOutputLogWindow,
  usePlay,
  usePlayDiagnosticsActions,
  usePlayFocusedNodeId,
  usePlaySimulationDocumentId,
} from "./play-context-hooks";
/* eslint-enable react-refresh/only-export-components */

/** The kinds Play and Simulation find their open Scene among (see `play-physics`). */
const PLAY_SCENE_KINDS = ["scene"] as const;

/** High-frequency updates must not rerender the session owner or its overlays. */
function PlayDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [logLines, setLogLines] = useState<string[]>([]);
  const outputLogWindows = useRef(0);
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
      showOutputLogWindow: () => {
        outputLogWindows.current += 1;
        return () => { outputLogWindows.current -= 1; };
      },
      outputLogWindowVisible: () => outputLogWindows.current > 0,
    }),
    [appendLog],
  );
  const outputLog = useMemo(() => ({ lines: logLines }), [logLines]);
  return (
    <PlayDiagnosticsActionsContext.Provider value={actions}>
      <OutputLogContext.Provider value={outputLog}>
        {children}
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
        <GraphDebugProvider>
          <PlaySessionProvider>{children}</PlaySessionProvider>
        </GraphDebugProvider>
      </PlayDiagnosticsProvider>
    </DiagnosticResultsProvider>
  );
}

function PlaySessionProvider({ children }: { children: ReactNode }) {
  const { appendLog, outputLogWindowVisible } = useContext(PlayDiagnosticsActionsContext)!;
  const { settings: appSettings, updateDebuggerDefaults } = useAppSettings();
  const {
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
  } = usePlayDebuggerDefaults({ appSettings, updateDebuggerDefaults });
  const providerMountRef = useRef(0);
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
  /** Scene viewports Play or Preview Build released, restored once the session ends. */
  const releasedViewportsRef = useRef<SimulationViewport[]>([]);
  // Presentation may close immediately; editor owners remain held until release.
  const playing = playOpen || sessionState.lifecycle === "running" || sessionState.lifecycle === "paused" ||
    sessionState.lifecycle === "stopping" || sessionState.quarantined;
  const [simulationAssetGuids, setSimulationAssetGuids] = useState<readonly string[] | undefined>();
  const [playSaveGame, setPlaySaveGame] = useState<import("@haptic/core").SaveGameConfiguration>();
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
  const [lastRuntimeMode, setLastRuntimeMode] = useState<
    "worker" | "in-process" | null
  >(null);
  const [scripts, setScripts] = useState<ScriptBundleEntry[]>([]);
  /** Game libraries of enabled gameplay Extensions, linked when Play is prepared. */
  const [extensionLibraries, setExtensionLibraries] = useState<ExtensionGameLibrary[]>([]);
  const [sessionPlayScene, setSessionPlayScene] = useState<PlaySceneLoad | null>(
    null,
  );
  const [startupAlertOpen, setStartupAlertOpen] = useState(false);
  const [unsavedPrompt, setUnsavedPrompt] = useState<PlayUnsavedPrompt | null>(null);
  const [playContent, playContentActions] = usePlayContent();
  const {
    playSourceHostRef,
    playSourceLifetimeRef,
    playSourceSetsRef,
    initialPlaySourceRef,
    mergedSourceControls,
    sessionSources,
    setSessionSources,
    acquireAssetSources,
    acquireSceneSources,
    releaseInitialSources,
    cookPlayComplexCollision,
    releaseAllSources,
  } = usePlayAssetSources({ resetContent: playContentActions.reset, setSessionPlayScene });
  const releasePlaySources = useCallback(() => {
    releaseAllSources();
    setPlayInputAssets([]);
    setPlayAudioSourceLoader(undefined);
    setScripts([]);
    setExtensionLibraries([]);
    pendingScriptsRef.current = null;
  }, [releaseAllSources]);
  const [playAudioSourceLoader, setPlayAudioSourceLoader] =
    useState<PlayAudioSourceLoader | undefined>(undefined);
  const [playInputAssets, setPlayInputAssets] = useState<import("@haptic/core").InputAssetDefinition[]>([]);
  const {
    beginSimulationDocument,
    collectPlayInputAssets,
    collectPlayPreviewScripts,
    createAssetLoadScope,
    exportGameArtifact,
    getAssetLoadState,
    getOpenDocuments,
    loadAssetDocument,
    lockAuthoring,
    lockAuthoringWrites,
    onSessionDiagnostic,
    openDocument,
    openRecordedTrace,
    registerBeforeTransition,
    saveAll,
    setActiveDocument,
    setAnimEditorMode,
  } = useDocumentActions();
  const activeDocumentId = useActiveDocumentId();
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch, projectGuid, extensionService } = useRegistryState();
  const { migrationPending } = useEditorShellState();
  const { dirtyDocuments, projectDirty } = useSaveState();
  const { graphsNeedCompile } = useCompileState();
  // Edits of other kinds leave this list alone; the save, compile and shell
  // slices above still re-render this provider whenever they change.
  const sceneDocuments = useOpenDocumentsOfKinds(PLAY_SCENE_KINDS);
  const projectOpen = projectDocument != null;
  const requestedBackend = normalizeRenderingPipeline(projectDocument?.settings.render).gpuBackend;
  const { setDiagnostics, focusDiagnostic, setFocusDiagnostic } = useValidation();
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
        getOpenDocuments().find((doc) => doc.ref.path === asset.path)?.content ?? undefined,
      readContent: async (asset) => {
        const found = indexed(asset.guid);
        if (!assetRegistry || !found) throw new Error(`Asset is unavailable: ${asset.guid}`);
        const document = await readStoredAssetDocument(assetRegistry.storageFor(found.rootId), found.path, {
          blobs: assetRegistry.blobsFor(found.rootId),
        });
        return document.payload;
      },
    };
  }, [assetRegistry, getOpenDocuments]);
  // This provider renders for every Scene edit, so it identifies the Scene
  // Play would run without normalizing it (every actor, on every render); the
  // Scene itself is read only while a game is presented.
  const openPlayScene = playSceneRefFromOpenDocuments(
    sceneDocuments,
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
  const canPlay = !sessionState.quarantined && playIsEnabled(sceneDocuments, activeDocumentId, {
    previewBuild,
    playFromScene,
    hasStartupScene,
  });
  const simulationDocument = simulationSceneDocument(sceneDocuments, activeDocumentId);
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
  // Scene documents, and re-renders with them by design.
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
      documents: sceneDocuments,
      activeDocumentId,
      playFromScene,
    });
    return {
      scene: scene?.scene,
      physics: scene
        ? playPhysicsFromSceneSettings(scene.scene.settings)
        : playPhysicsFromOpenDocuments(sceneDocuments, activeDocumentId),
    };
  }, [activeDocumentId, sceneDocuments, playFromScene, playOpen, sessionPlayScene]);
  const presentedPlay = sessionPresentation ?? openPresentation;

  // Play requests read documents, dirty state and project state as they are
  // when Play is pressed. Keeping that per-edit state out of the callbacks'
  // dependencies keeps the Play context value stable while documents change.
  const playRequestInputs: PlayRequestInputs = {
    activeDocumentId,
    assetRegistry,
    extensionService,
    projectGuid,
    projectDocument,
    dirtyDocuments,
    projectDirty,
    graphsNeedCompile,
    migrationPending,
    sceneDocuments,
    openPlaySceneGuid,
    openPlaySceneDocumentId: openPlayScene?.sceneAssetGuid ?? null,
    hasStartupScene,
  };
  const playRequestInputsRef = useRef<PlayRequestInputs>(playRequestInputs);
  useLayoutEffect(() => {
    playRequestInputsRef.current = playRequestInputs;
  });
  /** Loads the project's Save Game definition from the documents as they are when Play reads it. */
  const loadSaveGameDefinition = useCallback(async (guid: string) => {
    const registry = playRequestInputsRef.current.assetRegistry;
    const asset = registry?.getByGuid(guid);
    if (!asset) throw new Error("The default Save Game definition is missing.");
    const stored = await loadAssetDocument("save-game", asset.path);
    return requireSaveGameDefinition(stored, projectTypeSchemas(registry?.list() ?? [], getOpenDocuments()));
  }, [getOpenDocuments, loadAssetDocument]);

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

  // Save All holds the editor viewports' frames; game views are never registered here.
  useEffect(() => {
    const registry = schedulerRegistryRef.current;
    const unsubscribe = subscribeEditorViewportFrameHold((held) => registry.setFramesHeld(held));
    return () => {
      unsubscribe();
      registry.setFramesHeld(false);
    };
  }, []);

  /** Editor Play stopped at a breakpoint or an error, its view hidden behind the editor until Resume. */
  const [playBreak, setPlayBreak] = useState<SessionPauseCause | null>(null);
  const playStopped = playBreak !== null;
  // Play and Preview Build cover the editor, so its background work waits; a Simulation runs inside it,
  // and stopped Play shows it.
  const gameCoversEditor = playOpen && sessionState.mode !== null && sessionState.mode !== "simulate" && !playStopped;
  useEffect(() => {
    setEditorQuiet(gameCoversEditor);
  }, [gameCoversEditor]);
  useEffect(() => () => setEditorQuiet(false), []);
  // Stopped Play leaves the editor read-only, as a running Simulation does; breakpoints can still change.
  useEffect(() => (playStopped ? lockAuthoring("Read-only while Play is stopped") : undefined), [lockAuthoring, playStopped]);

  useEffect(() => {
    if (projectDocument) return;
    void sessionOwner.stop();
    preparingRef.current = false;
    setPreparing(false);
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

  const {
    engineRef,
    ownedEngineRef,
    projectEngine,
    projectEngineState,
    sharedEngineGeneration,
    registerSharedEngine,
    ensureEngine,
    retryRendering,
    renderingRetrying,
    renderingRetryFailure,
    renderingFailureDismissed,
    setRenderingFailureDismissed,
  } = useProjectRendering({
    projectOpen,
    projectGuid,
    requestedBackend,
    sessionOwner,
    sessionState,
    appendLog,
    simulationRef,
  });

  // Nearest Texture Filtering is the shared Engine's: every editor view and overlay Play draws with it.
  const nearestTextures = projectDocument ? nearestTextureFiltering(projectDocument.settings.twoD) : false;
  useEffect(() => {
    const engine = engineRef.current;
    if (engine) setNearestTextures(engine, nearestTextures);
  }, [engineRef, nearestTextures, sharedEngineGeneration]);

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
  }, [projectEngine, sessionOwner, releasePlaySources, ownedEngineRef, engineRef]);

  useEffect(() => {
    if (sessionOwner.canStart()) {
      releasePlaySources();
      // A Play Blocked prompt belongs to the preparation that just ended.
      setPlayBlockedOpen(false);
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

  /**
   * Play and Preview Build release every open Scene viewport's authoring Scene, as Simulation releases its own:
   * kept beside the game's, its GPU memory (shadow maps, probe cubes) doubled Play's, which iPad WebKit answers
   * by losing the context. Stop rebuilds them. Play, on the same Engine, takes over the textures it shares with
   * them; Preview Build's own Engine takes none. False when the session ended or the release failed.
   */
  const releaseSceneViewports = useCallback(async (ticket: GameSessionTicket): Promise<boolean> => {
    const viewports = [...simulationViewports.current.values()];
    if (!viewports.length) return true;
    releasedViewportsRef.current.push(...viewports);
    const handOverTextures = ticket.mode === "play";
    const release = Promise.all(viewports.map((viewport) => viewport.suspend({ handOverTextures }))).then(() => undefined);
    sessionOwner.holdRelease(ticket, release.then(() => ({ quarantined: false }), () => ({ quarantined: true })));
    try {
      await sessionOwner.awaitCurrent(ticket, release);
      return true;
    } catch (error) {
      if (sessionOwner.isCurrent(ticket)) sessionOwner.fail(ticket, error, true);
      return false;
    }
  }, [sessionOwner]);

  useEffect(() => {
    // A game that halted (a fatal diagnostic) ends its session while its presentation stays up for Stop.
    if (playOpen || !sessionOwner.canStart() || !releasedViewportsRef.current.length) return;
    const viewports = releasedViewportsRef.current.splice(0);
    // As for Simulation: a quarantined release leaves them released.
    if (sessionState.quarantined) return;
    for (const viewport of viewports) if (simulationViewports.current.get(viewport.documentId) === viewport) viewport.restore();
  }, [playOpen, sessionOwner, sessionState]);

  useEffect(() => {
    const simulation = simulationRef.current;
    if (!simulation || !sessionOwner.canStart()) return;
    simulationRef.current = null;
    simulation.dispose(!sessionState.quarantined);
    setSimulationHost(null);
  }, [sessionOwner, sessionState]);

  const presentPlay = useCallback(
    async (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => {
      // Only the preparation that still owns the session presents it: a ticket stopped meanwhile
      // (device loss, its source document closed) released the sources this launch would use.
      const ticket = sessionTicketRef.current;
      const launchable = () => Boolean(ticket && sessionOwner.isCurrent(ticket) && ticket.mode !== "preview" &&
        sessionOwner.getSnapshot().lifecycle === "preparing");
      if (!ticket || !launchable()) return;
      // Simulation released its own viewport while it prepared.
      if (ticket.mode === "play" && (!await releaseSceneViewports(ticket) || !launchable())) return;
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
    [appendLog, ensureEngine, sessionOwner, releasePlaySources, releaseSceneViewports],
  );
  const launchPlay = useCallback(
    (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => { void presentPlay(options); },
    [presentPlay],
  );

  const showPreviewReport = useCallback((entries: SessionReportEntry[]) => {
    setDropped(0);
    setReportEntries(entries);
    setReportOpen(true);
  }, []);
  const {
    previewOpen,
    previewSrc,
    previewIframeRef,
    previewError,
    previewPhase,
    previewPreparationError,
    previewCanCancel,
    closePreview,
    registerPreviewBeforeStop,
    requestPreviewBuild,
    cancelPreviewPreparation,
    onPreviewDetached,
  } = usePreviewBuild({
    sessionOwner,
    sessionTicketRef,
    sessionSourceDocumentRef,
    preparingRef,
    playRequestInputsRef,
    saveAll,
    exportGameArtifact,
    setPreparing,
    setPlayOpen,
    setSessionPlayScene,
    setStartupAlertOpen,
    setUnsavedPrompt,
    setPlayAwaitingMigration,
    appendLog,
    showPreviewReport,
    loadSaveGameDefinition,
    playFromScene,
    traceByteBudget: appSettings.traceByteBudget,
    projectOpen,
    releaseSceneViewports,
  });

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
        activeDocumentId, assetRegistry, dirtyDocuments, extensionService, graphsNeedCompile, migrationPending,
        projectDirty, projectDocument, sceneDocuments,
        hasStartupScene,
        openPlaySceneGuid,
        openPlaySceneDocumentId,
      } = playRequestInputsRef.current;
      const simulationTarget = simulating ? simulationSceneDocument(sceneDocuments, activeDocumentId) : null;
      const simulationViewport = simulationTarget ? simulationViewports.current.get(simulationTarget.id) : undefined;
      if (simulating && (!simulationTarget || !simulationViewport)) {
        appendLog("Open a world Scene and its Scene Viewport to simulate.");
        return;
      }
      if (!simulating && (
        !playIsEnabled(sceneDocuments, activeDocumentId, {
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
      const dirtyLabels = dirtyDocumentLabels(dirtyDocuments, projectDirty);
      const plan = planPlayPreviewPrepare({
        dirtyDocuments: skipSave ? [] : dirtyLabels.map((label) => ({ label })),
        scriptsStale: graphsNeedCompile,
        migrationPending: migrationPending.length > 0,
      });

      const dirtyNames = plan.action === "prepare" ? plan.dirtyNames : dirtyLabels;
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
      // The session's game worker loads while its content is prepared; the ticket ending first discards it.
      prewarmGameWorker(ticket.signal);
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
          const simulation = await SimulationSession.prepare({
            ticket, viewport: simulationViewport, source: { lockAuthoringWrites, beginSimulationDocument }, backingStorage: createSaveGameStorage(),
            keepChanges: simulationDefaultsFromSettings(appSettings.debuggerDefaults).keepChanges,
          });
          if (!sessionOwner.isCurrent(ticket)) { simulation.dispose(false); return; }
          simulationRef.current = simulation;
          setSimulationAssetGuids((assetRegistry?.list() ?? []).map(asset => asset.header.guid));
          setActiveDocument(simulation.baseline.id);
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
          openSceneGuid: baselineScene ? canonicalPlaySceneGuid(baselineScene, path => assetRegistry.getByPath(path)?.header.guid ?? null) : openPlaySceneGuid,
          startupSceneGuid: projectDocument.settings.startupSceneGuid ?? null,
        });
        if (!effectiveGuid) { setStartupAlertOpen(true); return; }
        releasePlaySources();
        const lifetime = new AbortController();
        const sourceSignal = AbortSignal.any([lifetime.signal, ticket.signal]);
        playSourceLifetimeRef.current = lifetime;
        const sourceDocuments = getOpenDocuments().map(document => ({
          ...(simulationRef.current?.baseline.id === document.id ? simulationRef.current.baseline : document),
        }));
        // An open Scene names its physics world now; a closed one once it is prepared below.
        const effectivePath = assetRegistry.getByGuid(effectiveGuid)?.path;
        const openScene = sourceDocuments.find((document) => document.ref.kind === "scene" && document.ref.path === effectivePath);
        if (openScene?.content) {
          preloadPrewarmedGameWorkerPhysics(playPhysicsFromOpenDocuments([openScene], openScene.id).physicsWorld, editorHavokWasmUrl());
        }
        const sourceHost: PlayAssetSourceHost = {
          registry: assetRegistry,
          documentOverrides: playDocumentOverrides(assetRegistry, sourceDocuments),
          project: projectDocument,
          // What a session released stays cached by revision, so the next Play reads only what changed.
          createScope: (owner) => createAssetLoadScope(owner, { keep: true }),
          // Each session checks storage once per asset; its later slot acquisitions trust those checks.
          verifiedRevisions: new Map(),
          // Editor Play and Simulation compile with the breakpoint check and the graph debugger's probes,
          // each a null check per node while nothing is set or followed. Preview Build and exports compile neither.
          traceExecution: true,
          compile: (required, storedDocuments) => collectPlayPreviewScripts(required, sourceDocuments, projectDocument, { traceExecution: true, storedDocuments }),
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
        const { game, content } = prepared;
        if (requestedBackend === "webgpu") {
          const reason = webGpuMaterialCompatibilityReason(content.materialDocuments, content.materialFunctions);
          if (reason) {
            await current(projectEngine.sync({ projectGuid: playRequestInputsRef.current.projectGuid!, backend: requestedBackend,
              prepare: async (signal) => { signal.throwIfAborted(); return reason; },
            }, true));
            sourceSignal.throwIfAborted();
            registerSharedEngine(projectEngine.getSnapshot().session?.engine ?? null);
          }
        }
        const scene = game.scenes.get(effectiveGuid);
        if (!scene) throw new Error(`Scene ${effectiveGuid} did not produce a document.`);
        preloadPrewarmedGameWorkerPhysics(playPhysicsFromSceneSettings(scene.settings).physicsWorld, editorHavokWasmUrl());
        const resolvedScene = { sceneAssetGuid: effectiveGuid, scene, path: assetRegistry.getByGuid(effectiveGuid)?.path };
        setSessionPlayScene(resolvedScene);
        const nextScripts = game.scripts;
        const nextDiagnostics: Diagnostic[] = [...prepared.diagnostics];
        // Linked from the files as they are now, so edits made in another editor play too;
        // extension assets open in tabs play with their unsaved values.
        const openExtensionAssets = new Map(getOpenDocuments().flatMap((doc) =>
          doc.ref.kind === "extension-asset" && doc.content && typeof doc.content === "object"
            ? [[doc.ref.path, doc.content as Record<string, unknown>] as const] : []));
        setExtensionLibraries(await current(extensionService.gameLibraries(
          projectDocument.settings.extensionOverrides, projectDocument.settings.extensionSettings,
          (path) => openExtensionAssets.get(path))));
        setScripts(nextScripts);
        setDiagnostics(nextDiagnostics);
        playContentActions.setPrepared(preparedPlayContent(prepared, {
          registry: assetRegistry,
          settings: projectDocument.settings,
          sceneGuid: effectiveGuid,
        }));
        setPlayInputAssets(await current(collectPlayInputAssets(prepared.required, prepared.game.decodedPayloads)));
        playContentActions.setAudioAndNavigation(playAudioAndNavigation(prepared, effectiveGuid));
        setPlayAudioSourceLoader(() => async ({ assetGuid, chunkId }: Parameters<PlayAudioSourceLoader>[0]) => {
          for (const entry of playSourceSetsRef.current) {
            const bytes = entry.audioChunks.get(assetGuid)?.get(chunkId);
            if (bytes) return bytes;
          }
          throw new Error(`Audio ${assetGuid} (${chunkId}) is not prepared for an active consumer.`);
        });
        setPlaySaveGame(await current(prepareSaveGameConfiguration({
          storage: simulating ? simulationRef.current?.storage : undefined,
          projectId: playRequestInputsRef.current.projectGuid,
          settings: projectDocument?.settings.saveGame,
          loadDefinition: loadSaveGameDefinition,
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
        setExtensionLibraries([]);
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
      loadSaveGameDefinition,
      playContentActions,
      playSourceLifetimeRef,
      playSourceHostRef,
      playSourceSetsRef,
      initialPlaySourceRef,
      setSessionSources,
      beginSimulationDocument,
      collectPlayInputAssets,
      collectPlayPreviewScripts,
      createAssetLoadScope,
      getOpenDocuments,
      lockAuthoringWrites,
      saveAll,
      setActiveDocument,
    ],
  );

  const requestSimulate = useCallback(() => requestPlay({ mode: "simulate", saveChoice: "skip" }), [requestPlay]);

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    const host = globalThis as typeof globalThis & {
      __hapticSimulationTest?: { start: () => Promise<void>; stop: () => Promise<unknown>; state: () => GameSessionState };
    };
    host.__hapticSimulationTest = { start: requestSimulate, stop: () => sessionOwner.stop(), state: sessionOwner.getSnapshot };
    return () => { delete host.__hapticSimulationTest; };
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
        void openRecordedTrace(result.lastTrace, { keep: appSettings.tracesKept });
      }
    },
    [appSettings.tracesKept, appendLog, openRecordedTrace, sessionOwner, playSourceLifetimeRef],
  );

  // Built after the value below; read when a source is opened, so it is always the latest.
  const sourceNavigationRef = useRef<SessionReportNavigationHost | null>(null);
  const openSessionSource = useCallback(
    (entry: Parameters<typeof navigateToSessionReportEntry>[0]): Promise<SessionReportNavigationResult> => {
      const host = sourceNavigationRef.current;
      return host
        ? navigateToSessionReportEntry(entry, host)
        : Promise.resolve({ opened: false, message: "The editor is not ready to open it yet." });
    },
    [],
  );
  // A paused session opens its source. Stable, so the memoized overlay skips this provider's renders.
  const onPausedAt = useCallback((cause: SessionPauseCause) => {
    void openSessionSource({ severity: cause.code === BREAKPOINT_PAUSE_CODE ? "info" : "error", ...cause });
  }, [openSessionSource]);
  // The Profiler's Scripts view opens an entry's graph the same way.
  const diagnosticResults = useDiagnosticResultsStore();
  useEffect(() => {
    if (!diagnosticResults) return;
    diagnosticResults.setSourceOpener(async (location) => {
      const result = await openSessionSource({ severity: "info", code: "editor.profilerScript", message: "Profiled Script", ...location });
      return result.opened ? null : result.message;
    });
    return () => diagnosticResults.setSourceOpener(null);
  }, [diagnosticResults, openSessionSource]);
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
      openSessionSource,
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
      openSessionSource,
    ],
  );

  // The running game's registry lists: rebuilt when the registry changes, not
  // on every render of this provider, and only while a game is open.
  const registryViews = useMemo(() => {
    if (!playOpen) return null;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    return playRegistryViews(assetRegistry?.list() ?? []);
  }, [assetRegistry, playOpen, registryEpoch]);

  // Session report rows and a Simulation paused on an error open their source the same way.
  const sessionReportNavigationHost: SessionReportNavigationHost = {
    findAsset: reportLocationSources.findAsset,
    currentFocus: () => focusDiagnostic,
    setFocusDiagnostic,
    setFocusedNodeId,
    openDocument,
    isDocumentOpen: (id) =>
      getOpenDocuments().some((doc) => doc.id === id && doc.content !== null),
    setActiveDocument,
    setAnimEditorMode,
    requestDocumentFocus,
    log: appendLog,
  };
  sourceNavigationRef.current = sessionReportNavigationHost;

  const gamePresentation = playOpen && !previewOpen && engineRef.current && sessionTicketRef.current && sessionTicketRef.current.mode !== "preview" ? (
          <PlayOverlay
            sessionOwner={sessionOwner}
            sessionTicket={sessionTicketRef.current}
            simulationSaveStorage={simulationRef.current?.storage}
            simulationSession={simulationRef.current ?? undefined}
            simulationAssetGuids={simulationAssetGuids}
            embedded={sessionTicketRef.current.mode === "simulate"}
            sharedEngine={engineRef.current}
            injectFixtureThrow={injectThrow}
            scripts={scripts}
            extensionLibraries={extensionLibraries}
            physics={presentedPlay?.physics}
            sceneAssetGuid={playSceneGuid}
            scene={presentedPlay?.scene}
            project={projectDocument?.metadata}
            saveGame={playSaveGame}
            gameInstanceClass={projectDocument?.settings.gameInstanceClass ?? undefined}
            // Each content field is the overlay prop of the same name; `satisfies` rejects a field
            // that is not, which the spread alone would drop without an error.
            {...(playContent satisfies Pick<PlayOverlayProps, keyof PlayContent>)}
            sceneCatalog={registryViews?.sceneCatalog}
            classAssetGuids={registryViews?.classAssetGuids}
            consoleCommands={registryViews?.consoleCommands}
            audioAssetGuids={registryViews?.audioAssetGuids}
            getAssetLoadState={getAssetLoadState}
            getSourceControls={mergedSourceControls}
            acquireSceneSources={acquireSceneSources}
            acquireAssetSources={acquireAssetSources}
            releaseInitialSources={releaseInitialSources}
            sessionSources={sessionSources}
            cookComplexCollision={cookPlayComplexCollision}
            loadAudioSourceBytes={playAudioSourceLoader}
            animClipCatalog={registryViews?.animClipCatalog}
            postProcessingEnabled={postProcessingEnabled}
            hardwareScalingLevel={hardwareScalingLevel}
            pauseOnPlay={pauseOnPlay}
            pauseOnErrors={simulationDefaultsFromSettings(appSettings.debuggerDefaults).pauseOnErrors}
            // A breakpoint stop opens its node like an error does, but is not an error.
            onPlayBreak={setPlayBreak}
            onPausedAt={onPausedAt}
            audioProjectSettings={projectDocument?.settings.audio}
            inputAssets={playInputAssets}
            focusNavigation={projectDocument?.settings.focusNavigation}
            sortingLayers={projectDocument?.settings.twoD.sortingLayers}
            pixelsPerUnit={
              projectDocument?.settings.twoD.pixelsPerUnit ?? 100
            }
            collisionPresets={projectDocument?.settings.physics.collisionPresets}
            pixelPerfect={projectDocument?.settings.twoD.pixelPerfect === true}
            touchMinTargetPx={
              projectDocument?.settings.touchMinTargetPx ?? 44
            }
            frameCap={
              projectDocument?.settings.playFrameCap ?? DEFAULT_PLAY_FRAME_CAP
            }
            garbageCollectionIntervalTicks={projectDocument?.settings.garbageCollectionIntervalTicks}
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
            onCancel={cancelPreviewPreparation}
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
              getOpenDocuments().map((doc) => doc.id),
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
            onDetached={onPreviewDetached}
            error={previewError}
            onClose={closePreview}
            registerBeforeStop={registerPreviewBeforeStop}
            onTrace={(trace) => void openRecordedTrace(trace, { keep: appSettings.tracesKept })}
            onOutputLog={appendLog}
            showStats={overlayStats}
            showConsole={overlayConsole}
            showProfiler={overlayProfiler}
          />
        ) : null}
        <PreviewSessionReport
          // A game that covers the editor hides the report instead of closing it; it returns when the game stops.
          open={reportOpen && !previewOpen && !(playOpen && sessionTicketRef.current?.mode !== "simulate")}
          entries={reportEntries}
          dropped={dropped}
          onOpenChange={setReportOpen}
          locationSources={reportLocationSources}
          // Rows open their source beside the report; only its own close actions dismiss it.
          onNavigate={(entry) => navigateToSessionReportEntry(entry, sessionReportNavigationHost)}
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

