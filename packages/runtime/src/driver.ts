import type { SimulationSceneCaptureResult } from "./simulation-scene-capture";
import { SimulationSession } from "./simulation-session";
import { RuntimeInspectorService } from "./runtime-inspector-service";
import { RuntimeDataCatalog } from "./data-catalog";
import type { SaveGameService } from "@babylonslate/core";
import { SessionBoundaries, type RuntimeSaveGameOptions } from "./session-boundaries";
import { RuntimeMaterialParameters } from "./runtime-material-parameters";
import { RuntimeAssetPreloads } from "./asset-preloads";
import type { RuntimeAssetLoadState, RuntimeAssetPreloadOptions, RuntimeAssetPreloadResult } from "@babylonslate/core";
import { SceneLayerOverlay, createSceneLayerOverlayHostBindings } from "./scene-layer-overlay";
import type { FocusNavigationSettings } from "@babylonslate/core";
import { CableWorldSync } from "./cable-sync";
import { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import { MovementWorldSync } from "./movement";
import type { RenderTargetPayload, RenderTargetTexturePayload } from "@babylonslate/core";
import type { WaterDefinition } from "@babylonslate/core";
import { ScalabilitySession, type ScalabilityRequest, type ScalabilityResult, type ScalabilitySnapshot, type ScalabilityAcknowledgement, type RenderPath, type RenderProjectSettings } from "@babylonslate/core";
import type { CollisionTriangleMesh, InputAssetDefinition } from "@babylonslate/core";
import { inputMappingsFromAssets } from "@babylonslate/input";
import {
  type CommandMessage,
  type ControlMessage,
  type RuntimeSceneContent,
  type GameSessionMode,
  type SessionPauseReason,
  type SessionBoundaryRequest,
  type SessionBoundaryResult,
  type RuntimeInspectorRequest,
  type RuntimeInspectorResult,
  type SimulationQuiesceRequest,
  type SimulationCaptureRequest,
  type DiagnosticOperationRequest,
  type DiagnosticOperationResult,
} from "@babylonslate/bridge";
import {
  ClassRegistry,
  World,
  createActorFromSerialized,
  createDebugInspectSnapshot,
  Actor,
  ActorComponent,
  BObject,
  MaterialObject,
  PostProcessMaterialObject,
  type MaterialInstanceObject,
  SceneLayer,
  type DebugInspectSnapshot,
} from "@babylonslate/object-model";
import {
  deprojectCursorRay,
  type MaterialParameterCatalog,
  type MaterialParameterValue,
  type RenderPathStatus,
  type Transform,
  type SerializedScene,
  type SerializedSceneLayer,
  type SceneStreamingState,
} from "@babylonslate/core";
import {
  InputRingBuffer,
  InputResolver,
  createDefaultInputMappings,
  normalizeInputMappings,
  decodeInputEvents,
  type InputMappings,
  type InputBindingControls,
  type RawInputEvent,
  type ResolvedInputTick,
} from "@babylonslate/input";
import { sceneRealizationCancelled, type CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { AcquireRuntimeScene } from "./scene-source";
import type { PhysicsWorldKind } from "@babylonslate/physics";
import {
  createInfiniteLoopGuard,
  isInfiniteLoopError,
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  DEFAULT_INFINITE_LOOP_COUNT,
  type CommandResult,
  type InfiniteLoopGuard,
  type RegisteredCommand,
  type TraceBtState,
  type TracePayload,
  type UserCommandDef,
} from "@babylonslate/debugger";
import { LogRingBuffer, type LogSeverity } from "./log-ring";
import {
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
} from "./diagnostics";
import { mapStackToAnchor, type AnchorEntry } from "./stack-map";
import { Painter2DRuntime } from "./painter2d-runtime";
import { UIControls2DRuntime } from "./ui-controls2d-runtime";
import { isUIControl2DClass } from "@babylonslate/core";
import { Text2DAppearRuntime } from "./text2d-appear-runtime";
import { TweenRuntime } from "./tween-runtime";
import { parseOverlayVisualStyle, supportsOverlayVisualStyle } from "@babylonslate/core";
import type { AnimClipCatalogEntry, AnimGraphDocument } from "@babylonslate/anim-graph";
import type { BehaviourTreeDocument, BlackboardDocument } from "@babylonslate/behaviour-tree";
import { ScriptHost, type CompiledScript } from "./script-host";
import { ScriptRuntime } from "./script-runtime";
import type { PhysicsWorldSync } from "./physics-sync";
import { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import { RagdollWorldSync } from "./ragdoll-sync";
import { RuntimeConsole } from "./runtime-console";
import { actorChainWorldTransform, firstSpawnedActorIndex } from "./actor-world-transform";
import { ActorRealization, type ScriptedActorSpawn } from "./actor-realization";
import type { OverlaySafeAreaInsets } from "@babylonslate/core";
import type { ModelPayload, SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import { initNavigation, type NavObstacleKind, type NavPoint } from "@babylonslate/navigation";
import { RuntimeSubsystems } from "./runtime-subsystems";
import { RenderSlots } from "./render-slots";
import { TickPipeline } from "./tick-pipeline";
import { SnapshotPublisher } from "./snapshot-publisher";
import { RenderCommandEmitter } from "./render-command-emitter";
import { AudioParticleEmitter, createAudioHostBindings } from "./audio-particle-emitter";
import { createActorHostBindings, createAssetHostBindings } from "./runtime-host-actors";
import { createComponentHostBindings } from "./runtime-host-components";
import { createWorldInputProvider } from "./runtime-host-input";
import { createNavigationHostBindings } from "./runtime-host-navigation";
import { createOutputHostBindings } from "./runtime-host-output";
import { createPhysicsHostBindings } from "./runtime-host-physics";
import {
  actorFromIlluminationTarget,
  createIlluminationHostBindings,
  createMaterialHostBindings,
  createRenderTargetHostBindings,
  createScalabilityHostBindings,
} from "./runtime-host-render";
import { createTimingHostBindings } from "./runtime-host-timing";
import { indexSceneLibrary, registerSceneAssetClasses } from "./scene-library";
import { RuntimeNavigation } from "./runtime-navigation";
import { SceneStreams, createSceneStreamHostBindings } from "./scene-streams";
import { SceneLayers, createSceneLayerHostBindings } from "./scene-layers";
import { SceneRealizer } from "./scene-realizer";
import { OwnerAdmission } from "./owner-admission";
import { AnimGraphRuntime } from "./anim-graph-runtime";
import { BehaviourTreeRuntime } from "./behaviour-tree-runtime";
import { LatentDelays } from "./latent-delays";

export interface RuntimeDriverOptions {
  sessionGeneration?: number;
  sessionMode?: GameSessionMode;
  /** Catalog identity only; registering an available class never reads its source. */
  classAssetGuids?: Readonly<Record<string, string>>;
  consoleCommands?: ReadonlyArray<import("@babylonslate/core").ConsoleCommandMetadata & { classId: string; assetGuid: string }>;
  /** JSON data and shared Structures snapshotted at session startup. */
  dataAssets?: import("@babylonslate/core").DataAssetCatalogEntry[];
  renderSettings?: Partial<RenderProjectSettings>;
  /** Initial render cap for console readback; does not change the simulation step. */
  frameCap?: number;
  /** Serialized trace retention budget in bytes for this session. */
  traceByteBudget?: number;
  project?: { name: string; version: string };
  seed: number;
  dt?: number;
  maxActors?: number;
  onCommand?: (command: CommandMessage) => void;
  /** Project Settings input mappings; defaults when omitted. */
  inputAssets?: InputAssetDefinition[];
  inputMappings?: InputMappings;
  focusNavigation?: Partial<FocusNavigationSettings>;
  /** Demo actors exist so an empty project still shows motion in Preview. */
  seedDemoActors?: boolean;
  /** Scene physics world kind (defaults to 3d). */
  physicsWorld?: PhysicsWorldKind;
  gravity?: [number, number, number];
  /** Worker-resolvable URL for HavokPhysics.wasm (3d Play). */
  havokWasmUrl?: string;
  /** Skip wasm backends (tests / CI without wasm). */
  preferSoftwarePhysics?: boolean;
  /** Authored scene to instantiate on `realizePlayWorld` (no demo actors). */
  playScene?: SerializedScene;
  playSceneGuid?: string;
  /** Class id for the session GameInstance singleton. */
  gameInstanceClass?: string;
  /** Extra authored scenes `changescene` can instantiate by guid or name. */
  sceneLibrary?: Readonly<Record<string, SerializedScene>>;
  /** Cold source preparation; ownership lasts until the consuming instance retires. */
  acquireScene?: AcquireRuntimeScene;
  /** Baked navigation keyed by canonical scene guid, selected before Begin Play. */
  sceneNavmeshBytes?: Readonly<Record<string, Uint8Array>>;
  /** Display name or library key → canonical scene asset guid. */
  sceneGuidByKey?: Readonly<Record<string, string>>;
  /** Overlay documents the session compositor can instantiate by guid or name. */
  sceneLayerLibrary?: Readonly<Record<string, SerializedSceneLayer>>;
  /** When false, debug-tier console commands are stripped (non-debug export stand-in). */
  includeDebugCommands?: boolean;
  /** Editor Play / bundled debugger: abort scripts that exceed `loopCount`. */
  infiniteLoopDetection?: boolean;
  /** Iterations in one tick that count as infinite when detection is on. */
  loopCount?: number;
  /** Audio asset guids known to this Play session (BT PlaySound fail-on-missing). */
  audioAssetGuids?: readonly string[];
  materialParameterCatalog?: MaterialParameterCatalog;
  materialTextureAssetGuids?: readonly string[];
  renderTargets?: Readonly<Record<string, RenderTargetPayload>>;
  renderTargetTextures?: Readonly<Record<string, RenderTargetTexturePayload>>;
  /** Animation / Sprite Animation clip metadata for BT Play Animation. */
  animClipCatalog?: readonly AnimClipCatalogEntry[];
  /** AnimationGraph documents keyed by asset guid (worker `loadAnimGraphs`). */
  animGraphs?: Readonly<Record<string, AnimGraphDocument>>;
  /** BehaviourTree documents keyed by asset guid (worker `loadBehaviourTrees`). */
  behaviourTrees?: Readonly<Record<string, BehaviourTreeDocument>>;
  blackboards?: Readonly<Record<string, BlackboardDocument>>;
  tilemaps?: Readonly<Record<string, TilemapPayload>>;
  waters?: Readonly<Record<string, WaterDefinition>>;
  tilesets?: Readonly<Record<string, TilesetPayload>>;
  sprites?: Readonly<Record<string, SpritePayload>>;
  spriteAnimations?: Readonly<Record<string, SpriteAnimationPayload>>;
  models?: Readonly<Record<string, ModelPayload>>;
  complexMeshes?: Readonly<Record<string, CollisionTriangleMesh>>;
  pixelsPerUnit?: number;
  texturePixelSizes?: Readonly<Record<string, { width: number; height: number }>>;
  /**
   * Hold OnSceneFinishLoading until `notifySceneModelsReady`. Play overlay and
   * the exported player set this; in-process tests leave it false.
   */
  deferSceneModelsReady?: boolean;
  deferMaterialEdits?: boolean;
  simulationAssetGuids?: string[];
  /** Wait for the host Loading UI to paint before retiring or realizing a Scene. */
  deferSceneLoadingPaint?: boolean;
  /** Real Play/player yield actor work; immediate harnesses keep the default. */
  cooperativeSceneLoading?: boolean | CooperativeSceneLoadingOptions;
}

export interface RuntimeDriver {
  notifyAssetPreloadResult(result: { preloadId: string; success: boolean; error?: string; progress?: number }): void;
  setAssetLoadStates(states: readonly { guid: string; state: RuntimeAssetLoadState }[]): void;
  configureSaveGame(options: RuntimeSaveGameOptions): SaveGameService;
  getSaveGameService(): SaveGameService | undefined;
  registerSaveActor(actor: BObject, persistentId?: string): void;
  readonly inputBindings: InputBindingControls;
  start(): void;
  stop(): void;
  pause(reason?: SessionPauseReason): void;
  resume(reason?: SessionPauseReason): void;
  requestSessionBoundary(request: SessionBoundaryRequest): Promise<SessionBoundaryResult>;
  requestRuntimeInspector(request: RuntimeInspectorRequest): Promise<RuntimeInspectorResult>;
  cancelRuntimeInspector(request: { sessionGeneration: number; requestId: number }): void;
  requestDiagnosticOperation(request: DiagnosticOperationRequest): Promise<DiagnosticOperationResult>;
  quiesceSimulation(request: SimulationQuiesceRequest): Promise<SessionBoundaryResult>;
  captureSimulationState(request: SimulationCaptureRequest): Promise<SimulationSceneCaptureResult>;
  applyRuntimeMaterialEditResult(message: Extract<ControlMessage, { type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" }>): void;
  tick(): void;
  /** Fixed-step catch-up from wall/accumulated time; capped. */
  advance(elapsedSeconds: number): void;
  pushInput(events: readonly RawInputEvent[]): void;
  pushInputBuffer(buffer: ArrayBuffer): void;
  /** Most recent resolved input tick (empty before the first tick). */
  getResolvedInput(): ResolvedInputTick;
  copySnapshot(out: Float32Array): boolean;
  readonly snapshotCapacity: number;
  readonly snapshotGeneration: number;
  getWorld(): World;
  getLogRing(): LogRingBuffer;
  getDiagnostics(): SessionDiagnosticAggregator;
  /** Add a host/native console message to both live output and dumplog. */
  reportLog(message: string, severity?: LogSeverity, category?: string): void;
  registerAnchors(assetGuid: string, anchors: readonly AnchorEntry[]): void;
  reportError(
    error: unknown,
    frameId?: number,
    hint?: { btNodeId?: string; assetGuid?: string },
  ): RuntimeDiagnostic | null;
  /** Load compiled graph modules and register their source anchors. */
  loadScripts(scripts: readonly CompiledScript[]): Promise<void>;
  replaceScriptSources(scripts: readonly CompiledScript[]): Promise<void>;
  /** Spawn an actor whose lifecycle hooks run its class's compiled graphs. */
  spawnScriptedActor(options: {
    classId: string;
    variables?: Record<string, unknown>;
    implementedInterfaces?: string[];
    transform?: Transform;
  }): Actor | null;
  /**
   * Instantiate `playScene` (if any) with compiled script hooks.
   * Idempotent. Call after `loadScripts` so Begin Play binds on spawn.
   */
  realizePlayWorld(): void | Promise<void>;
  /** Start Game Instance during cooperative boot, with scene phases suspended. */
  beginPlayLoading(): boolean;
  finishPlayLoading(): void;
  /** Complete the matching deferred load after the host presents its ready frame. */
  notifySceneModelsReady(sceneAssetGuid: string, sceneLoadId: number): void;
  loadSceneStream(target: unknown, blocking?: boolean): Promise<void>;
  /** Resolve a cold Scene before replacing the current, still-valid Scene. */
  changeSceneAsync(sceneKey: string): Promise<void>;
  unloadSceneStream(target: unknown, blocking?: boolean): Promise<void>;
  getTargetSceneName(target: unknown): string;
  getSceneState(target: unknown): SceneStreamingState;
  getSceneLoadProgress(target: unknown): number;
  notifySceneStreamReady(actorGuid: string, streamLoadId: number): void;
  notifySceneStreamProgress(actorGuid: string, streamLoadId: number, progress: number): void;
  notifySceneStreamFailed(actorGuid: string, streamLoadId: number, message: string): void;
  notifySceneLoadingPainted(sceneAssetGuid: string, sceneLoadId: number): void;
  notifySceneLayerReady(layerId: string, layerLoadId: number): void;
  notifySceneLayerLoadingPainted(layerId: string, layerLoadId: number): void;
  /** Upgrade from software to Havok/Rapier when available. */
  loadPhysics(): Promise<void>;
  getPhysicsSync(): PhysicsWorldSync | null;
  getOverlayPhysicsSync(): PhysicsWorldSync | null;
  createSceneLayer(
    assetGuid: string,
    zOrder?: number,
    ownerSceneGuid?: string | null,
  ): SceneLayer | null;
  removeSceneLayer(layerGuid: string): void;
  clearSceneLayers(): void;
  registerSceneLayerPostProcess(layerGuid: string, materialGuid: string): void;
  unregisterSceneLayerPostProcess(
    layerGuid: string,
    materialGuid: string,
  ): void;
  applySceneLayerResize(
    frustumWidth: number,
    frustumHeight: number,
    canvasWidth?: number,
    canvasHeight?: number,
    safeAreaInsets?: Partial<OverlaySafeAreaInsets>,
  ): void;
  applySceneLayerPointer(
    message: Extract<ControlMessage, { type: "sceneLayerPointer" }>,
  ): void;
  applySceneLayerControl(message: Extract<ControlMessage, { type: "sceneLayerControl" }>): void;
  applySceneLayerFocusNavigate(reverse: boolean): void;
  applySceneLayerScroll(layerId: string, actorId: string, componentId: string, deltaX: number, deltaY: number): void;
  applyAudioVoiceEnded(
    message: Extract<ControlMessage, { type: "audioVoiceEnded" }>,
  ): void;
  applyRenderPathStatus(
    message: Extract<ControlMessage, { type: "renderPathStatus" }>,
  ): void;
  applyRagdollPoseCaptured(message: Extract<ControlMessage, { type: "ragdollPoseCaptured" }>): void;
  applyScalabilityStatus(acknowledgement: ScalabilityAcknowledgement): void;
  requestScalability(request: ScalabilityRequest): ScalabilityResult;
  getScalability(): ScalabilitySnapshot;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  executeConsoleCommandAsync(command: string): Promise<{ success: boolean; output: string }>;
  inspectWorld(): DebugInspectSnapshot;
  invokeScriptEvent(
    classId: string,
    event: string,
    self?: BObject | null,
    args?: Record<string, unknown>,
  ): void;
  registerUserCommand(def: UserCommandDef): void;
  bindUserCommand(
    def: Omit<UserCommandDef, "run"> & { classId: string },
  ): void;
  listConsoleCommands(): readonly RegisteredCommand[];
  stopTrace(): TracePayload | null;
  restoreBtFromTrace(states: readonly TraceBtState[]): void;
  registerAnimGraph(guid: string, document: AnimGraphDocument): void;
  registerBehaviourTree(guid: string, document: BehaviourTreeDocument): void;
  registerBlackboard(guid: string, document: BlackboardDocument): void;
  registerSceneContent(content: RuntimeSceneContent): void;
  registerWaterContent(content: ReadonlyMap<string, WaterDefinition> | Readonly<Record<string, WaterDefinition>>): void;
  registerTileContent(options: {
    tilemaps: Readonly<Record<string, TilemapPayload>> | ReadonlyMap<string, TilemapPayload>;
    tilesets: Readonly<Record<string, TilesetPayload>> | ReadonlyMap<string, TilesetPayload>;
    pixelsPerUnit?: number;
  }): void;
  registerSpriteContent(options: {
    sprites: Readonly<Record<string, SpritePayload>> | ReadonlyMap<string, SpritePayload>;
    spriteAnimations:
      | Readonly<Record<string, SpriteAnimationPayload>>
      | ReadonlyMap<string, SpriteAnimationPayload>;
    pixelsPerUnit?: number;
  }): void;
  registerModelContent(options: {
    models: Readonly<Record<string, ModelPayload>> | ReadonlyMap<string, ModelPayload>;
    complexMeshes?:
      | Readonly<Record<string, CollisionTriangleMesh>>
      | ReadonlyMap<string, CollisionTriangleMesh>;
  }): void;
  /** Install host answers to `requestComplexCollision`; they survive later `loadModels` replacements. */
  registerComplexCollisionMeshes(meshes: ReadonlyMap<string, CollisionTriangleMesh>, unavailable?: readonly string[]): void;
  /** Import a baked Scene navmesh chunk. Never generates. */
  loadNavMesh(bytes: Uint8Array): Promise<void>;
  setNavAgentTarget(actorGuid: string, target: NavPoint): boolean;
  findNavPath(from: NavPoint, to: NavPoint): NavPoint[];
  addNavObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint): string;
  removeNavObstacle(id: string): void;
  stopNavAgent(actorGuid: string): void;
  readonly lastScriptMs: number;
  readonly lastPhysicsMs: number;
}

export type { RuntimeSaveGameOptions } from "./session-boundaries";

export function createInProcessRuntime(
  options: RuntimeDriverOptions,
): RuntimeDriver {
  return new InProcessRuntime(options);
}

/** Tile animation time is sent only while a tilemap could show an animated tile. */
function hasAnimatedTiles(tilemaps: ReadonlyMap<string, TilemapPayload>, tilesets: ReadonlyMap<string, TilesetPayload>): boolean {
  return tilemaps.size > 0 && [...tilesets.values()].some(
    (tileset) => tileset.tiles.some((tile) => tile.animation.length > 0),
  );
}

class RuntimeContinuationCancelled extends Error {
  constructor() { super("Scene realization was cancelled."); this.name = "AbortError"; }
}

class InProcessRuntime implements RuntimeDriver {
  private readonly simulation: SimulationSession;
  private readonly sessionGeneration: number;
  private readonly sessionMode: GameSessionMode;
  private commandRevision = 0;
  private readonly diagnosticsEnabled: boolean;
  private readonly inspector: RuntimeInspectorService;
  private readonly pauseReasons = new Set<SessionPauseReason>();
  private readonly pendingPauseChanges = new Map<SessionPauseReason, boolean>();
  private readonly assetPreloads = new RuntimeAssetPreloads(command => this.emit(command));
  private readonly demandAssetCatalog: boolean;

  notifyAssetPreloadResult(result: { preloadId: string; success: boolean; error?: string; progress?: number }): void {
    this.assetPreloads.receive(result);
  }

  setAssetLoadStates(states: readonly { guid: string; state: RuntimeAssetLoadState }[]): void {
    this.assetPreloads.setStates(states);
  }
  private readonly world: World;
  private readonly snapshots: SnapshotPublisher;
  private readonly input = new InputRingBuffer(512);
  private readonly resolver: InputResolver;
  private readonly overlay: SceneLayerOverlay;
  private resolvedInput: ResolvedInputTick = {
    inputs: {},
    actions: {},
    axes: {},
    axes2D: {},
    gamepadConnections: [],
    pressedKeys: [],
    cursor: { x: 0, y: 0, pressed: false },
  };
  /** Mutable box so TickContext can read connections without aliasing `this`. */
  private readonly connectionBox: {
    current: ResolvedInputTick["gamepadConnections"];
  } = { current: [] };
  private readonly logs = new LogRingBuffer(512);
  private readonly diagnostics = new SessionDiagnosticAggregator();
  private readonly anchors = new Map<string, readonly AnchorEntry[]>();
  private readonly painters = new Painter2DRuntime();
  private readonly uiControls: UIControls2DRuntime;
  private readonly textAppear = new Text2DAppearRuntime();
  private readonly tweens = new TweenRuntime((owner) => !this.stopped && !this.paused && !this.streams.blocking &&
    (!owner || this.admission.canRunActions(owner)));
  private readonly onCommand?: (command: CommandMessage) => void;
  private readonly dt: number;
  private readonly physics: RuntimePhysicsWorlds;
  private paused = false;
  private readonly simulationWaiters = new Set<() => void>();
  private readonly scalability: ScalabilitySession;
  private lastRenderPathStatus: RenderPathStatus | null = null;
  private readonly scalabilityProjectRenderPath: RenderPath;
  private timeDilation = 1;
  private running = false;
  private frameId = 0;
  private readonly scriptHost: ScriptHost;
  private readonly scriptRuntime: ScriptRuntime;
  private readonly dataCatalog: RuntimeDataCatalog;
  private readonly sourceRenderTargets = new Map<string, RenderTargetPayload>();
  private readonly sourceRenderTargetTextures = new Map<string, RenderTargetTexturePayload>();
  private readonly ragdolls: RagdollWorldSync;
  private readonly cables: CableWorldSync;
  private readonly dynamicMeshes: DynamicRuntimeMeshSync;
  private readonly movement: MovementWorldSync;
  private playScene: SerializedScene | undefined;
  private playSceneGuid: string;
  private readonly sceneLibrary = new Map<string, SerializedScene>();
  private readonly acquireScene?: AcquireRuntimeScene;
  private readonly sceneGuidByKey = new Map<string, string>();
  private readonly sceneLayerLibrary = new Map<string, SerializedSceneLayer>();
  private readonly deferSceneModelsReady: boolean;
  private readonly deferSceneLoadingPaint: boolean;
  private readonly materialParameters: RuntimeMaterialParameters;
  private readonly validateLegacyMeshParameters: boolean;
  private readonly admission = new OwnerAdmission({
    world: () => this.world,
    stopped: () => this.stopped,
    paused: () => this.paused,
    saveBoundaryActive: () => this.boundaries.saveBoundaryActive,
    sceneLoading: () => this.sceneRealizer.blocked || this.bootLoading,
    streams: () => this.streams,
    layers: () => this.layers,
    releaseAssets: (ownerGuid) => this.assetPreloads.releaseOwner(ownerGuid),
    reportError: (error) => { this.reportError(error); },
  });
  private readonly cooperativeSceneLoading: CooperativeSceneLoadingOptions | null;
  private bootLoading = false;
  private stopped = false;
  private lifecycleId = 0;
  /** A script `Possess Camera` outranks the authored per-camera option. */
  private cameraPossessedByScript = false;
  private possessedCameraSlotId: number | null = null;
  private readonly console: RuntimeConsole;
  private readonly loopGuard: InfiniteLoopGuard;
  private readonly seed: number;
  private tilemapAnimationTimeMs = 0;
  private hasAnimatedTiles = false;
  private readonly texturePixelSizes: Readonly<Record<string, { width: number; height: number }>>;
  /**
   * Subsystems with lifecycle hooks. Registration order (end of the
   * constructor) is the order Stop and Scene replacement run their hooks.
   */
  private readonly subsystems = new RuntimeSubsystems();
  private readonly renderSlots = new RenderSlots(this.subsystems, {
    ensureCapacity: (required) => this.snapshots.ensureCapacity(required),
    findActor: (guid) => this.world.findActor(guid),
  });
  private readonly renderEmitter = new RenderCommandEmitter({
    world: () => this.world,
    isStreamActor: (actor) => this.streams.isStreamActor(actor),
    playScene: () => this.playScene,
    slot: (actor) => this.actorSlot(actor),
    cables: () => this.cables,
    dynamicMeshes: () => this.dynamicMeshes,
    uiControls: () => this.uiControls,
    painters: () => this.painters,
    textAppear: () => this.textAppear,
    materialParameters: () => this.materialParameters,
    emit: (command) => this.emit(command),
  });
  private readonly audioParticles = new AudioParticleEmitter(this.admission, {
    slot: (actor) => this.actorSlot(actor),
    frameId: () => this.frameId,
    emit: (command) => this.emit(command),
  });
  private readonly delays = new LatentDelays(this.admission);
  private readonly navigation = new RuntimeNavigation({
    world: () => this.world,
    worldKind: () => this.physics.kind,
    physics: () => this.physics.main,
    streamActorReady: (actor) => this.streams.actorReady(actor),
    isStreamActor: (actor) => this.streams.isStreamActor(actor),
    dt: () => this.simulationDt(),
    actorName: (actor) => this.debugActorName(actor),
    emit: (command) => this.emit(command),
  }, nowMs);
  private readonly streams: SceneStreams = new SceneStreams(this.admission, {
    world: () => this.world,
    stopped: () => this.stopped,
    physicsWorldKind: () => this.physics.kind,
    sceneDocument: (key) => this.sceneLibrary.get(key),
    sceneGuid: (key) => this.sceneGuidByKey.get(key) ?? key,
    acquireScene: () => this.acquireScene,
    cooperativeLoading: () => this.cooperativeSceneLoading ?? {},
    deferModelsReady: () => this.deferSceneModelsReady,
    scripts: () => this.scriptHost,
    createActor: (serialized) => createActorFromSerialized(this.world, serialized, this.actors.sceneActorHooks),
    realizeActor: (actor, checkpoint) => this.actors.realize(actor, checkpoint),
    breakParentCycles: (actors, detach) => this.actors.breakLoadedParentCycles(actors, detach),
    publishSnapshot: () => this.snapshots.publish(),
    slot: (actor) => this.actorSlot(actor),
    syncPhysics: () => this.physics.main.syncFromWorld(this.world),
    navigation: () => this.navigation,
    removeActor: (actor) => this.actors.remove(actor),
    cancelInvalidTweens: () => this.tweens.cancelInvalid(),
    releaseAssets: (ownerGuid) => this.assetPreloads.releaseOwner(ownerGuid),
    markUnsupportedInstance: (sceneGuid) => this.simulation.markUnsupportedInstance("stream", sceneGuid),
    blockSettled: () => {
      this.ticks.resetAccumulator();
      this.admission.flush();
      if (!this.streams.blocking) {
        const waiters = [...this.simulationWaiters];
        this.simulationWaiters.clear();
        for (const resume of waiters) resume();
      }
    },
    emit: (command) => this.emit(command),
  });
  private readonly sceneRealizer: SceneRealizer = new SceneRealizer(this.admission, {
    world: () => this.world,
    stopped: () => this.stopped,
    frameId: () => this.frameId,
    playScene: () => this.playScene,
    playSceneGuid: () => this.playSceneGuid,
    enterScene: (scene, guid) => {
      this.playScene = scene;
      this.scalability.setScene(scene.settings);
      this.playSceneGuid = guid;
      // The new scene owns its own camera choice.
      this.cameraPossessedByScript = false;
      this.possessedCameraSlotId = null;
    },
    sceneLibrary: () => this.sceneLibrary,
    sceneGuid: (key) => this.sceneGuidByKey.get(key) ?? key,
    acquireScene: () => this.acquireScene,
    cooperativeLoading: () => this.cooperativeSceneLoading,
    bootLoading: () => this.bootLoading,
    deferModelsReady: () => this.deferSceneModelsReady,
    deferLoadingPaint: () => this.deferSceneLoadingPaint,
    physics: () => this.physics,
    navigation: () => this.navigation,
    layers: () => this.layers,
    scripts: () => this.scriptHost,
    startWorld: () => {
      this.tilemapAnimationTimeMs = 0;
      if (this.hasAnimatedTiles) this.emit({ type: "tilemapAnimationTime", elapsedMs: 0 });
      this.loopGuard.reset();
      this.world.start();
    },
    setWorldGravity: (gravity) => this.setWorldGravity(gravity),
    recordSimulationStart: (start) => this.simulation.recordStart(start),
    markSceneTransition: () => this.simulation.markSceneTransition(),
    createActor: (serialized) => createActorFromSerialized(this.world, serialized, this.actors.sceneActorHooks),
    realizeActor: (actor, checkpoint) => this.actors.realize(actor, checkpoint),
    breakParentCycles: (actors) => this.actors.breakLoadedParentCycles(actors),
    possessViewTarget: () => this.attemptPossessViewTarget(),
    publishSnapshot: () => this.snapshots.publish(),
    removeActor: (actor) => this.actors.remove(actor),
    removeSceneLayer: (layerGuid) => this.removeSceneLayer(layerGuid),
    releaseAssets: (ownerGuid) => this.assetPreloads.releaseOwner(ownerGuid),
    resetForSceneLoad: () => this.subsystems.resetForSceneLoad(),
    duringSceneTeardown: (teardown) => this.scriptRuntime.duringSceneTeardown(teardown),
    retireStreams: () => this.streams.retireAll(),
    emitSceneDebug: () => {
      this.navigation.emitDebug(true);
      this.behaviourTrees.emitSnapshot(true);
    },
    reportError: (error) => { this.reportError(error); },
    emit: (command) => this.emit(command),
  });
  private readonly layers: SceneLayers;
  private readonly boundaries: SessionBoundaries = new SessionBoundaries(this.admission, {
    world: () => this.world,
    sessionGeneration: () => this.sessionGeneration,
    stopped: () => this.stopped,
    playScene: () => this.playScene,
    playSceneGuid: () => this.playSceneGuid,
    sceneLibrary: () => this.sceneLibrary,
    scripts: () => this.scriptHost,
    streams: () => this.streams,
    sceneRealizer: () => this.sceneRealizer,
    physics: () => this.physics,
    actorHooks: () => this.actors.sceneActorHooks,
    canSpawnActorClass: (classId) => this.scriptRuntime.canSpawnActorClass(classId),
    realizeActor: (actor) => this.actors.realize(actor),
    removeActor: (actor) => this.actors.remove(actor),
    publishSnapshot: () => this.snapshots.publish(),
    takeDeferredOverlayLayout: () => this.overlay.takeDeferredLayout(),
    pauseReasons: () => this.pauseReasons,
    setPauseReason: (reason, paused) => this.setPauseReason(reason, paused),
    resetInputState: () => this.resetInputState(),
    commandRevision: () => this.commandRevision,
    reportError: (error) => { this.reportError(error); },
  });
  private readonly animGraphs = new AnimGraphRuntime({
    actors: () => this.world.getActors(),
    stopped: () => this.stopped,
    canTick: (actor) => this.admission.canTickActor(actor),
    slot: (actor) => this.actorSlot(actor),
    hasRenderSlot: (actor) => this.renderSlots.recordedSlot(actor) !== undefined,
    playAnimationOwns: (slotId) => this.behaviourTrees.playAnimationOwns(slotId),
    dt: () => this.simulationDt(),
    scripts: () => this.scriptHost,
    setSpriteClip: (actor, clip) => this.setActorSpriteClip(actor, clip),
    emit: (command) => this.emit(command),
  });
  private readonly behaviourTrees = new BehaviourTreeRuntime({
    world: () => this.world,
    frameActors: () => this.navFrameActors ?? undefined,
    stopped: () => this.stopped,
    canTick: (actor) => this.admission.canTickActor(actor),
    slot: (actor) => this.actorSlot(actor),
    navigation: () => this.navigation,
    worldKind: () => this.physics.kind,
    seed: () => this.seed,
    dt: () => this.simulationDt(),
    frameId: () => this.frameId,
    tickIndex: () => this.world.clock.tickIndex,
    scripts: () => this.scriptHost,
    setSpriteClip: (actor, clip) => this.setActorSpriteClip(actor, clip),
    actorName: (actor) => this.debugActorName(actor),
    recordDiagnostic: (diagnostic) => this.diagnostics.push(diagnostic),
    emit: (command) => this.emit(command),
  }, nowMs);
  private readonly actors: ActorRealization = new ActorRealization(this.admission, {
    world: () => this.world,
    stopped: () => this.stopped,
    scripts: () => this.scriptHost,
    scriptRuntime: () => this.scriptRuntime,
    streams: () => this.streams,
    boundaries: () => this.boundaries,
    physicsKind: () => this.physics.kind,
    renderSlots: () => this.renderSlots,
    renderEmitter: () => this.renderEmitter,
    audioParticles: () => this.audioParticles,
    overlay: () => this.overlay,
    movement: () => this.movement,
    dynamicMeshes: () => this.dynamicMeshes,
    textAppear: () => this.textAppear,
    subsystems: () => this.subsystems,
    cancelInvalidTweens: () => this.tweens.cancelInvalid(),
    frameActors: () => this.navFrameActors,
    reportLog: (message, severity, category) => this.reportLog(message, severity, category),
    emit: (command) => this.emit(command),
  });
  /** Frame index (first-spawned actor per guid) the BT and crowd ticks share. */
  private navFrameActors: Map<string, Actor> | null = null;
  private readonly ticks: TickPipeline;

  get lastScriptMs(): number {
    return this.ticks.lastScriptMs;
  }

  get lastPhysicsMs(): number {
    return this.ticks.lastPhysicsMs;
  }
  get snapshotCapacity(): number { return this.snapshots.capacity; }
  get snapshotGeneration(): number { return this.snapshots.generation; }

  constructor(options: RuntimeDriverOptions) {
    this.simulation = new SimulationSession({
      baseline: options.sessionMode === "simulate" ? options.playScene ?? null : null,
      assetGuids: options.simulationAssetGuids ?? [...Object.keys(options.materialParameterCatalog ?? {}), ...(options.materialTextureAssetGuids ?? []), ...(options.audioAssetGuids ?? [])],
      dataAssets: options.sessionMode === "simulate" ? options.dataAssets : undefined,
    }, {
      world: () => this.world,
      sessionGeneration: () => this.sessionGeneration,
      sessionMode: () => this.sessionMode,
      stopped: () => this.stopped,
      playSceneGuid: () => this.playSceneGuid,
      bootLoading: () => this.bootLoading,
      commandRevision: () => this.commandRevision,
      boundaries: () => this.boundaries,
      sceneRealizer: () => this.sceneRealizer,
      streams: () => this.streams,
      layers: () => this.layers,
      materialEditGate: () => this.inspector.materialEditGate,
      materialParameters: () => this.materialParameters,
      physics: () => this.physics,
      scripts: () => this.scriptHost,
      setPauseReason: (reason, paused) => this.setPauseReason(reason, paused),
      resetInputState: () => this.resetInputState(),
      flushInspectorRequests: () => this.inspector.flushQueued(),
      flushDeferredSnapshot: () => this.snapshots.flushDeferred(),
      emit: (command) => this.emit(command),
    });
    this.sessionGeneration = options.sessionGeneration ?? 0;
    this.sessionMode = options.sessionMode ?? "play";
    const projectName = options.project?.name ?? "";
    const projectVersion = options.project?.version ?? "";
    this.demandAssetCatalog = options.classAssetGuids !== undefined;
    this.scriptRuntime = new ScriptRuntime(this.admission, {
      gameInstanceClass: options.gameInstanceClass ?? "GameInstance",
      classAssetGuids: options.classAssetGuids ?? {},
    }, {
      world: () => this.world,
      stopped: () => this.stopped,
      scriptHost: () => this.scriptHost,
      streams: () => this.streams,
      registerAnchors: (label, anchors) => this.registerAnchors(label, anchors),
      deleteAnchors: (label) => { this.anchors.delete(label); },
      bindUserCommand: (def) => this.bindUserCommand(def),
      reportLog: (message, severity, category) => this.reportLog(message, severity, category),
    });
    this.diagnosticsEnabled = options.includeDebugCommands ?? true;
    this.inspector = new RuntimeInspectorService({
      deferMaterialEdits: options.deferMaterialEdits === true,
      demandAssetCatalog: this.demandAssetCatalog,
    }, {
      world: () => this.world,
      sessionGeneration: () => this.sessionGeneration,
      sessionMode: () => this.sessionMode,
      stopped: () => this.stopped,
      frameId: () => this.frameId,
      advanceFrameId: () => ++this.frameId,
      commandRevision: () => this.commandRevision,
      playSceneGuid: () => this.playSceneGuid,
      simulation: () => this.simulation,
      materialParameters: () => this.materialParameters,
      renderSlots: () => this.renderSlots,
      renderEmitter: () => this.renderEmitter,
      streams: () => this.streams,
      layers: () => this.layers,
      sceneRealizer: () => this.sceneRealizer,
      physics: () => this.physics,
      ragdolls: () => this.ragdolls,
      assetPreloads: () => this.assetPreloads,
      refreshComponent: (component, propertyName) => this.refreshRuntimeComponent(component, propertyName),
      setMaterialParameter: (material, name, value) => this.setMaterialParameter(material, name, value, true),
      publishSnapshot: () => this.snapshots.publish(),
      emit: (command) => this.emit(command),
    });
    this.materialParameters = new RuntimeMaterialParameters(options.materialParameterCatalog, options.materialTextureAssetGuids);
    this.validateLegacyMeshParameters = options.materialParameterCatalog !== undefined;
    this.scalabilityProjectRenderPath = options.renderSettings?.renderPath ?? "forward";
    this.scalability = new ScalabilitySession(options.renderSettings, options.frameCap, options.playScene?.settings,
      (transaction) => this.emit({ type: "setScalability", transaction }));
    this.dt = options.dt ?? 1 / 60;
    this.seed = options.seed;
    this.onCommand = options.onCommand;
    const tilemaps = new Map(Object.entries(options.tilemaps ?? {}));
    const tilesets = new Map(Object.entries(options.tilesets ?? {}));
    this.physics = new RuntimePhysicsWorlds({
      world: () => this.world,
      stopped: () => this.stopped,
      lifecycleId: () => this.lifecycleId,
      mainActorReady: (actor) => this.streams.actorReady(actor),
      overlayActorReady: (actor) => this.admission.canTickActor(actor, true),
      hasSceneLayerDocuments: () => this.sceneLayerLibrary.size > 0,
      canTickActor: (actor) => this.admission.canTickActor(actor),
      scripts: () => this.scriptHost,
      frameId: () => this.frameId,
      recordDiagnostic: (diagnostic) => this.diagnostics.push(diagnostic),
      emit: (command) => this.emit(command),
    }, {
      kind: options.physicsWorld ?? options.playScene?.settings.physicsWorld ?? "3d",
      gravity: options.gravity ?? [0, -9.81, 0],
      havokWasmUrl: options.havokWasmUrl,
      preferSoftware: options.preferSoftwarePhysics ?? false,
      pixelsPerUnit: options.pixelsPerUnit,
      tilemaps,
      tilesets,
    });
    this.playScene = options.playScene;
    this.acquireScene = options.acquireScene;
    this.playSceneGuid = options.playSceneGuid ?? "play-scene";
    this.navigation.replaceSceneNavMeshes(options.sceneNavmeshBytes ?? {});
    this.deferSceneModelsReady = options.deferSceneModelsReady === true;
    this.deferSceneLoadingPaint = options.deferSceneLoadingPaint === true;
    this.cooperativeSceneLoading = options.cooperativeSceneLoading
      ? (options.cooperativeSceneLoading === true ? {} : options.cooperativeSceneLoading)
      : null;
    indexSceneLibrary({
      sceneLibrary: options.sceneLibrary,
      sceneGuidByKey: options.sceneGuidByKey,
      sceneLayerLibrary: options.sceneLayerLibrary,
      playScene: options.playScene,
      playSceneGuid: this.playSceneGuid,
      acquired: Boolean(this.acquireScene),
    }, { scenes: this.sceneLibrary, sceneGuids: this.sceneGuidByKey, sceneLayers: this.sceneLayerLibrary });
    this.console = new RuntimeConsole({
      includeDebug: options.includeDebugCommands ?? true,
      demandAssetCatalog: this.demandAssetCatalog,
    }, {
      world: () => this.world,
      stopped: () => this.stopped,
      sessionMode: () => this.sessionMode,
      classAssetGuid: (classId) => this.scriptRuntime.classAssetGuid(classId),
      scriptHost: () => this.scriptHost,
      assetPreloads: () => this.assetPreloads,
      sceneRealizer: () => this.sceneRealizer,
      scalability: () => this.scalability,
      requestScalability: (request) => { this.requestScalability(request); },
      projectRenderPath: () => this.scalabilityProjectRenderPath,
      renderPathStatus: () => this.lastRenderPathStatus,
      physics: () => this.physics,
      navigation: () => this.navigation,
      behaviourTrees: () => this.behaviourTrees,
      audioParticles: () => this.audioParticles,
      ticks: () => this.ticks,
      snapshots: () => this.snapshots,
      logs: () => this.logs,
      inspectWorld: () => this.inspectWorld(),
      actorSlot: (actor) => this.actorSlot(actor),
      possessCamera: (actor) => this.possessCamera(actor),
      stop: () => this.stop(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      tick: () => this.tick(),
      paused: () => this.paused,
      userPaused: () => this.pauseReasons.has("user"),
      timeDilation: () => this.timeDilation,
      setTimeDilation: (rate) => { this.timeDilation = rate; },
      emit: (command) => this.emit(command),
    });
    for (const command of options.consoleCommands ?? []) {
      this.scriptRuntime.setClassAssetGuid(command.classId, command.assetGuid);
      this.bindUserCommand({ ...command, name: command.name || command.classId.toLowerCase() });
    }
    this.loopGuard = createInfiniteLoopGuard({
      enabled:
        (options.includeDebugCommands ?? true) &&
        options.infiniteLoopDetection !== false,
      loopCount: options.loopCount ?? DEFAULT_INFINITE_LOOP_COUNT,
    });
    if (options.animGraphs) {
      for (const [guid, document] of Object.entries(options.animGraphs)) {
        this.animGraphs.register(guid, document);
      }
    }
    if (options.behaviourTrees) {
      for (const [guid, document] of Object.entries(options.behaviourTrees)) {
        this.behaviourTrees.register(guid, document);
      }
    }
    if (options.blackboards) {
      for (const [guid, document] of Object.entries(options.blackboards)) {
        this.behaviourTrees.registerBlackboard(guid, document);
      }
    }
    this.texturePixelSizes = options.texturePixelSizes ?? {};
    this.hasAnimatedTiles = hasAnimatedTiles(tilemaps, tilesets);
    this.behaviourTrees.replaceAudioAssets((options.audioAssetGuids ?? []).filter((guid) => guid));
    this.behaviourTrees.replaceAnimClipCatalog((options.animClipCatalog ?? []).filter((entry) => entry.guid));

    const registry = new ClassRegistry();
    registry.register({
      id: "Enemy",
      parentClassId: "Actor",
      kind: "actor",
      variables: [{ name: "speed", type: "float", defaultValue: 1 }],
      implementedInterfaces: [],
    });

    const mappings = normalizeInputMappings(
      options.inputAssets !== undefined ? inputMappingsFromAssets(options.inputAssets) : options.inputMappings ?? createDefaultInputMappings(),
    );
    this.resolver = new InputResolver(mappings);

    if (options.tilemaps || options.tilesets) this.physics.bindAll();
    if (options.sprites || options.spriteAnimations) {
      this.registerSpriteContent({
        sprites: options.sprites ?? {},
        spriteAnimations: options.spriteAnimations ?? {},
        pixelsPerUnit: options.pixelsPerUnit,
      });
    }
    if (options.waters) this.registerWaterContent(options.waters);
    if (options.models) {
      this.registerModelContent({
        models: options.models,
        complexMeshes: options.complexMeshes,
      });
    }

    let guidSeq = 0;
    this.world = new World({
      seed: options.seed,
      dt: this.dt,
      classRegistry: registry,
      guidFactory: () => `rt-${++guidSeq}`,
      onPhase: (phase) => this.ticks.markPhase(phase),
      canTickScene: () => !this.stopped && !this.streams.blocking,
      canTickActor: (actor) => this.admission.canTickActor(actor),
      componentHooksFor: (classId) => this.actors.componentHooks(classId),
      sceneSubsystemHooksFor: (classId) => this.scriptRuntime.sceneSubsystemHooks(classId),
      // Strict gate: Tick only after On Init, while the main Scene may run.
      canTickSceneSubsystem: (subsystem) =>
        this.admission.isCreated(subsystem) && this.admission.canRunSceneSubsystem(subsystem),
      onPhysics: (ctx) => {
        this.dynamicMeshes.flush();
        this.ragdolls.sync();
        if (this.admission.canTickScene()) this.physics.stepMain(ctx.dt, ctx.tickIndex, (sync) => this.movement.step(ctx.dt, sync));
        if (this.admission.hasReadyLayers()) this.physics.stepOverlay(ctx.dt, (sync) => this.movement.step(ctx.dt, sync));
        this.ragdolls.afterStep();
        if (this.admission.canTickScene()) this.cables.step(ctx.dt, this.physics.gravity, this.frameId + 1);
        this.physics.dispatchCollisionEvents();
      },
    });
    this.snapshots = new SnapshotPublisher(options.maxActors ?? 256, this.world, this.renderSlots, {
      stopped: () => this.stopped,
      frameId: () => this.frameId,
      lastScriptMs: () => this.ticks.lastScriptMs,
      lastPhysicsMs: () => this.ticks.lastPhysicsMs,
      canPublish: () => this.admission.canTickScene() || this.admission.hasReadyLayers(),
      cameraActor: () => this.playCameraActor(),
      applyOverlayLayouts: () => this.overlay.applyLayouts(),
      retireDetachedStreams: () => this.streams.retireDetached(),
      removedActors: () => this.behaviourTrees.emitSnapshot(true),
      recorder: () => this.ticks.recorder,
      profilePublish: (milliseconds) => this.ticks.profilePublish(milliseconds),
      reportLog: (message, severity, category) => this.reportLog(message, severity, category),
      reportError: (error) => { this.reportError(error); },
      emit: (command) => this.emit(command),
    }, nowMs);
    this.ticks = new TickPipeline(this.world, this.snapshots, this.logs, {
      canTick: () => this.running && !this.paused && !this.boundaries.saveBoundaryActive && !this.streams.blocking,
      canAdvance: () => this.running && !this.paused && !this.streams.blocking,
      paused: () => this.paused,
      stopped: () => this.stopped,
      runTick: () => this.runTick(),
      settlePauseChanges: () => this.settlePauseChanges(),
      frameId: () => this.frameId,
      liveActors: () => this.renderSlots.guidCount,
      btTraceStates: () => this.behaviourTrees.traceStates(),
      reportLog: (message, severity, category) => this.reportLog(message, severity, category),
      emit: (command) => this.emit(command),
    }, {
      dt: this.dt,
      seed: this.seed,
      generation: this.sessionGeneration,
      mode: this.sessionMode,
      diagnosticsEnabled: this.diagnosticsEnabled,
      traceByteBudget: options.traceByteBudget,
    }, nowMs);
    this.dynamicMeshes = new DynamicRuntimeMeshSync({
      eligible: (actor) => !actor.sceneLayerId && this.admission.canRun(actor),
      slot: (actor) => this.actorSlot(actor),
      emit: (command) => this.emit(command),
    });
    this.movement = new MovementWorldSync({
      world: this.world,
      physics: (actor) => this.physics.forActor(actor),
      eligible: (actor) => this.admission.canTickActor(actor),
      gravity: (actor) => -this.physics.gravityFor(actor)[1],
      warn: (component) => this.emit({ type: "log", severity: "warning", category: "Movement",
        message: `Movement on ${component.owner?.guid ?? "actor"} could not create its motor. Use one Movement component without Rigid Body, Nav Agent, Ragdoll or Water Buoyancy components.`, frameId: this.frameId }),
      event: (component, event, args) => {
        const actor = component.owner;
        if (actor) this.admission.guard(() => this.scriptHost.invokeEvent(actor.classId, event, actor, args, component.guid));
      },
    });
    this.cables = new CableWorldSync({
      world: this.world,
      physics: () => this.physics.main.getBackend(),
      eligible: (actor) => this.admission.canTickActor(actor),
      slot: (actor) => this.actorSlot(actor),
      emit: (command) => this.emit(command),
    });
    this.ragdolls = new RagdollWorldSync({
      world: this.world,
      physics: () => this.physics.main,
      slot: (actor) => this.actorSlot(actor),
      eligible: (actor) => this.admission.canTickActor(actor),
      deferNative: !this.physics.preferSoftware,
      emit: (command) => this.emit(command),
      error: (error) => { this.reportError(error); },
    });
    this.uiControls = new UIControls2DRuntime({
      actors: () => this.world.getActors(),
      canRun: (actor) => !this.stopped && this.admission.canTickActor(actor),
      update: (component, properties) => {
        const slotId = component.owner ? this.actorSlot(component.owner) : undefined;
        if (slotId !== undefined) this.emit({ type: "setUIControl2D", slotId, componentId: component.guid,
          uiControl: { classId: component.classId, properties } });
      },
      event: (component, event, args) => {
        const actor = component.owner;
        if (actor && !actor.destroyed && !component.destroyed && this.admission.canTickActor(actor)) {
          this.scriptHost.invokeEvent(actor.classId, event, actor, args, component.guid);
        }
      },
    });
    this.overlay = new SceneLayerOverlay({
      world: this.world,
      focusNavigation: options.focusNavigation,
      admission: this.admission,
      uiControls: this.uiControls,
      render: this.renderEmitter,
      audioParticles: this.audioParticles,
      texturePixelSizes: this.texturePixelSizes,
    }, {
      stopped: () => this.stopped,
      saveBoundaryActive: () => this.boundaries.saveBoundaryActive,
      removing: (actor) => this.actors.removing(actor),
      pixelsPerUnit: () => this.physics.pixelsPerUnit,
      scripts: () => this.scriptHost,
      slot: (actor) => this.actorSlot(actor),
      guidSlot: (guid) => this.guidSlot(guid),
      actorHooks: (classId) => this.actors.sceneActorHooks(classId),
      prepareActor: (actor) => {
        this.scriptHost.bindInterfaceHandlers(actor);
        this.actors.applyDefaults(actor);
        this.actors.assignSlot(actor);
      },
      breakParentCycles: (actors) => this.actors.breakLoadedParentCycles(actors),
      realizeActor: (actor) => this.actors.realize(actor),
      removeActor: (actor) => this.actors.remove(actor),
      publishSnapshot: () => this.snapshots.publish(),
      syncOverlayPhysics: () => this.physics.overlay.syncFromWorld(this.world),
      emit: (command) => this.emit(command),
    });
    this.layers = new SceneLayers(this.admission, this.overlay, {
      world: () => this.world,
      stopped: () => this.stopped,
      frameId: () => this.frameId,
      bootLoading: () => this.bootLoading,
      cooperativeLoading: () => this.cooperativeSceneLoading,
      deferModelsReady: () => this.deferSceneModelsReady,
      deferLoadingPaint: () => this.deferSceneLoadingPaint,
      document: (assetGuid) => this.sceneLayerLibrary.get(assetGuid),
      demandAssets: () => this.demandAssetCatalog,
      assetPreloads: () => this.assetPreloads,
      continueSimulation: (owner) => this.continueSimulation(owner),
      setOverlayGravity: (gravity) => this.physics.setOverlayGravity(gravity),
      markUnsupportedInstance: (layerGuid) => this.simulation.markUnsupportedInstance("layer", layerGuid),
      guidTaken: (id) => this.renderSlots.hasGuid(id) || this.world.findActor(id) != null,
      createActor: (serialized, layerGuid) => createActorFromSerialized(this.world, serialized, this.actors.sceneActorHooks, layerGuid),
      publishSnapshot: () => this.snapshots.publish(),
      syncOverlayPhysics: () => this.physics.overlay.syncFromWorld(this.world),
      tryCompleteSceneLoad: () => this.sceneRealizer.tryCompleteSceneLoad(),
      removeActor: (actor) => this.actors.remove(actor),
      cancelInvalidTweens: () => this.tweens.cancelInvalid(),
      reportError: (error) => { this.reportError(error); },
      emit: (command) => this.emit(command),
    });
    this.world.setInputProvider(createWorldInputProvider({
      resolved: () => this.resolvedInput,
      connections: this.connectionBox,
      frameId: () => this.frameId,
      emit: (command) => this.emit(command),
    }));

    this.dataCatalog = new RuntimeDataCatalog(options.dataAssets);
    for (const [guid, value] of Object.entries(options.renderTargets ?? {})) this.sourceRenderTargets.set(guid, value);
    for (const [guid, value] of Object.entries(options.renderTargetTextures ?? {})) this.sourceRenderTargetTextures.set(guid, value);
    const emit = (command: CommandMessage): void => this.emit(command);
    const frameId = (): number => this.frameId;
    const slot = (actor: Actor): number | undefined => this.actorSlot(actor);
    const canRun = (owner: BObject): boolean => this.admission.canRun(owner);
    const continueSimulation = (owner: BObject | null): Promise<void> | undefined => this.continueSimulation(owner);
    this.scriptHost = new ScriptHost({
      data: this.dataCatalog,
      seed: options.seed,
      canRunOwner: (owner) => this.admission.canRun(owner),
      inputBindings: this.resolver.bindings,
      getInputState: (input) => this.resolver.getInputState(input),
      interfaceRegistry: this.world.interfaceRegistry,
      classRegistry: registry,
      checkInfiniteLoop: () => this.loopGuard.check(),
      ...createOutputHostBindings({
        frameId,
        tickIndex: () => this.world.clock.tickIndex,
        anchors: this.anchors,
        recordDiagnostic: (diagnostic) => this.diagnostics.push(diagnostic),
        recordPrint: (print) => this.ticks.recordPrint(print),
        emit,
      }),
      ...createActorHostBindings({
        world: () => this.world,
        stopped: () => this.stopped,
        scripts: () => this.scriptHost,
        audioParticles: this.audioParticles,
        tweens: this.tweens,
        classAssetGuids: this.scriptRuntime.classAssetGuids,
        demandAssetCatalog: this.demandAssetCatalog,
        assetPreloads: this.assetPreloads,
        spawn: (spawn) => this.spawnScriptedActor(spawn),
        continueSimulation,
        slot,
        emit,
      }),
      ...createAssetHostBindings({
        world: () => this.world,
        demandAssetCatalog: this.demandAssetCatalog,
        assetPreloads: this.assetPreloads,
        continueSimulation,
      }),
      ...createTimingHostBindings({
        tweens: this.tweens,
        delays: this.delays,
        stopped: () => this.stopped,
        continueSimulation,
      }),
      ...createPhysicsHostBindings({
        world: () => this.world,
        physics: () => this.physics.main,
        overlayPhysics: () => this.physics.overlay,
        ragdolls: this.ragdolls,
        dt: this.dt,
        projectCursorToScene: (channel, options) => this.projectCursorToScene(channel, options),
      }),
      ...createScalabilityHostBindings({
        getScalability: () => this.getScalability(),
        requestScalability: (request) => this.requestScalability(request),
      }),
      ...createMaterialHostBindings({
        canRun,
        materialParameters: this.materialParameters,
        setMaterialParameter: (material, name, parameter) => this.setMaterialParameter(material, name, parameter),
      }),
      ...createIlluminationHostBindings({
        slot,
        emitMeshAssignment: (actor, slotId) => this.renderEmitter.emitMeshAssignment(actor, slotId),
        possessCamera: (target) => this.possessCamera(target),
      }),
      ...createRenderTargetHostBindings({
        renderTargets: this.sourceRenderTargets,
        renderTargetTextures: this.sourceRenderTargetTextures,
        canRun,
        emit,
      }),
      ...createComponentHostBindings({
        painters: this.painters,
        uiControls: this.uiControls,
        dynamicMeshes: this.dynamicMeshes,
        movement: this.movement,
        textAppear: this.textAppear,
        processingTick: () => this.ticks.processing,
        flushPainters: () => this.flushPainters(),
        flushTextAppear: () => this.flushTextAppear(),
        refreshComponent: (component, propertyName) => this.refreshRuntimeComponent(component, propertyName),
      }),
      ...createAudioHostBindings({ frameId, emit }),
      ...createNavigationHostBindings({ navigation: () => this.navigation }),
      ...createSceneStreamHostBindings({ streams: this.streams, world: () => this.world }),
      animGraphControl: (target) => this.animGraphs.control(target),
      registerSaveActor: (actor, persistentId) => this.registerSaveActor(actor, persistentId),
      getSaveActorId: (actor) => this.boundaries.saveActorId(actor),
      resolveSaveActor: (id) => this.boundaries.findSaveActor(id) ?? this.world.findActor(id),
      getSubsystem: (classId) => this.scriptRuntime.findSubsystem(classId),
      getGameInstance: () => this.world.gameInstance,
      getSceneLoadingProgress: () => {
        const value = this.sceneRealizer.loadingProgress;
        if (!Number.isFinite(value)) return 0;
        return Math.min(1, Math.max(0, value));
      },
      preloadAssets: (assets, owner, options) => this.preloadForGameplay(assets, owner, options),
      waitForSimulation: (owner) => this.continueSimulation(owner) ?? Promise.resolve(),
      getProjectName: () => projectName,
      getProjectVersion: () => projectVersion,
      setWorldGravity: (gravity) => {
        this.setWorldGravity(gravity);
      },
      executeConsoleCommand: (command) => this.console.execute(command),
      executeConsoleCommandAsync: (command) => this.console.executeAsync(command),
      reportError: (error) => {
        this.reportError(error);
      },
      changeScene: (scene) => {
        this.sceneRealizer.change(scene);
      },
      ...createSceneLayerHostBindings({ layers: this.layers }),
      ...createSceneLayerOverlayHostBindings({ overlay: this.overlay }),
    });

    // Stop order: Delays resume in phase 1, then every scene stream retires;
    // physics-owning syncs release before the physics worlds, then the crowd
    // and the remaining debug overlays. Actor removal first retires a stream
    // the actor owns, then ragdolls, cables, dynamic meshes and animation
    // graphs; a released slot then drops its ragdoll/cable/mesh and BT state,
    // its owner's text reveal, its sent component-command state and, last,
    // a camera possession that targeted it. Scene Layers register next to
    // last: phase 1 cancels independent layer creation and removes its layers,
    // then the Scene realizer cancels the main Scene's realization and cleans
    // up what it acquired.
    this.subsystems.register(this.delays);
    this.subsystems.register(this.streams);
    this.subsystems.register(this.ragdolls);
    this.subsystems.register(this.cables);
    this.subsystems.register(this.dynamicMeshes);
    this.subsystems.register(this.movement);
    this.subsystems.register(this.physics);
    this.subsystems.register(this.navigation);
    this.subsystems.register(this.animGraphs);
    this.subsystems.register(this.behaviourTrees);
    this.subsystems.register(this.textAppear);
    this.subsystems.register(this.renderEmitter);
    this.subsystems.register({
      releaseSlot: (slotId) => {
        if (this.possessedCameraSlotId !== slotId) return;
        this.possessedCameraSlotId = null;
        this.cameraPossessedByScript = false;
      },
    });
    this.subsystems.register(this.layers);
    this.subsystems.register(this.sceneRealizer);

    registerSceneAssetClasses(this.world.classRegistry, this.playSceneGuid, this.sceneGuidByKey.values());
    this.scriptRuntime.bindGameInstance();

    if (options.seedDemoActors !== false && !options.playScene) {
      this.actors.seedDemoActors();
    }
  }

  getTargetSceneName(target: unknown): string {
    return this.streams.targetSceneName(target);
  }

  getSceneState(target: unknown): SceneStreamingState {
    return this.streams.state(target);
  }

  getSceneLoadProgress(target: unknown): number {
    return this.streams.progress(target);
  }

  private simulationBlocked(owner: BObject | null): boolean {
    return (this.streams.blocking || this.paused || this.boundaries.pausePending ||
      [...this.pendingPauseChanges.values()].some(Boolean)) && !this.stopped && !owner?.destroyed;
  }

  private async waitForSimulation(owner: BObject | null): Promise<void> {
    while (this.simulationBlocked(owner))
      await new Promise<void>((resolve) => this.simulationWaiters.add(resolve));
    this.assertContinuable(owner);
  }

  /** Like waitForSimulation, but an unblocked continuation resumes without extra microtask hops. */
  private continueSimulation(owner: BObject | null): Promise<void> | undefined {
    if (this.simulationBlocked(owner)) return this.waitForSimulation(owner);
    this.assertContinuable(owner);
    return undefined;
  }

  private assertContinuable(owner: BObject | null): void {
    if (this.stopped || owner?.destroyed || !this.streams.ownerReady(owner))
      throw new RuntimeContinuationCancelled();
  }

  private async preloadForGameplay(assets: readonly string[], owner: BObject | null, options: RuntimeAssetPreloadOptions = {}): Promise<RuntimeAssetPreloadResult> {
    const callbackOwner = owner ?? this.world.gameInstance;
    let queued = false, active = true, latest = 0;
    const onProgress = options.onProgress ? (value: number) => {
      latest = value;
      if (queued || !active) return;
      queued = true;
      // Only the latest progress value waits during Pause; no callback flood or
      // gameplay continuation is delivered by an I/O completion while frozen.
      const deliver = () => {
        queued = false;
        if (active) this.admission.guard(() => options.onProgress!(latest));
      };
      if (callbackOwner) this.admission.run(callbackOwner, deliver);
      else deliver();
    } : undefined;
    let result: RuntimeAssetPreloadResult | undefined;
    try {
      result = await this.assetPreloads.acquire(assets, owner?.guid ?? this.world.currentScene?.guid ?? "session", { ...options, onProgress });
      { const pending = this.continueSimulation(owner); if (pending) await pending; }
      return result;
    } catch (error) {
      if (result?.preloadId) this.assetPreloads.release(result.preloadId);
      throw error;
    } finally { active = false; }
  }

  loadSceneStream(target: unknown, blocking = false): Promise<void> {
    return this.streams.load(target, blocking);
  }

  notifySceneStreamProgress(actorGuid: string, streamLoadId: number, progress: number): void {
    this.streams.notifyProgress(actorGuid, streamLoadId, progress);
  }

  notifySceneStreamReady(actorGuid: string, streamLoadId: number): void {
    this.streams.notifyReady(actorGuid, streamLoadId);
  }

  notifySceneStreamFailed(actorGuid: string, streamLoadId: number, message: string): void {
    this.streams.notifyFailed(actorGuid, streamLoadId, message);
  }

  unloadSceneStream(target: unknown, blocking = false): Promise<void> {
    return this.streams.unload(target, blocking);
  }

  loadPhysics(): Promise<void> {
    return this.physics.load();
  }

  getPhysicsSync(): PhysicsWorldSync | null {
    return this.physics.main;
  }

  getOverlayPhysicsSync(): PhysicsWorldSync | null {
    return this.physics.overlay;
  }

  applyRagdollPoseCaptured(message: Extract<ControlMessage, { type: "ragdollPoseCaptured" }>): void {
    if (this.stopped) return;
    this.ragdolls.accept(message);
    this.physics.main.syncFromWorld(this.world);
  }

  private setWorldGravity(gravity: { x: number; y: number; z: number }): void {
    const next = this.physics.setGravity(gravity);
    if (this.playScene) {
      // Prepared authoring content is also the immutable Simulation baseline.
      this.playScene = { ...this.playScene, settings: { ...this.playScene.settings, gravity: next } };
    }
    const scene = this.world.currentScene;
    if (scene && !scene.destroyed) {
      scene.setVariable("gravity", { x: next[0], y: next[1], z: next[2] });
    }
  }

  createSceneLayer(
    assetGuid: string,
    zOrder = 0,
    ownerSceneGuid: string | null = null,
  ): SceneLayer | null {
    return this.layers.create(assetGuid, zOrder, ownerSceneGuid);
  }

  notifySceneLayerLoadingPainted(layerId: string, layerLoadId: number): void {
    this.layers.notifyLoadingPainted(layerId, layerLoadId);
  }

  applySceneLayerScroll(layerId: string, actorId: string, componentId: string, deltaX: number, deltaY: number): void {
    this.overlay.applyScroll(layerId, actorId, componentId, deltaX, deltaY);
  }

  removeSceneLayer(layerGuid: string): void {
    this.layers.remove(layerGuid);
  }

  clearSceneLayers(): void {
    this.layers.clearAll();
  }

  registerSceneLayerPostProcess(layerGuid: string, materialGuid: string): void {
    this.layers.registerPostProcess(layerGuid, materialGuid);
  }

  unregisterSceneLayerPostProcess(
    layerGuid: string,
    materialGuid: string,
  ): void {
    this.layers.unregisterPostProcess(layerGuid, materialGuid);
  }

  applySceneLayerResize(
    frustumWidth: number,
    frustumHeight: number,
    canvasWidth?: number,
    canvasHeight?: number,
    safeAreaInsets?: Partial<OverlaySafeAreaInsets>,
  ): void {
    this.overlay.resize(frustumWidth, frustumHeight, canvasWidth, canvasHeight, safeAreaInsets);
  }

  applySceneLayerFocusNavigate(reverse: boolean): void {
    this.overlay.focusNavigate(reverse);
  }

  applySceneLayerControl(message: Extract<ControlMessage, { type: "sceneLayerControl" }>): void {
    this.overlay.control(message);
  }

  applySceneLayerPointer(
    message: Extract<ControlMessage, { type: "sceneLayerPointer" }>,
  ): void {
    this.overlay.pointer(message);
  }

  applyAudioVoiceEnded(
    message: Extract<ControlMessage, { type: "audioVoiceEnded" }>,
  ): void {
    const voiceId = String(message.voiceId ?? "").trim();
    if (!voiceId) return;
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
      const component = actor.components.find(
        (entry) =>
          !entry.destroyed &&
          entry.classId === "AudioComponent" &&
          (entry.guid === voiceId || entry.sourceId === voiceId),
      );
      if (!component) continue;
      this.admission.run(component, () => this.scriptHost.invokeEvent(
        actor.classId,
        "onAudioFinished",
        actor,
        {},
        component.guid,
      ));
      return;
    }
  }

  applyRenderPathStatus(
    message: Extract<ControlMessage, { type: "renderPathStatus" }>,
  ): void {
    this.lastRenderPathStatus = {
      requested: message.requested,
      effective: message.effective,
      gpuBackend: message.gpuBackend,
      limits: [...message.limits],
    };
  }

  requestScalability(request: ScalabilityRequest): ScalabilityResult {
    return this.scalability.request(request);
  }

  getScalability(): ScalabilitySnapshot { return this.scalability.snapshot(); }

  applyScalabilityStatus(acknowledgement: ScalabilityAcknowledgement): void {
    if (!this.scalability.acknowledge(acknowledgement)) return;
    const snapshot = this.scalability.snapshot();
    // GameSubsystems share the Game Instance's native events, Scalability Changed included.
    const owners = [this.world.gameInstance, ...this.world.getGameSubsystems(), this.world.currentScene, ...this.world.getSceneLayers(), ...this.world.getActors().flatMap((actor) => [actor, ...actor.components])];
    for (const owner of owners) if (owner && !owner.destroyed) {
      this.admission.run(owner, () => this.scriptHost.invokeEvent(owner.classId, "onScalabilityChanged", owner, { settings: snapshot }));
    }
  }

  private flushPainters(): void {
    this.painters.flush((component, painter) => {
      const slotId = component.owner ? this.actorSlot(component.owner) : undefined;
      if (slotId !== undefined) this.emit({ type: "setPainter2D", slotId, componentId: component.guid, painter });
    });
  }

  private flushTextAppear(): void {
    this.textAppear.flush((component, progress) => {
      const slotId = component.owner ? this.actorSlot(component.owner) : undefined;
      if (slotId !== undefined) this.emit({ type: "setText2DAppear", slotId, componentId: component.guid, progress });
    });
  }

  async loadScripts(scripts: readonly CompiledScript[]): Promise<void> {
    return this.scriptRuntime.updateSources(scripts, false);
  }

  replaceScriptSources(scripts: readonly CompiledScript[]): Promise<void> {
    return this.scriptRuntime.updateSources(scripts, true);
  }

  spawnScriptedActor(options: ScriptedActorSpawn): Actor | null {
    return this.actors.spawnScripted(options);
  }

  private refreshRuntimeComponent(component: ActorComponent, propertyName?: string): void {
    const owner = component.owner;
    if (!owner || owner.destroyed) return;
    if (isUIControl2DClass(component.classId)) {
      this.uiControls.refresh(component);
      if (owner.sceneLayerId) this.overlay.applyLayouts();
      return;
    }
    if ((propertyName === "opacity" || propertyName === "tint") && supportsOverlayVisualStyle(component.classId)) {
      const slotId = this.renderSlots.recordedSlot(owner);
      if (slotId !== undefined) this.emit({ type: "setOverlayVisualStyle", slotId, componentId: component.guid,
        style: parseOverlayVisualStyle(Object.fromEntries(component.variables)) });
      return;
    }
    if (component.classId === "2DRichTextComponent") this.textAppear.refresh(component);
    if (this.overlay.refreshComponent(owner, component, propertyName)) return;
    // Steering/tuning is consumed by the next motor tick; only dimensions
    // need immediate collider/query refresh after a property write.
    if (component.classId === "MovementComponent" && propertyName && propertyName !== "radius" && propertyName !== "height") return;
    const slotId = this.renderSlots.recordedSlot(owner);
    if (component.classId === "DeformerComponent") {
      if (slotId !== undefined) {
        if (this.ticks.processing) this.renderEmitter.queueDeformers(owner);
        else this.renderEmitter.emitActorDeformers(owner, slotId);
      }
      return;
    }
    if (component.classId === "MeshComponent" && propertyName === "materialGuid") {
      // A staged material belongs to this existing native mesh. Re-emitting the
      // mesh assignment here would replace that owner between prepare/commit.
      if (slotId !== undefined) this.renderEmitter.emitMaterialAssignments([component], slotId, true);
      return;
    }
    if (component.classId === "DynamicRuntimeMeshComponent" &&
      (propertyName === "materialGuid" || propertyName === "enableCollision" || propertyName === "layer" || propertyName === "mask")) {
      if (propertyName === "materialGuid" && slotId !== undefined) this.renderEmitter.emitMaterialAssignments([component], slotId, true);
      // Geometry collision changes are coalesced by the next physics step.
      return;
    }
    if (slotId !== undefined) {
      if (component.classId === "RenderTargetCaptureComponent") this.renderEmitter.emitRenderTargetCapture(owner, slotId);
      else if (component.classId === "OutlineComponent") this.renderEmitter.emitActorOutlines(owner, slotId);
      else if (component.classId === "FogVolumeComponent") this.renderEmitter.emitActorFogVolumes(owner, slotId);
      else if (propertyName === "transform") this.renderEmitter.emitComponentTransforms(owner, slotId);
      else if (component.classId !== "PhysicsConstraintComponent" && component.classId !== "RagdollComponent" && component.classId !== "MovementComponent") this.renderEmitter.emitMeshAssignment(owner, slotId);
    }
    if (component.classId === "ParticleComponent") {
      this.audioParticles.emitParticles(owner);
    }
    if (component.classId === "AudioComponent") {
      this.audioParticles.emitVoiceGain(component);
    }
    if (component.classId === "NavAgentComponent") {
      this.navigation.updateAgentParams(owner);
    }
    const sync = this.physics.forActor(owner);
    if (component.classId === "RagdollComponent" || component.classId === "MeshComponent") {
      // Ragdoll and mesh-collision edits can create or retire the owner's
      // body; reconcile that one actor from its own chain.
      this.ragdolls.sync();
      sync.syncActor(owner, this.world);
    } else sync.applyComponent(component);
  }

  private setMaterialParameter(material: MaterialInstanceObject, parameterName: string, parameter: MaterialParameterValue, inspector = false): boolean {
    if (inspector ? !(material instanceof MaterialObject) || !material.component.owner || !this.simulation.canEditActor(material.component.owner) : !this.admission.canRun(material)) return false;
    const validated = this.materialParameters.accepts(material, parameterName, parameter);
    if (!validated && (material instanceof PostProcessMaterialObject || this.validateLegacyMeshParameters)) return false;
    if (material instanceof PostProcessMaterialObject) {
      if (!material.entry.id) return false;
      const owner = material.owner;
      const target: Extract<CommandMessage, { type: "setPostProcessMaterialParameter" }>["owner"] = owner instanceof SceneLayer
        ? { kind: "sceneLayer", layerId: owner.guid, layerLoadId: this.layers.get(owner.guid)!.loadId }
        : { kind: "scene", sceneAssetGuid: owner.assetGuid, sceneLoadId: this.sceneRealizer.loadId };
      this.emit({ type: "setPostProcessMaterialParameter", owner: target, entryId: material.entry.id,
        materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
    } else {
      const component = material.component;
      const owner = component.owner;
      if (!owner || owner.destroyed || component.destroyed || component.getVariable("materialObject") !== material) return false;
      const slotId = this.renderSlots.recordedSlot(owner);
      if (slotId === undefined) return false;
      if (!this.renderEmitter.rendersComponent(owner, component)) return false;
      this.emit({ type: "setMaterialParameter", slotId, componentId: component.guid,
        materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
    }
    if (validated) this.materialParameters.set(material, parameterName, parameter);
    return true;
  }

  notifySceneLayerReady(layerId: string, layerLoadId: number): void {
    this.layers.notifyReady(layerId, layerLoadId);
  }

  beginPlayLoading(): boolean {
    if (!this.cooperativeSceneLoading) return false;
    if (this.stopped) throw sceneRealizationCancelled();
    this.bootLoading = true;
    this.running = true;
    return true;
  }

  finishPlayLoading(): void {
    if (this.stopped) throw sceneRealizationCancelled();
    this.bootLoading = false;
    this.layers.readyPresented();
    this.sceneRealizer.finishBootLoading();
  }

  realizePlayWorld(): void | Promise<void> {
    return this.sceneRealizer.realizePlayWorld();
  }

  notifySceneLoadingPainted(sceneAssetGuid: string, sceneLoadId: number): void {
    this.sceneRealizer.notifyLoadingPainted(sceneAssetGuid, sceneLoadId);
  }

  /**
   * Opt-in per camera (`attemptPossessViewTarget`). Runs after every actor has
   * spawned so the slot exists, and yields to a Begin Play `Possess Camera`
   * because an explicit script choice outranks the authored default.
   */
  private attemptPossessViewTarget(): void {
    if (this.cameraPossessedByScript) return;
    const scene = this.playScene;
    const defaultActor = scene?.actors.find((actor) => actor.id === scene.settings.mainCameraActorId);
    if (defaultActor?.components.some((component) =>
      component.id === scene?.settings.mainCameraComponentId && component.classId === "CameraComponent",
    ) && this.guidSlot(defaultActor.id) !== undefined) return;
    for (const actor of this.playScene?.actors ?? []) {
      const opted = actor.components.some(
        (component) =>
          component.classId === "CameraComponent" &&
          component.properties.attemptPossessViewTarget === true,
      );
      if (!opted) continue;
      const slotId = this.guidSlot(actor.id);
      if (slotId === undefined) continue;
      this.emit({ type: "possessCamera", slotId });
      this.possessedCameraSlotId = slotId;
      return;
    }
  }

  changeSceneAsync(sceneKey: string): Promise<void> {
    return this.sceneRealizer.changeAsync(sceneKey);
  }

  executeConsoleCommand(command: string): { success: boolean; output: string } {
    return this.console.execute(command);
  }

  executeConsoleCommandAsync(command: string): Promise<CommandResult> {
    return this.console.executeAsync(command);
  }

  inspectWorld(): DebugInspectSnapshot {
    return createDebugInspectSnapshot(this.world);
  }

  invokeScriptEvent(
    classId: string,
    event: string,
    self?: BObject | null,
    args?: Record<string, unknown>,
  ): void {
    this.scriptHost.invokeEvent(classId, event, self ?? null, args ?? {});
  }

  registerUserCommand(def: UserCommandDef): void {
    this.console.register(def);
  }

  bindUserCommand(
    def: Omit<UserCommandDef, "run"> & { classId: string },
  ): void {
    this.console.bind(def);
  }

  listConsoleCommands(): readonly RegisteredCommand[] {
    return this.console.list();
  }

  stopTrace(): TracePayload | null {
    return this.ticks.lastTrace;
  }

  restoreBtFromTrace(states: readonly TraceBtState[]): void {
    this.behaviourTrees.restoreFromTrace(states);
  }

  registerAnimGraph(guid: string, document: AnimGraphDocument): void {
    this.animGraphs.register(guid, document);
  }

  registerBehaviourTree(guid: string, document: BehaviourTreeDocument): void {
    this.behaviourTrees.register(guid, document);
  }

  registerBlackboard(guid: string, document: BlackboardDocument): void {
    this.behaviourTrees.registerBlackboard(guid, document);
  }

  registerSceneContent(content: RuntimeSceneContent): void {
    const retained = new Set(content.assetGuids);
    this.simulation.retainSceneContent(retained, content.dataAssets);
    this.animGraphs.retain(retained);
    this.behaviourTrees.retain(retained);
    this.sceneLayerLibrary.clear();
    for (const entry of content.sceneLayers ?? []) this.sceneLayerLibrary.set(entry.guid, entry.layer);
    this.navigation.replaceSceneNavMeshes(content.sceneNavmeshBytes ?? {});
    this.behaviourTrees.replaceAnimClipCatalog(content.animClipCatalog ?? []);
    this.behaviourTrees.replaceAudioAssets(content.audioAssetGuids ?? []);
    this.sourceRenderTargets.clear();
    for (const [guid, value] of Object.entries(content.renderTargets ?? {})) this.sourceRenderTargets.set(guid, value);
    this.sourceRenderTargetTextures.clear();
    for (const [guid, value] of Object.entries(content.renderTargetTextures ?? {})) this.sourceRenderTargetTextures.set(guid, value);
    this.materialParameters.replaceCatalog(content.materialParameterCatalog, content.materialTextureAssetGuids);
    this.dataCatalog.replace(content.dataAssets ?? []);
  }

  registerWaterContent(content: ReadonlyMap<string, WaterDefinition> | Readonly<Record<string, WaterDefinition>>): void {
    this.physics.registerWaterContent(content);
  }

  registerTileContent(options: {
    tilemaps: Readonly<Record<string, TilemapPayload>> | ReadonlyMap<string, TilemapPayload>;
    tilesets: Readonly<Record<string, TilesetPayload>> | ReadonlyMap<string, TilesetPayload>;
    pixelsPerUnit?: number;
  }): void {
    const tilemaps =
      options.tilemaps instanceof Map
        ? new Map(options.tilemaps)
        : new Map(Object.entries(options.tilemaps));
    const tilesets =
      options.tilesets instanceof Map
        ? new Map(options.tilesets)
        : new Map(Object.entries(options.tilesets));
    this.hasAnimatedTiles = hasAnimatedTiles(tilemaps, tilesets);
    if (this.hasAnimatedTiles) this.emit({ type: "tilemapAnimationTime", elapsedMs: this.tilemapAnimationTimeMs });
    this.physics.registerTileContent(tilemaps, tilesets, options.pixelsPerUnit);
  }

  registerSpriteContent(options: {
    sprites: Readonly<Record<string, SpritePayload>> | ReadonlyMap<string, SpritePayload>;
    spriteAnimations:
      | Readonly<Record<string, SpriteAnimationPayload>>
      | ReadonlyMap<string, SpriteAnimationPayload>;
    pixelsPerUnit?: number;
  }): void {
    this.physics.registerSpriteContent(options);
  }

  registerModelContent(options: {
    models: Readonly<Record<string, ModelPayload>> | ReadonlyMap<string, ModelPayload>;
    complexMeshes?:
      | Readonly<Record<string, CollisionTriangleMesh>>
      | ReadonlyMap<string, CollisionTriangleMesh>;
  }): void {
    this.physics.registerModelContent(options);
  }

  registerComplexCollisionMeshes(meshes: ReadonlyMap<string, CollisionTriangleMesh>, unavailable: readonly string[] = []): void {
    this.physics.registerComplexCollisionMeshes(meshes, unavailable);
  }

  async loadNavMesh(bytes: Uint8Array): Promise<void> {
    const lifecycleId = this.lifecycleId;
    const sceneGuid = this.playSceneGuid;
    this.navigation.setSceneNavMesh(sceneGuid, bytes);
    await initNavigation();
    if (this.stopped || lifecycleId !== this.lifecycleId) throw sceneRealizationCancelled();
    this.navigation.markInitialized();
    if (sceneGuid !== this.playSceneGuid) return;
    this.navigation.importNavMesh(sceneGuid, bytes);
    if (this.sceneRealizer.realized) {
      this.navigation.registerAgents();
      this.navigation.registerObstacles();
    }
  }

  setNavAgentTarget(actorGuid: string, target: NavPoint): boolean {
    return this.navigation.setAgentTarget(actorGuid, target);
  }

  findNavPath(from: NavPoint, to: NavPoint): NavPoint[] {
    return this.navigation.findPath(from, to);
  }

  addNavObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint): string {
    return this.navigation.addObstacle(kind, pose, size);
  }

  removeNavObstacle(id: string): void {
    this.navigation.removeObstacle(id);
  }

  stopNavAgent(actorGuid: string): void {
    this.navigation.stopAgent(actorGuid);
  }

  private simulationDt(): number {
    return this.dt * this.timeDilation;
  }

  private debugActorName(actor: Actor): string {
    const name = actor.getVariable("name");
    return typeof name === "string" && name.trim() ? name : actor.classId;
  }

  /** Animation graphs and BT Play Animation drive sprite clips in the actor's physics world. */
  private setActorSpriteClip(
    actor: Actor,
    clip: { assetGuid: string; clipName: string; normalisedTime: number } | null,
  ): void {
    this.physics.forActor(actor).setActorSpriteClip(actor, clip);
  }

  private possessCamera(target: unknown): void {
    const actor = actorFromIlluminationTarget(target);
    if (!actor) return;
    const slotId = this.actorSlot(actor);
    if (slotId === undefined) return;
    this.cameraPossessedByScript = true;
    this.possessedCameraSlotId = slotId;
    this.emit({ type: "possessCamera", slotId });
  }

  private playCameraActor(): Actor | null {
    if (this.possessedCameraSlotId != null) {
      for (const actor of this.world.getActors()) {
        if (actor.destroyed) continue;
        if (this.actorSlot(actor) === this.possessedCameraSlotId) {
          return actor;
        }
      }
    }
    const mainId = this.playScene?.settings.mainCameraActorId;
    if (mainId) {
      const actor = this.world.findActor(mainId);
      if (actor && !actor.destroyed) return actor;
    }
    for (const actor of this.world.getActors()) {
      if (actor.destroyed || actor.sceneLayerId || this.streams.isStreamActor(actor)) continue;
      if (
        actor.components.some(
          (component) =>
            component.classId === "CameraComponent" && !component.destroyed,
        )
      ) {
        return actor;
      }
    }
    return null;
  }

  private projectCursorToScene(
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
  ) {
    const miss = {
      hit: false,
      location: null,
      normal: null,
      distance: 0,
      actorId: null,
      bodyId: null,
      worldOrigin: { x: 0, y: 0, z: 0 },
      worldDirection: { x: 0, y: 0, z: 1 },
    };
    const camera = this.playCameraActor();
    const component = camera?.components.find(
      (entry) => entry.classId === "CameraComponent" && !entry.destroyed,
    );
    if (!camera || !component) return miss;
    const projection = component.getVariable("projectionMode");
    // Cast from the camera's world pose at call time; a parented camera's
    // local transform is relative to its parent.
    const pose = actorChainWorldTransform(camera, (guid) => this.world.findActor(guid)) ?? camera.transform;
    const ray = deprojectCursorRay(
      this.resolvedInput.cursor,
      this.overlay.canvasSize(),
      {
        position: pose.position,
        rotation: pose.rotation,
        lens: {
          projectionMode:
            projection === "orthographic" ? "orthographic" : "perspective",
          fieldOfView: Number(component.getVariable("fieldOfView") ?? 60),
          orthographicSize: Number(
            component.getVariable("orthographicSize") ?? 5,
          ),
          nearClip: Number(component.getVariable("nearClip") ?? 0.1),
          farClip: Number(component.getVariable("farClip") ?? 1000),
        },
      },
    );
    // Same freshness as Line Trace: bodies as of the last step plus call-time
    // pose writes and component refreshes. Actors spawned, destroyed or
    // reparented earlier this tick reach the ray after the next step, so a
    // script aiming every tick does not pay a whole-world pass per call.
    const hit = this.physics.main.lineTrace(ray.origin, ray.end, { channel });
    const drawDebug = options?.drawDebug !== false;
    if (drawDebug) {
      const duration =
        typeof options?.duration === "number" && Number.isFinite(options.duration)
          ? options.duration
          : 0;
      const end =
        hit.hit === true && hit.location ? hit.location : ray.end;
      this.emit({
        type: "debugDraw",
        kind: "line",
        start: ray.origin,
        end,
        thickness: 1,
        color: { x: 1, y: 0, z: 0, w: 1 },
        duration,
        frameId: this.frameId,
      });
      if (hit.hit === true && hit.location) {
        this.emit({
          type: "debugDraw",
          kind: "square",
          center: hit.location,
          size: 0.16,
          color: { x: 0, y: 1, z: 0, w: 1 },
          duration,
          frameId: this.frameId,
        });
      }
    }
    return {
      ...hit,
      worldOrigin: ray.origin,
      worldDirection: ray.direction,
    };
  }

  /** The render slot this actor's own commands target (`RenderSlots.actorSlot`). */
  private actorSlot(actor: Actor): number | undefined {
    return this.renderSlots.actorSlot(actor);
  }

  /** The slot of a guid's first-spawned live actor, the one guid lookups resolve. */
  private guidSlot(guid: string): number | undefined {
    return this.renderSlots.guidSlot(guid);
  }

  notifySceneModelsReady(sceneAssetGuid: string, sceneLoadId: number): void {
    this.sceneRealizer.notifyModelsReady(sceneAssetGuid, sceneLoadId);
  }

  configureSaveGame(options: RuntimeSaveGameOptions): SaveGameService {
    return this.boundaries.configureSaveGame(options);
  }

  getSaveGameService(): SaveGameService | undefined { return this.boundaries.saveGameService; }

  registerSaveActor(actor: BObject, persistentId?: string): void {
    this.boundaries.registerSaveActor(actor, persistentId);
  }

  start(): void {
    if (this.stopped) return;
    this.running = true;
    try {
      this.world.start();
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.assetPreloads.dispose();
    this.console.stop();
    this.layers.rejectWaiters();
    this.stopped = true;
    this.ticks.stopDiagnostics();
    this.inspector.stop();
    this.boundaries.flush();
    this.pendingPauseChanges.clear();
    this.tweens.stop();
    this.overlay.clear();
    this.lifecycleId++;
    this.sceneRealizer.cancelSceneChange();
    this.running = false;
    for (const resume of this.simulationWaiters) resume();
    this.simulationWaiters.clear();
    // The Scene realizer registers last: its realization cancels after every other subsystem's work.
    this.subsystems.cancelPending();
    this.ticks.finalizeTrace("session-ended");
    for (const actor of this.world.getActors()) {
      for (const component of [...actor.components]) {
        if (!component.destroyed) {
          component.destroyed = true;
          component.callOnDestroyed();
          this.textAppear.remove(component);
        }
      }
    }
    this.world.end();
    this.scriptHost.dispose();
    this.scriptRuntime.unregisterClasses();
    this.anchors.clear();
    this.sceneRealizer.releaseSceneSources();
    this.playScene = undefined;
    this.sceneLibrary.clear();
    this.admission.clear();
    this.layers.clear();
    this.subsystems.dispose();
  }

  pause(reason: SessionPauseReason = "user"): void {
    this.setPauseReason(reason, true);
  }

  resume(reason: SessionPauseReason = "user"): void {
    this.setPauseReason(reason, false);
  }

  private setPauseReason(reason: SessionPauseReason, paused: boolean): void {
    if (this.stopped) return;
    if (this.simulation.quiescent && !paused) return;
    if (this.ticks.processing) { this.pendingPauseChanges.set(reason, paused); return; }
    const wasPaused = this.paused;
    if (paused) this.pauseReasons.add(reason); else this.pauseReasons.delete(reason);
    this.paused = this.pauseReasons.size > 0;
    if (this.paused === wasPaused) return;
    this.ticks.resetAccumulator();
    if (this.paused) { this.resetInputState(); return; }
    this.ticks.discardNextElapsed();
    this.admission.flush();
    if (!this.streams.blocking) {
      const waiters = [...this.simulationWaiters];
      this.simulationWaiters.clear();
      for (const resume of waiters) resume();
    }
  }

  requestSessionBoundary(request: SessionBoundaryRequest): Promise<SessionBoundaryResult> {
    return this.boundaries.requestSessionBoundary(request);
  }

  requestDiagnosticOperation(request: DiagnosticOperationRequest): Promise<DiagnosticOperationResult> {
    return this.ticks.requestDiagnosticOperation(request);
  }

  quiesceSimulation(request: SimulationQuiesceRequest): Promise<SessionBoundaryResult> {
    return this.simulation.quiesce(request);
  }

  captureSimulationState(request: SimulationCaptureRequest): Promise<SimulationSceneCaptureResult> {
    return this.simulation.capture(request);
  }

  applyRuntimeMaterialEditResult(message: Extract<ControlMessage, { type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" }>): void {
    this.inspector.applyMaterialEditResult(message);
  }

  requestRuntimeInspector(request: RuntimeInspectorRequest): Promise<RuntimeInspectorResult> {
    return this.inspector.request(request);
  }

  cancelRuntimeInspector(request: { sessionGeneration: number; requestId: number }): void {
    this.inspector.cancel(request);
  }

  private resetInputState(): void {
    this.input.drain();
    this.resolvedInput = this.resolver.reset();
    this.connectionBox.current = this.resolvedInput.gamepadConnections;
  }

  pushInput(events: readonly RawInputEvent[]): void {
    if (this.stopped || this.paused) return;
    for (const event of events) {
      this.input.push(event);
    }
  }

  pushInputBuffer(buffer: ArrayBuffer): void {
    this.pushInput(decodeInputEvents(buffer));
  }

  get inputBindings(): InputBindingControls { return this.resolver.bindings; }

  getResolvedInput(): ResolvedInputTick {
    return this.resolvedInput;
  }

  tick(): void {
    this.ticks.tick();
  }

  private settlePauseChanges(): void {
    if (this.pendingPauseChanges.size) {
      for (const [reason, paused] of this.pendingPauseChanges) this.setPauseReason(reason, paused);
      this.pendingPauseChanges.clear();
    }
  }

  /** The tick's phases in order; `TickPipeline` owns the gate, timing, stats and trace around them. */
  private runTick(): void {
    const simDt = this.simulationDt();
    this.world.clock.dt = simDt;
    // Consume every event queued since the last tick. Gating on event.tick
    // dropped Play worker input: the host stamped with a wall-clock index
    // (performance.now()/16.67) while World.clock.tickIndex stayed small,
    // and drain() discarded the "future" events instead of deferring them.
    // Replay still works because it feeds one tick of events at a time.
    const pending = this.input.drain();
    this.resolvedInput = this.resolver.resolve(pending, simDt);
    this.connectionBox.current = this.resolvedInput.gamepadConnections;
    this.ticks.clearPrints();
    for (const connection of this.resolvedInput.gamepadConnections) {
      this.emit({
        type: "log",
        severity: "log",
        category: "input",
        message: connection.connected
          ? `gamepad ${connection.gamepadIndex} connected`
          : `gamepad ${connection.gamepadIndex} disconnected`,
        frameId: this.frameId,
      });
    }

    this.ticks.beginPhaseTiming();

    this.loopGuard.reset();
    this.tweens.advance(simDt);
    this.textAppear.advance(this.world.getActors(), simDt, (actor) => this.admission.canTickActor(actor));
    this.painters.beginFrame(this.world.getActors(), (actor) => this.admission.canTickActor(actor));
    try {
      this.overlay.tickFocus(pending, this.resolvedInput, simDt);
      this.world.tick();
      // World committed actors queued by this tick; deliver their deferred
      // notifications after actor and component creation hooks have completed.
      this.admission.flush();
      if (this.admission.canTickScene()) this.streams.tickScenes(simDt, () => this.admission.canTickScene());
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
    if (this.stopped) return;
    this.tweens.cancelInvalid();
    this.delays.advance(this.simulationDt());
    if (this.admission.canTickScene() || this.admission.hasReadyLayers()) this.animGraphs.tick();
    if (this.admission.canTickScene() || this.admission.hasReadyLayers()) {
      this.tilemapAnimationTimeMs += simDt * 1000;
      if (this.hasAnimatedTiles) this.emit({ type: "tilemapAnimationTime", elapsedMs: this.tilemapAnimationTimeMs });
      // Only behaviour trees and the crowd read the frame index.
      this.navFrameActors = this.navigation.active || this.behaviourTrees.hasTrees ? firstSpawnedActorIndex(this.world.getActors()) : null;
      try {
        this.behaviourTrees.tick();
        if (this.navigation.active && this.admission.canTickScene()) this.navigation.tickCrowd(this.navFrameActors ?? firstSpawnedActorIndex(this.world.getActors()));
      } finally {
        this.navFrameActors = null;
      }
    }
    this.ticks.closePhaseTiming();

    this.flushPainters();
    this.flushTextAppear();
    this.renderEmitter.flushDeformers();
    const completedFrameId = this.frameId;
    this.frameId += 1;
    if (this.admission.canTickScene() || this.admission.hasReadyLayers()) {
      this.snapshots.publishTick();
      this.physics.emitDebugColliders();
      this.navigation.emitDebug();
      this.behaviourTrees.emitSnapshot();
    }
    this.ticks.finishTick(completedFrameId, pending);
  }

  advance(elapsedSeconds: number): void {
    this.ticks.advance(elapsedSeconds);
  }

  copySnapshot(out: Float32Array): boolean {
    if (this.stopped || (this.sceneRealizer.blocked && !this.sceneRealizer.realizationFinished &&
      !this.layers.anyRealized())) return false;
    return this.snapshots.copy(out);
  }

  getWorld(): World {
    return this.world;
  }

  getLogRing(): LogRingBuffer {
    return this.logs;
  }

  getDiagnostics(): SessionDiagnosticAggregator {
    return this.diagnostics;
  }

  reportLog(message: string, severity: LogSeverity = "log", category = "console"): void {
    this.emit({ type: "log", message, severity, category, frameId: this.frameId });
  }

  registerAnchors(assetGuid: string, anchors: readonly AnchorEntry[]): void {
    this.anchors.set(assetGuid, anchors);
  }

  reportError(
    error: unknown,
    frameId = this.frameId,
    hint?: { btNodeId?: string; assetGuid?: string },
  ): RuntimeDiagnostic | null {
    if (error instanceof RuntimeContinuationCancelled && this.stopped) return null;
    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack ?? "";
    const anchor = mapStackToAnchor(stack, this.anchors);
    const location = isInfiniteLoopError(err) ? err.scriptLocation : undefined;
    const diag: RuntimeDiagnostic = {
      code: isInfiniteLoopError(err)
        ? INFINITE_LOOP_DIAGNOSTIC_CODE
        : "runtime.uncaught",
      message: err.message,
      severity: "error",
      assetGuid: hint?.assetGuid ?? this.behaviourTrees.currentAssetGuid ?? location?.assetGuid ?? anchor?.assetGuid,
      graphId: location?.graphId ?? anchor?.graphId,
      nodeId: hint?.btNodeId ? undefined : location?.nodeId ?? anchor?.nodeId,
      bodyLine: anchor?.bodyLine,
      btNodeId: hint?.btNodeId ?? this.behaviourTrees.currentNodeId ?? anchor?.btNodeId,
      stack,
      frameId,
      tickIndex: this.world.clock.tickIndex,
    };
    this.diagnostics.push(diag);
    this.logs.push({
      severity: "error",
      category: "runtime",
      message: err.message,
      frameId,
      tickIndex: this.world.clock.tickIndex,
    });
    this.emit({
      type: "diagnostic",
      code: diag.code,
      message: diag.message,
      assetGuid: diag.assetGuid,
      graphId: diag.graphId,
      nodeId: diag.nodeId,
      btNodeId: diag.btNodeId,
      bodyLine: diag.bodyLine,
      stack: diag.stack,
      frameId,
      severity: "error",
    });
    return diag;
  }

  private emit(command: CommandMessage): void {
    command = this.inspector.annotate(command);

    this.commandRevision++;
    // Every log line and Print String reaches the ring that `dumplog` and the
    // session report read, not only the ones routed through reportLog.
    if (command.type === "log") {
      this.logs.push({
        message: command.message,
        severity: command.severity,
        category: command.category,
        frameId: command.frameId,
        tickIndex: this.world.clock.tickIndex,
      });
    } else if (command.type === "print") {
      this.logs.push({
        message: command.message,
        severity: "log",
        category: "print",
        frameId: command.frameId ?? this.frameId,
        tickIndex: this.world.clock.tickIndex,
      });
    }
    this.onCommand?.(command);
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

