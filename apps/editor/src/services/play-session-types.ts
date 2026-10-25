import type {
  AudioProjectSettings,
  createSessionSaveStorage,
  RenderProjectSettings,
  SerializedScene,
  SerializedSceneLayer,
} from "@haptic/core";
import type { AnimClipCatalogEntry } from "@haptic/anim-graph";
import type { RuntimeDriver, SessionReportEntry } from "@haptic/runtime";
import type { DebugInspectSnapshot } from "@haptic/object-model";
import type {
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
  ModelPayload,
  RetargetAnimationLoad,
} from "@haptic/assets";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@haptic/shader-graph";
import type {
  SceneLoadProgress,
  AudioLibrary,
  EngineHandle,
  ParticleLibrary,
  PlayActorPosition,
  SceneSourceAssets,
} from "@haptic/render";
import type { SpawnableLight } from "@haptic/render/spawnable-lights";
import type {
  CommandMessage,
  ControlMessage,
  DebugObserveTarget,
  ScriptBundleEntry,
  SessionPauseCause,
  Breakpoint,
} from "@haptic/bridge";
import type { RuntimeInspectionAction, RuntimeInspectionWriteOptions } from "./runtime-inspector-client";
import type { GameWorkerHost } from "./game-worker-host";
import type { PlayPhysicsSettings } from "./play-physics";
import type {
  PerformanceProfile,
  SessionDiagnostics,
  TracePayload,
} from "@haptic/debugger";

export interface PlaySessionResult {
  diagnostics: SessionReportEntry[];
  droppedDiagnostics: number;
  textureCountBefore: number;
  /**
   * Settles after the shared-Engine teardown confirms actual release and a
   * stopped worker was terminated, then measures the texture cache.
   * `quarantined` is true when release never confirmed; the promise never
   * rejects.
   */
  released: Promise<{
    textureCountAfter: number;
    /** True when textures created during Play outlived its release. */
    textureLeak: boolean;
    quarantined: boolean;
    /** When `textureLeak`: the retained textures by name, size, references and owner. */
    textureLeakDetail?: string;
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
  diagnostics: SessionDiagnostics<import("@haptic/render").RenderFrameReport>;
  setPaused: (paused: boolean) => void;
  setPauseReason: (reason: import("@haptic/bridge").SessionPauseReason, paused: boolean) => Promise<import("@haptic/bridge").SessionBoundaryResult>;
  setInputMode: (mode: "game" | "edit") => Promise<void>;
  /**
   * Point the graph debugger at the live instances of `target` (null stops) and follow
   * `instanceId`. The runtime answers with `onDebugRoster` and, for the followed instance
   * only, `onExecutionTrace` each tick (and a Behaviour Tree's `onBtState`).
   */
  observeGraphDebug: (target: DebugObserveTarget | null, instanceId: string | null) => void;
  /** Replace the node breakpoints a Simulation stops at (its scripts check them). */
  setBreakpoints: (breakpoints: Breakpoint[]) => void;
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
  requestRuntimeInspection: (action: RuntimeInspectionAction, options?: RuntimeInspectionWriteOptions) => Promise<import("@haptic/bridge").RuntimeInspectorResult>;
  /** Complete final canonical scene, captured before destructive Stop/End Play. */
  captureSimulationScene: (maxBytes?: number) => Promise<import("@haptic/runtime").SimulationSceneCaptureResult>;
  /** Advance one simulation tick while paused. */
  step: () => void;
  /**
   * Simulation's Step: one tick of a session paused only by the user, acknowledged through the
   * session boundary after the tick's commands, so the paused view can redraw the result.
   */
  stepPaused: () => Promise<import("@haptic/bridge").SessionBoundaryResult>;
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
}) => Promise<PlaySourcePreparation & { scene: SerializedScene; /** The Scene's baked reverb field, if any. */ audioReverb: Uint8Array | null }>;
export type PlayAssetSourceLoader = (guids: string[], options: {
  consumer: string; signal: AbortSignal; onProgress?: (progress: number) => void;
  /** Orders this load's source reads against other queued work; default gameplay. */
  priority?: import("@haptic/core").RuntimeAssetSchedulerPriority;
  fontModes?: import("@haptic/render").CommandFontModes;
}) => Promise<PlaySourcePreparation>;

