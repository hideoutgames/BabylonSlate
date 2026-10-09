import { createSaveStorageServer, createSessionSaveStorage } from "@babylonslate/core";
import { createSaveGameStorage } from "@babylonslate/vfs";
import type { ScalabilityAcknowledgement, RenderProjectSettings } from "@babylonslate/core";
import { buildMaterialParameterCatalog } from "@babylonslate/shader-graph";
import {
  parseAnimGraphDocument,
  resolveAnimGraphClips,
  type AnimClipCatalogEntry,
} from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import {
  createPlayBootCoordinator,
  createPlayPauseGate,
  createRuntimeFromLoad,
  createSceneSourceHost,
  applyRuntimeSourceControl,
  type AcquireRuntimeScene,
  captureConsoleLogs,
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
  type RuntimeDriver,
  type SessionReportEntry,
} from "@babylonslate/runtime";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import { materialParameterTextureAssetGuids, resolveModelAnimationDurations } from "@babylonslate/assets";
import {
  DEFAULT_PLAY_FRAME_CAP,
  printHudCssColor,
  type AudioProjectSettings,
  type ResolvedRenderingPipeline,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import type {
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
  ModelPayload,
  RetargetAnimationLoad,
} from "@babylonslate/assets";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import {
  playLoadModelsControl,
  playLoadSpritesControl,
  playLoadTilemapsControl,
  playSceneByGuid,
} from "../lib/play-content";
import {
  createEngine,
  createSceneLoadReadiness,
  createSceneStreamingReadiness,
  waitForSceneLoadingPaint,
  type SceneLoadProgress,
  navDebugBlockersFromActors,
  type AudioLibrary,
  type EngineHandle,
  type ParticleLibrary,
  type PlayActorPosition,
  type SceneSourceAssets,
} from "@babylonslate/render";
import { encodeInputEvents } from "@babylonslate/input";
import {
  isPlayEngineCommandType,
  snapshotFloatCount,
  snapshotTickIndex,
  type CommandMessage,
  type ControlMessage,
  type ScriptBundleEntry,
} from "@babylonslate/bridge";
import { attachInputCapture, type InputCaptureHandle } from "./input-capture";
import { createSessionBoundaryClient } from "./session-boundary-client";
import { RuntimeInspectorClient, type RuntimeInspectionAction, type RuntimeInspectionWriteOptions } from "./runtime-inspector-client";
import { RuntimeMaterialEditHost } from "./runtime-material-edit-host";
import { SimulationCaptureClient } from "./simulation-capture-client";
import { getBuildIdentity } from "../lib/build-identity";
import { observedMoveXFromEvents } from "../lib/play-input-observe";
import { createGameWorkerHost, type GameWorkerHost } from "./game-worker-host";
import { playLoadControl, type PlayPhysicsSettings } from "./play-physics";
import {
  editorDracoPublicBase,
  editorKtx2PublicBase,
  editorMeshoptPublicBase,
} from "../lib/public-engine-assets";
import {
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  SessionDiagnostics,
  createDiagnosticOperationClient,
  type PerformanceProfile,
  type TracePayload,
} from "@babylonslate/debugger";

/**
 * Extract a `RuntimeDiagnostic` from a worker `diagnostic` command so it can
 * feed the same `SessionDiagnosticAggregator` the in-process driver uses.
 * The dedicated Worker path never runs `RuntimeDriver.reportError` on the
 * main thread, so without this the Preview session report would stay empty
 * for real script errors that occur while Play uses the Worker transport.
 */
export function diagnosticFromCommand(
  command: CommandMessage,
): RuntimeDiagnostic | null {
  if (command.type !== "diagnostic") return null;
  return {
    code: command.code,
    message: command.message,
    severity: command.severity,
    assetGuid: command.assetGuid,
    graphId: command.graphId,
    nodeId: command.nodeId,
    btNodeId: command.btNodeId,
    bodyLine: command.bodyLine,
    stack: command.stack,
    frameId: command.frameId,
  };
}

export function inspectSnapshotFromCommand(
  command: CommandMessage,
): DebugInspectSnapshot | null {
  if (command.type !== "inspectSnapshot") return null;
  return command.snapshot;
}

/** Resolve the next inspect waiter from a worker inspectSnapshot command. */
export function deliverInspectSnapshot(
  waiters: Array<(snapshot: DebugInspectSnapshot) => void>,
  command: CommandMessage,
): boolean {
  const snapshot = inspectSnapshotFromCommand(command);
  if (!snapshot) return false;
  waiters.shift()?.(snapshot);
  return true;
}

export function isFatalPlayDiagnostic(code: string | undefined): boolean {
  return code === INFINITE_LOOP_DIAGNOSTIC_CODE;
}

/** Apply worker sessionPaused onto Play overlay chrome. */
export function applyPlaySessionPausedCommand(
  command: CommandMessage,
  onSessionPaused?: (paused: boolean) => void,
): boolean {
  if (command.type !== "sessionPaused") return false;
  onSessionPaused?.(command.paused);
  return true;
}

export function shouldForwardPlayEngineCommand(type: string): boolean {
  return isPlayEngineCommandType(type);
}

export function overlayLogForCommand(command: CommandMessage): string | null {
  if (command.type === "playSound") return null;
  return null;
}

export function applyPlayActiveScene(options: {
  handle: {
    loadScene: (
      scene: SerializedScene,
      options?: { sceneAssetGuid?: string },
    ) => void;
    applySceneEnvironment: (scene: SerializedScene) => void;
    resetAudioSession: () => void;
    setAudioReverbField?: (bytes: Uint8Array | null) => void;
    resetParticleSession: () => void;
  };
  command: { type: string; sceneAssetGuid?: string };
  scenes: ReadonlyArray<{ guid: string; scene: SerializedScene }>;
  boot: { guid?: string; scene?: SerializedScene };
  currentSceneGuid: string | null;
  forceReload?: boolean;
  audioReverbByScene?: ReadonlyMap<string, Uint8Array>;
}): string | null {
  if (
    options.command.type !== "activeScene" ||
    typeof options.command.sceneAssetGuid !== "string"
  ) {
    return options.currentSceneGuid;
  }
  const guid = options.command.sceneAssetGuid;
  if (!options.forceReload && guid === options.currentSceneGuid) {
    return options.currentSceneGuid;
  }
  const scene = playSceneByGuid(guid, options.scenes, options.boot);
  if (!scene) throw new Error("The requested scene is not available in this Play session.");
  options.handle.loadScene(scene, { sceneAssetGuid: guid });
  options.handle.applySceneEnvironment(scene);
  options.handle.resetAudioSession();
  options.handle.setAudioReverbField?.(options.audioReverbByScene?.get(guid) ?? null);
  options.handle.resetParticleSession();
  return guid;
}

export function applyPlayHudConsoleCommand(
  command: CommandMessage,
  handlers: {
    onShowFps?: (enabled: boolean) => void;
    onStat?: (name: string, enabled: boolean) => void;
    onFreeCam?: (enabled: boolean) => void;
  },
): boolean {
  if (command.type === "setShowFps") {
    handlers.onShowFps?.(command.enabled);
    return true;
  }
  if (command.type === "setStat") {
    handlers.onShowFps?.(true);
    handlers.onStat?.(command.name, command.enabled);
    return true;
  }
  if (command.type === "setFreeCam") {
    handlers.onFreeCam?.(command.enabled);
    return true;
  }
  return false;
}

export type PlaySessionStepTarget = {
  worker?: { postControl: (message: ControlMessage) => void } | null;
  runtime?: {
    resume(): void;
    tick(): void;
    pause(): void;
  } | null;
};

/** Advance one paused tick: worker `step` control, or in-process resume/tick/pause. */
export function applyPlaySessionStep(target: PlaySessionStepTarget): boolean {
  if (target.worker) {
    target.worker.postControl({ type: "step" });
    return true;
  }
  if (target.runtime) {
    target.runtime.resume();
    target.runtime.tick();
    target.runtime.pause();
    return true;
  }
  return false;
}

export function playSessionBootControls(options: {
  load: Extract<ControlMessage, { type: "load" }>;
  scripts?: readonly ScriptBundleEntry[];
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  waters?: Extract<ControlMessage, { type: "loadWater" }> | null;
  tilemaps?: Extract<ControlMessage, { type: "loadTilemaps" }> | null;
  sprites?: Extract<ControlMessage, { type: "loadSprites" }> | null;
  models?: Extract<ControlMessage, { type: "loadModels" }> | null;
  navmeshBytes?: Uint8Array | null;
  pauseOnPlay?: boolean;
}): ControlMessage[] {
  const controls: ControlMessage[] = [options.load];
  if ((options.scripts?.length ?? 0) > 0) {
    controls.push({
      type: "loadScripts",
      scripts: [...(options.scripts ?? [])],
      spawn: [],
    });
  }
  if ((options.animGraphs?.length ?? 0) > 0) {
    controls.push({
      type: "loadAnimGraphs",
      graphs: [...(options.animGraphs ?? [])],
    });
  }
  if (
    (options.behaviourTrees?.length ?? 0) > 0 ||
    (options.blackboards?.length ?? 0) > 0
  ) {
    controls.push({
      type: "loadBehaviourTrees",
      trees: [...(options.behaviourTrees ?? [])],
      blackboards: [...(options.blackboards ?? [])],
    });
  }
  if (options.waters) controls.push(options.waters);
  if (options.tilemaps) controls.push(options.tilemaps);
  if (options.sprites) controls.push(options.sprites);
  if (options.models) controls.push(options.models);
  if (options.navmeshBytes && options.navmeshBytes.byteLength > 0) {
    const copy = options.navmeshBytes.slice();
    controls.push({
      type: "loadNavMesh",
      bytes: copy.buffer.slice(
        copy.byteOffset,
        copy.byteOffset + copy.byteLength,
      ) as ArrayBuffer,
    });
  }
  controls.push({ type: "play" });
  if (options.pauseOnPlay) {
    controls.push({ type: "setPaused", paused: true });
  }
  return controls;
}

export interface PlaySessionResult {
  diagnostics: SessionReportEntry[];
  droppedDiagnostics: number;
  textureCountBefore: number;
  /**
   * Settles after the shared-Engine teardown confirms actual release, then
   * measures the texture cache. `quarantined` is true when release never
   * confirmed; the promise never rejects.
   */
  released: Promise<{
    textureCountAfter: number;
    /** True when Play left more GPU textures than it started with. */
    textureLeak: boolean;
    quarantined: boolean;
  }>;
  /** Which runtime host was used. */
  runtimeMode: "worker" | "in-process";
  liveObjectCounts?: { meshes: number; textures: number };
  /** Finalized recorder payload, if snapshot start ran this session. */
  lastTrace: TracePayload | null;
}

export interface PlaySession {
  canvas: HTMLCanvasElement;
  handle: EngineHandle;
  runtime: RuntimeDriver | null;
  worker: GameWorkerHost | null;
  runtimeMode: "worker" | "in-process";
  diagnostics: SessionDiagnostics<import("@babylonslate/render").RenderFrameReport>;
  setPaused: (paused: boolean) => void;
  setPauseReason: (reason: import("@babylonslate/bridge").SessionPauseReason, paused: boolean) => Promise<import("@babylonslate/bridge").SessionBoundaryResult>;
  setInputMode: (mode: "game" | "edit") => Promise<void>;
  setEditorInputSuppressed: (suppressed: boolean) => Promise<void>;
  requestPausedRedraw: () => { accepted: boolean; reason?: string };
  /** Last resolved Move.x from the in-process runtime; null on the worker path. */
  lastMoveX: () => number | null;
  /** Latest snapshot actor positions for e2e collision / motion. */
  lastActorPositions: () => readonly PlayActorPosition[];
  /** Latest sim tick (in-process World clock, else last published snapshot). */
  lastTickIndex: () => number;
  /** Session-only Play/Preview fps cap; does not write `project.json`. */
  setFrameCap: (fps: number) => void;
  /** Actor guids spawned this session (authored scene + explicit runtime spawns). */
  spawnedActorGuids: () => readonly string[];
  executeConsoleCommand: (
    line: string,
  ) => Promise<{ success: boolean; output: string }>;
  inspectWorld: () => Promise<DebugInspectSnapshot>;
  /** Correlated typed selection and live edits; continuous drafts are coalesced. */
  requestRuntimeInspection: (action: RuntimeInspectionAction, options?: RuntimeInspectionWriteOptions) => Promise<import("@babylonslate/bridge").RuntimeInspectorResult>;
  /** Complete final canonical scene, captured before destructive Stop/End Play. */
  captureSimulationScene: (maxBytes?: number) => Promise<import("@babylonslate/runtime").SimulationSceneCaptureResult>;
  /** Advance one simulation tick while paused. */
  step: () => void;
  lastTrace: () => TracePayload | null;
  accountedBytes: () => number;
  liveObjectCounts: () => { meshes: number; textures: number };
  whenModelsReady: () => Promise<void>;
  modelLoadCount: () => number;
  drawCalls: () => number;
  bridgeMessagesPerSec: () => number;
  stop: () => PlaySessionResult;
}

export type PlaySourcePreparation = {
  sources: SceneSourceAssets;
  controls?: ControlMessage[];
  getControls?: () => ControlMessage[];
  release(): void;
  controlsAfterRelease?: () => ControlMessage[];
  required?: ReadonlySet<string>;
};
export type PlaySceneSourceLoader = (guid: string, options: {
  consumer: string; signal: AbortSignal;
}) => Promise<PlaySourcePreparation & { scene: SerializedScene }>;
export type PlayAssetSourceLoader = (guids: string[], options: {
  consumer: string; signal: AbortSignal; onProgress?: (progress: number) => void;
  fontModes?: import("@babylonslate/render").CommandFontModes;
}) => Promise<PlaySourcePreparation>;

/** Resolve a Play session cap; omitted or non-positive values become 60. */
export function resolvePlayFrameCap(fps?: number): number {
  return typeof fps === "number" && fps > 0 ? fps : DEFAULT_PLAY_FRAME_CAP;
}

/**
 * Tick stamp for Play canvas events. In-process Play uses World.clock;
 * the worker host has no World on the main thread, so it must use the last
 * snapshot `tickIndex` rather than `performance.now() / (1000/60)`.
 */
export function playInputStampTick(
  inProcessTickIndex: number | undefined,
  lastWorkerTickIndex: number,
): number {
  return inProcessTickIndex ?? lastWorkerTickIndex;
}

/** Worker hosts stamp input from snapshot tickIndex so throttled stats cannot drop sticks. */
export function applyPlaySnapshotTick(
  previous: number,
  buffer: Float32Array,
): number {
  return snapshotTickIndex(buffer) ?? previous;
}

export interface PlayHudStats {
  fps: number;
  scriptMs: number;
  physicsMs: number;
  /** Snapshot publish time, reported apart from the tick's script/physics budget. */
  publishMs: number;
  frameId: number;
  liveActors?: number;
  snapshotCapacity?: number;
}

/** Worker `stats` commands are the source of truth for script/physics/publish ms. */
export function applyWorkerPlayStats(
  previous: PlayHudStats | undefined,
  command: {
    fps?: number;
    scriptMs: number;
    physicsMs: number;
    publishMs?: number;
    frameId: number;
    liveActors?: number;
    snapshotCapacity?: number;
  },
): PlayHudStats {
  return {
    fps: previous?.fps ?? 0,
    scriptMs: command.scriptMs,
    physicsMs: command.physicsMs,
    publishMs: command.publishMs ?? 0,
    frameId: command.frameId,
    liveActors: command.liveActors ?? previous?.liveActors ?? 0,
    snapshotCapacity:
      command.snapshotCapacity ?? previous?.snapshotCapacity ?? 0,
  };
}

/** Main-thread FPS sample must not zero worker timings. */
export function applyPlayFpsSample(
  previous: PlayHudStats | undefined,
  fps: number,
): PlayHudStats {
  return {
    fps,
    scriptMs: previous?.scriptMs ?? 0,
    physicsMs: previous?.physicsMs ?? 0,
    publishMs: previous?.publishMs ?? 0,
    frameId: previous?.frameId ?? 0,
    liveActors: previous?.liveActors ?? 0,
    snapshotCapacity: previous?.snapshotCapacity ?? 0,
  };
}

const FIXTURE_ASSET = "preview-fixture";
const FIXTURE_NODE = "throw-node";

/** When Play injects a fixture throw and a tree is loaded, navigate to the task. */
export function previewFixtureThrowHint(
  trees?: ReadonlyArray<{ guid: string; document: unknown }>,
): { assetGuid: string; btNodeId: string } | null {
  const entry = trees?.[0];
  if (!entry) return null;
  const parsed = parseBehaviourTreeDocument(entry.document);
  const task = parsed?.nodes.find((node) => node.kind === "task");
  if (!task) return null;
  return { assetGuid: entry.guid, btNodeId: task.id };
}

/**
 * Start a fullscreen Play session. Prefers a dedicated game Worker; falls back
 * to in-process runtime. Own Scene on the shared app Engine via registerView.
 */
export function startPlaySession(options: {
  /** Preview uses the packaged player, never this in-process presentation host. */
  mode?: "play" | "simulate";
  sessionGeneration?: number;
  /** Transfer the preparation overlay, including wipe-on-start, to this owner. */
  simulationSaveStorage?: ReturnType<typeof createSessionSaveStorage>;
  /** Authoring asset identities admitted by preparation; this does not load assets. */
  simulationAssetGuids?: readonly string[];
  onRetentionUnavailable?: (reason: string) => void;
  saveGame?: import("@babylonslate/core").SaveGameConfiguration;
  renderSettings?: import("@babylonslate/render").RenderShadingSettings;
  consoleRenderSettings?: import("@babylonslate/render").RenderShadingSettings;
  canvas: HTMLCanvasElement;
  sharedEngine: EngineHandle["engine"];
  injectFixtureThrow?: boolean;
  /** Scene physics world and gravity from the open scene document. */
  physics?: PlayPhysicsSettings;
  /** Compiled project graphs to run for this session. */
  scripts?: readonly ScriptBundleEntry[];
  /** Authored scene instantiated in the worker instead of demo actors. */
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
  releaseInitialSources?: () => void | ControlMessage[];
  sessionSources?: SceneSourceAssets;
  getAssetLoadState?: (guid: string) => import("@babylonslate/core").RuntimeAssetLoadState;
  getSourceControls?: () => ControlMessage[];
  sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
  onStats?: (stats: {
    fps: number;
    scriptMs: number;
    physicsMs: number;
    publishMs: number;
    frameId: number;
  }) => void;
  onLog?: (message: string, severity: string) => void;
  onPrint?: (entry: {
    message: string;
    key: string;
    duration: number;
    color: string;
  }) => void;
  /** Project `playFrameCap`; omitted or invalid → 60. */
  frameCap?: number;
  /** Engine Settings trace retention budget, captured when Play starts. */
  traceByteBudget?: number;
  onProfile?: (profile: PerformanceProfile) => void;
  /** AnimationGraph documents for `loadAnimGraphs` / `registerAnimGraph`. */
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  /** BehaviourTree / Blackboard documents for worker load. */
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  /** Sprite payloads keyed by asset guid for Play clip UV seeks. */
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  /** Sprite Animation clips referenced by loaded Animation Graphs. */
  spriteAnimationPayloads?: ReadonlyMap<string, SpriteAnimationPayload>;
  /** Tilemap / tileset payloads for Play chunk meshes and Rapier chains. */
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
  fontFaceEntries?: readonly import("@babylonslate/render").FontAssetEntry[];
  fontCssStack?: string;
  fontCssStackByGuid?: ReadonlyMap<string, string>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  modelPayloads?: ReadonlyMap<string, ModelPayload>;
  /** Complex Collision meshes cooked during source preparation; Play never re-cooks them. */
  complexMeshes?: ReadonlyMap<string, import("@babylonslate/core").CollisionTriangleMesh>;
  /** Answers the runtime's `requestComplexCollision` for a Model the content scan missed. */
  cookComplexCollision?: (assetGuid: string) => Promise<import("@babylonslate/core").CollisionTriangleMesh | null>;
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  retargetAnimationLoads?: ReadonlyMap<
    string,
    readonly RetargetAnimationLoad[]
  >;
  loadAudioSourceBytes?: import("@babylonslate/render").AudioSourceBytesLoader;
  audioLibrary?: AudioLibrary;
  /** Animation / Sprite Animation clip metadata for BT Play Animation. */
  animClipCatalog?: readonly AnimClipCatalogEntry[];
  particleLibrary?: ParticleLibrary;
  /** Baked Scene `audioReverb` bytes; Play imports and never generates. */
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
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  /** Reads bake assets (project registry or packed container). */
  postProcessingEnabled?: boolean;
  hardwareScalingLevel?: number;
  pixelsPerUnit?: number;
  sortingLayers?: readonly string[];
  pixelPerfect?: boolean;
  /** Overlay 2DButton pick floor in CSS pixels. */
  touchMinTargetPx?: number;
  /** Baked Scene navmesh bytes; Play imports and never generates. */
  navmeshBytes?: Uint8Array | null;
  sceneNavmeshBytes?: ReadonlyMap<string, Uint8Array>;
  audioReverbByScene?: ReadonlyMap<string, Uint8Array>;
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  inputAssets?: import("@babylonslate/core").InputAssetDefinition[];
  dataAssets?: import("@babylonslate/core").DataAssetCatalogEntry[];
  /** Packaged authored assets the Asset Registry nodes query, snapshotted when Play starts. */
  assetCatalog?: import("@babylonslate/core").RuntimeAssetCatalogEntry[];
  inputMappings?: import("@babylonslate/core").ProjectInputSettings;
  focusNavigation?: import("@babylonslate/core").FocusNavigationSettings;
  /** Called when a session-fatal diagnostic (infinite loop) arrives. */
  onFatalDiagnostic?: () => void;
  /** When true, pause after Play boot so `boot.play`'s resume cannot undo it. */
  pauseOnPlay?: boolean;
  onSceneLoading?: (state: SceneLoadProgress | null) => void;
  onSessionPaused?: (paused: boolean) => void;
  onShowFps?: (enabled: boolean) => void;
  onStatHighlight?: (name: string, enabled: boolean) => void;
  onFreeCam?: (enabled: boolean) => void;
  onSetRenderResolution?: (width: number, height: number) => void;
  onRenderOutputChanged?: (settings: RenderProjectSettings) => void;
  onBehaviourTreeDebug?: (enabled: boolean) => void;
  onBehaviourTreeSnapshot?: (
    trees: readonly import("@babylonslate/bridge").DebugBehaviourTree[],
  ) => void;
  onBtState?: (state: {
    slotId: number;
    status: string;
    btNodeId: string | null;
    lastResults: Record<string, string>;
    blackboard: Record<string, unknown>;
    stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
  }) => void;
}): PlaySession {
  options = { ...options };
  const { canvas, sharedEngine } = options;
  const textureCountBefore = sharedEngine.getLoadedTexturesCache().length;
  const liveBefore = {
    meshes: 0,
    textures: textureCountBefore,
  };

  let worker: GameWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  // eslint-disable-next-line prefer-const -- runtime command handlers installed first may run before assignment.
  let performanceDiagnostics: SessionDiagnostics<import("@babylonslate/render").RenderFrameReport> | undefined;
  const diagnosticClient = createDiagnosticOperationClient({
    sessionGeneration: options.sessionGeneration ?? 0,
    send: async (request) => {
      if (worker) { worker.postControl({ type: "diagnosticOperation", ...request }); return; }
      if (!runtime) throw new Error("The game runtime is unavailable.");
      diagnosticClient.receive(await runtime.requestDiagnosticOperation(request));
    },
  });
  let gameInputMode: "game" | "edit" = "game";
  let inputTransition = 0;
  let inputTransitionPending = false;
  let editorInputSuppressed = false;
  let editorInputRoutingEnabled = false;
  let acknowledgedPaused = false;
  let lastBoundaryId = 0;
  const requestedPauses = new Set<import("@babylonslate/bridge").SessionPauseReason>();
  const boundaryClient = createSessionBoundaryClient(options.sessionGeneration ?? 0, (request) => {
    if (worker) worker.postControl({ type: "sessionBoundary", ...request });
    else if (runtime) void runtime.requestSessionBoundary(request).then((result) => boundaryClient.receive(result));
    else throw new Error("The game runtime is unavailable");
  });
  const inspectorClient = new RuntimeInspectorClient({
    sessionGeneration: options.sessionGeneration ?? 0,
    cancel: request => {
      if (worker) worker.postControl({ type: "cancelRuntimeInspector", ...request });
      else runtime?.cancelRuntimeInspector(request);
    },
    send: async request => {
      if (worker) { worker.postControl({ type: "runtimeInspector", ...request }); return; }
      if (!runtime) throw new Error("The game runtime is unavailable");
      const owner = runtime;
      const result = await owner.requestRuntimeInspector(request);
      if (runtime !== owner || stopped) return;
      if (result.success && result.payload?.kind === "mutation") {
        // Apply the authoritative edited pose before acknowledging it. This is
        // snapshot publication only: paused edits never advance a game tick.
        if (!owner.copySnapshot(snapBuf)) throw new Error("The runtime edit applied, but its presentation snapshot is unavailable.");
        lastWorkerTickIndex = applyPlaySnapshotTick(lastWorkerTickIndex, snapBuf);
        handle.pushSnapshot(snapBuf);
        if (acknowledgedPaused) handle.requestPausedRedraw();
      }
      inspectorClient.receive(result);
    },
  });
  const suppressGameInput = () => {
    const suppressed = editorInputSuppressed || inputTransitionPending || gameInputMode === "edit" || acknowledgedPaused || requestedPauses.size > 0;
    const routed = options.mode === "simulate" || editorInputRoutingEnabled;
    // Ordinary Play keeps shared routing until something actually takes input away.
    if (routed || suppressed) input?.setSuppressed(suppressed);
    if (routed) handle.setGameInputEnabled(!suppressed);
    return suppressed;
  };
  let pendingPauseBoundary: Promise<import("@babylonslate/bridge").SessionBoundaryResult> | null = null;
  const synchronizePauseBoundary = (action: import("@babylonslate/bridge").SessionBoundaryRequest["action"]) => {
    const work = boundaryClient.request(action).then(result => {
      if (result.success && result.requestId > lastBoundaryId) {
        lastBoundaryId = result.requestId;
        acknowledgedPaused = result.paused;
        handle.setGameTimePaused(result.paused);
        if (!result.paused) last = performance.now();
        suppressGameInput();
      }
      return result;
    });
    pendingPauseBoundary = work;
    return work;
  };
  const setPauseReason: PlaySession["setPauseReason"] = (reason, paused) => {
    if (paused) requestedPauses.add(reason); else requestedPauses.delete(reason);
    suppressGameInput();
    return synchronizePauseBoundary({ kind: "pause", reason, paused });
  };

  const publishScalabilityStatus = (acknowledgement: ScalabilityAcknowledgement) => {
    if (worker) worker.postControl({ type: "scalabilityStatus", acknowledgement });
    else runtime?.applyScalabilityStatus(acknowledgement);
  };
  const publishRenderPathStatus = (status: ResolvedRenderingPipeline) => {
    const control: ControlMessage = {
      type: "renderPathStatus",
      requested: status.requested.renderPath,
      effective: status.effective.renderPath,
      gpuBackend: status.effective.gpuBackend,
      limits: status.limits,
    };
    if (worker) worker.postControl(control);
    else runtime?.applyRenderPathStatus(control);
  };

  const handle = createEngine(canvas, {
    renderSettings: options.consoleRenderSettings ?? options.renderSettings,
    physicsWorld: options.physics?.physicsWorld ?? options.scene?.settings.physicsWorld,
    sharedEngine,
    playMode: true,
    frameCap: resolvePlayFrameCap(options.frameCap),
    spritePayloads: options.spritePayloads,
    spriteAnimations: options.spriteAnimationPayloads,
    waterPayloads: options.waterPayloads,
    renderTargets: options.renderTargets,
    renderTargetTextures: options.renderTargetTextures,
    tilemapPayloads: options.tilemapPayloads,
    tilesetPayloads: options.tilesetPayloads,
    textureBytes: options.textureBytes,
    areaEmissions: options.areaEmissions,
    texturePixelSizes: options.texturePixelSizes,
    fontFacetypeBytes: options.fontFacetypeBytes,
    fontMsdfJson: options.fontMsdfJson,
    fontMsdfPng: options.fontMsdfPng,
    fontFaceEntries: options.fontFaceEntries,
    fontCssStack: options.fontCssStack,
    fontCssStackByGuid: options.fontCssStackByGuid,
    modelBytes: options.modelBytes,
    modelPayloads: options.modelPayloads,
    modelClipAnimationGuids: options.modelClipAnimationGuids,
    retargetAnimationLoads: options.retargetAnimationLoads,
    loadAudioSourceBytes: options.loadAudioSourceBytes,
    prepareAudioAsset: options.acquireAssetSources ? async (guid, request) => {
      const prepared = await options.acquireAssetSources!([guid], request);
      return prepareSources(prepared, request.signal);
    } : undefined,
    audioLibrary: options.audioLibrary,
    particleLibrary: options.particleLibrary,
    audioReverbBytes: options.audioReverbBytes,
    audioProjectSettings: options.audioProjectSettings,
    materialDocuments: options.materialDocuments,
    materialFunctions: options.materialFunctions,
    postProcessStack: options.scene?.settings.postProcessStack,
    postProcessingEnabled: options.postProcessingEnabled,
    hardwareScalingLevel: options.hardwareScalingLevel,
    pixelsPerUnit: options.pixelsPerUnit,
    sortingLayers: options.sortingLayers,
    pixelPerfect: options.pixelPerfect,
    touchMinTargetPx: options.touchMinTargetPx,
    environmentColor: options.scene?.settings.environmentColor,
    viewportMode: options.scene?.viewportMode,
    navmeshBytes: options.navmeshBytes,
    navBlockers: options.scene
      ? navDebugBlockersFromActors(options.scene.actors)
      : undefined,
    ktx2BasePath: editorKtx2PublicBase(),
    dracoBasePath: editorDracoPublicBase(),
    meshoptBasePath: editorMeshoptPublicBase(),
    onPostProcessDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
    },
    onAudioDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
      if (diagnostic.assetGuid && ["audio.missing_source", "audio.decode_failed", "audio.budget_exceeded", "audio.play_failed", "audio.load_failed"].includes(diagnostic.code))
        publishAssetStates([diagnostic.assetGuid], "failed");
    },
    onAudioAssetReady: (guid) => {
      for (const [prepared, scope] of preparedSourceScopes) if (scope.guids.includes(guid)) markSourceReady(prepared);
      publishAssetStates([guid], "ready");
    },
    onParticleDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
    },
    onMaterialDiagnostic: (diagnostic) => {
      options.onLog?.(
        diagnostic.message,
        diagnostic.severity === "error" ? "error" : "warning",
      );
    },
    onTouchAxis: (controlId, value) => {
      if (options.mode === "simulate") input?.setTouchAxis(controlId, value);
      else input?.ring.push({ kind: "touchAxis", controlId, value, tick: playInputStampTick(runtime?.getWorld().clock.tickIndex, lastWorkerTickIndex) });
    },
    onSceneLayerScroll: (event) => {
      if (options.mode === "simulate" && suppressGameInput()) return;
      const control = { type: "sceneLayerScroll" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerScroll(event.layerId, event.actorId, event.componentId, event.deltaX, event.deltaY);
    },
    onSceneLayerControl: (event) => {
      if (options.mode === "simulate" && suppressGameInput()) return;
      const control = { type: "sceneLayerControl" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerControl(control);
    },
    onSceneLayerFocusNavigate: (reverse) => {
      const control = { type: "sceneLayerFocusNavigate" as const, reverse };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerFocusNavigate(reverse);
    },
    onSceneLayerPointer: (event) => {
      const control = { type: "sceneLayerPointer" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerPointer(control);
    },
    onSceneLayerResize: (size) => {
      const control = { type: "sceneLayerResize" as const, ...size };
      if (worker) worker.postControl(control);
      else
        runtime?.applySceneLayerResize(
          size.frustumWidth,
          size.frustumHeight,
          size.canvasWidth,
          size.canvasHeight,
          size.safeAreaInsets,
        );
    },
    onAudioVoiceEnded: (voiceId) => {
      const control = { type: "audioVoiceEnded" as const, voiceId };
      if (worker) worker.postControl(control);
      else runtime?.applyAudioVoiceEnded(control);
    },
    onRenderPathChanged: publishRenderPathStatus,
    onScalabilityApplied: publishScalabilityStatus,
    onRagdollPoseCaptured: (result) => {
      if (worker) worker.postControl(result);
      else runtime?.applyRagdollPoseCaptured(result);
    },
    onRuntimeOutputChanged: (settings) => {
      if (options.onRenderOutputChanged) options.onRenderOutputChanged(settings);
      else options.onSetRenderResolution?.(settings.width, settings.height);
    },
  });
  if (options.scene) {
    handle.applySceneEnvironment(options.scene);
  }
  handle.scheduler.invalidate("play");
  const releaseConsoleCapture = captureConsoleLogs(
    console,
    (message, severity) => {
      if (runtime) runtime.reportLog(message, severity);
      else options.onLog?.(message, severity);
    },
  );
  const onWindowError = (event: ErrorEvent) =>
    options.onLog?.(event.error?.stack ?? event.message, "error");
  const onRejection = (event: PromiseRejectionEvent) =>
    options.onLog?.(
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : String(event.reason),
      "error",
    );
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onRejection);
  liveBefore.meshes = handle.liveObjectCounts().meshes;

  let runtimeMode: "worker" | "in-process" = "in-process";
  let pauseGate: ReturnType<typeof createPlayPauseGate> | null = null;
  let resetBoot = () => {};
  // Aggregates diagnostics received over the command channel (Worker mode).
  // The in-process path already aggregates via `runtime.getDiagnostics()`.
  const workerDiagnostics = new SessionDiagnosticAggregator();
  const hostDiagnostics = new SessionDiagnosticAggregator();

  const spawnedActorGuids: string[] = [];
  let releaseSessionSources: (() => void) | undefined;
  const sessionSourcesReady = options.sessionSources ? handle.acquireSceneSources(options.sessionSources).then((release) => {
    if (stopped) release(); else releaseSessionSources = release;
  }) : Promise.resolve();
  void sessionSourcesReady.catch((error: unknown) => options.onLog?.(`Session sources: ${String(error)}`, "error"));
  const preparedScenes = new Map((options.scenes ?? []).map((entry) => [entry.guid, entry.scene]));
  const sceneSourceOwners = new Map<string, number>();
  let nextSourceRequestId = 0;
  const sourceRequests = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const publishSourceControl = async (control: ControlMessage) => {
    if (worker && control.type === "loadScripts") {
      const requestId = ++nextSourceRequestId;
      await new Promise<void>((resolve, reject) => {
        sourceRequests.set(requestId, { resolve, reject });
        worker!.postControl({ ...control, requestId });
      });
    } else if (worker) worker.postControl(control);
    else if (runtime && !await applyRuntimeSourceControl(runtime, control))
      throw new Error(`Unsupported source preparation control: ${control.type}.`);
  };
  // Runtime fallback for a Complex Collision Model the content scan missed. The
  // answer is always asynchronous, so it never re-enters the requesting tick.
  const answerComplexCollision = (assetGuid: string) => {
    void Promise.resolve()
      .then(() => options.cookComplexCollision?.(assetGuid) ?? null)
      .catch((error: unknown) => {
        options.onLog?.(`Complex Collision for ${assetGuid}: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return null;
      })
      .then((mesh) => stopped ? undefined : publishSourceControl(mesh
        ? { type: "loadComplexCollision", meshes: [{ guid: assetGuid, positions: mesh.positions, indices: mesh.indices }] }
        : { type: "loadComplexCollision", meshes: [], unavailable: [assetGuid] }))
      .catch((error: unknown) => options.onLog?.(`Complex Collision for ${assetGuid}: ${String(error)}`, "error"));
  };
  const knownAssetGuids = new Set<string>();
  const preparedAssetGuids = new Set<string>();
  const initialSourceGuids = new Set(options.getSourceControls?.().flatMap((control) => control.type === "loadSceneContent" ? control.assetGuids : []) ?? []);
  let initialSourcesReady = false;
  const publishedAssetStates = new Map<string, import("@babylonslate/core").RuntimeAssetLoadState>();
  const preparedSourceScopes = new Map<PlaySourcePreparation, { guids: string[]; ready: boolean }>();
  const sceneSourceScopes = new Map<string, Set<PlaySourcePreparation>>();
  const streamSceneAssets = new Map<string, { guid: string; loadId: number; prepared?: PlaySourcePreparation }>();
  const publishAssetStates = (guids: readonly string[], fallback: import("@babylonslate/core").RuntimeAssetLoadState, queryCache = false) => {
    const states = guids.map((guid) => {
      knownAssetGuids.add(guid);
      if (!queryCache && fallback === "ready") preparedAssetGuids.add(guid);
      const cached = queryCache ? options.getAssetLoadState?.(guid) : undefined;
      let state = cached === "ready" && !preparedAssetGuids.has(guid) ? "unloaded" as const : cached ?? fallback;
      if (state === "unloaded" && publishedAssetStates.get(guid) === "failed") state = "failed";
      publishedAssetStates.set(guid, state);
      return { guid, state };
    });
    if (worker) worker.postControl({ type: "assetLoadStates", states });
    else runtime?.setAssetLoadStates(states);
  };
  const markSourceReady = (prepared: PlaySourcePreparation) => {
    const scope = preparedSourceScopes.get(prepared);
    if (!scope) return;
    scope.ready = true;
    publishAssetStates(scope.guids, "ready");
  };
  let sourceControlWork: Promise<void> = Promise.resolve();
  const publishSourceBatch = (getControls: () => readonly ControlMessage[] | void): Promise<void> => {
    const work = sourceControlWork.catch(() => {}).then(async () => {
      if (stopped) return;
      for (const control of options.getSourceControls?.() ?? getControls() ?? []) {
        await publishSourceControl(control);
      }
    });
    sourceControlWork = work;
    return work;
  };
  const publishReleasedSources = (controls: readonly ControlMessage[] | void | (() => readonly ControlMessage[] | void)) => {
    if (stopped) return;
    void publishSourceBatch(typeof controls === "function" ? controls : () => controls).catch((error: unknown) => {
      options.onLog?.(`Source release: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
    if (options.getAssetLoadState) publishAssetStates([...knownAssetGuids], "unloaded", true);
  };
  const prepareSources = async (prepared: PlaySourcePreparation, signal: AbortSignal, prepare = false, priority: "gameplay" | "preload" = "gameplay") => {
    let releaseRender: (() => void) | undefined;
    const scope = { guids: [...(prepared.required ?? [])], ready: false };
    preparedSourceScopes.set(prepared, scope);
    publishAssetStates(scope.guids, "loading");
    const releaseState = () => {
      preparedSourceScopes.delete(prepared);
      const remaining = new Set([...preparedSourceScopes.values()].filter((owner) => owner.ready).flatMap((owner) => owner.guids));
      if (initialSourcesReady) for (const guid of initialSourceGuids) remaining.add(guid);
      for (const guid of scope.guids) if (!remaining.has(guid)) preparedAssetGuids.delete(guid);
      publishAssetStates(scope.guids.filter((guid) => !remaining.has(guid)), "unloaded");
    };
    try {
      signal.throwIfAborted();
      releaseRender = await handle.acquireSceneSources(prepared.sources, { prepare, signal, priority });
      signal.throwIfAborted();
      await publishSourceBatch(() => prepared.getControls?.() ?? prepared.controls);
      signal.throwIfAborted();
      if (prepare) markSourceReady(prepared);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseRender?.();
        releaseRender = undefined;
        prepared.release();
        releaseState();
        publishReleasedSources(prepared.controlsAfterRelease);
      };
    } catch (error) {
      releaseRender?.();
      prepared.release();
      publishAssetStates(scope.guids, signal.aborted ? "unloaded" : "failed");
      releaseState();
      publishReleasedSources(prepared.controlsAfterRelease);
      throw error;
    }
  };
  const acquireScene: AcquireRuntimeScene | undefined = options.acquireSceneSources ? async (guid, request) => {
    publishAssetStates([guid], "loading");
    if (request.stream) streamSceneAssets.set(request.stream.actorGuid, { guid, loadId: request.stream.streamLoadId });
    let prepared: PlaySourcePreparation & { scene: SerializedScene };
    let release: () => void;
    try {
      prepared = await options.acquireSceneSources!(guid, request);
      release = await prepareSources(prepared, request.signal, true);
    } catch (error) {
      publishAssetStates([guid], request.signal.aborted ? "unloaded" : "failed");
      throw error;
    }
    preparedScenes.set(guid, prepared.scene);
    let sceneScopes = sceneSourceScopes.get(guid);
    if (!sceneScopes) sceneSourceScopes.set(guid, sceneScopes = new Set());
    sceneScopes.add(prepared);
    if (request.stream) streamSceneAssets.set(request.stream.actorGuid, { guid, loadId: request.stream.streamLoadId, prepared });
    sceneSourceOwners.set(guid, (sceneSourceOwners.get(guid) ?? 0) + 1);
    let released = false;
    return { scene: prepared.scene, release: () => {
      if (released) return;
      released = true;
      sceneSourceScopes.get(guid)?.delete(prepared);
      if (!sceneSourceScopes.get(guid)?.size) sceneSourceScopes.delete(guid);
      const remaining = (sceneSourceOwners.get(guid) ?? 1) - 1;
      if (remaining) sceneSourceOwners.set(guid, remaining);
      else { sceneSourceOwners.delete(guid); preparedScenes.delete(guid); preparedAssetGuids.delete(guid); publishAssetStates([guid], "unloaded"); }
      release();
    } };
  } : undefined;
  handle.setCommandSourceLoader?.(options.acquireAssetSources ? async (guids, request) =>
    prepareSources(await options.acquireAssetSources!([...guids], request), request.signal, true) : null);
  const sceneSources = acquireScene ? createSceneSourceHost({ acquireScene,
    send: (control) => worker?.postControl(control),
  }) : undefined;
  const preloads = new Map<string, { controller: AbortController; release?: () => void; guids: string[] }>();
  const publishPreloadResult = (result: { preloadId: string; success: boolean; error?: string; progress?: number }) => {
    if (worker) worker.postControl({ type: "assetPreloadResult", ...result });
    else runtime?.notifyAssetPreloadResult(result);
  };
  const releasePreload = (preloadId: string) => {
    const request = preloads.get(preloadId);
    if (!request) return;
    preloads.delete(preloadId);
    request.controller.abort(new Error("Asset preload was released."));
    request.release?.();
    if (options.getAssetLoadState) publishAssetStates(request.guids, "unloaded", true);
  };
  const receivePreload = (command: CommandMessage) => {
    if (command.type === "assetPreloadRelease") { releasePreload(command.preloadId); return true; }
    if (command.type !== "assetPreload") return false;
    const { preloadId, assetGuids, ownerId } = command;
    if (preloads.has(preloadId)) return true;
    if (!options.acquireAssetSources) {
      publishPreloadResult({ preloadId, success: false, error: "This Play session has no asset source loader." });
      return true;
    }
    const request: { controller: AbortController; release?: () => void; guids: string[] } = {
      controller: new AbortController(), guids: assetGuids,
    };
    preloads.set(preloadId, request);
    publishAssetStates(assetGuids, "loading");
    void options.acquireAssetSources(assetGuids, { consumer: ownerId, signal: request.controller.signal,
      onProgress: (progress) => {
        if (preloads.get(preloadId) === request) publishPreloadResult({ preloadId, success: true, progress: Math.min(0.9, progress * 0.9) });
      },
    }).then((prepared) => prepareSources(prepared, request.controller.signal, true, "preload")).then((release) => {
      if (preloads.get(preloadId) !== request) { release(); return; }
      request.release = release;
      publishAssetStates(assetGuids, "ready");
      publishPreloadResult({ preloadId, success: true, progress: 1 });
    }).catch((error: unknown) => {
      if (preloads.get(preloadId) !== request) return;
      releasePreload(preloadId);
      publishAssetStates(assetGuids, "failed");
      publishPreloadResult({ preloadId, success: false, error: `Assets requested by ${ownerId}: ${error instanceof Error ? error.message : String(error)}` });
    });
    return true;
  };
  let initialSourcesReleased = false;
  const releaseInitialSources = () => {
    if (initialSourcesReleased) return;
    initialSourcesReleased = true;
    handle.releaseInitialSources();
    publishReleasedSources(options.releaseInitialSources?.());
    const scoped = new Set([...preparedSourceScopes.values()].flatMap((scope) => scope.guids));
    const persistent = options.getSourceControls?.().flatMap((control) => control.type === "loadSceneContent" ? control.assetGuids : []) ?? [];
    for (const guid of initialSourceGuids) if (!scoped.has(guid)) preparedAssetGuids.delete(guid);
    initialSourceGuids.clear();
    for (const guid of persistent) if (!scoped.has(guid)) initialSourceGuids.add(guid);
    if (initialSourcesReady) publishAssetStates([...initialSourceGuids], "ready");
    for (const guid of preparedScenes.keys()) if (!sceneSourceOwners.has(guid)) preparedScenes.delete(guid);
    for (const key of ["textureBytes", "modelBytes", "modelPayloads", "complexMeshes", "spritePayloads", "spriteAnimationPayloads",
      "tilemapPayloads", "tilesetPayloads", "waterPayloads", "fontFacetypeBytes", "fontMsdfJson", "fontMsdfPng",
      "fontCssStackByGuid", "fontFaceEntries", "materialDocuments", "materialFunctions", "audioLibrary", "particleLibrary",
      "renderTargets", "renderTargetTextures", "areaEmissions", "texturePixelSizes", "modelClipAnimationGuids",
      "retargetAnimationLoads", "animGraphs", "behaviourTrees", "blackboards", "dataAssets", "sceneNavmeshBytes",
      "audioReverbByScene", "navmeshBytes", "audioReverbBytes", "scenes", "scene", "sceneLayers"] as const) delete options[key];
    loadControl.scene = undefined;
    loadControl.scenes = undefined;
    loadControl.sceneLayers = undefined;
  };
  let hostSceneGuid: string | null = options.sceneAssetGuid ?? null;
  let receivedActiveScene = false;
  const sceneReadiness = createSceneLoadReadiness({
    handle: { ...handle, whenEditorModelsReady: async (owner) => {
      await sessionSourcesReady;
      await handle.whenEditorModelsReady(owner);
    } },
    loading: {
      acquire: () => handle.scheduler.acquireObstruction(),
      progress: (state) => options.onSceneLoading?.(state),
      paint: waitForSceneLoadingPaint,
      layerPainted: ({ layerId, layerLoadId }) => {
        worker?.postControl({ type: "sceneLayerLoadingPainted", layerId, layerLoadId });
        runtime?.notifySceneLayerLoadingPainted(layerId, layerLoadId);
      },
      painted: ({ sceneAssetGuid, sceneLoadId }) => {
        worker?.postControl({ type: "sceneLoadingPainted", sceneAssetGuid, sceneLoadId });
        runtime?.notifySceneLoadingPainted(sceneAssetGuid, sceneLoadId);
      },
    },
    activate: ({ sceneAssetGuid }) => {
      hostSceneGuid = applyPlayActiveScene({
        handle,
        command: { type: "activeScene", sceneAssetGuid },
        scenes: [...preparedScenes].map(([guid, scene]) => ({ guid, scene })),
        boot: { guid: options.sceneAssetGuid, scene: options.scene },
        currentSceneGuid: hostSceneGuid,
        forceReload: receivedActiveScene,
        audioReverbByScene: options.audioReverbByScene,
      });
      if (receivedActiveScene && options.acquireSceneSources) releaseInitialSources();
      receivedActiveScene = true;
    },
    onReady: ({ sceneAssetGuid, sceneLoadId }) => {
      if (!initialSourcesReleased) { initialSourcesReady = true; publishAssetStates([...initialSourceGuids], "ready"); }
      for (const prepared of sceneSourceScopes.get(sceneAssetGuid) ?? []) markSourceReady(prepared);
      publishAssetStates([sceneAssetGuid], "ready");
      worker?.postControl({ type: "sceneModelsReady", sceneAssetGuid, sceneLoadId });
      runtime?.notifySceneModelsReady(sceneAssetGuid, sceneLoadId);
    },
    onLayerReady: ({ layerId, layerLoadId }) => {
      worker?.postControl({ type: "sceneLayerReady", layerId, layerLoadId });
      runtime?.notifySceneLayerReady(layerId, layerLoadId);
    },
    onFailed: (scene, error) => {
      if (scene.sceneAssetGuid) publishAssetStates([scene.sceneAssetGuid], "failed");
      const message = `Scene loading failed: ${error instanceof Error ? error.message : String(error)}`;
      hostDiagnostics.push({ code: "scene.loading.failed", severity: "error", message,
        assetGuid: scene.sceneAssetGuid, frameId: 0,
        stack: error instanceof Error ? error.stack : undefined });
      try { options.onLog?.(message, "error"); }
      finally { queueMicrotask(() => options.onFatalDiagnostic?.()); }
    },
  });
  const streamReadiness = createSceneStreamingReadiness({
    handle,
    onProgress: ({ actorGuid, streamLoadId }, progress) => {
      worker?.postControl({ type: "sceneStreamProgress", actorGuid, streamLoadId, progress });
      runtime?.notifySceneStreamProgress(actorGuid, streamLoadId, progress);
    },
    onReady: ({ actorGuid, streamLoadId }) => {
      const source = streamSceneAssets.get(actorGuid);
      if (source?.loadId === streamLoadId) {
        if (source.prepared) markSourceReady(source.prepared);
        publishAssetStates([source.guid], "ready");
      }
      worker?.postControl({ type: "sceneStreamReady", actorGuid, streamLoadId });
      runtime?.notifySceneStreamReady(actorGuid, streamLoadId);
    },
    onFailed: ({ actorGuid, streamLoadId }, error) => {
      const source = streamSceneAssets.get(actorGuid);
      if (source?.loadId === streamLoadId) publishAssetStates([source.guid], "failed");
      const message = error instanceof Error ? error.message : String(error);
      worker?.postControl({ type: "sceneStreamFailed", actorGuid, streamLoadId, message });
      runtime?.notifySceneStreamFailed(actorGuid, streamLoadId, message);
    },
  });
  const consoleWaiters: Array<
    (result: { success: boolean; output: string }) => void
  > = [];
  const inspectWaiters: Array<(snapshot: DebugInspectSnapshot) => void> = [];
  let recordedTrace: TracePayload | null = null;
  let commandCount = 0;
  let commandWindowStart = performance.now();
  let bridgeRate = 0;
  let hudStats: PlayHudStats | undefined;
  let lastWorkerTickIndex = 0;
  let input: InputCaptureHandle | null = null;

  const emitHudStats = (next: PlayHudStats) => {
    hudStats = next;
    options.onStats?.(next);
  };

  const noteCommand = () => {
    commandCount += 1;
    const now = performance.now();
    const elapsed = (now - commandWindowStart) / 1000;
    if (elapsed >= 0.2) {
      bridgeRate = commandCount / elapsed;
      commandCount = 0;
      commandWindowStart = now;
    }
  };

  const simulationSaveStorage = options.mode === "simulate"
    ? options.simulationSaveStorage ?? createSessionSaveStorage(createSaveGameStorage())
    : undefined;
  const saveStorage = simulationSaveStorage ?? createSaveGameStorage();
  const saveServer = createSaveStorageServer(saveStorage, (response) => worker?.postControl({ type: "saveStorageResponse", response }));
  let captureTask: Promise<import("@babylonslate/runtime").SimulationSceneCaptureResult> | null = null;
  let captureAbort: AbortController | null = null;
  let captureRequested = false;
  let captureFenceActive = false;
  let captureFenceChanged = false;
  const acceptQuiesced = (result: import("@babylonslate/bridge").SessionBoundaryResult) => {
    if (captureClient.receive({ type: "simulationQuiesced", ...result }) && result.success) {
      captureFenceActive = true;
      captureFenceChanged = false;
    }
  };
  const captureClient = new SimulationCaptureClient({
    generation: options.sessionGeneration ?? 0,
    quiesce: async request => {
      if (worker) { worker.postControl({ type: "quiesceSimulation", ...request }); return; }
      if (!runtime) throw new Error("The Simulation runtime is unavailable.");
      acceptQuiesced(await runtime.quiesceSimulation(request));
    },
    capture: async request => {
      if (worker) { worker.postControl({ type: "captureSimulationState", ...request }); return; }
      if (!runtime) throw new Error("The Simulation runtime is unavailable.");
      captureClient.receiveComplete(request, await runtime.captureSimulationState(request));
    },
  });
  const captureSimulationScene: PlaySession["captureSimulationScene"] = (maxBytes) => {
    if (options.mode !== "simulate" || stopped) return Promise.reject(new Error("A live Simulation session is required for final scene capture."));
    if (captureTask) return captureTask;
    captureRequested = true;
    captureFenceActive = false;
    inspectorClient.dispose();
    input?.neutralize();
    requestedPauses.add("loading");
    suppressGameInput();
    const abort = new AbortController();
    captureAbort = abort;
    const work = (async () => {
      const boundary = await captureClient.quiesce();
      if (!boundary.success) throw new Error(boundary.reason ?? "Simulation did not reach a final boundary.");
      abort.signal.throwIfAborted();
      acknowledgedPaused = true;
      handle.setGameTimePaused(true);
      const drainTimer = setTimeout(() => abort.abort(new Error("Final render-owned resources did not settle within 30 seconds. Retry or Discard the Simulation changes.")), 30_000);
      let rendered: { commandRevision: number };
      try { rendered = await handle.quiesceAuthoringRevision(boundary.commandRevision, abort.signal); }
      finally { clearTimeout(drainTimer); }
      if (captureFenceChanged) throw new Error("A render-owned property changed after the final Simulation boundary.");
      const result = await captureClient.capture(rendered.commandRevision, maxBytes);
      abort.signal.throwIfAborted();
      if (captureFenceChanged) throw new Error("A render-owned property changed while the final Simulation scene was transferring.");
      return result;
    })();
    captureTask = work.finally(() => {
      abort.abort();
      if (captureAbort === abort) captureAbort = null;
      captureTask = null;
    });
    return captureTask;
  };
  const materialEditHost = new RuntimeMaterialEditHost({
    sessionGeneration: options.sessionGeneration ?? 0,
    mode: options.mode ?? "play",
    prepare: request => handle.prepareRuntimeMaterialEdit(request),
    commit: command => handle.commitRuntimeMaterialEdit(command),
    release: token => handle.releaseRuntimeMaterialPreparation(token),
    respond: response => {
      if (worker) worker.postControl(response);
      else runtime?.applyRuntimeMaterialEditResult(response);
    },
  });
  const onCommand = (command: CommandMessage) => {
    if (command.type === "simulationRetentionUnavailable") {
      if (command.sessionGeneration === (options.sessionGeneration ?? 0)) options.onRetentionUnavailable?.(command.reason);
      return;
    }
    if (command.type === "simulationQuiesced") { acceptQuiesced(command); return; }
    if (command.type === "simulationCaptureChunk" || command.type === "simulationCaptureResult") { captureClient.receive(command); return; }
    if (captureFenceActive && shouldForwardPlayEngineCommand(command.type)) captureFenceChanged = true;
    if (materialEditHost.receive(command)) return;
    if (command.type === "diagnosticOperationResult") { diagnosticClient.receive(command); return; }
    if (command.type === "performanceTicks") {
      if (command.sessionGeneration === (options.sessionGeneration ?? 0)) performanceDiagnostics?.receiveTicks(command);
      return;
    }
    if (command.type === "diagnosticOperationStopped") {
      if (command.sessionGeneration === (options.sessionGeneration ?? 0)) performanceDiagnostics?.runtimeStopped(command);
      return;
    }
    if (command.type === "sessionBoundaryResult") { boundaryClient.receive(command); return; }
    if (command.type === "runtimeInspectorResult") {
      if (command.success && command.payload?.kind === "mutation" && acknowledgedPaused) handle.requestPausedRedraw();
      inspectorClient.receive(command);
      return;
    }
    if (command.type === "assetSourcesReady") {
      const request = sourceRequests.get(command.requestId);
      sourceRequests.delete(command.requestId);
      if (command.success) request?.resolve();
      else request?.reject(new Error(command.error ?? "Script sources failed to prepare."));
      return;
    }
    if (command.type === "requestComplexCollision") { answerComplexCollision(command.assetGuid); return; }
    if (receivePreload(command)) return;
    if (sceneSources?.receive(command)) return;
    if (command.type === "saveStorageRequest") { saveServer.receive(command.request); return; }
    noteCommand();
    if (command.type === "activeScene") { inspectorClient.invalidateScene(); materialEditHost.invalidate(); }
    if (command.type === "despawn") { inspectorClient.invalidateActor(command.actorGuid); materialEditHost.invalidateActor(command.actorGuid); }
    if (command.type === "sceneStreamBlocking") handle.setSceneStreamingPaused(command.blocking);
    if (command.type === "snapshotLayout" && runtime)
      snapBuf = new Float32Array(snapshotFloatCount(command.capacity));
    if (command.type === "spawn") {
      spawnedActorGuids.push(command.actorGuid);
    }
    if (
      command.type === "snapshotLayout" ||
      shouldForwardPlayEngineCommand(command.type)
    ) {
      handle.applyCommand(command);
    }
    if ((command.type === "sceneRealized" || command.type === "sceneLayerRealized" || command.type === "sceneStreamRealized") && runtime) {
      if (!runtime.copySnapshot(snapBuf)) throw new Error("Completed Scene snapshot is unavailable.");
      handle.pushSnapshot(snapBuf);
    }
    sceneReadiness.receive(command);
    streamReadiness.receive(command);
    if (command.type === "log") {
      options.onLog?.(command.message, command.severity ?? "log");
    }
    if (command.type === "print" && command.message) {
      options.onPrint?.({
        message: command.message,
        key: command.key ?? "",
        duration: command.duration ?? 2,
        color: printHudCssColor(command.color),
      });
    }
    if (command.type === "stats") {
      emitHudStats(
        applyWorkerPlayStats(hudStats, {
          fps: command.fps,
          scriptMs: command.scriptMs ?? 0,
          physicsMs: command.physicsMs ?? 0,
          publishMs: command.publishMs,
          frameId: command.frameId ?? 0,
          liveActors: command.liveActors,
          snapshotCapacity: command.snapshotCapacity,
        }),
      );
    }
    if (command.type === "diagnostic") {
      options.onLog?.(command.message, command.severity ?? "error");
      const diagnostic = diagnosticFromCommand(command);
      if (diagnostic) workerDiagnostics.push(diagnostic);
      if (isFatalPlayDiagnostic(command.code)) {
        queueMicrotask(() => options.onFatalDiagnostic?.());
      }
    }
    if (command.type === "consoleResult") {
      const waiter = consoleWaiters.shift();
      waiter?.({ success: command.success, output: command.output });
    }
    deliverInspectSnapshot(inspectWaiters, command);
    if (command.type === "trace") {
      recordedTrace = command.payload as unknown as TracePayload;
    }
    if (command.type === "sessionPaused") {
      // Console Pause/Resume already changed the runtime reason. Ask for its
      // completed boundary without rewriting another outstanding pause hold.
      void synchronizePauseBoundary({ kind: "resetInput" }).catch((error: unknown) => options.onLog?.(String(error), "error"));
    }
    applyPlaySessionPausedCommand(command, options.onSessionPaused);
    applyPlayHudConsoleCommand(command, {
      onShowFps: options.onShowFps,
      onStat: options.onStatHighlight,
      onFreeCam: options.onFreeCam,
    });
    if (command.type === "btState") {
      options.onBtState?.({
        slotId: command.slotId,
        status: command.status,
        btNodeId: command.btNodeId,
        lastResults: command.lastResults,
        blackboard: command.blackboard,
        stack: command.stack,
      });
    }
    if (command.type === "setBehaviourTreeDebug")
      options.onBehaviourTreeDebug?.(command.enabled);
    if (command.type === "behaviourTreeSnapshot")
      options.onBehaviourTreeSnapshot?.(command.trees);
    const overlayLog = overlayLogForCommand(command);
    if (overlayLog) options.onLog?.(overlayLog, "log");
  };

  const scripts = options.scripts ?? [];
  const physics = options.physics ?? {
    physicsWorld: "3d" as const,
    gravity: [0, -9.81, 0] as [number, number, number],
  };
  const animClipCatalog = options.animClipCatalog
    ? resolveModelAnimationDurations(options.animClipCatalog, options.modelBytes ?? new Map(), options.retargetAnimationLoads)
    : undefined;
  const animGraphs = options.animGraphs?.map((entry) => {
    const document = parseAnimGraphDocument(entry.document);
    return document && animClipCatalog
      ? { ...entry, document: resolveAnimGraphClips(document, animClipCatalog) }
      : entry;
  });
  const loadControl = playLoadControl({
    sessionMode: options.mode ?? "play",
    sessionGeneration: options.sessionGeneration,
    simulationAssetGuids: options.simulationAssetGuids ? [...options.simulationAssetGuids] : undefined,
    saveGame: options.saveGame,
    frameCap: resolvePlayFrameCap(options.frameCap),
    traceByteBudget: options.traceByteBudget,
    renderSettings: options.consoleRenderSettings ?? options.renderSettings,
    sceneAssetGuid: options.sceneAssetGuid ?? "play-scene",
    scene: options.scene,
    physicsWorld: physics.physicsWorld,
    gravity: physics.gravity,
    project: options.project,
    gameInstanceClass: options.gameInstanceClass,
    scenes: options.scenes,
    sceneNavmeshBytes: Object.fromEntries(options.sceneNavmeshBytes ?? []),
    sceneLayers: options.sceneLayers,
    infiniteLoopDetection: options.infiniteLoopDetection,
    loopCount: options.loopCount,
    inputAssets: options.inputAssets,
    dataAssets: options.dataAssets,
    assetCatalog: options.assetCatalog,
    inputMappings: options.inputMappings,
    focusNavigation: options.focusNavigation,
    pixelsPerUnit: options.pixelsPerUnit,
    texturePixelSizes: Object.fromEntries(options.texturePixelSizes ?? []),
    audioAssetGuids: options.audioAssetGuids ?? [...(options.audioLibrary?.audio.keys() ?? [])],
    materialParameterCatalog: buildMaterialParameterCatalog(options.materialDocuments ?? new Map(), options.materialFunctions),
    materialTextureAssetGuids: materialParameterTextureAssetGuids(options.textureBytes, options.renderTargetTextures),
    animClipCatalog,
    renderTargets: Object.fromEntries(options.renderTargets ?? []),
    renderTargetTextures: Object.fromEntries(options.renderTargetTextures ?? []),
  });
  if (acquireScene) loadControl.sceneCatalog = options.sceneCatalog ?? [];
  if (options.classAssetGuids) loadControl.classAssetGuids = options.classAssetGuids;
  if (options.consoleCommands) loadControl.consoleCommands = options.consoleCommands;

  try {
    worker = createGameWorkerHost();
    runtimeMode = "worker";
    worker.onCommand((cmd) => onCommand(cmd));
    worker.onSnapshot((buffer) => {
      lastWorkerTickIndex = applyPlaySnapshotTick(lastWorkerTickIndex, buffer);
      handle.pushSnapshot(buffer);
    });
    for (const control of playSessionBootControls({
      load: loadControl,
      scripts,
      animGraphs,
      behaviourTrees: options.behaviourTrees,
      blackboards: options.blackboards,
      waters: { type: "loadWater", waters: [...(options.waterPayloads ?? [])].map(([guid, document]) => ({ guid, document })) },
      tilemaps: playLoadTilemapsControl(
        options.tilemapPayloads,
        options.tilesetPayloads,
        options.pixelsPerUnit,
      ),
      sprites: playLoadSpritesControl(
        options.spritePayloads,
        options.spriteAnimationPayloads,
        options.pixelsPerUnit,
      ),
      models: playLoadModelsControl(options.modelPayloads, options.complexMeshes),
      navmeshBytes: options.navmeshBytes,
      pauseOnPlay: options.pauseOnPlay,
    })) {
      worker.postControl(control);
    }
  } catch (err) {
    worker = null;
    runtimeMode = "in-process";
    runtime = createRuntimeFromLoad(loadControl, (command) =>
      onCommand(command),
      saveStorage,
      acquireScene ? { acquireScene } : undefined,
    );
    runtime.registerAnchors(FIXTURE_ASSET, [
      {
        line: 1,
        column: 0,
        assetGuid: FIXTURE_ASSET,
        graphId: "event-graph",
        nodeId: FIXTURE_NODE,
      },
    ]);
    const inProcess = runtime;
    const boot = createPlayBootCoordinator();
    resetBoot = () => boot.reset();
    pauseGate = createPlayPauseGate({
      pause: () => inProcess.pause(),
      resume: () => inProcess.resume(),
    });
    if (scripts.length > 0) {
      boot.queueScripts(inProcess, scripts, []);
    }
    for (const entry of animGraphs ?? []) {
      const document = parseAnimGraphDocument(entry.document);
      if (document) inProcess.registerAnimGraph(entry.guid, document);
    }
    for (const entry of options.behaviourTrees ?? []) {
      const document = parseBehaviourTreeDocument(entry.document);
      if (document) inProcess.registerBehaviourTree(entry.guid, document);
    }
    inProcess.registerWaterContent(options.waterPayloads ?? new Map());
    for (const entry of options.blackboards ?? []) {
      const document = parseBlackboardDocument(entry.document);
      if (document) inProcess.registerBlackboard(entry.guid, document);
    }
    if (
      (options.tilemapPayloads && options.tilemapPayloads.size > 0) ||
      (options.tilesetPayloads && options.tilesetPayloads.size > 0)
    ) {
      inProcess.registerTileContent({
        tilemaps: options.tilemapPayloads ?? new Map(),
        tilesets: options.tilesetPayloads ?? new Map(),
        pixelsPerUnit: options.pixelsPerUnit,
      });
    }
    if (
      (options.spritePayloads && options.spritePayloads.size > 0) ||
      (options.spriteAnimationPayloads &&
        options.spriteAnimationPayloads.size > 0)
    ) {
      inProcess.registerSpriteContent({
        sprites: options.spritePayloads ?? new Map(),
        spriteAnimations: options.spriteAnimationPayloads ?? new Map(),
        pixelsPerUnit: options.pixelsPerUnit,
      });
    }
    if (options.modelPayloads && options.modelPayloads.size > 0) {
      inProcess.registerModelContent({
        models: options.modelPayloads,
        complexMeshes: options.complexMeshes,
      });
    }
    if (options.navmeshBytes && options.navmeshBytes.byteLength > 0) {
      boot.queueNavMesh(inProcess, options.navmeshBytes);
    }
    void pauseGate
      .beginPlay((onStarted) => boot.play(inProcess, onStarted))
      .catch((error: unknown) => {
        if (!stopped) inProcess.reportError(error);
      });
    if (options.pauseOnPlay) {
      pauseGate.setPaused(true);
    }
    options.onLog?.(
      `Play worker unavailable (${err instanceof Error ? err.message : String(err)}); using in-process.`,
      "warning",
    );
  }
  // The subscription fired before the runtime existed; report the current
  // status now that the worker or in-process runtime can store it.
  publishRenderPathStatus(handle.renderPathStatus());
  const initialScalability = handle.scalabilityStatus?.();
  if (initialScalability) publishScalabilityStatus(initialScalability);

  input = attachInputCapture(canvas, {
    skipPointerAndKeyboard: () => handle.isFreeCamEnabled(),
  });
  if (options.mode === "simulate") input.setSuppressed(false);

  const unlock = () => {
    void handle.unlockAudio();
  };
  canvas.addEventListener("pointerdown", unlock);
  canvas.addEventListener("touchstart", unlock);

  let snapBuf = new Float32Array(snapshotFloatCount(256));
  let last = performance.now();
  let raf = 0;
  let fpsWindowStart = last;
  let sessionDiagnostics: SessionReportEntry[] = [];
  let droppedDiagnostics = 0;
  let lastObservedMoveX: number | null = null;
  let stopped = false;
  let stopResult: PlaySessionResult | null = null;

  const pump = () => {
    if (stopped) return;
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    const tick = playInputStampTick(
      runtime?.getWorld().clock.tickIndex,
      lastWorkerTickIndex,
    );
    input.setTick(tick);
    input.pollGamepads();
    const drained = input.ring.drain();
    if (drained.length > 0) {
      lastObservedMoveX = observedMoveXFromEvents(drained, lastObservedMoveX);
      if (worker) worker.pushInput(drained);
      else if (runtime) runtime.pushInputBuffer(encodeInputEvents(drained));
    }
    if (runtime) {
      runtime.advance(elapsed);
      if (runtime.copySnapshot(snapBuf)) {
        lastWorkerTickIndex = applyPlaySnapshotTick(
          lastWorkerTickIndex,
          snapBuf,
        );
        handle.pushSnapshot(snapBuf);
      }
    }
    // Worker pumps itself; host only feeds input + applies snapshots via onSnapshot.
    if (now - fpsWindowStart >= 1000) {
      emitHudStats(
        applyPlayFpsSample(hudStats, handle.scheduler.stats().renderedFps),
      );
      fpsWindowStart = now;
    }
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  if (options.injectFixtureThrow) {
    queueMicrotask(() => {
      const hint = previewFixtureThrowHint(options.behaviourTrees);
      if (runtime) {
        const err = new Error("Preview fixture throw");
        err.stack = `Error: Preview fixture throw\n    at run (babylonslate:///${FIXTURE_ASSET}.js:1:1)`;
        runtime.reportError(err, undefined, hint ?? undefined);
      } else if (worker) {
        // Worker path: route through the same aggregator a real worker
        // `diagnostic` command would use, rather than a report shortcut.
        workerDiagnostics.push({
          code: "runtime.uncaught",
          message: "Preview fixture throw",
          severity: "error",
          assetGuid: hint?.assetGuid ?? FIXTURE_ASSET,
          graphId: hint ? undefined : "event-graph",
          nodeId: hint ? undefined : FIXTURE_NODE,
          btNodeId: hint?.btNodeId,
          frameId: 1,
        });
        options.onLog?.("Preview fixture throw", "error");
      }
    });
  }

  const diagnosticSessionId = `play:${options.sessionGeneration ?? 0}:${performance.now()}`;
  performanceDiagnostics = new SessionDiagnostics({
    mode: options.mode ?? "play",
    identity: () => {
      const build = getBuildIdentity();
      const render = handle.scalabilityStatus()?.effective?.render ?? options.consoleRenderSettings ?? options.renderSettings;
      const frameCap = handle.scheduler.gateState().frameCap;
      return { sessionId: diagnosticSessionId, mode: options.mode ?? "play", sourceSha: build?.sourceSha ?? null,
        buildId: build ? `${build.packageVersion}:${build.runNumber}.${build.runAttempt}` : null,
        sceneId: hostSceneGuid ?? options.sceneAssetGuid ?? "play-scene",
        backend: handle.engine.isWebGPU ? "webgpu" : "webgl2", renderPath: handle.renderPathStatus().effective.renderPath,
        runtimeHost: runtimeMode, quality: JSON.stringify(render ?? {}), frameCap: Number.isFinite(frameCap) ? frameCap : null,
        dynamicResolution: render?.quality?.resolution?.dynamic === true,
        enabledDiagnostics: ["performance"], gpuTiming: "unavailable" };
    },
    observeFrames: (listener) => handle.observePerformance(listener),
    observeGpuTiming: (listener, onError) => handle.observeGpuTiming(listener, onError),
    runtimeOperation: (request) => diagnosticClient.request(request),
    captureFrame: async (signal) => {
      const cancel = () => handle.cancelFrameCapture("Frame capture was cancelled.");
      signal.addEventListener("abort", cancel, { once: true });
      try {
        // A paused report is render-only only after the requested game-clock
        // boundary has completed; a legacy caller-paused view is insufficient.
        let pending: typeof pendingPauseBoundary;
        do {
          pending = pendingPauseBoundary;
          if (pending) {
            const result = await pending;
            if (!result.success) throw new Error(result.reason ?? "Game pause did not reach its completed boundary.");
          }
          signal.throwIfAborted();
        } while (pending !== pendingPauseBoundary);
        return await handle.captureFrame();
      }
      finally { signal.removeEventListener("abort", cancel); }
    },
    onProfile: (profile) => options.onProfile?.(profile),
  });
  return {
    canvas,
    handle,
    runtime,
    worker,
    runtimeMode,
    diagnostics: performanceDiagnostics,
    setPaused: (paused: boolean) => {
      void setPauseReason("user", paused).catch((error: unknown) => options.onLog?.(String(error), "error"));
    },
    setPauseReason,
    setEditorInputSuppressed: async (suppressed) => {
      const transition = ++inputTransition;
      inputTransitionPending = true;
      editorInputRoutingEnabled = true;
      editorInputSuppressed = suppressed;
      input.neutralize();
      suppressGameInput();
      const result = await boundaryClient.request({ kind: "resetInput" });
      if (!result.success) throw new Error(result.reason ?? "Editor input ownership could not be reset");
      if (transition !== inputTransition) return;
      inputTransitionPending = false;
      suppressGameInput();
    },
    setInputMode: async (mode) => {
      const transition = ++inputTransition;
      inputTransitionPending = true;
      gameInputMode = mode;
      input.neutralize();
      suppressGameInput();
      const result = await boundaryClient.request({ kind: "resetInput" });
      if (!result.success) throw new Error(result.reason ?? "Game input could not be reset");
      if (transition !== inputTransition) return;
      inputTransitionPending = false;
      suppressGameInput();
      handle.setSimulationEditMode(mode === "edit");
    },
    requestPausedRedraw: () => handle.requestPausedRedraw(),
    lastMoveX: () => {
      if (runtime) {
        return runtime.getResolvedInput().axes2D.Move?.x ?? lastObservedMoveX;
      }
      return lastObservedMoveX;
    },
    lastActorPositions: () => handle.lastActorPositions(),
    lastTickIndex: () =>
      playInputStampTick(
        runtime?.getWorld().clock.tickIndex,
        lastWorkerTickIndex,
      ),
    setFrameCap: (fps: number) => {
      handle.scheduler.setFrameCap(fps);
    },
    spawnedActorGuids: () => spawnedActorGuids,
    executeConsoleCommand: (line) => {
      if (captureRequested) return Promise.resolve({ success: false, output: "Simulation is resolving its final scene; choose Retry or Discard." });
      if (stopped)
        return Promise.resolve({
          success: false,
          output: "Play session stopped",
        });
      if (runtime) {
        return runtime.executeConsoleCommandAsync(line);
      }
      if (worker) {
        return new Promise((resolve) => {
          consoleWaiters.push(resolve);
          worker.postControl({ type: "console", line });
        });
      }
      return Promise.resolve({
        success: false,
        output: "runtime unavailable",
      });
    },
    inspectWorld: () => {
      if (runtime) {
        return Promise.resolve(runtime.inspectWorld());
      }
      if (worker) {
        return new Promise((resolve) => {
          inspectWaiters.push(resolve);
          worker.postControl({ type: "inspect" });
        });
      }
      return Promise.resolve({ tickIndex: 0, nodes: [] });
    },
    requestRuntimeInspection: (action, options) => inspectorClient.request(action, options),
    captureSimulationScene,
    step: () => {
      if (captureRequested) return;
      applyPlaySessionStep({ worker, runtime });
    },
    lastTrace: () => recordedTrace ?? runtime?.stopTrace() ?? null,
    accountedBytes: () => handle.resourceCache.accountedBytes(),
    liveObjectCounts: () => handle.liveObjectCounts(),
    whenModelsReady: async () => { await sessionSourcesReady; await handle.whenEditorModelsReady(); },
    modelLoadCount: () => handle.modelLoadCount(),
    drawCalls: () => handle.drawCalls(),
    bridgeMessagesPerSec: () => {
      const now = performance.now();
      const elapsed = (now - commandWindowStart) / 1000;
      if (elapsed >= 0.2) {
        bridgeRate = commandCount / Math.max(elapsed, 0.001);
        commandCount = 0;
        commandWindowStart = now;
      }
      return Math.round(bridgeRate);
    },
    stop: () => {
      if (stopped && stopResult) return stopResult;
      void performanceDiagnostics?.dispose().finally(() => diagnosticClient.dispose());
      resetBoot();
      pauseGate?.reset();
      sceneReadiness.dispose();
      streamReadiness.dispose();
      stopped = true;
      boundaryClient.dispose();
      inspectorClient.dispose();
      captureAbort?.abort();
      captureClient.dispose();
      materialEditHost.dispose();
      simulationSaveStorage?.dispose();
      releaseConsoleCapture();
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
      for (const resolve of consoleWaiters.splice(0))
        resolve({ success: false, output: "Play session stopped" });
      for (const resolve of inspectWaiters.splice(0))
        resolve({ tickIndex: 0, nodes: [] });
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", unlock);
      canvas.removeEventListener("touchstart", unlock);
      input.dispose();
      if (runtime) {
        runtime.stop();
        sessionDiagnostics = runtime.getDiagnostics().entries();
        droppedDiagnostics = runtime.getDiagnostics().droppedCount();
      } else {
        sessionDiagnostics = workerDiagnostics.entries();
        droppedDiagnostics = workerDiagnostics.droppedCount();
      }
      sessionDiagnostics.push(...hostDiagnostics.entries());
      droppedDiagnostics += hostDiagnostics.droppedCount();
      worker?.postControl({ type: "stop" });
      saveServer.dispose();
      worker?.terminate();
      for (const request of sourceRequests.values()) request.reject(new Error("Play stopped during script preparation."));
      sourceRequests.clear();
      sceneSources?.dispose();
      for (const preloadId of preloads.keys()) releasePreload(preloadId);
      preparedScenes.clear();
      sceneSourceOwners.clear();
      streamSceneAssets.clear();
      sceneSourceScopes.clear();
      preparedSourceScopes.clear();
      const liveAfter = handle.liveObjectCounts();
      handle.dispose();
      releaseSessionSources?.();
      releaseSessionSources = undefined;
      releaseInitialSources();
      // Shared-Engine teardown defers Scene/library release until actual
      // native release confirms; measure the texture cache only then. A
      // rejected release quarantines the owners — retained textures are not a
      // leak, and the render layer already warns.
      const released = handle
        .whenReleased()
        .then(
          () => false,
          () => true,
        )
        .then((quarantined) => {
          const textureCountAfter =
            sharedEngine.getLoadedTexturesCache().length;
          const textureLeak = textureCountAfter > textureCountBefore;
          if (textureLeak && !quarantined) {
            console.error(
              `[play] texture cache grew ${textureCountBefore} → ${textureCountAfter}`,
            );
          }
          return { textureCountAfter, textureLeak, quarantined };
        });
      stopResult = {
        diagnostics: sessionDiagnostics,
        droppedDiagnostics,
        textureCountBefore,
        released,
        runtimeMode,
        liveObjectCounts: liveAfter,
        lastTrace: recordedTrace ?? runtime?.stopTrace() ?? null,
      };
      return stopResult;
    },
  };
}

export const PREVIEW_FIXTURE_NODE_ID = FIXTURE_NODE;
