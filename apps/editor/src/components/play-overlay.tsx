import { useDiagnosticResultsStore } from "../context/diagnostic-results-context";
import type { DiagnosticResultsStore } from "../services/diagnostic-results-store";
import type { SimulationSession } from "../services/simulation-session";
import { SimulationRetentionDialog, SimulationRetentionHint } from "./simulation-retention-dialog";
import { SimulationTransformToolbar } from "./simulation-transform-toolbar";
import type { GizmoTool, RuntimeTransformTools } from "@babylonslate/render";
import { useSimulationInspectionStore } from "../context/simulation-inspection-context";
import { useAppSettings } from "../context/app-settings-context";
import { captureShadowDiagnostics, lightsDebugText } from "@babylonslate/render";
import { SceneLoadingDialog } from "./scene-loading-dialog";
import type { SceneLoadProgress } from "@babylonslate/render";
import type { RenderDiagnostics } from "@babylonslate/render";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  resolveRenderingQuality,
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  type PlayPreviewProjectSettings,
  type ProjectInputSettings,
  type RenderProjectSettings,
  type AudioProjectSettings,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import { cn } from "@babylonslate/ui/lib/utils";
import { SelectableText } from "@babylonslate/editor-kit";
import type { AnimClipCatalogEntry } from "@babylonslate/anim-graph";
import { applyInspectSelectionToConsoleLine } from "@babylonslate/runtime";
import type { AbstractEngine } from "@babylonjs/core";
import { createAppSettingsStore } from "@babylonslate/vfs";
import {
  startPlaySession,
  type PlaySession,
  type PlaySessionResult,
  type PlaySceneSourceLoader,
  type PlayAssetSourceLoader,
} from "../services/play-session";
import type { GameSessionOwner, GameSessionTicket } from "../services/game-session-owner";
import { finishPlaySessionWithTrace } from "../lib/play-trace-spill";
import type { StatsHudHighlight } from "./stats-hud";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import {
  applyLiveEngineSettings,
  canvasIsEditorVisible,
  localRenderingQualityOverrides,
  ENGINE_SETTINGS_CHANGED_EVENT,
  type LiveEngineSettings,
} from "../lib/viewport-render-gate";
import { createCanvasResizeGuard } from "../lib/canvas-resize-guard";
import { PrintHud, type PrintHudPrint } from "./print-overlay";
import { DebugConsole } from "./debug-console";
import { DebugBehaviourTreeDialog } from "./debug-behaviour-tree-dialog";
import type { DebugBehaviourTree } from "@babylonslate/bridge";
import { DebugInspectDialog } from "./debug-inspect-dialog";
import { PlayOverlayChrome } from "./play-overlay-chrome";
import { PlayFreeCamJoystick } from "./play-freecam-joystick";
import { StatsHud } from "./stats-hud";
import {
  playConsoleCommands,
  playConsoleCompletionContext,
} from "../lib/play-console";
import { nextPlayInspectorOpen } from "../lib/play-debugger-defaults";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  applyPlayPreviewCanvasLayout,
  clampRenderResolution,
  playFramebufferSize,
} from "../lib/play-preview-aspect";
import type { PlayPhysicsSettings } from "../services/play-physics";
import type {
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
  ModelPayload,
  ParticleLibrary,
  RetargetAnimationLoad,
} from "@babylonslate/assets";
import type { PlayAudioLibrary } from "../lib/play-audio";
import {
  PLAY_AUDIO_UNLOCK_HINT,
  shouldShowPlayAudioUnlockHint,
} from "../lib/play-audio-unlock-hint";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { isTestModeEnabled } from "@babylonslate/vfs";
import {
  getHostMemoryStats,
  type HostMemoryStats,
} from "@babylonslate/vfs";
import {
  audioDebugOverlayText,
  audioStats,
  type FontAssetEntry,
} from "@babylonslate/render";
import { useInspectWorldPoll } from "../lib/use-inspect-world-poll";
import { useDebugConsoleLogs } from "../lib/use-debug-console-logs";
import { usePlay } from "../context/play-context";

export interface PlayOverlayProps {
  sessionOwner?: GameSessionOwner<PlaySessionResult>;
  sessionTicket?: GameSessionTicket;
  embedded?: boolean;
  simulationSession?: SimulationSession;
  simulationAssetGuids?: readonly string[];
  simulationSaveStorage?: Parameters<typeof startPlaySession>[0]["simulationSaveStorage"];
  saveGame?: import("@babylonslate/core").SaveGameConfiguration;
  sharedEngine: AbstractEngine;
  injectFixtureThrow?: boolean;
  scripts?: readonly ScriptBundleEntry[];
  physics?: PlayPhysicsSettings;
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  project?: { name: string; version: string };
  gameInstanceClass?: string;
  scenes?: Array<{ guid: string; scene: SerializedScene }>;
  sceneCatalog?: Array<{ guid: string; name: string }>;
  classAssetGuids?: Record<string, string>;
  consoleCommands?: Array<import("@babylonslate/core").ConsoleCommandMetadata & { classId: string; assetGuid: string }>;
  audioAssetGuids?: string[];
  acquireSceneSources?: PlaySceneSourceLoader;
  acquireAssetSources?: PlayAssetSourceLoader;
  sessionSources?: import("@babylonslate/render").SceneSourceAssets;
  getAssetLoadState?: (guid: string) => import("@babylonslate/core").RuntimeAssetLoadState;
  getSourceControls?: () => import("@babylonslate/bridge").ControlMessage[];
  releaseInitialSources?: () => void | import("@babylonslate/bridge").ControlMessage[];
  sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
  /** Project `playFrameCap` applied once when the session starts. */
  frameCap?: number;
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  inputAssets?: import("@babylonslate/core").InputAssetDefinition[];
  dataAssets?: import("@babylonslate/core").DataAssetCatalogEntry[];
  inputMappings?: ProjectInputSettings;
  focusNavigation?: import("@babylonslate/core").FocusNavigationSettings;
  /** Project Play Preview letterbox; snapshotted when the session starts. */
  playPreview?: PlayPreviewProjectSettings;
  /** Project render size; snapshotted when the session starts. */
  render?: RenderProjectSettings;
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimationPayloads?: ReadonlyMap<string, SpriteAnimationPayload>;
  renderTargets?: ReadonlyMap<string, import("@babylonslate/core").RenderTargetPayload>;
  renderTargetTextures?: ReadonlyMap<string, import("@babylonslate/core").RenderTargetTexturePayload>;
  waterPayloads?: ReadonlyMap<string, import("@babylonslate/core").WaterDefinition>;
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  textureBytes?: ReadonlyMap<string, Uint8Array>;
  areaEmissions?: ReadonlyMap<string, import("@babylonslate/assets").AreaEmissionPixels>;
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
  fontMsdfJson?: ReadonlyMap<string, Uint8Array>;
  fontMsdfPng?: ReadonlyMap<string, Uint8Array>;
  fontFaceEntries?: readonly FontAssetEntry[];
  fontCssStack?: string;
  fontCssStackByGuid?: ReadonlyMap<string, string>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  modelPayloads?: ReadonlyMap<string, ModelPayload>;
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  retargetAnimationLoads?: ReadonlyMap<
    string,
    readonly RetargetAnimationLoad[]
  >;
  loadAudioSourceBytes?: import("@babylonslate/render").AudioSourceBytesLoader;
  audioLibrary?: PlayAudioLibrary;
  animClipCatalog?: readonly AnimClipCatalogEntry[];
  particleLibrary?: ParticleLibrary;
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  postProcessingEnabled?: boolean;
  hardwareScalingLevel?: number;
  pixelsPerUnit?: number;
  sortingLayers?: readonly string[];
  pixelPerfect?: boolean;
  touchMinTargetPx?: number;
  navmeshBytes?: Uint8Array | null;
  sceneNavmeshBytes?: ReadonlyMap<string, Uint8Array>;
  audioReverbByScene?: ReadonlyMap<string, Uint8Array>;
  audioReverbBytes?: Uint8Array | null;
  audioProjectSettings?: Partial<
    Pick<
      AudioProjectSettings,
      | "occlusionEnabled"
      | "reverbWetScale"
      | "reverbDecayScale"
      | "reverbDampingScale"
    >
  >;
  pauseOnPlay?: boolean;
  onClose: (result: PlaySessionResult, ticket?: GameSessionTicket) => void;
}