/** One Print node message as the HUD and console show it. */
export interface PlayPrintEntry {
  message: string;
  key: string;
  duration: number;
  color: string;
}

export interface PlayHudStats {
  fps: number;
  scriptMs: number;
  physicsMs: number;
  /** Snapshot publish time, reported apart from the tick's script/physics budget. */
  publishMs: number;
  /** The last tick's milliseconds per timed phase (`TICK_TIMING_PHASES`), when the worker reports them. */
  phaseMs?: readonly number[];
  frameId: number;
  /** The worker's tick index, from its latest `stats` command. */
  ticks?: number;
  liveActors?: number;
  snapshotCapacity?: number;
}

/** What `startPlaySession` takes. The session works on its own shallow copy, which releasing the initial sources prunes. */
export type PlaySessionOptions = {
  /** Preview uses the packaged player, never this in-process presentation host. */
  mode?: "play" | "simulate";
  sessionGeneration?: number;
  /** Transfer the preparation overlay, including wipe-on-start, to this owner. */
  simulationSaveStorage?: ReturnType<typeof createSessionSaveStorage>;
  /** Authoring asset identities admitted by preparation; this does not load assets. */
  simulationAssetGuids?: readonly string[];
  onRetentionUnavailable?: (reason: string) => void;
  saveGame?: import("@haptic/core").SaveGameConfiguration;
  renderSettings?: import("@haptic/render").RenderShadingSettings;
  consoleRenderSettings?: import("@haptic/render").RenderShadingSettings;
  canvas: HTMLCanvasElement;
  sharedEngine: EngineHandle["engine"];
  injectFixtureThrow?: boolean;
  /** Scene physics world and gravity from the open scene document. */
  physics?: PlayPhysicsSettings;
  /** Compiled project graphs to run for this session. */
  scripts?: readonly ScriptBundleEntry[];
  /** The light parts the startup sources may spawn (`spawnableLightsOfLoad`); defaults to those of `scripts`. */
  spawnableLights?: ReadonlyMap<string, SpawnableLight>;
  /** Authored scene instantiated in the worker instead of demo actors. */
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  project?: { name: string; version: string };
  gameInstanceClass?: string;
  scenes?: Array<{ guid: string; scene: SerializedScene }>;
  sceneCatalog?: Array<{ guid: string; name: string }>;
  classAssetGuids?: Record<string, string>;
  consoleCommands?: Array<import("@haptic/core").ConsoleCommandMetadata & { classId: string; assetGuid: string }>;
  audioAssetGuids?: string[];
  acquireSceneSources?: PlaySceneSourceLoader;
  acquireAssetSources?: PlayAssetSourceLoader;
  releaseInitialSources?: () => void | ControlMessage[];
  sessionSources?: SceneSourceAssets;
  getAssetLoadState?: (guid: string) => import("@haptic/core").RuntimeAssetLoadState;
  getSourceControls?: () => ControlMessage[];
  sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
  onStats?: (stats: PlayHudStats) => void;
  onLog?: (message: string, severity: string) => void;
  /** Each log the runtime raises (Log nodes included), with its category; the host's Output Log feed. */
  onRuntimeLog?: (entry: { category: string; severity: string; message: string }) => void;
  onPrint?: (entry: PlayPrintEntry) => void;
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
  renderTargets?: ReadonlyMap<string, import("@haptic/core").RenderTargetPayload>;
  renderTargetTextures?: ReadonlyMap<string, import("@haptic/core").RenderTargetTexturePayload>;
  waterPayloads?: ReadonlyMap<string, import("@haptic/core").WaterDefinition>;
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  textureBytes?: ReadonlyMap<string, Uint8Array>;
  areaEmissions?: ReadonlyMap<string, import("@haptic/assets").AreaEmissionPixels>;
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
  fontMsdfJson?: ReadonlyMap<string, Uint8Array>;
  fontMsdfPng?: ReadonlyMap<string, Uint8Array>;
  fontFaceEntries?: readonly import("@haptic/render").FontAssetEntry[];
  fontCssStack?: string;
  fontCssStackByGuid?: ReadonlyMap<string, string>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  modelPayloads?: ReadonlyMap<string, ModelPayload>;
  /** Complex Collision meshes cooked during source preparation; Play never re-cooks them. */
  complexMeshes?: ReadonlyMap<string, import("@haptic/core").CollisionTriangleMesh>;
  /** Answers the runtime's `requestComplexCollision` for a Model the content scan missed. */
  cookComplexCollision?: (assetGuid: string) => Promise<import("@haptic/core").CollisionTriangleMesh | null>;
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  retargetAnimationLoads?: ReadonlyMap<
    string,
    readonly RetargetAnimationLoad[]
  >;
  loadAudioSourceBytes?: import("@haptic/render").AudioSourceBytesLoader;
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
  /** Project Collision Presets (`PhysicsProjectSettings.collisionPresets`). */
  collisionPresets?: readonly import("@haptic/core").CollisionPreset[];
  sortingLayers?: readonly string[];
  pixelPerfect?: boolean;
  /** Overlay 2DButton pick floor in CSS pixels. */
  touchMinTargetPx?: number;
  /** Baked Scene navmesh bytes; Play imports and never generates. */
  navmeshBytes?: Uint8Array | null;
  sceneNavmeshBytes?: ReadonlyMap<string, Uint8Array>;
  audioReverbByScene?: ReadonlyMap<string, Uint8Array>;
  infiniteLoopDetection?: boolean;
  /** Simulation: pause the first time each node reports an error (Engine Settings, Pause On Errors). */
  pauseOnErrors?: boolean;
  /** Simulation: the enabled node breakpoints when it starts; `setBreakpoints` changes them. */
  breakpoints?: Breakpoint[];
  loopCount?: number;
  inputAssets?: import("@haptic/core").InputAssetDefinition[];
  dataAssets?: import("@haptic/core").DataAssetCatalogEntry[];
  /** Packaged authored assets the Asset Registry nodes query, snapshotted when Play starts. */
  assetCatalog?: import("@haptic/core").RuntimeAssetCatalogEntry[];
  focusNavigation?: import("@haptic/core").FocusNavigationSettings;
  /** Called when a session-fatal diagnostic (infinite loop) arrives. */
  onFatalDiagnostic?: () => void;
  /** Called when the runtime ended its own session (console `quit`); the host stops as for its Stop control. */
  onSessionEnded?: () => void;
  /** When true, pause after Play boot so `boot.play`'s resume cannot undo it. */
  pauseOnPlay?: boolean;
  onSceneLoading?: (state: SceneLoadProgress | null) => void;
  /** A scene load failed; it stays pending until the session stops, and the session reports a fatal diagnostic next. */
  onSceneLoadFailed?: () => void;
  onSessionPaused?: (paused: boolean, cause?: SessionPauseCause) => void;
  onShowFps?: (enabled: boolean) => void;
  onStatHighlight?: (name: string, enabled: boolean) => void;
  onFreeCam?: (enabled: boolean) => void;
  onSetRenderResolution?: (width: number, height: number) => void;
  onRenderOutputChanged?: (settings: RenderProjectSettings) => void;
  onBehaviourTreeDebug?: (enabled: boolean) => void;
  onBehaviourTreeSnapshot?: (
    trees: readonly import("@haptic/bridge").DebugBehaviourTree[],
  ) => void;
  onDebugRoster?: (roster: Extract<CommandMessage, { type: "debugRoster" }>) => void;
  onExecutionTrace?: (trace: Extract<CommandMessage, { type: "executionTrace" }>) => void;
  onDebugVariables?: (report: Extract<CommandMessage, { type: "debugVariables" }>) => void;
  onBtState?: (state: Extract<CommandMessage, { type: "btState" }>) => void;
};
