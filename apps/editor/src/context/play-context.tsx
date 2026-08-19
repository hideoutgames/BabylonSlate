import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Engine } from "@babylonjs/core";
import {
  DEFAULT_INFINITE_LOOP_DETECTION,
  DEFAULT_LOOP_COUNT,
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  isErr,
  resolveGameInstanceClass,
} from "@babylonslate/core";
import { createAppEngine, type FontAssetEntry } from "@babylonslate/render";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";
import { emptyPlayAudioLibrary, type PlayAudioLibrary } from "../lib/play-audio";
import {
  emptyPlayParticleLibrary,
  particleMaterialGuidsFromLibrary,
  particleTextureGuidsFromLibrary,
  type PlayParticleLibrary,
} from "../lib/play-particles";
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
} from "@babylonslate/exporter";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { createAppSettingsStore } from "@babylonslate/vfs";
import {
  DEFAULT_PLAY_DEBUGGER_OVERLAY,
  playDebuggerOverlayFromSettings,
  type PlayDebuggerOverlaySettings,
} from "../lib/play-debugger-defaults";
import { loadPlayerDistFiles } from "../services/load-player-files";
import { playerPreviewSrc } from "../lib/player-host-url";
import { canSendPreviewPack } from "../lib/preview-build-handoff";
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
} from "../services/play-physics";
import { documentIdToRevealForDiagnostic, sessionReportNavigation } from "../services/diagnostic-navigation";
import type {
  PlayAnimGraphEntry,
  PlayBehaviourTreeEntry,
  PlayBlackboardEntry,
} from "../lib/play-content";
import {
  readPlayNavmeshBytes,
  readPlayAudioReverbBytes,
  modelSlotMaterialGuidsFromPayloads,
  skyboxFaceGuidsFromScene,
} from "../lib/play-content";
import {
  hydrateSpriteAnimationPixelSizes,
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
import {
  collectImageGuidsFromUiDocuments,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";
import { playUserInterfaceRuntimeDocuments, interfaceMaterialGuidsFromUiDocuments } from "../lib/play-content";
import type { UserInterfaceRuntimeDocument } from "@babylonslate/bridge";
import { collectFontAssetEntries } from "../lib/play-fonts";
import { animClipCatalogFromAssets, modelClipAnimationGuidsFromAssets, retargetAnimationLoadsFromAssets } from "../lib/anim-clip-catalog";
import {
  collectUiImageUrls,
  revokeUiImageUrls,
} from "../lib/play-ui-images";
import {
  ENGINE_SETTINGS_CHANGED_EVENT,
  type LiveEngineSettings,
} from "../lib/viewport-render-gate";
import {
  isUsableEngine,
  nextSharedEngineGeneration,
} from "../lib/shared-engine-generation";

type PlayOptions = { injectFixtureThrow?: boolean };

/** Slim UI metadata for Play. Never auto-applies a HUD. */
export function playSessionUiOptions(library: Record<string, UserInterfaceDocument>): {
  userInterfaces: UserInterfaceRuntimeDocument[];
  autoApply: false;
} {
  return {
    userInterfaces: playUserInterfaceRuntimeDocuments(library),
    autoApply: false,
  };
}

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
  stopPlay: () => void;
  registerSharedEngine: (engine: Engine | null) => void;
  ensureSharedEngine: () => Engine | null;
  sharedEngineGeneration: number;
  registerScheduler: (scheduler: EditorLoopHandle) => () => void;
  focusedNodeId: string | null;
  clearFocusedNode: () => void;
  appendLog: (line: string) => void;
  logLines: string[];
  liveBtState: LiveBtState | null;
  reportBtState: (state: LiveBtState | null) => void;
}

const PlayContext = createContext<PlayContextValue | null>(null);
const OutputLogContext = createContext<{ lines: string[] }>({ lines: [] });

export function PlayProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<Engine | null>(null);
  const ownedEngineRef = useRef<Engine | null>(null);
  const ownedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const schedulerRegistryRef = useRef(new EditorSchedulerRegistry());
  const preparingRef = useRef(false);
  const pendingPlayOptionsRef = useRef<PlayOptions | undefined>(undefined);
  const pendingScriptsRef = useRef<ScriptBundleEntry[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [playAwaitingMigration, setPlayAwaitingMigration] = useState(false);
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
  const [liveBtState, setLiveBtState] = useState<LiveBtState | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [sharedEngineGeneration, setSharedEngineGeneration] = useState(0);
  const [lastRuntimeMode, setLastRuntimeMode] = useState<
    "worker" | "in-process" | null
  >(null);
  const [scripts, setScripts] = useState<ScriptBundleEntry[]>([]);
  const [previewBuild, setPreviewBuildState] = useState(false);
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
  const [previewSrc, setPreviewSrc] = useState(() => playerPreviewSrc(0));
  const [previewPhase, setPreviewPhase] = useState<PreviewPreparePhase | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewCanCancel, setPreviewCanCancel] = useState(true);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewFilesRef = useRef<Map<string, Uint8Array> | null>(null);
  const previewCancelledRef = useRef(false);
  const previewClosingRef = useRef(false);
  const previewDiagnosticsRef = useRef<SessionReportEntry[]>([]);
  const [playUiLibrary, setPlayUiLibrary] = useState<
    Record<string, UserInterfaceDocument>
  >({});
  const [playFontEntries, setPlayFontEntries] = useState<FontAssetEntry[]>([]);
  const [playImageUrls, setPlayImageUrls] = useState<Map<string, string>>(
    () => new Map(),
  );
  const playImageUrlsRef = useRef(playImageUrls);
  playImageUrlsRef.current = playImageUrls;
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
  const [playTilemaps, setPlayTilemaps] = useState<Map<string, TilemapPayload>>(
    () => new Map(),
  );
  const [playTilesets, setPlayTilesets] = useState<Map<string, TilesetPayload>>(
    () => new Map(),
  );
  const [playTextureBytes, setPlayTextureBytes] = useState<
    Map<string, Uint8Array>
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
  const [playAudioBytes, setPlayAudioBytes] = useState<Map<string, Uint8Array>>(
    () => new Map(),
  );
  const [playAudioLibrary, setPlayAudioLibrary] = useState<PlayAudioLibrary>(
    () => emptyPlayAudioLibrary(),
  );
  const [playParticleLibrary, setPlayParticleLibrary] =
    useState<PlayParticleLibrary>(() => emptyPlayParticleLibrary());
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
  const [playAudioReverbBytes, setPlayAudioReverbBytes] = useState<Uint8Array | null>(
    null,
  );
  const [playSceneLibrary, setPlaySceneLibrary] = useState<
    Array<{ guid: string; scene: import("@babylonslate/core").SerializedScene }>
  >([]);
  const {
    collectPlayPreviewScripts,
    collectPlayUiLibrary,
    collectPlayAnimGraphs,
    collectPlayBehaviourTrees,
    collectPlayBlackboards,
    collectPlaySpritePayloads,
    collectPlaySpriteAnimationPayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayAudio,
    collectPlayParticles,
    collectPlayMaterialLibrary,
    collectPlaySceneLibrary,
    exportGameArtifact,
    openDocuments,
    activeDocumentId,
    setActiveDocument,
    openDocument,
    projectDocument,
    dirtyDocuments,
    scriptsStale,
    migrationPending,
    saveAll,
    assetRegistry,
    readAssetChunk,
    onSessionDiagnostic,
  } = useDocuments();
  const { diagnostics, setDiagnostics, setFocusDiagnostic } = useValidation();
  const playScene = resolvePlayScene({
    documents: openDocuments,
    activeDocumentId,
  });
  const playSceneGuid = playScene
    ? canonicalPlaySceneGuid(
        playScene,
        (path) =>
          assetRegistry?.list().find((asset) => asset.path === path)?.header
            .guid ?? null,
      )
    : undefined;
  const canPlay = playIsEnabled(openDocuments, activeDocumentId, {
    previewBuild,
  });
  const playPhysics = playScene
    ? playPhysicsFromSceneSettings(playScene.scene.settings)
    : playPhysicsFromOpenDocuments(openDocuments, activeDocumentId);

  useEffect(() => {
    const applyOverlay = (defaults?: Partial<PlayDebuggerOverlaySettings>) => {
      const overlay = playDebuggerOverlayFromSettings(defaults);
      setOverlayStatsState(overlay.overlayStats);
      setOverlayConsoleState(overlay.overlayConsole);
      setOverlayInspectorState(overlay.overlayInspector);
      setPauseOnPlayState(overlay.pauseOnPlay);
    };
    const apply = (settings: {
      postProcessingEnabled?: boolean;
      hardwareScalingLevel?: number;
      debuggerDefaults?: {
        previewBuild?: boolean;
      } & Partial<PlayDebuggerOverlaySettings>;
    }) => {
      if (typeof settings.debuggerDefaults?.previewBuild === "boolean") {
        setPreviewBuildState(settings.debuggerDefaults.previewBuild);
      }
      if (settings.debuggerDefaults) {
        applyOverlay(settings.debuggerDefaults);
      }
      if (typeof settings.postProcessingEnabled === "boolean") {
        setPostProcessingEnabled(settings.postProcessingEnabled);
      }
      if (typeof settings.hardwareScalingLevel === "number") {
        setHardwareScalingLevel(settings.hardwareScalingLevel);
      }
    };
    void createAppSettingsStore()
      .load()
      .then((settings) => {
        setPreviewBuildState(settings.debuggerDefaults.previewBuild === true);
        applyOverlay(settings.debuggerDefaults);
        apply(settings);
      });
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<LiveEngineSettings>).detail;
      if (detail) apply(detail);
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () => {
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    };
  }, []);

  const persistDebuggerDefaults = useCallback(
    async (patch: Partial<PlayDebuggerOverlaySettings> & { previewBuild?: boolean }) => {
      const store = createAppSettingsStore();
      const settings = await store.load();
      await store.save({
        ...settings,
        debuggerDefaults: {
          ...settings.debuggerDefaults,
          ...patch,
        },
      });
    },
    [],
  );

  const setPreviewBuild = useCallback((value: boolean) => {
    setPreviewBuildState(value);
    void persistDebuggerDefaults({ previewBuild: value });
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

  const appendLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-500), line]);
  }, []);

  useEffect(
    () => onSessionDiagnostic(appendLog),
    [appendLog, onSessionDiagnostic],
  );

  const registerSharedEngine = useCallback((engine: Engine | null) => {
    const previous = engineRef.current;
    const next = isUsableEngine(engine) ? engine : ownedEngineRef.current;
    engineRef.current = isUsableEngine(next) ? next : null;
    setSharedEngineGeneration((current) =>
      nextSharedEngineGeneration(current, engineRef.current, previous),
    );
  }, []);

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
    setPrepareState(null);
    setPlayBlockedOpen(false);
    setBlockedDiagnostics([]);
    setPlayAwaitingMigration(false);
    pendingScriptsRef.current = null;
    pendingPlayOptionsRef.current = undefined;
  }, [projectDocument]);

  const ensureEngine = useCallback((): Engine | null => {
    if (isUsableEngine(engineRef.current)) return engineRef.current;
    if (isUsableEngine(ownedEngineRef.current)) {
      engineRef.current = ownedEngineRef.current;
      return ownedEngineRef.current;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    canvas.style.display = "none";
    document.body.appendChild(canvas);
    const engine = createAppEngine(canvas);
    ownedCanvasRef.current = canvas;
    ownedEngineRef.current = engine;
    const previous = engineRef.current;
    engineRef.current = engine;
    setSharedEngineGeneration((current) =>
      nextSharedEngineGeneration(current, engine, previous),
    );
    return engine;
  }, []);

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
    const frame = previewIframeRef.current;
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ type: PREVIEW_STOP_MESSAGE }, "*");
    }
    previewFilesRef.current = null;
    setPreviewOpen(false);
    setPreviewPhase(null);
    setPreviewError(null);
    setPreviewCanCancel(true);
    setPlaying(false);
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
      frame.postMessage(previewPackFromFiles(handoff.files), "*");
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
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appendLog, closePreview, sendPreviewPack]);

  const requestPreviewBuild = useCallback(async () => {
    if (playing || preparingRef.current) return;
    const startup = projectDocument?.settings.startupSceneGuid?.trim() ?? "";
    const asset = startup ? assetRegistry?.getByGuid(startup) : undefined;
    if (!startup || asset?.header.type !== "Scene") {
      setStartupAlertOpen(true);
      return;
    }
    previewCancelledRef.current = false;
    previewClosingRef.current = false;
    preparingRef.current = true;
    setPreparing(true);
    setPreviewCanCancel(true);
    setPreviewPhase("Saving");
    try {
      if (dirtyDocuments.length > 0) {
        const saved = await saveAll();
        if (!saved) return;
      }
      if (previewCancelledRef.current) return;
      setPreviewPhase("Collecting Assets");
      const playerFiles = await loadPlayerDistFiles();
      if (previewCancelledRef.current) return;
      const packed = await exportGameArtifact({
        previewBuild: true,
        playerFiles,
        onPhase: (phase) => {
          if (!previewCancelledRef.current) setPreviewPhase(phase);
        },
      });
      if (isErr(packed)) {
        if (packed.error === MISSING_STARTUP_SCENE_MESSAGE) {
          setStartupAlertOpen(true);
        } else {
          appendLog(`Preview Build failed: ${packed.error}`);
        }
        return;
      }
      if (previewCancelledRef.current) {
        previewFilesRef.current = null;
        return;
      }
      previewFilesRef.current = packed.value.files;
      setPreviewCanCancel(false);
      setPreviewPhase("Launching");
      setEncodeQueuePauseReason("play", true);
      setPlaying(true);
      setPreviewError(null);
      setPreviewSrc(playerPreviewSrc(Date.now()));
      setPreviewOpen(true);
    } catch (error) {
      previewFilesRef.current = null;
      appendLog(
        `Preview Build failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      preparingRef.current = false;
      setPreparing(false);
      setPreviewPhase(null);
    }
  }, [
    appendLog,
    assetRegistry,
    dirtyDocuments.length,
    exportGameArtifact,
    playing,
    projectDocument,
    saveAll,
  ]);

  const requestPlay = useCallback(
    async (options?: PlayOptions) => {
      if (previewBuild) {
        await requestPreviewBuild();
        return;
      }
      if (playing || preparingRef.current) return;
      if (!playIsEnabled(openDocuments, activeDocumentId)) return;
      pendingPlayOptionsRef.current = options;
      const inject = Boolean(options?.injectFixtureThrow);
      const plan = planPlayPreviewPrepare({
        dirtyDocuments: dirtyDocuments.map((doc) => ({ label: doc.ref.label })),
        scriptsStale,
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

        const shouldCompile =
          scriptsStale ||
          scripts.length === 0 ||
          (plan.action === "prepare" && plan.needsCompile);
        let nextScripts = scripts;
        let nextDiagnostics = diagnostics;
        if (shouldCompile) {
          const result = await collectPlayPreviewScripts();
          nextScripts = result.bundles;
          nextDiagnostics = result.diagnostics;
          setScripts(nextScripts);
          setDiagnostics(nextDiagnostics);
        }
        const resolvedScene = playSceneFromOpenDocuments(
          openDocuments,
          activeDocumentId,
        );
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
        let uiLibrary: Record<string, UserInterfaceDocument> = {};
        try {
          uiLibrary = await collectPlayUiLibrary();
          setPlayUiLibrary(uiLibrary);
          const urls = await collectUiImageUrls(
            collectImageGuidsFromUiDocuments(Object.values(uiLibrary)),
            (assetRegistry?.list() ?? []).map((asset) => ({
              guid: asset.header.guid,
              path: asset.path,
              type: asset.header.type,
              chunks: asset.header.chunks,
            })),
            readAssetChunk,
            playImageUrlsRef.current,
          );
          playImageUrlsRef.current = urls;
          setPlayImageUrls(urls);
        } catch (error) {
          appendLog(
            `UserInterface library failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          uiLibrary = {};
          setPlayUiLibrary({});
          revokeUiImageUrls(playImageUrlsRef.current);
          playImageUrlsRef.current = new Map();
          setPlayImageUrls(new Map());
        }
        try {
          const fonts = assetRegistry?.list() ?? [];
          setPlayFontEntries(
            await collectFontAssetEntries(
              fonts.map((asset) => ({
                guid: asset.header.guid,
                path: asset.path,
                type: asset.header.type,
                payload: asset.header.payload,
              })),
              readAssetChunk,
            ),
          );
        } catch (error) {
          appendLog(
            `Font registry failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayFontEntries([]);
        }
        let playGraphs: typeof playAnimGraphs = [];
        try {
          playGraphs = await collectPlayAnimGraphs(resolvedScene?.scene);
          setPlayAnimGraphs(playGraphs);
        } catch (error) {
          appendLog(
            `AnimationGraph load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayAnimGraphs([]);
        }
        let playTrees: typeof playBehaviourTrees = [];
        try {
          playTrees = await collectPlayBehaviourTrees(resolvedScene?.scene);
          setPlayBehaviourTrees(playTrees);
        } catch (error) {
          appendLog(
            `BehaviourTree load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayBehaviourTrees([]);
        }
        try {
          setPlayBlackboards(await collectPlayBlackboards(resolvedScene?.scene));
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
        try {
          sprites = await collectPlaySpritePayloads(
            resolvedScene?.scene,
            playGraphs,
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
          const tileContent = await collectPlayTilemapContent(resolvedScene?.scene);
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
          setPlayModelBytes(await collectPlayModelBytes(resolvedScene?.scene));
          modelPayloads = await collectPlayModelPayloads(resolvedScene?.scene);
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
          const particles = await collectPlayParticles();
          setPlayParticleLibrary(particles);
          const materials = await collectPlayMaterialLibrary(
            resolvedScene?.scene,
            playLibrary.map((entry) => entry.scene),
            [
              ...interfaceMaterialGuidsFromUiDocuments(Object.values(uiLibrary)),
              ...particleMaterialGuidsFromLibrary(particles),
              ...modelSlotMaterialGuidsFromPayloads(modelPayloads),
            ],
          );
          setPlayMaterialDocuments(materials.documents);
          setPlayMaterialFunctions(materials.functions);
          textureBytes = await collectPlayTextureBytes(
            sprites,
            tilesets,
            [
              ...materials.textureGuids,
              ...particleTextureGuidsFromLibrary(particles),
              ...skyboxFaceGuidsFromScene(resolvedScene?.scene),
            ],
            spriteAnimations,
          );
          setPlayTextureBytes(textureBytes);
        } catch (error) {
          appendLog(
            `Material load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayMaterialDocuments(new Map());
          setPlayMaterialFunctions(new Map());
          setPlayParticleLibrary(emptyPlayParticleLibrary());
          try {
            textureBytes = await collectPlayTextureBytes(
              sprites,
              tilesets,
              skyboxFaceGuidsFromScene(resolvedScene?.scene),
              spriteAnimations,
            );
            setPlayTextureBytes(textureBytes);
          } catch (textureError) {
            appendLog(
              `Texture load failed: ${textureError instanceof Error ? textureError.message : String(textureError)}`,
            );
            setPlayTextureBytes(new Map());
          }
        }
        spriteAnimations = hydrateSpriteAnimationPixelSizes(
          spriteAnimations,
          textureBytes,
        );
        setPlaySpriteAnimationPayloads(spriteAnimations);

        try {
          const audio = await collectPlayAudio();
          setPlayAudioBytes(audio.bytes);
          setPlayAudioLibrary(audio.library);
        } catch (error) {
          appendLog(
            `Audio load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayAudioBytes(new Map());
          setPlayAudioLibrary(emptyPlayAudioLibrary());
        }
        try {
          setPlayNavmeshBytes(
            await readPlayNavmeshBytes(resolvedScene?.path, readAssetChunk),
          );
        } catch (error) {
          appendLog(
            `Navmesh load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayNavmeshBytes(null);
        }
        try {
          setPlayAudioReverbBytes(
            await readPlayAudioReverbBytes(resolvedScene?.path, readAssetChunk),
          );
        } catch (error) {
          appendLog(
            `Audio reverb load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayAudioReverbBytes(null);
        }

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
      collectPlayPreviewScripts,
      collectPlayUiLibrary,
      collectPlayAnimGraphs,
      collectPlayBehaviourTrees,
      collectPlayBlackboards,
      collectPlaySpritePayloads,
      collectPlaySpriteAnimationPayloads,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayModelBytes,
      collectPlayModelPayloads,
      collectPlayAudio,
      collectPlayParticles,
      collectPlayMaterialLibrary,
      collectPlaySceneLibrary,
      diagnostics,
      dirtyDocuments,
      launchPlay,
      migrationPending.length,
      playing,
      playScene,
      previewBuild,
      requestPreviewBuild,
      openDocuments,
      activeDocumentId,
      assetRegistry,
      readAssetChunk,
      saveAll,
      scripts,
      scriptsStale,
      setDiagnostics,
    ],
  );

  const resumePlayAfterMigration = useCallback(async () => {
    setPlayAwaitingMigration(false);
    await requestPlay(pendingPlayOptionsRef.current);
  }, [requestPlay]);

  const cancelPlayMigration = useCallback(() => {
    setPlayAwaitingMigration(false);
    pendingPlayOptionsRef.current = undefined;
  }, []);

  const handleClose = useCallback(
    (result: PlaySessionResult) => {
      setPlaying(false);
      revokeUiImageUrls(playImageUrlsRef.current);
      playImageUrlsRef.current = new Map();
      setPlayImageUrls(new Map());
      setEncodeQueuePauseReason("play", false);
      setLiveBtState(null);
      setDropped(result.droppedDiagnostics);
      setReportEntries(result.diagnostics);
      setLastRuntimeMode(result.runtimeMode);
      if (result.diagnostics.length > 0) {
        setReportOpen(true);
      }
      const leakNote = result.textureLeak ? " LEAK" : "";
      appendLog(
        `Play ended (${result.runtimeMode}; textures ${result.textureCountBefore}→${result.textureCountAfter}${leakNote})`,
      );
      if (result.textureLeak) {
        appendLog(
          `Texture leak detected: ${result.textureCountBefore} → ${result.textureCountAfter}`,
        );
      }
    },
    [appendLog],
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
      stopPlay: () => {
        if (previewOpen) {
          closePreview();
          return;
        }
        setPlaying(false);
      },
      registerSharedEngine,
      ensureSharedEngine: ensureEngine,
      sharedEngineGeneration,
      registerScheduler,
      focusedNodeId,
      clearFocusedNode: () => setFocusedNodeId(null),
      appendLog,
      logLines,
      liveBtState,
      reportBtState: setLiveBtState,
    }),
    [
      playing,
      preparing,
      playAwaitingMigration,
      requestPlay,
      canPlay,
      previewBuild,
      setPreviewBuild,
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
      logLines,
      liveBtState,
      closePreview,
      previewOpen,
    ],
  );

  return (
    <PlayContext.Provider value={value}>
      <OutputLogContext.Provider value={{ lines: logLines }}>
        {children}
        {previewPhase ? (
          <PreparingPreviewDialog
            open
            phase={previewPhase}
            canCancel={previewCanCancel}
            onCancel={() => {
              previewCancelledRef.current = true;
              setPreviewPhase(null);
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
            gameInstanceClass={resolveGameInstanceClass(
              projectDocument?.settings,
              playScene?.scene,
            )}
            scenes={playSceneLibrary}
            uiLibrary={playUiLibrary}
            uiSettings={projectDocument?.settings.ui}
            fontEntries={playFontEntries}
            resolveImageUrl={(guid) => playImageUrls.get(guid) ?? null}
            animGraphs={playAnimGraphs}
            behaviourTrees={playBehaviourTrees}
            blackboards={playBlackboards}
            spritePayloads={playSpritePayloads}
            spriteAnimationPayloads={playSpriteAnimationPayloads}
            tilemapPayloads={playTilemaps}
            tilesetPayloads={playTilesets}
            textureBytes={playTextureBytes}
            modelBytes={playModelBytes}
            modelPayloads={playModelPayloads}
            modelClipAnimationGuids={playModelClipAnimationGuids}
            retargetAnimationLoads={playRetargetAnimationLoads}
            audioBytes={playAudioBytes}
            audioLibrary={playAudioLibrary}
            animClipCatalog={animClipCatalogFromAssets(assetRegistry?.list() ?? [])}
            particleLibrary={playParticleLibrary}
            materialDocuments={playMaterialDocuments}
            materialFunctions={playMaterialFunctions}
            postProcessingEnabled={postProcessingEnabled}
            hardwareScalingLevel={hardwareScalingLevel}
            pauseOnPlay={pauseOnPlay}
            navmeshBytes={playNavmeshBytes}
            audioReverbBytes={playAudioReverbBytes}
            audioProjectSettings={projectDocument?.settings.audio}
            pixelsPerUnit={
              projectDocument?.settings.twoD.pixelsPerUnit ?? 100
            }
            pixelPerfect={projectDocument?.settings.twoD.pixelPerfect === true}
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
      </OutputLogContext.Provider>
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

export function useOutputLog(): { lines: string[] } {
  return useContext(OutputLogContext);
}