function emptyPlayResult(): PlaySessionResult {
  return {
    diagnostics: [],
    droppedDiagnostics: 0,
    textureCountBefore: 0,
    released: Promise.resolve({
      textureCountAfter: 0,
      textureLeak: false,
      quarantined: false,
    }),
    runtimeMode: "in-process",
    lastTrace: null,
  };
}

export function PlayOverlay({
  sessionOwner,
  sessionTicket,
  embedded = false,
  simulationSaveStorage,
  simulationSession,
  simulationAssetGuids,
  saveGame,
  sharedEngine,
  injectFixtureThrow,
  scripts,
  physics,
  sceneAssetGuid,
  scene,
  project,
  gameInstanceClass,
  scenes,
  sceneCatalog,
  classAssetGuids,
  consoleCommands,
  audioAssetGuids,
  acquireSceneSources,
  acquireAssetSources,
  sessionSources,
  getAssetLoadState,
  getSourceControls,
  releaseInitialSources,
  sceneLayers,
  frameCap = DEFAULT_PLAY_FRAME_CAP,
  infiniteLoopDetection,
  loopCount,
  inputAssets,
  dataAssets,
  inputMappings,
  focusNavigation,
  playPreview = DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  render = DEFAULT_RENDER_PROJECT_SETTINGS,
  animGraphs,
  behaviourTrees,
  blackboards,
  spritePayloads,
  spriteAnimationPayloads,
  waterPayloads,
  renderTargets,
  renderTargetTextures,
  tilemapPayloads,
  tilesetPayloads,
  textureBytes,
  areaEmissions,
  texturePixelSizes,
  fontFacetypeBytes,
  fontMsdfJson,
  fontMsdfPng,
  fontFaceEntries,
  fontCssStack,
  fontCssStackByGuid,
  modelBytes,
  modelPayloads,
  modelClipAnimationGuids,
  retargetAnimationLoads,
  loadAudioSourceBytes,
  audioLibrary,
  animClipCatalog,
  particleLibrary,
  materialDocuments,
  materialFunctions,
  postProcessingEnabled,
  hardwareScalingLevel,
  pixelsPerUnit,
  sortingLayers,
  pixelPerfect,
  touchMinTargetPx,
  navmeshBytes,
  sceneNavmeshBytes,
  audioReverbByScene,
  audioReverbBytes,
  audioProjectSettings,
  pauseOnPlay = false,
  onClose,
}: PlayOverlayProps) {
  const { reportBtState, overlayStats, overlayConsole, overlayInspector } =
    usePlay();
  const simulating = sessionTicket?.mode === "simulate";
  const inspectionStore = useSimulationInspectionStore();
  const diagnosticStore = useDiagnosticResultsStore();
  const diagnosticDetachRef = useRef<(() => void) | null>(null);
  const inspectionDetachRef = useRef<(() => void) | null>(null);
  const transformToolsRef = useRef<RuntimeTransformTools | null>(null);
  const transformConsumerRef = useRef<(() => void) | null>(null);
  const transformDetachRef = useRef<(() => void) | null>(null);
  const transformEditableRef = useRef(false);
  const syncTransformVisibilityRef = useRef<() => void>(() => {});
  const [transformTool, setTransformTool] = useState<GizmoTool>("translate");
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<PlaySession | null>(null);
  const [fps, setFps] = useState(0);
  const [scriptMs, setScriptMs] = useState(0);
  const [physicsMs, setPhysicsMs] = useState(0);
  const [publishMs, setPublishMs] = useState(0);
  const [memoryBytes, setMemoryBytes] = useState(0);
  const [hostMemory, setHostMemory] = useState<HostMemoryStats | null>(null);
  const [geometryBytes, setGeometryBytes] = useState(0);
  const [meshCount, setMeshCount] = useState(0);
  const [textureCount, setTextureCount] = useState(0);
  const [draws, setDraws] = useState(0);
  const [rendering, setRendering] = useState<RenderDiagnostics>();
  const [bridgeRate, setBridgeRate] = useState(0);
  const { logs, pushLog } = useDebugConsoleLogs();
  const [treeOpen, setTreeOpen] = useState(false);
  const [trees, setTrees] = useState<readonly DebugBehaviourTree[]>([]);
  const [moveX, setMoveX] = useState<number | null>(null);
  const [actorGuids, setActorGuids] = useState<string[]>([]);
  const [actorYs, setActorYs] = useState<number[]>([]);
  const [audioQueued, setAudioQueued] = useState(0);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [audioDebugText, setAudioDebugText] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [freeCamEnabled, setFreeCamEnabled] = useState(false);
  const [paused, setPaused] = useState(pauseOnPlay);
  const [pausePending, setPausePending] = useState(false);
  const [inputMode, setInputMode] = useState<"game" | "edit">("game");
  const [inputPending, setInputPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const inputModeRef = useRef<"game" | "edit">("game");
  const inputSequenceRef = useRef(0);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsHighlight, setStatsHighlight] =
    useState<StatsHudHighlight | null>(null);
  const inspectSelectionRef = useRef<string | null>(null);
  const hostMemoryInFlight = useRef(false);
  const userPausedRef = useRef(pauseOnPlay);
  const [postProcessPasses, setPostProcessPasses] = useState(0);
  const [assignedMaterials, setAssignedMaterials] = useState("");
  // The Worker can take time to initialize before its first scene token arrives.
  const [sceneLoading, setSceneLoading] = useState<Pick<SceneLoadProgress, "phase" | "progress"> | null>({
    phase: "Preparing Scene",
    progress: 0,
  });
  const printRef = useRef<PrintHudPrint | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closedRef = useRef(false);
  const finishSessionRef = useRef<() => void>(() => {});
  const detachInspection = () => {
    transformDetachRef.current?.();
    transformDetachRef.current = null;
    inspectionDetachRef.current?.();
    inspectionDetachRef.current = null;
  };
  finishSessionRef.current = () => {
    if (closedRef.current) return;
    if (sessionOwner && sessionTicket) {
      void sessionOwner.stop(sessionTicket).then((result) => {
        // A refused retention gate leaves the runtime and its controls available.
        if (!result && sessionOwner.canStart()) onCloseRef.current(emptyPlayResult(), sessionTicket);
      });
      return;
    }
    closedRef.current = true;
    detachInspection();
    const session = sessionRef.current;
    sessionRef.current = null;
    void (async () => {
      const result = session ? await finishPlaySessionWithTrace(session) : emptyPlayResult();
      diagnosticDetachRef.current?.();
      diagnosticDetachRef.current = null;
      onCloseRef.current(result);
    })();
  };
  const changeInputModeRef = useRef<(mode: "game" | "edit") => void>(() => {});
  changeInputModeRef.current = (mode) => {
    const session = sessionRef.current;
    if (!session || !simulating || closedRef.current) return;
    const sequence = ++inputSequenceRef.current;
    inputModeRef.current = mode;
    transformEditableRef.current = false;
    syncTransformVisibilityRef.current();
    setInputPending(true);
    setControlError(null);
    void session.setInputMode(mode).then(() => {
      if (sessionRef.current !== session || inputSequenceRef.current !== sequence) return;
      inputModeRef.current = mode;
      setInputMode(mode);
      transformEditableRef.current = mode === "edit";
      syncTransformVisibilityRef.current();
      session.requestPausedRedraw();
    }, (error: unknown) => {
      if (sessionRef.current === session && inputSequenceRef.current === sequence) setControlError(String(error));
    }).finally(() => {
      if (sessionRef.current === session && inputSequenceRef.current === sequence) setInputPending(false);
    });
  };
  const pauseRef = useRef<(reason: "user" | "lifecycle", next: boolean) => void>(() => {});
  pauseRef.current = (reason, next) => {
    const session = sessionRef.current;
    if (!session || closedRef.current) return;
    if (!simulating) {
      userPausedRef.current = next;
      session.setPaused(next);
      setPaused(next);
      return;
    }
    if (reason === "user") setPausePending(true);
    setControlError(null);
    void session.setPauseReason(reason, next).then((result) => {
      if (sessionRef.current !== session) return;
      if (!result.success) { setControlError(result.reason ?? "Pause could not reach a completed runtime boundary."); return; }
      userPausedRef.current = result.pauseReasons.includes("user");
      setPaused(result.paused);
      if (sessionOwner && sessionTicket) sessionOwner.acknowledgePaused(sessionTicket, result.paused);
      if (result.paused) session.requestPausedRedraw();
    }, (error: unknown) => {
      if (sessionRef.current === session) setControlError(String(error));
    }).finally(() => { if (sessionRef.current === session && reason === "user") setPausePending(false); });
  };

  useEffect(() => {
    if (!simulating) return;
    const releaseOutsideGame = (event: Event) => {
      if (inputModeRef.current !== "game") return;
      const target = event.target;
      // Chrome owns this gesture; it cannot also become a game or camera gesture.
      if (target instanceof Node && !canvasRef.current?.contains(target) &&
        !(target instanceof Element && target.closest('[data-testid="simulation-input-mode"]'))) {
        changeInputModeRef.current("edit");
      }
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") changeInputModeRef.current("edit"); };
    document.addEventListener("pointerdown", releaseOutsideGame, true);
    document.addEventListener("focusin", releaseOutsideGame, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", releaseOutsideGame, true);
      document.removeEventListener("focusin", releaseOutsideGame, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [simulating]);

  useEffect(() => {
    if (simulating && (consoleOpen || inspectorOpen || treeOpen)) changeInputModeRef.current("edit");
  }, [simulating, consoleOpen, inspectorOpen, treeOpen]);

  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;
  const animGraphsRef = useRef(animGraphs);
  animGraphsRef.current = animGraphs;
  const behaviourTreesRef = useRef(behaviourTrees);
  behaviourTreesRef.current = behaviourTrees;
  const blackboardsRef = useRef(blackboards);
  blackboardsRef.current = blackboards;
  const spritePayloadsRef = useRef(spritePayloads);
  spritePayloadsRef.current = spritePayloads;
  const spriteAnimationPayloadsRef = useRef(spriteAnimationPayloads);
  spriteAnimationPayloadsRef.current = spriteAnimationPayloads;
  const renderTargetsRef = useRef(renderTargets);
  renderTargetsRef.current = renderTargets;
  const renderTargetTexturesRef = useRef(renderTargetTextures);
  renderTargetTexturesRef.current = renderTargetTextures;
  const waterPayloadsRef = useRef(waterPayloads);
  waterPayloadsRef.current = waterPayloads;
  const tilemapPayloadsRef = useRef(tilemapPayloads);
  tilemapPayloadsRef.current = tilemapPayloads;
  const tilesetPayloadsRef = useRef(tilesetPayloads);
  tilesetPayloadsRef.current = tilesetPayloads;
  const textureBytesRef = useRef(textureBytes);
  const areaEmissionsRef = useRef(areaEmissions);
  areaEmissionsRef.current = areaEmissions;
  textureBytesRef.current = textureBytes;
  const texturePixelSizesRef = useRef(texturePixelSizes);
  texturePixelSizesRef.current = texturePixelSizes;
  const fontFacetypeBytesRef = useRef(fontFacetypeBytes);
  fontFacetypeBytesRef.current = fontFacetypeBytes;
  const fontMsdfJsonRef = useRef(fontMsdfJson);
  fontMsdfJsonRef.current = fontMsdfJson;
  const fontMsdfPngRef = useRef(fontMsdfPng);
  fontMsdfPngRef.current = fontMsdfPng;
  const fontFaceEntriesRef = useRef(fontFaceEntries);
  fontFaceEntriesRef.current = fontFaceEntries;
  const fontCssStackRef = useRef(fontCssStack);
  fontCssStackRef.current = fontCssStack;
  const fontCssStackByGuidRef = useRef(fontCssStackByGuid);
  fontCssStackByGuidRef.current = fontCssStackByGuid;
  const modelBytesRef = useRef(modelBytes);
  modelBytesRef.current = modelBytes;
  const modelPayloadsRef = useRef(modelPayloads);
  modelPayloadsRef.current = modelPayloads;
  const modelClipAnimationGuidsRef = useRef(modelClipAnimationGuids);
  modelClipAnimationGuidsRef.current = modelClipAnimationGuids;
  const retargetAnimationLoadsRef = useRef(retargetAnimationLoads);
  retargetAnimationLoadsRef.current = retargetAnimationLoads;
  const loadAudioSourceBytesRef = useRef(loadAudioSourceBytes);
  loadAudioSourceBytesRef.current = loadAudioSourceBytes;
  const audioLibraryRef = useRef(audioLibrary);
  audioLibraryRef.current = audioLibrary;
  const animClipCatalogRef = useRef(animClipCatalog);
  animClipCatalogRef.current = animClipCatalog;
  const particleLibraryRef = useRef(particleLibrary);
  particleLibraryRef.current = particleLibrary;
  const materialDocumentsRef = useRef(materialDocuments);
  materialDocumentsRef.current = materialDocuments;
  const materialFunctionsRef = useRef(materialFunctions);
  materialFunctionsRef.current = materialFunctions;
  const navmeshBytesRef = useRef(navmeshBytes);
  navmeshBytesRef.current = navmeshBytes;
  const sceneNavmeshBytesRef = useRef(sceneNavmeshBytes);
  sceneNavmeshBytesRef.current = sceneNavmeshBytes;
  const audioReverbBySceneRef = useRef(audioReverbByScene);
  audioReverbBySceneRef.current = audioReverbByScene;
  const audioReverbBytesRef = useRef(audioReverbBytes);
  audioReverbBytesRef.current = audioReverbBytes;
  const audioProjectSettingsRef = useRef(audioProjectSettings);
  audioProjectSettingsRef.current = audioProjectSettings;
  const sortingLayersRef = useRef(sortingLayers);
  sortingLayersRef.current = sortingLayers;
  const pixelsPerUnitRef = useRef(pixelsPerUnit);
  pixelsPerUnitRef.current = pixelsPerUnit;
  const touchMinTargetPxRef = useRef(touchMinTargetPx);
  touchMinTargetPxRef.current = touchMinTargetPx;
  const pixelPerfectRef = useRef(pixelPerfect);
  pixelPerfectRef.current = pixelPerfect;
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  const sceneRef = useRef({
    sceneAssetGuid,
    scene,
    project,
    saveGame,
    gameInstanceClass,
    scenes,
    sceneCatalog,
    classAssetGuids,
    consoleCommands,
    audioAssetGuids,
    acquireSceneSources,
    acquireAssetSources,
    sessionSources,
    getAssetLoadState,
    getSourceControls,
    releaseInitialSources,
    sceneLayers,
  });
  sceneRef.current = {
    sceneAssetGuid,
    scene,
    project,
    saveGame,
    gameInstanceClass,
    scenes,
    sceneCatalog,
    classAssetGuids,
    consoleCommands,
    audioAssetGuids,
    acquireSceneSources,
    acquireAssetSources,
    sessionSources,
    getAssetLoadState,
    getSourceControls,
    releaseInitialSources,
    sceneLayers,
  };
  const initialFrameCapRef = useRef(frameCap);
  const initialPauseOnPlayRef = useRef(pauseOnPlay);
  const initialInfiniteLoopDetectionRef = useRef(infiniteLoopDetection);
  const initialLoopCountRef = useRef(loopCount);
  const initialInputAssetsRef = useRef(inputAssets);
  const initialDataAssetsRef = useRef(dataAssets);
  const initialInputMappingsRef = useRef(inputMappings);
  const initialFocusNavigationRef = useRef(focusNavigation);
  const initialPlayPreviewRef = useRef(playPreview);
  const { settings: localEngineSettings } = useAppSettings();
  const initialTraceByteBudgetRef = useRef(localEngineSettings.traceByteBudget);
  const initialRenderRef = useRef(render);
  const runtimeRenderRef = useRef(render);
  const initialConsoleRenderRef = useRef({ ...render, quality: resolveRenderingQuality(render, {}, localRenderingQualityOverrides(localEngineSettings)) });
  const liveSizeRef = useRef<{ width: number; height: number } | null>(null);
  const commands = useMemo(() => playConsoleCommands(scripts ?? []), [scripts]);
  const inspectSnapshot = useInspectWorldPoll(
    consoleOpen || nextPlayInspectorOpen(inspectorOpen, overlayInspector),
    () =>
      sessionRef.current?.inspectWorld() ??
      Promise.resolve({ tickIndex: 0, nodes: [] }),
  );
  const completionContext = useMemo(
    () =>
      playConsoleCompletionContext({
        commands,
        sceneAssetGuid,
        scene,
        scenes,
        inspectNodes: inspectSnapshot.nodes,
      }),
    [commands, sceneAssetGuid, scene, scenes, inspectSnapshot],
  );

  useEffect(() => {
    setInspectorOpen((open) => nextPlayInspectorOpen(open, overlayInspector));
  }, [overlayInspector]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    if (sessionOwner && sessionTicket && !sessionOwner.isCurrent(sessionTicket)) return;
    // StrictMode probes effects with setup/cleanup/setup. Defer acquisition so
    // the abandoned setup cannot allocate a second shared-Engine consumer.
    let cancelled = false;
    let disposePresentation: (() => void) | undefined;
    queueMicrotask(() => {
      if (cancelled || closedRef.current || (sessionOwner && sessionTicket && !sessionOwner.isCurrent(sessionTicket))) return;
      const layoutPlay = () => {
        applyPlayPreviewCanvasLayout({
          overlay,
          canvas,
          ...initialPlayPreviewRef.current,
          render: runtimeRenderRef.current,
          liveSize: liveSizeRef.current,
        });
      };
      const resizeIfSized = createCanvasResizeGuard(
        () => {
          sessionRef.current?.handle.resize();
        },
        {
          onHoldChange: (holding) => {
            sessionRef.current?.handle.scheduler.setResizing(holding);
          },
        },
      );
      const syncFramebuffer = (sessionHandle: {
        setSize: (w: number, h: number) => void;
        resize: () => void;
      }) => {
        const framebuffer = playFramebufferSize(
          runtimeRenderRef.current,
          liveSizeRef.current,
        );
        if (framebuffer) {
          sessionHandle.setSize(framebuffer.width, framebuffer.height);
          return;
        }
        resizeIfSized(canvas);
      };
      layoutPlay();
      userPausedRef.current = initialPauseOnPlayRef.current;
      setPaused(initialPauseOnPlayRef.current);
      let session: PlaySession;
      let diagnosticLease: ReturnType<DiagnosticResultsStore["bindSession"]> | undefined;
      if (sessionOwner && sessionTicket && !sessionOwner.attach(sessionTicket, async () => {
        closedRef.current = true;
        transformDetachRef.current?.();
        transformDetachRef.current = null;
        inspectionDetachRef.current?.();
        inspectionDetachRef.current = null;
        sessionRef.current = null;
        const result = await finishPlaySessionWithTrace(session);
        diagnosticLease?.release();
        diagnosticDetachRef.current = null;
        onCloseRef.current(result, sessionTicket);
        return result;
      })) return;
      try {
        session = startPlaySession({
          canvas,
          sharedEngine,
          mode: sessionTicket?.mode === "simulate" ? "simulate" : "play",
          sessionGeneration: sessionTicket?.generation,
          simulationSaveStorage,
          simulationAssetGuids,
          onProfile: profile => diagnosticLease?.publishProfile(profile),
          onRetentionUnavailable: reason => simulationSession?.reportRetentionUnavailable(reason),
          injectFixtureThrow,
          scripts: scriptsRef.current,
          physics: physicsRef.current,
          sceneAssetGuid: sceneRef.current.sceneAssetGuid,
          scene: sceneRef.current.scene,
          project: sceneRef.current.project,
          saveGame: sceneRef.current.saveGame,
          gameInstanceClass: sceneRef.current.gameInstanceClass,
          scenes: sceneRef.current.scenes,
          sceneCatalog: sceneRef.current.sceneCatalog,
          classAssetGuids: sceneRef.current.classAssetGuids,
          consoleCommands: sceneRef.current.consoleCommands,
          audioAssetGuids: sceneRef.current.audioAssetGuids,
          acquireSceneSources: sceneRef.current.acquireSceneSources,
          acquireAssetSources: sceneRef.current.acquireAssetSources,
          sessionSources: sceneRef.current.sessionSources,
          getAssetLoadState: sceneRef.current.getAssetLoadState,
          getSourceControls: sceneRef.current.getSourceControls,
          releaseInitialSources: sceneRef.current.releaseInitialSources,
          sceneLayers: sceneRef.current.sceneLayers,
          frameCap: initialFrameCapRef.current,
          traceByteBudget: initialTraceByteBudgetRef.current,
          infiniteLoopDetection: initialInfiniteLoopDetectionRef.current,
          loopCount: initialLoopCountRef.current,
          inputAssets: initialInputAssetsRef.current,
          dataAssets: initialDataAssetsRef.current,
          inputMappings: initialInputMappingsRef.current,
          focusNavigation: initialFocusNavigationRef.current,
          animGraphs: animGraphsRef.current,
          behaviourTrees: behaviourTreesRef.current,
          blackboards: blackboardsRef.current,
          spritePayloads: spritePayloadsRef.current,
          spriteAnimationPayloads: spriteAnimationPayloadsRef.current,
          waterPayloads: waterPayloadsRef.current,
          renderTargets: renderTargetsRef.current,
          renderTargetTextures: renderTargetTexturesRef.current,
          tilemapPayloads: tilemapPayloadsRef.current,
          tilesetPayloads: tilesetPayloadsRef.current,
          textureBytes: textureBytesRef.current,
          areaEmissions: areaEmissionsRef.current,
          texturePixelSizes: texturePixelSizesRef.current,
          fontFacetypeBytes: fontFacetypeBytesRef.current,
          fontMsdfJson: fontMsdfJsonRef.current,
          fontMsdfPng: fontMsdfPngRef.current,
          fontFaceEntries: fontFaceEntriesRef.current,
          fontCssStack: fontCssStackRef.current,
          fontCssStackByGuid: fontCssStackByGuidRef.current,
          modelBytes: modelBytesRef.current,
          modelPayloads: modelPayloadsRef.current,
          modelClipAnimationGuids: modelClipAnimationGuidsRef.current,
          retargetAnimationLoads: retargetAnimationLoadsRef.current,
          loadAudioSourceBytes: loadAudioSourceBytesRef.current,
          audioLibrary: audioLibraryRef.current,
          animClipCatalog: animClipCatalogRef.current,
          particleLibrary: particleLibraryRef.current,
          materialDocuments: materialDocumentsRef.current,
          materialFunctions: materialFunctionsRef.current,
          postProcessingEnabled,
          renderSettings: initialRenderRef.current,
          consoleRenderSettings: initialConsoleRenderRef.current,
          hardwareScalingLevel,
          pixelsPerUnit: pixelsPerUnitRef.current,
          sortingLayers: sortingLayersRef.current,
          touchMinTargetPx: touchMinTargetPxRef.current,
          pixelPerfect: pixelPerfectRef.current,
          navmeshBytes: navmeshBytesRef.current,
          sceneNavmeshBytes: sceneNavmeshBytesRef.current,
          audioReverbByScene: audioReverbBySceneRef.current,
          audioReverbBytes: audioReverbBytesRef.current,
          audioProjectSettings: audioProjectSettingsRef.current,
          pauseOnPlay: initialPauseOnPlayRef.current,
          onSceneLoading: setSceneLoading,
          onSessionPaused: (next) => {
            if (!simulating) userPausedRef.current = next;
            setPaused(next);
          },
          onShowFps: (enabled) => {
            setStatsOpen(enabled);
            if (!enabled) setStatsHighlight(null);
          },
          onFreeCam: (enabled) => {
            setFreeCamEnabled(enabled);
          },
          onStatHighlight: (name, enabled) => {
            setStatsOpen(true);
            setStatsHighlight(
              enabled &&
                (name === "unit" ||
                  name === "memory" ||
                  name === "draws" ||
                  name === "threads")
                ? name
                : null,
            );
          },
          onStats: (stats) => {
            setFps(stats.fps);
            setScriptMs(stats.scriptMs);
            setPhysicsMs(stats.physicsMs);
            setPublishMs(stats.publishMs);
            setMoveX(sessionRef.current?.lastMoveX() ?? null);
          },
          onLog: (message, severity) => pushLog(severity, message),
          onPrint: (entry) => {
            printRef.current?.(entry);
            pushLog("print", entry.message);
          },
          onBehaviourTreeDebug: (enabled) => {
            setTreeOpen(enabled);
            if (enabled) setConsoleOpen(false);
          },
          onBehaviourTreeSnapshot: setTrees,
          onBtState: (state) => reportBtState(state),
          onRenderOutputChanged: (settings) => {
            runtimeRenderRef.current = settings;
            liveSizeRef.current = null;
            layoutPlay();
          },
          onSetRenderResolution: (width, height) => {
            liveSizeRef.current = {
              width: clampRenderResolution(width),
              height: clampRenderResolution(height),
            };
            layoutPlay();
            const current = sessionRef.current;
            if (current) syncFramebuffer(current.handle);
          },
          onFatalDiagnostic: () => finishSessionRef.current(),
        });
      } catch (error) {
        if (sessionOwner && sessionTicket) sessionOwner.fail(sessionTicket, error, true);
        pushLog("error", `Play startup failed: ${error instanceof Error ? error.message : String(error)}`);
        onCloseRef.current(emptyPlayResult(), sessionTicket);
        return;
      }
      sessionRef.current = session;
      if (simulationSession && sessionOwner && sessionTicket) {
        sessionOwner.setBeforeStop(sessionTicket, () => simulationSession.resolveStop(() => session.captureSimulationScene()));
      }
      diagnosticLease = diagnosticStore?.bindSession({
        mode: simulating ? "simulate" : "play",
        startProfile: async options => {
          const result = await session.diagnostics.startProfile(options);
          if (!result.success) throw new Error(result.reason ?? "Performance recording is unavailable.");
        },
        stopProfile: () => session.diagnostics.stopProfile(),
        captureFrame: () => session.diagnostics.captureFrame(),
        stopSession: () => sessionOwner && sessionTicket ? sessionOwner.stop(sessionTicket) : finishSessionRef.current(),
        releaseInput: () => { if (simulating) changeInputModeRef.current("edit"); },
        setSurfaceOpen: (open) => session.setEditorInputSuppressed(open),
      });
      diagnosticDetachRef.current = diagnosticLease?.release ?? null;
      if (simulating && inspectionStore) {
        inspectionDetachRef.current = inspectionStore.attach((action, options) => session.requestRuntimeInspection(action, options));
        const tools = session.handle.attachRuntimeTransformTools({
          onPick: target => {
            if (!target) inspectionStore.select(null);
            else void inspectionStore.pick(target.actorGuid, target.slotId).catch(error => setControlError(String(error)));
          },
          onTransform: ({ target, transform, space, phase }) => inspectionStore.request({ kind: "setTransform", target, transform, space },
            phase === "commit" ? { final: true } : { continuous: true }),
          onSelectionLost: (target, reason) => inspectionStore.selectionUnavailable(target, reason),
          onError: reason => setControlError(reason),
        });
        transformToolsRef.current = tools;
        const syncSelection = () => {
          const state = inspectionStore.getSnapshot();
          const detail = state.selection;
          tools.setSelection(state.selected, { slotId: detail?.renderSlotId,
            worldTransform: detail?.worldTransform, writable: detail?.transformCapability === "live" });
        };
        const unsubscribe = inspectionStore.subscribe(syncSelection);
        syncSelection();
        const syncToolsVisibility = () => {
          const enabled = transformEditableRef.current && canvasIsEditorVisible(canvas, true);
          tools.setEnabled(enabled);
          if (enabled && !transformConsumerRef.current) transformConsumerRef.current = inspectionStore.consume("selection");
          if (!enabled) { transformConsumerRef.current?.(); transformConsumerRef.current = null; }
        };
        syncTransformVisibilityRef.current = syncToolsVisibility;
        const visibility = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(syncToolsVisibility);
        visibility?.observe(canvas);
        syncToolsVisibility();
        transformDetachRef.current = () => {
          visibility?.disconnect();
          syncTransformVisibilityRef.current = () => {};
          unsubscribe();
          transformConsumerRef.current?.();
          transformConsumerRef.current = null;
          transformToolsRef.current = null;
          tools.dispose();
        };
      }
      void createAppSettingsStore()
        .load()
        .then((settings) => {
          if (sessionRef.current !== session) return;
          applyLiveEngineSettings(
            session.handle,
            {
              renderingOverridesEnabled: settings.renderingOverridesEnabled,
              hardwareScalingLevel: settings.hardwareScalingLevel,
              postProcessingEnabled: settings.postProcessingEnabled,
              textureBudgetEnabled: settings.textureBudgetEnabled,
              textureByteCeiling: settings.textureByteCeiling,
              audioBudgetEnabled: settings.audioBudgetEnabled,
              audioByteCeiling: settings.audioByteCeiling,
              audioMaxVoices: settings.audioMaxVoices,
            },
            { applyFrameCap: false },
          );
        });
      if (initialPauseOnPlayRef.current) pauseRef.current("user", true);
      syncFramebuffer(session.handle);
      const resizeObserver = new ResizeObserver(() => {
        layoutPlay();
        syncTransformVisibilityRef.current();
        const framebuffer = playFramebufferSize(
          runtimeRenderRef.current,
          liveSizeRef.current,
        );
        if (!framebuffer) {
          syncFramebuffer(session.handle);
        }
      });
      resizeObserver.observe(overlay);
      const detachLifecycle = attachLifecyclePause((hidden) => {
        if (simulating) pauseRef.current("lifecycle", hidden);
        else sessionRef.current?.setPaused(hidden || userPausedRef.current);
      });
      const movePoll = window.setInterval(() => {
        const current = sessionRef.current;
        setMoveX(current?.lastMoveX() ?? null);
        setActorGuids([...(current?.spawnedActorGuids() ?? [])]);
        setActorYs((current?.lastActorPositions() ?? []).map((entry) => entry.y));
        setAudioQueued(audioStats.queued);
        setAudioUnlocked(audioStats.unlocked);
        if (current) {
          setMemoryBytes(current.accountedBytes());
          if (!hostMemoryInFlight.current) {
            hostMemoryInFlight.current = true;
            void getHostMemoryStats()
              .then(setHostMemory)
              .catch(() => setHostMemory(null))
              .finally(() => {
                hostMemoryInFlight.current = false;
              });
          }
          setGeometryBytes(current.handle.accountedGeometryBytes());
          const counts = current.liveObjectCounts();
          setMeshCount(counts.meshes);
          setTextureCount(counts.textures);
          setDraws(current.drawCalls());
          setRendering(current.handle.renderDiagnostics());
          setBridgeRate(current.bridgeMessagesPerSec());
          setPostProcessPasses(current.handle.postProcessPassCount());
          setAssignedMaterials(current.handle.assignedMaterialGuids().join(","));
          setFreeCamEnabled(current.handle.isFreeCamEnabled());
        }
      }, 200);
      const onSettings = (event: Event) => {
        const detail = (event as CustomEvent<LiveEngineSettings>).detail;
        if (!detail) return;
        applyLiveEngineSettings(session.handle, detail, { applyFrameCap: false });
        setPostProcessPasses(session.handle.postProcessPassCount());
      };
      window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
      disposePresentation = () => {
        window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
        resizeIfSized.dispose();
        resizeObserver.disconnect();
        window.clearInterval(movePoll);
        detachLifecycle();
        reportBtState(null);
        finishSessionRef.current();
      };
    });
    return () => { cancelled = true; disposePresentation?.(); };
  }, [sharedEngine, injectFixtureThrow, reportBtState, pushLog, sessionOwner, sessionTicket, simulating, simulationSaveStorage, simulationAssetGuids, inspectionStore, simulationSession, diagnosticStore]);

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    const host = globalThis as {
      __babylonslatePlayTest?: {
        actorPositions: () => readonly {
          slotId: number;
          x: number;
          y: number;
          z: number;
        }[];
        visuals: () => ReturnType<PlaySession["handle"]["playVisualStates"]>;
        liveObjectCounts: () => { meshes: number; textures: number } | null;
        whenModelsReady: () => Promise<void>;
        modelLoadCount: () => number;
        tickIndex: () => number;
        inspectWorld: PlaySession["inspectWorld"];
        runtimeMode: () => PlaySession["runtimeMode"] | null;
        rendering: () => ReturnType<PlaySession["handle"]["renderDiagnostics"]> | null;
        scalability: () => ReturnType<PlaySession["handle"]["scalabilityStatus"]>;
        renderTasks: () => string[];
        shadowDiagnostics: () => ReturnType<typeof captureShadowDiagnostics> | null;
        setRenderSettings: PlaySession["handle"]["setRenderSettings"];
        materialDefines: () => ReturnType<PlaySession["handle"]["playMeshMaterialDefines"]>;
      };
    };
    host.__babylonslatePlayTest = {
      actorPositions: () => sessionRef.current?.lastActorPositions() ?? [],
      rendering: () => sessionRef.current?.handle.renderDiagnostics() ?? null,
      scalability: () => sessionRef.current?.handle.scalabilityStatus(),
      renderTasks: () => sessionRef.current?.handle.renderTaskNames() ?? [],
      shadowDiagnostics: () => {
        const handle = sessionRef.current?.handle;
        return handle ? captureShadowDiagnostics(handle.scene, { host: "play", meshes: handle.scene.meshes }) : null;
      },
      setRenderSettings: (settings) => sessionRef.current?.handle.setRenderSettings(settings),
      materialDefines: () => sessionRef.current?.handle.playMeshMaterialDefines() ?? [],
      visuals: () => sessionRef.current?.handle.playVisualStates() ?? [],
      liveObjectCounts: () => sessionRef.current?.liveObjectCounts() ?? null,
      whenModelsReady: () =>
        sessionRef.current?.whenModelsReady() ?? Promise.resolve(),
      modelLoadCount: () => sessionRef.current?.modelLoadCount() ?? 0,
      tickIndex: () => sessionRef.current?.lastTickIndex() ?? 0,
      inspectWorld: () => sessionRef.current?.inspectWorld() ?? Promise.resolve({ tickIndex: 0, nodes: [] }),
      runtimeMode: () => sessionRef.current?.runtimeMode ?? null,
    };
    return () => {
      delete host.__babylonslatePlayTest;
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const next = audioDebugOverlayText(audioStats);
      setAudioDebugText((prev) => (prev === next ? prev : next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={overlayRef}
      className={cn(
        embedded ? "absolute inset-0 z-20 flex flex-col" : "fixed inset-0 z-50 flex flex-col",
        playPreview.followSystem
          ? "bg-background"
          : "items-center justify-center bg-black",
      )}
      data-testid="play-overlay"
      data-mode={simulating ? "simulate" : "play"}
      data-scene-guid={sceneAssetGuid ?? ""}
      data-post-process-passes={String(postProcessPasses)}
      data-assigned-materials={assignedMaterials}
    >
      {simulationSession ? <SimulationRetentionDialog session={simulationSession} onStop={() => finishSessionRef.current()} /> : null}
      <SceneLoadingDialog open={sceneLoading !== null} progress={sceneLoading?.progress ?? 0}
        phase={sceneLoading?.phase ?? "Preparing Scene"} onStop={() => finishSessionRef.current()} />
      <PlayOverlayChrome
        paused={paused}
        statsOpen={statsOpen}
        inspectorOpen={inspectorOpen}
        showStats={overlayStats}
        showConsole={overlayConsole}
        showInspector={overlayInspector && !simulating}
        pausePending={pausePending}
        simulation={simulating ? { inputMode, inputPending, keepChanges: simulationSession?.keepChanges, onInputModeChange: (mode) => changeInputModeRef.current(mode) } : undefined}
        onPauseToggle={() => pauseRef.current("user", !userPausedRef.current)}
        onStatsToggle={() => setStatsOpen((open) => !open)}
        onConsoleOpen={() => setConsoleOpen(true)}
        onInspectorToggle={() => setInspectorOpen((open) => !open)}
        onStep={simulating ? undefined : () => sessionRef.current?.step()}
        onClose={() => finishSessionRef.current()}
        stats={
          <StatsHud
            fps={fps}
            scriptMs={scriptMs}
            physicsMs={physicsMs}
            publishMs={publishMs}
            memoryBytes={memoryBytes}
            hostMemory={hostMemory}
            geometryBytes={geometryBytes}
            meshCount={meshCount}
            textureCount={textureCount}
            draws={draws}
            rendering={rendering}
            bridgeMessagesPerSec={bridgeRate}
            highlight={statsHighlight}
          />
        }
        extras={
          <>
            {simulationSession ? <SimulationRetentionHint session={simulationSession} /> : null}
            {controlError ? <p role="alert" className="pointer-events-auto text-xs text-destructive">{controlError}</p> : null}
            {simulating && inputMode === "edit" ? <>
              <SimulationTransformToolbar tool={transformTool} onToolChange={tool => { setTransformTool(tool); transformToolsRef.current?.setTool(tool); }} />
              <p className="pointer-events-none text-xs text-muted-foreground">Pause to inspect without gameplay changing values. The editor camera does not change the game camera.</p>
            </> : null}
            <span
              data-testid="play-move-x"
              data-move-x={moveX === null ? "" : String(moveX)}
              className="sr-only"
            >
              <SelectableText>
                move.x={moveX === null ? "—" : moveX.toFixed(2)}
              </SelectableText>
            </span>
            <span
              data-testid="play-actor-guids"
              data-guids={actorGuids.join(",")}
            />
            <span data-testid="play-actor-y" data-ys={actorYs.join(",")} />
            {shouldShowPlayAudioUnlockHint({
              queued: audioQueued,
              unlocked: audioUnlocked,
            }) ? (
              <p
                data-testid="play-audio-unlock-hint"
                className="text-sm text-muted-foreground"
              >
                <SelectableText>{PLAY_AUDIO_UNLOCK_HINT}</SelectableText>
              </p>
            ) : null}
          </>
        }
      />
      <canvas
        ref={canvasRef}
        className={cn(
          "touch-none",
          playPreview.followSystem && "h-full w-full",
        )}
        data-testid="play-canvas"
      />
      <PlayFreeCamJoystick
        enabled={freeCamEnabled}
        onFly={(forward, right) =>
          sessionRef.current?.handle.steerPlayFreeCam(forward, right)
        }
      />
      <PrintHud printRef={printRef} />
      {rendering && lightsDebugText(rendering) ? (
        <pre className="pointer-events-none absolute top-12 right-3 m-0 max-h-64 max-w-xl overflow-hidden whitespace-pre-wrap rounded-md bg-background/80 p-2 font-mono text-xs text-foreground" data-testid="lights-debug-overlay">
          <SelectableText>{lightsDebugText(rendering)}</SelectableText>
        </pre>
      ) : null}
      {audioDebugText !== null ? (
        <pre
          className="pointer-events-none absolute bottom-3 right-3 z-20 m-0 max-h-48 max-w-md overflow-hidden whitespace-pre rounded-md bg-background/80 p-2 font-mono text-xs text-foreground"
          data-testid="audio-debug-overlay"
        >
          <SelectableText>{audioDebugText}</SelectableText>
        </pre>
      ) : null}
      {logs.length > 0 ? (
        <div
          className="pointer-events-none absolute bottom-3 left-3 max-h-32 max-w-md overflow-hidden rounded-md bg-background/80 p-2 text-xs"
          data-testid="play-log-tail"
        >
          {logs.slice(-5).map((line) => (
            <div key={line.id}>
              <SelectableText>{line.message}</SelectableText>
            </div>
          ))}
        </div>
      ) : null}
      <DebugConsole
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        commands={commands}
        logs={logs}
        completionContext={completionContext}
        onExecute={(line) =>
          sessionRef.current?.executeConsoleCommand(
            applyInspectSelectionToConsoleLine(
              line,
              inspectSelectionRef.current,
            ),
          ) ?? Promise.resolve({ success: false, output: "not playing" })
        }
      />
      <DebugBehaviourTreeDialog
        open={treeOpen}
        onOpenChange={(open) => {
          setTreeOpen(open);
          if (!open)
            void sessionRef.current?.executeConsoleCommand(
              "behaviourtreedebug off",
            );
        }}
        trees={trees}
      />
      <DebugInspectDialog
        open={nextPlayInspectorOpen(inspectorOpen, overlayInspector)}
        onOpenChange={setInspectorOpen}
        snapshot={inspectSnapshot}
        onExecute={(line) => sessionRef.current?.executeConsoleCommand(line)
          ?? Promise.resolve({ success: false, output: "Not Playing" })}
        onSelectedIdChange={(id) => {
          inspectSelectionRef.current = id;
        }}
      />
    </div>
  );
}
