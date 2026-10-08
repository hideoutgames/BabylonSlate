import { captureSimulationScene, type SimulationSceneCaptureResult, type SimulationCaptureIdentity } from "./simulation-scene-capture";
import { RuntimeMaterialEditGate } from "./runtime-material-edit-gate";
import { runtimeEditLocalTransform } from "./runtime-transform-edit";
import { RuntimeInspector } from "./runtime-inspector";
import { RuntimeDataCatalog, dataTypeSchemas } from "./data-catalog";
import { resolveActorDefaults, type SaveGameService } from "@babylonslate/core";
import { SessionBoundaries, type RuntimeSaveGameOptions } from "./session-boundaries";
import { RuntimeMaterialParameters } from "./runtime-material-parameters";
import { RuntimeAssetPreloads } from "./asset-preloads";
import type { RuntimeAssetLoadState, RuntimeAssetPreloadOptions, RuntimeAssetPreloadResult } from "@babylonslate/core";
import { SceneLayerOverlay, createSceneLayerOverlayHostBindings } from "./scene-layer-overlay";
import type { FocusNavigationSettings } from "@babylonslate/core";
import { CableWorldSync } from "./cable-sync";
import { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import { MovementWorldSync } from "./movement";
import { captureComponent } from "./render-targets";
import { createDefaultRenderTargetCaptureProperties, type RenderTargetPayload, type RenderTargetTexturePayload } from "@babylonslate/core";
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
  type RuntimeMaterialEditPreparation,
  type SimulationQuiesceRequest,
  type SimulationCaptureRequest,
  type DiagnosticOperationRequest,
  type DiagnosticOperationResult,
} from "@babylonslate/bridge";
import {
  ClassRegistry,
  World,
  createActorFromSerialized,
  attachSerializedComponents,
  createDebugInspectSnapshot,
  Actor,
  ActorComponent,
  BObject,
  MaterialObject,
  PostProcessMaterialObject,
  getPostProcessMaterialObject,
  type MaterialInstanceObject,
  SceneLayer,
  SceneSubsystem,
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  instantiableSubsystemClassIds,
  isLockedEngineClassId,
  sceneAssetClassId,
  hydrateClassVariableValue,
  type ClassKind,
  type DebugInspectSnapshot,
  type GameSubsystemHooks,
  type SceneSubsystemHooks,
  type Subsystem,
  type TickContext,
  type SceneActorHooks,
} from "@babylonslate/object-model";
import {
  DEFAULT_PLAY_FRAME_CAP,
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
import { parseColliderProperties, type PhysicsWorldKind } from "@babylonslate/physics";
import {
  createCommandRegistry,
  createUserCommand,
  tokenize,
  matchCommandName,
  parseCommandArgs,
  isReservedConsoleCommandName,
  createInfiniteLoopGuard,
  isInfiniteLoopError,
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  DEFAULT_INFINITE_LOOP_COUNT,
  type CommandRegistry,
  type CommandResult,
  type ConsoleCommandHost,
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
import { ScriptHost, compiledScriptKey, compiledScriptSourceLabel, type CompiledScript } from "./script-host";
import { COMPILED_MODULE_LINE_OFFSET } from "./module-loader";
import { shouldSpawnScriptedActor } from "./play-load";
import type { PhysicsWorldSync } from "./physics-sync";
import { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import { RagdollWorldSync } from "./ragdoll-sync";
import {
  formatDumpActors,
  formatInspectActor,
} from "./console-inspect";
import { actorChainWorldTransform, actorLabel, breakParentCycles, firstSpawnedActorIndex } from "./actor-world-transform";
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
import { indexSceneLibrary } from "./scene-library";
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

/** Hooks both `GameInstanceHooks` and `GameSubsystemHooks` accept. */
type GameLifecycleHooks = {
  onCreation: (self: BObject) => void;
  onTick: (self: BObject, ctx: TickContext) => void;
  onGameEnd: (self: BObject) => void;
  onSceneStartLoading: (self: BObject, sceneName: string) => void;
  onSceneFinishLoading: (self: BObject, sceneName: string) => void;
  onFirstSceneLoaded: (self: BObject, sceneName: string) => void;
  onSceneExit: (self: BObject, sceneName: string) => void;
};

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
  private readonly simulationBaseline: SerializedScene | null;
  /** Catalog identities are persistable without loading every referenced asset. */
  private readonly simulationAssets: ReadonlySet<string>;
  private simulationOwnedAssets: ReadonlySet<string>;
  private simulationDataAssets: RuntimeDriverOptions["dataAssets"];
  private simulationStart: Pick<SimulationCaptureIdentity, "sceneAssetGuid" | "sceneInstanceId" | "sceneLoadId"> | null = null;
  private simulationQuiescent = false;
  private simulationUnsupportedInstance: { kind: "stream" | "layer"; id: string } | null = null;
  private lastCaptureRequestId = 0;
  private readonly sessionGeneration: number;
  private readonly sessionMode: GameSessionMode;
  private commandRevision = 0;
  private readonly diagnosticsEnabled: boolean;
  private readonly deferMaterialEdits: boolean;
  private materialEditGate: RuntimeMaterialEditGate | null = null;
  private materialEditEmission: { preparation: RuntimeMaterialEditPreparation; emitted: boolean } | null = null;
  private runtimeInspector: RuntimeInspector | null = null;
  private inspectorScheduled = false;
  private lastInspectorRequestId = 0;
  private readonly inspectorRequests: Array<{ request: RuntimeInspectorRequest; resolve(result: RuntimeInspectorResult): void }> = [];
  private readonly pauseReasons = new Set<SessionPauseReason>();
  private readonly pendingPauseChanges = new Map<SessionPauseReason, boolean>();
  private readonly assetPreloads = new RuntimeAssetPreloads(command => this.emit(command));
  private readonly classAssetGuids = new Map<string, string>();
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
  private volume = 1;
  private timeDilation = 1;
  private running = false;
  private flushingConsoleActors = false;
  private frameId = 0;
  private readonly removingActors = new WeakSet<Actor>();
  private readonly scriptHost: ScriptHost;
  private readonly scriptSources = new Map<string, CompiledScript>();
  private scriptSourceWork: Promise<void> = Promise.resolve();
  private readonly dataCatalog: RuntimeDataCatalog;
  private readonly sourceRenderTargets = new Map<string, RenderTargetPayload>();
  private readonly sourceRenderTargetTextures = new Map<string, RenderTargetTexturePayload>();
  private readonly ragdolls: RagdollWorldSync;
  private readonly cables: CableWorldSync;
  private readonly dynamicMeshes: DynamicRuntimeMeshSync;
  private readonly movement: MovementWorldSync;
  private playScene: SerializedScene | undefined;
  private playSceneGuid: string;
  private readonly gameInstanceClass: string;
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
  /**
   * Actors each SceneSubsystem heard enter play (Scene Actor Spawned); only
   * these report Scene Actor Destroyed to it.
   */
  private readonly sceneSubsystemActors = new WeakMap<SceneSubsystem, WeakSet<Actor>>();
  /**
   * Nonzero while the main Scene's own teardown removes its streams, layers
   * and actors: its SceneSubsystems hear none of those notifications.
   */
  private sceneTeardownDepth = 0;
  /** `Get <Subsystem>` matches by class id; cleared when live subsystems change. */
  private readonly subsystemMatches = new Map<string, readonly Subsystem[]>();
  private readonly ambiguousSubsystemWarnings = new Set<string>();
  private readonly cooperativeSceneLoading: CooperativeSceneLoadingOptions | null;
  private bootLoading = false;
  private stopped = false;
  private lifecycleId = 0;
  private gameInstanceBound = false;
  /** A script `Possess Camera` outranks the authored per-camera option. */
  private cameraPossessedByScript = false;
  private possessedCameraSlotId: number | null = null;
  private readonly commands: CommandRegistry;
  private readonly commandClasses = new Map<string, { classId: string; assetGuid: string }>();
  private readonly consoleLifetime = new AbortController();
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
    createActor: (serialized) => createActorFromSerialized(this.world, serialized, this.sceneActorHooks),
    realizeActor: (actor, checkpoint) => this.realizeActor(actor, checkpoint),
    breakParentCycles: (actors, detach) => this.breakLoadedParentCycles(actors, detach),
    publishSnapshot: () => this.snapshots.publish(),
    slot: (actor) => this.actorSlot(actor),
    syncPhysics: () => this.physics.main.syncFromWorld(this.world),
    navigation: () => this.navigation,
    removeActor: (actor) => this.removeOwnedActor(actor),
    cancelInvalidTweens: () => this.tweens.cancelInvalid(),
    releaseAssets: (ownerGuid) => this.assetPreloads.releaseOwner(ownerGuid),
    markUnsupportedInstance: (sceneGuid) => this.markUnsupportedSimulationInstance("stream", sceneGuid),
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
    recordSimulationStart: (start) => {
      if (this.sessionMode === "simulate" && !this.simulationStart) this.simulationStart = start;
    },
    markSceneTransition: () => {
      if (this.sessionMode === "simulate") this.emit({ type: "simulationRetentionUnavailable", sessionGeneration: this.sessionGeneration,
        reason: "Keep cannot retain a scene transition into the starting scene document." });
    },
    createActor: (serialized) => createActorFromSerialized(this.world, serialized, this.sceneActorHooks),
    realizeActor: (actor, checkpoint) => this.realizeActor(actor, checkpoint),
    breakParentCycles: (actors) => this.breakLoadedParentCycles(actors),
    possessViewTarget: () => this.attemptPossessViewTarget(),
    publishSnapshot: () => this.snapshots.publish(),
    removeActor: (actor) => this.removeOwnedActor(actor),
    removeSceneLayer: (layerGuid) => this.removeSceneLayer(layerGuid),
    releaseAssets: (ownerGuid) => this.assetPreloads.releaseOwner(ownerGuid),
    resetForSceneLoad: () => this.subsystems.resetForSceneLoad(),
    duringSceneTeardown: (teardown) => this.duringSceneTeardown(teardown),
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
    actorHooks: () => this.sceneActorHooks,
    canSpawnActorClass: (classId) => this.canSpawnActorClass(classId),
    realizeActor: (actor) => this.realizeActor(actor),
    removeActor: (actor) => this.removeOwnedActor(actor),
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
    this.simulationBaseline = options.sessionMode === "simulate" ? options.playScene ?? null : null;
    this.simulationAssets = new Set(options.simulationAssetGuids ?? [...Object.keys(options.materialParameterCatalog ?? {}), ...(options.materialTextureAssetGuids ?? []), ...(options.audioAssetGuids ?? [])]);
    this.simulationOwnedAssets = this.simulationAssets;
    this.simulationDataAssets = options.sessionMode === "simulate" ? options.dataAssets : undefined;
    this.sessionGeneration = options.sessionGeneration ?? 0;
    this.sessionMode = options.sessionMode ?? "play";
    const projectName = options.project?.name ?? "";
    const projectVersion = options.project?.version ?? "";
    this.demandAssetCatalog = options.classAssetGuids !== undefined;
    for (const [classId, guid] of Object.entries(options.classAssetGuids ?? {})) this.classAssetGuids.set(classId, guid);
    this.diagnosticsEnabled = options.includeDebugCommands ?? true;
    this.deferMaterialEdits = options.deferMaterialEdits === true;
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
    this.gameInstanceClass = options.gameInstanceClass ?? "GameInstance";
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
    this.commands = createCommandRegistry({
      includeDebug: options.includeDebugCommands ?? true,
    });
    for (const command of options.consoleCommands ?? []) {
      this.classAssetGuids.set(command.classId, command.assetGuid);
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
      componentHooksFor: (classId) => {
        if (!registry.isA(classId, "ActorComponent")) return undefined;
        return {
          onCreation: (self) => {
            this.movement.initialize(self);
            this.scriptHost.bindInterfaceHandlers(self);
            this.admission.runCreation(self, () => this.scriptHost.hooksFor(classId)?.onCreation?.(self));
          },
          // Engine component classes never carry scripts, so they skip the
          // per-frame script lookup; project components keep it for reloads.
          onTick: isLockedEngineClassId(classId)
            ? undefined
            : (self, ctx) =>
                this.admission.guard(() => this.scriptHost.hooksFor(classId)?.onTick?.(self, ctx)),
          onDestroyed: (self) => {
            this.admission.runDestroyed(self, () => this.scriptHost.hooksFor(classId)?.onDestroyed?.(self));
            this.dynamicMeshes.remove(self);
            this.textAppear.remove(self);
          },
        };
      },
      sceneSubsystemHooksFor: (classId) => this.sceneSubsystemHooks(classId),
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
      removing: (actor) => this.removingActors.has(actor),
      pixelsPerUnit: () => this.physics.pixelsPerUnit,
      scripts: () => this.scriptHost,
      slot: (actor) => this.actorSlot(actor),
      guidSlot: (guid) => this.guidSlot(guid),
      actorHooks: (classId) => this.sceneActorHooks(classId),
      prepareActor: (actor) => {
        this.scriptHost.bindInterfaceHandlers(actor);
        this.applyActorDefaults(actor);
        this.assignSlot(actor);
      },
      breakParentCycles: (actors) => this.breakLoadedParentCycles(actors),
      realizeActor: (actor) => this.realizeActor(actor),
      removeActor: (actor) => this.removeOwnedActor(actor),
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
      markUnsupportedInstance: (layerGuid) => this.markUnsupportedSimulationInstance("layer", layerGuid),
      guidTaken: (id) => this.renderSlots.hasGuid(id) || this.world.findActor(id) != null,
      createActor: (serialized, layerGuid) => createActorFromSerialized(this.world, serialized, this.sceneActorHooks, layerGuid),
      publishSnapshot: () => this.snapshots.publish(),
      syncOverlayPhysics: () => this.physics.overlay.syncFromWorld(this.world),
      tryCompleteSceneLoad: () => this.sceneRealizer.tryCompleteSceneLoad(),
      removeActor: (actor) => this.removeOwnedActor(actor),
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
        classAssetGuids: this.classAssetGuids,
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
      getSubsystem: (classId) => this.findSubsystem(classId),
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
      executeConsoleCommand: (command) => this.executeConsoleCommand(command),
      executeConsoleCommandAsync: (command) => this.executeConsoleCommandAsync(command),
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

    this.registerPlaySceneTypes();
    this.bindGameInstance();

    if (options.seedDemoActors !== false && !options.playScene) {
      this.seedDefaultActors();
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
    return this.updateScriptSources(scripts, false);
  }

  replaceScriptSources(scripts: readonly CompiledScript[]): Promise<void> {
    return this.updateScriptSources(scripts, true);
  }

  private updateScriptSources(scripts: readonly CompiledScript[], replace: boolean): Promise<void> {
    const work = this.scriptSourceWork.catch(() => {}).then(async () => {
      if (this.stopped) throw new Error("The runtime stopped during script preparation.");
      const requested = new Map(scripts.map((script) => [compiledScriptKey(script), script]));
      const actors = this.world.getActors();
      const owners = [this.world.gameInstance, this.world.currentScene, ...actors, ...actors.flatMap((actor) => actor.components),
        ...this.world.getSceneLayers(), ...this.world.getGameSubsystems(), ...this.world.getSceneSubsystems(),
        ...this.streams.scenes()];
      const liveClasses = new Set(owners.filter((owner) => owner && !owner.destroyed)
        .flatMap((owner) => this.world.classRegistry.ancestry(owner!.classId)));
      for (const script of this.scriptSources.values())
        if ((!replace || liveClasses.has(script.classId)) && !requested.has(compiledScriptKey(script))) requested.set(compiledScriptKey(script), script);
      const ordered = parentFirstScriptOrder([...requested.values()], (classId) => this.world.classRegistry.has(classId));
      await this.scriptHost.replaceScripts(ordered);
      if (this.stopped) throw new Error("The runtime stopped during script preparation.");
      const classes = this.world.classRegistry;
      for (const classId of [...new Set([...this.scriptSources.values()].map((script) => script.classId))]
        .sort((a, b) => classes.ancestry(b).length - classes.ancestry(a).length)) classes.unregister(classId);
      for (const previous of this.scriptSources.values()) {
        this.anchors.delete(compiledScriptSourceLabel(previous));
        this.anchors.delete(previous.assetGuid);
      }
      this.scriptSources.clear();
      const ownerAnchors = new Map<string, AnchorEntry[]>();
      for (const script of ordered) {
        this.classAssetGuids.set(script.classId, script.assetGuid);
        this.registerScriptClass(script);
        this.scriptSources.set(compiledScriptKey(script), script);
        if (script.anchors.length > 0) {
          this.registerAnchors(compiledScriptSourceLabel(script), script.anchors.map((anchor) => ({
            ...anchor, line: anchor.line + COMPILED_MODULE_LINE_OFFSET,
          })));
          const anchors = ownerAnchors.get(script.assetGuid) ?? [];
          anchors.push(...script.anchors);
          ownerAnchors.set(script.assetGuid, anchors);
        }
        if (script.command) {
          this.bindUserCommand({
            ...script.command,
            classId: script.classId,
          });
        }
      }
      for (const [guid, anchors] of ownerAnchors)
        this.registerAnchors(guid, anchors.sort((a, b) => a.line - b.line || a.column - b.column));
      this.applyGameInstanceClassDefaults();
      this.installSubsystems();
      for (const owner of owners) if (owner && !owner.destroyed) this.scriptHost.bindInterfaceHandlers(owner);
    });
    this.scriptSourceWork = work;
    return work;
  }

  /**
   * Instantiate the leaf subsystem classes the registry now knows. Real hosts
   * load scripts once, before `World.start()`, so GameSubsystems' On Init can
   * precede the Game Instance's. Scripts loaded after the World started (only
   * a headless caller can do that) cannot honour that order: the installed
   * GameSubsystems stay and new ones are reported, never started late.
   * SceneSubsystem classes apply to every later main Scene.
   */
  private installSubsystems(): void {
    const classes = this.world.classRegistry;
    const classIds = classes.classIds();
    this.subsystemMatches.clear();
    this.world.setSceneSubsystemClasses(
      instantiableSubsystemClassIds(classes, classIds, SCENE_SUBSYSTEM_CLASS_ID),
    );
    const gameClassIds = instantiableSubsystemClassIds(classes, classIds, GAME_SUBSYSTEM_CLASS_ID);
    const subsystems = gameClassIds.map((classId) =>
      this.world.createGameSubsystem({ classId, hooks: this.gameSubsystemHooks(classId) }));
    try {
      this.world.setGameSubsystems(subsystems);
    } catch {
      const installed = this.world.getGameSubsystems().map((subsystem) => subsystem.classId);
      const missing = gameClassIds.filter((classId) => !installed.includes(classId));
      if (missing.length > 0) {
        this.reportLog(`GameSubsystems loaded after Play started are not created: ${missing.join(", ")}`, "warning", "subsystem");
      }
      return;
    }
    for (const subsystem of subsystems) this.scriptHost.bindInterfaceHandlers(subsystem);
  }

  /**
   * The Game Instance is created before scripts register its class, so apply
   * its class variable defaults, inherited interfaces and interface handlers
   * once they are known (before `World.start()` fires On Init). Values already
   * on the instance win, as with `World.createGameInstance`.
   */
  private applyGameInstanceClassDefaults(): void {
    const gameInstance = this.world.gameInstance;
    if (!gameInstance) return;
    const classes = this.world.classRegistry;
    for (const variable of classes.inheritedVariables(gameInstance.classId)) {
      if (gameInstance.variables.has(variable.name)) continue;
      const value = hydrateClassVariableValue(variable);
      if (value !== undefined) gameInstance.setVariable(variable.name, value);
    }
    const interfaces = new Set(gameInstance.implementedInterfaces);
    for (const iface of classes.inheritedInterfaces(gameInstance.classId)) {
      interfaces.add(iface);
    }
    gameInstance.implementedInterfaces = [...interfaces];
    this.scriptHost.bindInterfaceHandlers(gameInstance);
  }

  private registerScriptClass(script: CompiledScript): void {
    const classes = this.world.classRegistry;
    const requestedParent =
      script.parentClassId?.trim() || "Actor";
    const parentClassId = classes.has(requestedParent)
      ? requestedParent
      : "Actor";
    const kind: ClassKind =
      classes.get(parentClassId)?.kind ?? "actor";
    const existingParent = classes.get(script.classId)?.parentClassId;
    // `ensure` keeps an existing class's parent. Repair a user class registered
    // before its script (the built-in demo `Enemy : Actor`) to the registered
    // parent the script names; `reparent` refuses cycles, keeping the old one.
    if (existingParent !== undefined && parentClassId === requestedParent &&
      existingParent !== requestedParent && !isLockedEngineClassId(script.classId)) {
      classes.reparent(script.classId, requestedParent);
    }
    classes.ensure({
      id: script.classId,
      parentClassId,
      kind,
      variables: [
        ...Object.entries(script.actorDefaults?.properties ?? {}).map(([name, defaultValue]) => ({ name, type: "unknown", defaultValue })),
        ...(script.variables ?? []).map((variable) => ({
        name: variable.name,
        type: variable.type,
        defaultValue: variable.defaultValue,
        ...(variable.container === "array" || variable.container === "map"
          ? { container: variable.container }
          : {}),
        ...(variable.keyTypeId ? { keyTypeId: variable.keyTypeId } : {}),
        ...(variable.keyTypeClassId
          ? { keyTypeClassId: variable.keyTypeClassId }
          : {}),
      })),
      ],
      implementedInterfaces: [...(script.implementedInterfaces ?? [])],
    });
  }

  spawnScriptedActor(options: {
    classId: string;
    variables?: Record<string, unknown>;
    implementedInterfaces?: string[];
    transform?: Transform;
    streamOwner?: BObject | null;
  }): Actor | null {
    if (this.stopped) return null;
    if (!this.streams.canSpawnFor(options.streamOwner)) return null;
    if (!this.canSpawnActorClass(options.classId)) return null;
    const hooks = this.scriptHost.hooksFor(options.classId) ??
      (this.world.classRegistry.isA(options.classId, "RenderTargetCapture") ? {} : undefined);
    if (!hooks) return null;
    const actor = this.world.createActor({
      classId: options.classId,
      variables: options.variables,
      implementedInterfaces: options.implementedInterfaces,
      transform: options.transform,
      hooks: {
        onCreation: (self) => this.admission.runCreation(self, () => hooks.onCreation?.(self)),
        onTick: (self, ctx) =>
          this.admission.guard(() => hooks.onTick?.(self, ctx)),
        onDestroyed: (self) =>
          this.admission.runDestroyed(self, () => hooks.onDestroyed?.(self)),
      },
    });
    this.streams.adoptSpawned(options.streamOwner, actor);
    this.scriptHost.bindInterfaceHandlers(actor);
    const components = this.scriptHost.scriptsFor(options.classId)
      .find((script) => script.components !== undefined)?.components;
    if (components) attachSerializedComponents(this.world, actor, components, { freshIds: true });
    this.boundaries.markSpawned(actor);
    try {
      this.realizeActor(actor);
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
    return actor;
  }

  private readonly sceneActorHooks: SceneActorHooks = (classId) => {
    const hooks = this.scriptHost.hooksFor(classId);
    return {
      onCreation: (self) => this.admission.runCreation(self, () => hooks?.onCreation?.(self)),
      // Logic-free actors (Prefabs, scriptless classes) add no per-frame call.
      onTick: hooks?.onTick
        ? (self, ctx) => this.admission.guard(() => hooks.onTick?.(self, ctx))
        : undefined,
      onDestroyed: (self) => {
        this.overlay.retireSwitcher(self);
        this.admission.runDestroyed(self, () => hooks?.onDestroyed?.(self));
      },
    };
  };

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
    if (inspector ? !(material instanceof MaterialObject) || !material.component.owner || !this.inspectorActorReady(material.component.owner) : !this.admission.canRun(material)) return false;
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

  private removeOwnedActor(actor: Actor): void {
    if (this.removingActors.has(actor)) return;
    this.removingActors.add(actor);
    this.overlay.retireSwitcher(actor);
    this.subsystems.retireActor(actor);
    this.admission.dropActor(actor);
    const slotId = this.actorSlot(actor);
    const ownsSlot = () => slotId !== undefined && this.renderSlots.owner(slotId) === actor;
    try {
      if (ownsSlot()) this.audioParticles.stopAudio(actor);
      if (ownsSlot()) this.audioParticles.stopParticles(actor);
      if (ownsSlot()) this.emit({ type: "despawn", slotId: slotId!, actorGuid: actor.guid });
    } finally {
      if (ownsSlot()) this.renderSlots.release(actor.guid, slotId!);
      this.overlay.forgetActor(actor);
      this.world.destroyActorInstance(actor);
      this.tweens.cancelInvalid();
      this.removingActors.delete(actor);
    }
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
    const { name } = matchCommandName(tokenize(command.trim()), new Set(this.commands.list().map(entry => entry.name.toLowerCase())));
    const user = this.commandClasses.get(name);
    if (this.demandAssetCatalog && user && this.assetPreloads.getState(user.assetGuid) !== "ready") {
      return { success: false, output: `Command ${name} is not prepared; use executeConsoleCommandAsync` };
    }
    return this.commands.execute(command, this.consoleHost());
  }

  async executeConsoleCommandAsync(command: string): Promise<CommandResult> {
    if (this.stopped) return { success: false, output: "The runtime session has ended" };
    const { name, rest } = matchCommandName(tokenize(command.trim()), new Set(this.commands.list().map(entry => entry.name.toLowerCase())));
    const user = this.commandClasses.get(name);
    if (!user) return this.executeConsoleCommand(command);
    const definition = this.commands.get(name);
    if (!definition) return { success: false, output: `Unknown command: ${name}` };
    const parsed = parseCommandArgs(rest, definition.parameters);
    if (!parsed.ok) return { success: false, output: parsed.output };
    let preloadId = "";
    try {
      if (this.demandAssetCatalog) {
        const result = await this.assetPreloads.acquire([user.assetGuid], `Console Command ${name}`);
        if (!result.success) return { success: false, output: `Command ${name} (${user.assetGuid}): ${result.errorMessage}` };
        preloadId = result.preloadId;
      }
      this.consoleLifetime.signal.throwIfAborted();
      return await this.scriptHost.invokeCommandAsync(user.classId, parsed.args, this.consoleLifetime.signal);
    } catch (error) {
      return { success: false, output: `Command ${name}: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (preloadId) this.assetPreloads.release(preloadId);
    }
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
    this.commands.register(createUserCommand(def));
  }

  bindUserCommand(
    def: Omit<UserCommandDef, "run"> & { classId: string },
  ): void {
    if (isReservedConsoleCommandName(def.name.toLowerCase())) return;
    const guid = this.classAssetGuids.get(def.classId);
    if (guid) this.commandClasses.set(def.name.toLowerCase(), { classId: def.classId, assetGuid: guid });
    this.registerUserCommand({
      ...def,
      run: (args) => this.scriptHost.invokeCommand(def.classId, args),
    });
  }

  listConsoleCommands(): readonly RegisteredCommand[] {
    return this.commands.list();
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
    if (this.sessionMode === "simulate") {
      // Source scopes are acquired/released on demand. Retention must validate
      // against current owned source metadata, including newly prepared types.
      this.simulationOwnedAssets = retained;
      this.simulationDataAssets = content.dataAssets;
    }
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

  private consoleHost(): ConsoleCommandHost {
    return {
      changeScene: (scene) => this.sceneRealizer.change(scene),
      quality: (group, choice, value) => this.scalability.executeQuality(group, choice, value),
      setRenderPath: (path) => {
        this.requestScalability({ kind: "patch", render: { renderPath: path ?? this.scalabilityProjectRenderPath } });
      },
      getRenderPath: () => this.lastRenderPathStatus,
      setLightsDebug: (enabled) => this.emit({ type: "setLightsDebug", enabled }),
      setFrameCap: (fps) => {
        this.requestScalability({ kind: "patch", frameCap: fps > 0 ? fps : DEFAULT_PLAY_FRAME_CAP });
      },
      getFrameCap: () => this.scalability.requested.frameCap,
      setVolume: (volume) => {
        this.volume = Number(volume);
        this.emit({ type: "setGlobalVolume", volume: this.volume });
      },
      getVolume: () => this.volume,
      quit: () => {
        this.stop();
      },
      setShowFps: (enabled) => {
        this.emit({ type: "setShowFps", enabled: Boolean(enabled) });
      },
      setStat: (name, enabled) => {
        if (enabled) this.emit({ type: "setShowFps", enabled: true });
        this.emit({ type: "setStat", name, enabled: Boolean(enabled) });
      },
      setShowCollision: (enabled) => this.physics.setShowCollision(enabled),
      setShowBounds: (enabled) => {
        this.emit({ type: "setShowBounds", enabled: Boolean(enabled) });
      },
      setWireframe: (enabled) => {
        this.emit({ type: "setWireframe", enabled: Boolean(enabled) });
      },
      setShowNav: (enabled) => {
        this.emit({ type: "setShowNav", enabled: Boolean(enabled) });
      },
      setShowPathfinding: (enabled) => this.navigation.setShowPathfinding(enabled),
      setShowNavAgent: (enabled) => this.navigation.setShowNavAgent(enabled),
      setBehaviourTreeDebug: (enabled) => this.behaviourTrees.setDebug(enabled),
      setShowAudioDebug: (enabled) => {
        this.emit({ type: "setShowAudioDebug", enabled: Boolean(enabled) });
      },
      dumpActors: () => formatDumpActors(this.inspectWorld()),
      inspectActor: (query) =>
        formatInspectActor(this.inspectWorld(), query, null),
      possessActorCamera: (query) => {
        const target = this.resolveConsoleActor(query);
        if (!(target instanceof Actor)) return target;
        if (!target.components.some((component) =>
          component.classId === "CameraComponent" && !component.destroyed,
        ) || this.actorSlot(target) === undefined) {
          return { success: false, output: `actor '${query}' has no live camera` };
        }
        this.emit({ type: "setFreeCam", enabled: false });
        this.possessCamera(target);
        return { success: true, output: `possessed ${target.guid}` };
      },
      destroyActor: (query) => {
        const target = this.resolveConsoleActor(query);
        if (!(target instanceof Actor)) return target;
        this.audioParticles.stopAudio(target);
        this.audioParticles.stopParticles(target);
        this.world.destroyActor(target.guid);
        if (!this.ticks.processing && !this.flushingConsoleActors) {
          this.flushingConsoleActors = true;
          try {
            this.world.flushPending();
            this.physics.main.syncFromWorld(this.world);
            this.physics.overlay.syncFromWorld(this.world);
            this.snapshots.publish();
            this.physics.emitDebugColliders();
          } finally {
            this.flushingConsoleActors = false;
          }
        }
        return { success: true, output: `destroyed ${target.guid}` };
      },
      setFreeCam: (enabled) => {
        this.emit({ type: "setFreeCam", enabled: Boolean(enabled) });
      },
      pause: () => {
        this.pause();
        this.emit({ type: "sessionPaused", paused: this.paused });
      },
      resume: () => {
        this.resume();
        this.emit({ type: "sessionPaused", paused: this.paused });
      },
      step: () => {
        const wasPaused = this.pauseReasons.has("user");
        this.resume();
        this.tick();
        if (wasPaused) this.pause();
      },
      setTimeDilation: (rate) => {
        this.timeDilation = Math.min(8, Math.max(0, Number(rate)));
      },
      getTimeDilation: () => this.timeDilation,
      dumpLog: () =>
        this.logs
          .entries()
          .map((entry) => entry.message)
          .join("\n"),
      startSnapshot: () => {
        if (this.sessionMode === "simulate") return { success: false, output: "Use Play or Preview Build to record diagnostics." };
        return this.ticks.startTrace();
      },
      stopSnapshot: () => {
        this.ticks.finalizeTrace();
      },
    };
  }

  private resolveConsoleActor(query: string): Actor | CommandResult {
    const key = query.trim();
    if (!key) return { success: false, output: "an actor GUID or unique exact name is required" };
    const actors = this.world.getActors().filter((actor) => !actor.destroyed);
    const byGuid = actors.find((actor) => actor.guid === key);
    if (byGuid) return byGuid;
    const matches = actors.filter((actor) => {
      const name = actor.getVariable("name");
      return (typeof name === "string" && name.length > 0 ? name : actor.classId) === key;
    });
    if (matches.length === 1) return matches[0]!;
    return {
      success: false,
      output: matches.length > 1
        ? `actor name '${key}' is ambiguous; use its GUID`
        : `no live actor matches '${key}'`,
    };
  }

  private applyActorDefaults(actor: Actor): void {
    for (const component of actor.components) {
      this.scriptHost.bindInterfaceHandlers(component);
    }
    const resolved = resolveActorDefaults(
      this.world.classRegistry.ancestry(actor.classId)
        .map((classId) => this.scriptHost.scriptsFor(classId)[0]?.actorDefaults),
    );
    actor.generateHitEvents = resolved.generateHitEvents;
    actor.generateOverlapEvents = resolved.generateOverlapEvents;
    actor.tickEnabled = resolved.eventTick;
  }

  /**
   * Loaded data can hold parent cycles that script writes would refuse. Once a
   * scene, streamed scene or SceneLayer batch has spawned (before readiness,
   * Begin Play, physics or the crowd see it), clear the link that closes each
   * cycle in spawn order and warn once per cleared link. `detach` gives the
   * actor the parent a root of its batch has (default: none).
   */
  private breakLoadedParentCycles(batch: Iterable<Actor>, detach?: (child: Actor) => void): void {
    for (const { child, parent } of breakParentCycles(batch, (guid) => this.world.findActor(guid), detach)) {
      this.reportLog(
        `Loaded parent cycle broken: ${actorLabel(child)} is no longer parented to ${actorLabel(parent)}.`,
        "warning",
        "actor",
      );
    }
  }

  private realizeActor(actor: Actor, checkpoint: () => void = () => {}): void {
    checkpoint();
    this.boundaries.trackRealized(actor);
    if (this.world.classRegistry.isA(actor.classId, "RenderTargetCapture") && !captureComponent(actor) && !actor.sceneLayerId) {
      attachSerializedComponents(this.world, actor, [{
        id: `${actor.guid}:capture`, classId: "RenderTargetCaptureComponent", properties: createDefaultRenderTargetCaptureProperties(),
      }]);
    }
    this.applyActorDefaults(actor);
    // Reject invalid draft primitives while the host still owns the Scene load.
    // Deferring this until native physics boot left the host at Realizing Scene.
    for (const component of actor.components) {
      if (component.classId !== "ColliderComponent" || component.destroyed) continue;
      const shape = component.getVariable("shape");
      const kind = shape && typeof shape === "object" ? (shape as { kind?: unknown }).kind : undefined;
      if (kind === "convex" || kind === "mesh" || kind === "polygon" || kind === "chain") continue;
      try {
        parseColliderProperties({ shape }, actor.sceneLayerId ? "2d" : this.physics.kind);
      } catch (error) {
        throw new Error(`${actorLabel(actor)} / ${component.guid}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    const slotId = this.assignSlot(actor);
    checkpoint();
    this.renderEmitter.emitMeshAssignment(actor, slotId);
    checkpoint();
    this.audioParticles.emitAudio(actor);
    checkpoint();
    this.audioParticles.emitParticles(actor);
    checkpoint();
    this.world.spawnActorNow(actor);
    checkpoint();
    this.admission.flushSpawned(actor);
    checkpoint();
    // The frame index answers first-spawned: a new actor enters only when no
    // earlier live actor already holds its guid.
    if (this.world.findActor(actor.guid) === actor) this.navFrameActors?.set(actor.guid, actor);
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

  private seedDefaultActors(): void {
    const actor = this.world.createActor({
      classId: "Enemy",
      variables: { speed: 1, n: 0 },
      hooks: {
        onTick: (self, ctx) => {
          const speed = Number(self.getVariable("speed") ?? 1);
          const bump = ctx.world.rngNextFloat() * speed;
          self.setVariable("n", Number(self.getVariable("n")) + bump);
          self.transform.position.x += bump;
          self.transform.position.y += bump * 0.5;
        },
      },
    });
    this.world.spawnActorNow(actor);
    this.assignSlot(actor);

    const second = this.world.createActor({
      classId: "Actor",
      variables: { tag: "follower" },
      hooks: {
        onTick: (self, ctx) => {
          self.transform.position.z += ctx.world.rngNextFloat() * 0.1;
        },
      },
    });
    this.world.spawnActorNow(second);
    this.assignSlot(second);
  }

  private assignSlot(actor: Actor): number {
    const slotId = this.renderSlots.allocate(actor);
    const stream = this.streams.actorInstance(actor);
    this.emit({
      type: "spawn",
      slotId,
      actorGuid: actor.guid,
      classId: actor.classId,
      ...(actor.sceneLayerId ? { sceneLayerId: actor.sceneLayerId } : {}),
      ...(stream ? { sceneStreamActorGuid: stream.actor.guid, streamLoadId: stream.loadId } : {}),
    });
    return slotId;
  }

  /** The render slot this actor's own commands target (`RenderSlots.actorSlot`). */
  private actorSlot(actor: Actor): number | undefined {
    return this.renderSlots.actorSlot(actor);
  }

  /** The slot of a guid's first-spawned live actor, the one guid lookups resolve. */
  private guidSlot(guid: string): number | undefined {
    return this.renderSlots.guidSlot(guid);
  }

  private bindGameInstance(): void {
    if (this.gameInstanceBound) return;
    this.gameInstanceBound = true;
    const classId = this.gameInstanceClass;
    const hooks = this.gameLifecycleHooks(classId);
    this.world.setGameInstance(
      this.world.createGameInstance({
        classId,
        guid: "runtime-gi",
        variables: { ticks: 0 },
        hooks: {
          ...hooks,
          onTick: (self, ctx) => {
            self.setVariable(
              "ticks",
              Number(self.getVariable("ticks")) + 1,
            );
            hooks.onTick(self, ctx);
          },
        },
      }),
    );
  }

  /**
   * Script binding shared by the Game Instance and GameSubsystems (full
   * parity). Scripts resolve lazily, so objects built before `loadScripts`
   * still run them. On End, and On Scene Exit once Play stops, are the final
   * lifecycle.
   */
  private gameLifecycleHooks(classId: string): GameLifecycleHooks {
    const sceneEvent = (event: string) => (self: BObject, sceneName: string) => {
      this.admission.run(self, () => this.admission.guard(() => this.scriptHost.invokeEvent(classId, event, self, { sceneName })));
    };
    return {
      onCreation: (self) => {
        const hooks = this.scriptHost.hooksFor(classId);
        this.admission.runCreation(self, () => hooks?.onCreation?.(self));
      },
      onTick: (self, ctx) => {
        const hooks = this.scriptHost.hooksFor(classId);
        this.admission.guard(() => hooks?.onTick?.(self, ctx));
      },
      onGameEnd: (self) => {
        this.admission.guard(() =>
          this.scriptHost.invokeGameShutdownEvent(classId, "onEnd", self),
        );
      },
      onSceneStartLoading: sceneEvent("onSceneStartLoading"),
      onSceneFinishLoading: sceneEvent("onSceneFinishLoading"),
      onFirstSceneLoaded: sceneEvent("onFirstSceneLoaded"),
      onSceneExit: (self, sceneName) => {
        this.admission.guard(() => {
          if (this.stopped) {
            this.scriptHost.invokeGameShutdownEvent(classId, "onSceneExit", self, { sceneName });
          } else {
            this.admission.run(self, () => this.scriptHost.invokeEvent(classId, "onSceneExit", self, { sceneName }));
          }
        });
      },
    };
  }

  private gameSubsystemHooks(classId: string): GameSubsystemHooks {
    const hooks = this.gameLifecycleHooks(classId);
    return {
      ...hooks,
      onGameEnd: (self) => {
        this.subsystemMatches.clear();
        hooks.onGameEnd(self);
      },
    };
  }

  /**
   * Script binding for a SceneSubsystem the World creates with the main Scene.
   * Interface handlers bind at creation, so it is callable while the Scene
   * prepares. On Init and every notification wait in its owner queue until
   * the Scene may run, preserving the World's order (On Init first). On End
   * is final and always runs, dropping anything still queued.
   */
  private sceneSubsystemHooks(classId: string): SceneSubsystemHooks {
    const notify = (self: SceneSubsystem, event: string, args: Record<string, unknown>) => {
      if (!this.sceneSubsystemNotificationsMuted()) this.runSceneSubsystemEvent(self, classId, event, args);
    };
    return {
      onCreation: (self) => {
        this.subsystemMatches.clear();
        this.scriptHost.bindInterfaceHandlers(self);
        this.admission.runCreation(self, () => this.scriptHost.hooksFor(classId)?.onCreation?.(self));
      },
      onTick: (self, ctx) =>
        this.admission.guard(() => this.scriptHost.hooksFor(classId)?.onTick?.(self, ctx)),
      onEnd: (self) => {
        this.subsystemMatches.clear();
        this.admission.drop(self);
        this.admission.guard(() => this.scriptHost.invokeGameShutdownEvent(classId, "onEnd", self));
      },
      onSceneLoaded: (self, sceneName) => notify(self, "onSceneLoaded", { sceneName }),
      onStreamedSceneLoaded: (self, streamingActor, scene) =>
        notify(self, "onStreamedSceneLoaded", { streamingActor, scene }),
      onStreamedSceneUnloaded: (self, streamingActor, scene) =>
        notify(self, "onStreamedSceneUnloaded", { streamingActor, scene }),
      onSceneLayerAdded: (self, sceneLayer) => notify(self, "onSceneLayerAdded", { sceneLayer }),
      onSceneLayerRemoved: (self, sceneLayer) => notify(self, "onSceneLayerRemoved", { sceneLayer }),
      onSceneActorSpawned: (self, actor) => {
        if (this.sceneSubsystemNotificationsMuted()) return;
        // The World announces at spawn commit; the actor enters play when its
        // own queue runs, so Spawned waits there, right before its Begin Play.
        this.admission.run(actor, () => {
          if (self.ended) return;
          let entered = this.sceneSubsystemActors.get(self);
          if (!entered) this.sceneSubsystemActors.set(self, entered = new WeakSet());
          entered.add(actor);
          this.runSceneSubsystemEvent(self, classId, "onSceneActorSpawned", { actor });
        });
      },
      onSceneActorDestroyed: (self, actor) => {
        if (this.sceneSubsystemActors.get(self)?.delete(actor)) notify(self, "onSceneActorDestroyed", { actor });
      },
    };
  }

  /**
   * The main Scene's own teardown is silent for its SceneSubsystems: Stop
   * (streams, layers, the cancelled realization), Change Scene's stream
   * retirement and a failed realization's cleanup.
   */
  private sceneSubsystemNotificationsMuted(): boolean {
    return this.stopped || this.sceneTeardownDepth > 0;
  }

  private duringSceneTeardown(teardown: () => void): void {
    this.sceneTeardownDepth++;
    try {
      teardown();
    } finally {
      this.sceneTeardownDepth--;
    }
  }

  /** Dispatch after On Init and any earlier queued notification, in order. */
  private runSceneSubsystemEvent(
    subsystem: SceneSubsystem,
    classId: string,
    event: string,
    args: Record<string, unknown>,
  ): void {
    this.admission.runAfterQueued(subsystem, () =>
      this.admission.guard(() => this.scriptHost.invokeEvent(classId, event, subsystem, args)));
  }

  /**
   * `Get <Subsystem>`: compiled graphs evaluate it at every use, so matches
   * are cached until the live subsystems change. More than one match takes
   * the first (class-id order) and warns once per class id.
   */
  private findSubsystem(classId: string): Subsystem | null {
    let matches = this.subsystemMatches.get(classId);
    if (!matches) {
      matches = this.world.findSubsystems(classId);
      this.subsystemMatches.set(classId, matches);
      if (matches.length > 1 && !this.ambiguousSubsystemWarnings.has(classId)) {
        this.ambiguousSubsystemWarnings.add(classId);
        this.reportLog(
          `Get ${classId} matches ${matches.length} subsystems (${matches.map((match) => match.classId).join(", ")}); using ${matches[0]!.classId}.`,
          "warning",
          "subsystem",
        );
      }
    }
    return matches[0] ?? null;
  }

  private registerPlaySceneTypes(): void {
    const guids = new Set<string>();
    if (this.playSceneGuid) guids.add(this.playSceneGuid);
    for (const guid of this.sceneGuidByKey.values()) {
      if (guid) guids.add(guid);
    }
    for (const guid of guids) {
      this.world.classRegistry.ensure({
        id: sceneAssetClassId(guid),
        parentClassId: "Scene",
        kind: "object",
        variables: [],
        implementedInterfaces: [],
      });
    }
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
    this.consoleLifetime.abort(new Error("The runtime session has ended"));
    this.layers.rejectWaiters();
    this.stopped = true;
    this.ticks.stopDiagnostics();
    this.materialEditGate?.cancel("The game session has stopped.");
    if (this.inspectorRequests.length) this.flushInspectorRequests();
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
    for (const classId of [...new Set([...this.scriptSources.values()].map((script) => script.classId))]
      .sort((a, b) => this.world.classRegistry.ancestry(b).length - this.world.classRegistry.ancestry(a).length))
      this.world.classRegistry.unregister(classId);
    this.scriptSources.clear();
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
    if (this.simulationQuiescent && !paused) return;
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

  private markUnsupportedSimulationInstance(kind: "stream" | "layer", id: string): void {
    if (this.sessionMode !== "simulate" || this.simulationUnsupportedInstance) return;
    this.simulationUnsupportedInstance = { kind, id };
    this.emit({ type: "simulationRetentionUnavailable", sessionGeneration: this.sessionGeneration,
      reason: `Keep cannot retain an independent ${kind === "layer" ? "SceneLayer" : "streamed Scene"} instance (${id}), including one removed before Stop.` });
  }

  quiesceSimulation(request: SimulationQuiesceRequest): Promise<SessionBoundaryResult> {
    return new Promise(resolve => queueMicrotask(() => {
      const boundaryRequest: SessionBoundaryRequest = { ...request, action: { kind: "resetInput" } };
      const invalid = request.sessionGeneration !== this.sessionGeneration ? "Stale session generation." :
        this.sessionMode !== "simulate" ? "Final scene capture is available only during Simulation Play." :
        this.stopped ? "The game session has stopped." :
        !Number.isSafeInteger(request.requestId) || request.requestId <= this.lastCaptureRequestId ? "Invalid or superseded capture request ID." : null;
      if (invalid) { resolve(this.boundaries.result(boundaryRequest, invalid)); return; }
      this.lastCaptureRequestId = request.requestId;
      this.setPauseReason("loading", true);
      this.materialEditGate?.cancel("Simulation is stopping; the pending material edit was cancelled.");
      this.simulationQuiescent = true;
      this.resetInputState();
      if (this.inspectorRequests.length) this.flushInspectorRequests();
      this.snapshots.flushDeferred();
      resolve(this.boundaries.result(boundaryRequest));
    }));
  }

  captureSimulationState(request: SimulationCaptureRequest): Promise<SimulationSceneCaptureResult> {
    return new Promise(resolve => queueMicrotask(() => {
      const identity: SimulationCaptureIdentity = { generation: this.sessionGeneration, sceneAssetGuid: this.playSceneGuid,
        sceneInstanceId: this.world.currentScene?.guid ?? "", sceneLoadId: this.sceneRealizer.loadId,
        tickIndex: this.world.clock.tickIndex, commandRevision: this.commandRevision };
      const fail = (reason: string, code: "boundary" | "ownership" | "budget" | "resource" = "boundary") => resolve({ ok: false, code, path: "scene", reason, identity });
      if (request.sessionGeneration !== this.sessionGeneration || !Number.isSafeInteger(request.requestId) || request.requestId <= this.lastCaptureRequestId) { fail("Stale or superseded capture request."); return; }
      this.lastCaptureRequestId = request.requestId;
      if (this.stopped || !this.simulationQuiescent || !this.simulationBaseline || !this.simulationStart || this.sessionMode !== "simulate") { fail("A live Simulation must acknowledge its final quiescent boundary before capture."); return; }
      if (this.materialEditGate?.busy || this.materialEditGate?.ownershipFailure) { fail(this.materialEditGate.ownershipFailure ?? "A material edit is still pending.", "ownership"); return; }
      if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 64 * 1024 * 1024)) { fail("Invalid final scene capture budget.", "budget"); return; }
      try {
        const scene = this.world.currentScene;
        if (!scene || this.sceneRealizer.blocked || this.bootLoading || this.streams.blocking) { fail("Scene loading has not reached a complete final boundary."); return; }
        const postProcessStack: typeof scene.postProcessStack = [];
        for (const entry of scene.postProcessStack) {
          const material = getPostProcessMaterialObject(scene, entry.id ?? "");
          const overrides = material ? this.materialParameters.captureOverrides(material) : null;
          if (!overrides) { fail(`Post-process material ${entry.materialGuid} has no complete current authoring parameter state.`, "resource"); return; }
          postProcessStack.push({ ...entry, parameters: overrides });
        }
        if (postProcessStack.some(entry => !this.simulationOwnedAssets.has(entry.materialGuid))) { fail("A post-process material has no prepared authoring asset.", "resource"); return; }
        const schemas = dataTypeSchemas(this.simulationDataAssets ?? []);
        resolve(captureSimulationScene({ world: this.world, baseline: this.simulationBaseline, identity, startingScene: this.simulationStart,
          quiescent: true, renderRevision: request.renderRevision, maxBytes: request.maxBytes,
          sceneSettings: { ...this.simulationBaseline.settings, gravity: [this.physics.gravity[0], this.physics.gravity[1], this.physics.gravity[2]], postProcessStack },
          ownership: actor => actor.sceneLayerId ? "layer" : this.streams.isStreamActor(actor) ? "stream" : "root",
          independentInstances: this.simulationUnsupportedInstance ? [this.simulationUnsupportedInstance] : [],
          materialOverrides: component => {
            const material = component.getVariable("materialObject");
            return material instanceof MaterialObject ? this.materialParameters.captureOverrides(material) : null;
          },
          prefabComponents: classId => this.world.classRegistry.ancestry(classId).flatMap(ancestor => this.scriptHost.scriptsFor(ancestor))
            .find(script => script.components !== undefined)?.components ?? [],
          assetExists: guid => this.simulationAssets.has(guid) || this.simulationOwnedAssets.has(guid),
          structFields: guid => schemas.structs[guid]?.fields.map(field => ({ ...field, type: field.typeId })) ?? null,
          enumMembers: guid => schemas.enums[guid]?.members.map(member => member.name) ?? null,
        }));
      } catch (error) { fail(error instanceof Error ? error.message : "Final scene capture failed."); }
    }));
  }

  private inspectorActorReady(actor: Actor): boolean {
    if (this.simulationQuiescent || this.stopped || this.boundaries.saveBoundaryActive || actor.destroyed || actor.world !== this.world || this.world.findActorInstances(actor.guid).length !== 1 || this.streams.blocking || !this.streams.actorReady(actor)) return false;
    return actor.sceneLayerId ? this.layers.get(actor.sceneLayerId)?.ready === true : !this.sceneRealizer.blocked && !this.bootLoading;
  }

  private getRuntimeInspector(): RuntimeInspector {
    return this.runtimeInspector ??= new RuntimeInspector({
      world: this.world, materials: this.materialParameters, sessionGeneration: this.sessionGeneration,
      canWrite: () => this.sessionMode === "simulate" && !this.simulationQuiescent, stopped: () => this.stopped,
      ready: actor => this.inspectorActorReady(actor),
      renderSlot: actor => this.renderSlots.recordedSlot(actor),
      resolvePick: (guid, slot) => { const actor = this.renderSlots.owner(slot); return actor && !actor.destroyed && actor.world === this.world && actor.guid === guid ? actor : null; },
      sceneIdentity: actor => {
        const stream = this.streams.actorInstance(actor);
        if (stream) return `stream:${stream.actor.guid}:${stream.loadId}`;
        if (actor.sceneLayerId) return `layer:${actor.sceneLayerId}:${this.layers.get(actor.sceneLayerId)?.loadId ?? -1}`;
        return `scene:${this.playSceneGuid}:${this.sceneRealizer.loadId}:${this.world.currentScene?.guid ?? ""}`;
      },
      boundary: () => ({ tickIndex: this.world.clock.tickIndex, frameId: this.frameId,
        commandRevision: this.commandRevision, structuralRevision: this.world.structuralRevision }),
      applyProperty: (target, key, value) => {
        const materialAssignment = target instanceof ActorComponent && key === "materialGuid";
        const priorSourcePresent = materialAssignment && target.variables.has("materialSource");
        const priorSource = materialAssignment ? target.getVariable("materialSource") : undefined;
        const prior = target instanceof Actor && key === "generateHitEvents" ? target.generateHitEvents :
          target instanceof Actor && key === "generateOverlapEvents" ? target.generateOverlapEvents : target.getVariable(key);
        const apply = (next: unknown) => {
          if (target instanceof Actor && key === "generateHitEvents") target.generateHitEvents = next as boolean;
          else if (target instanceof Actor && key === "generateOverlapEvents") target.generateOverlapEvents = next as boolean;
          else target.setVariable(key, next);
          if (target instanceof ActorComponent) this.refreshRuntimeComponent(target, key);
        };
        // An explicit None is a real override too, including an untouched model slot.
        if (materialAssignment) target.setVariable("materialSource", "override");
        try { apply(value); } catch (error) {
          if (materialAssignment) {
            if (priorSourcePresent) target.setVariable("materialSource", priorSource);
            else target.variables.delete("materialSource");
          }
          apply(prior); throw error;
        }
        if (target instanceof Actor && key === "visible") this.publishInspectorSnapshot(target);
      },
      applyTransform: (target, transform, space) => {
        const prior = target.transform;
        const actor = target instanceof Actor ? target : target.owner!;
        const affected = [actor];
        if (target instanceof Actor) {
          const ids = new Set([actor.guid]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const candidate of this.world.getActors()) {
              if (candidate.destroyed || candidate.sceneLayerId !== actor.sceneLayerId || ids.has(candidate.guid) || !ids.has(String(candidate.getVariable("parentId") ?? ""))) continue;
              affected.push(candidate); ids.add(candidate.guid); changed = true;
            }
          }
        }
        if (affected.some(entry => entry.components.some(component => !component.destroyed && component.classId === "RagdollComponent")))
          throw new Error("This transform moves an articulated body; preserving its live state requires a new session.");
        const apply = () => {
          for (const affectedActor of affected) {
            this.ragdolls.retireActor(affectedActor);
            this.physics.forActor(affectedActor).teleportActor(affectedActor, this.world);
          }
        };
        target.transform = runtimeEditLocalTransform(this.world, target, transform, space);
        try { apply(); } catch (error) { target.transform = prior; apply(); throw error; }
        if (target instanceof ActorComponent) {
          const slotId = this.renderSlots.recordedSlot(actor);
          if (slotId !== undefined) this.renderEmitter.emitComponentTransforms(actor, slotId);
        }
        this.publishInspectorSnapshot(actor);
      },
      applyMaterial: (component, name, value) => {
        const material = component.getVariable("materialObject");
        return material instanceof MaterialObject && this.setMaterialParameter(material, name, value, true);
      },
    });
  }

  private getMaterialEditGate(): RuntimeMaterialEditGate {
    return this.materialEditGate ??= new RuntimeMaterialEditGate({ generation: this.sessionGeneration,
      inspector: this.getRuntimeInspector(), materials: this.materialParameters,
      slot: component => component.owner ? this.renderSlots.recordedSlot(component.owner) : undefined,
      acquireSource: this.demandAssetCatalog ? async (component, guids, signal) => {
        const result = await this.assetPreloads.acquire(guids, component.guid, {}, signal);
        if (!result.success) throw new Error(result.errorMessage || "Material source preparation failed.");
        return result.preloadId;
      } : undefined,
      releaseSource: id => this.assetPreloads.release(id),
      emit: command => this.emit(command),
      execute: (request, preparation) => {
        const emission = { preparation, emitted: false }; this.materialEditEmission = emission;
        try { return { result: this.getRuntimeInspector().execute(request), emitted: emission.emitted }; }
        finally { this.materialEditEmission = null; }
      },
      restore: component => {
        const actor = component.owner; const slot = actor ? this.renderSlots.recordedSlot(actor) : undefined;
        if (slot === undefined) throw new Error("Material owner is unavailable.");
        this.renderEmitter.emitMaterialAssignments([component], slot, true);
        const material = component.getVariable("materialObject");
        if (material instanceof MaterialObject) for (const [name, value] of Object.entries(this.materialParameters.describe(material) ?? {}))
          this.setMaterialParameter(material, name, value, true);
      },
    });
  }

  applyRuntimeMaterialEditResult(message: Extract<ControlMessage, { type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" }>): void {
    if (!this.materialEditGate || this.stopped) return;
    queueMicrotask(() => { if (!this.stopped) this.materialEditGate?.receive(message); });
  }

  private publishInspectorSnapshot(actor: Actor): void {
    // Presentation identity advances, while tick index, delays and physics do not.
    this.frameId++;
    const slotId = this.renderSlots.recordedSlot(actor);
    if (slotId !== undefined) this.emit({ type: "resetActorInterpolation", actorGuid: actor.guid, slotId, frameId: this.frameId });
    this.snapshots.publish();
  }

  requestRuntimeInspector(request: RuntimeInspectorRequest): Promise<RuntimeInspectorResult> {
    const inspector = this.getRuntimeInspector();
    const invalid = inspector.validateRequest(request) ??
      (request.requestId <= this.lastInspectorRequestId ? "Invalid or superseded Inspector request ID." :
        this.inspectorRequests.length >= 32 ? "Runtime Inspector request queue is full." : null);
    if (invalid) return Promise.resolve(inspector.result(request, invalid));
    this.lastInspectorRequestId = request.requestId;
    const result = new Promise<RuntimeInspectorResult>(resolve => this.inspectorRequests.push({ request: structuredClone(request), resolve }));
    if (!this.inspectorScheduled) {
      this.inspectorScheduled = true;
      queueMicrotask(() => this.flushInspectorRequests());
    }
    return result;
  }

  cancelRuntimeInspector(request: { sessionGeneration: number; requestId: number }): void {
    if (request.sessionGeneration !== this.sessionGeneration || !Number.isSafeInteger(request.requestId)) return;
    const index = this.inspectorRequests.findIndex(entry => entry.request.requestId === request.requestId);
    if (index !== -1) {
      const [entry] = this.inspectorRequests.splice(index, 1);
      entry!.resolve(this.getRuntimeInspector().result(entry!.request, "Inspector request cancelled."));
    }
    this.materialEditGate?.cancelRequest(request.requestId);
  }

  private flushInspectorRequests(): void {
    this.inspectorScheduled = false;
    const inspector = this.getRuntimeInspector();
    for (const { request, resolve } of this.inspectorRequests.splice(0)) {
      if (this.deferMaterialEdits && !this.stopped && this.getMaterialEditGate().stage(request, resolve)) continue;
      resolve(inspector.execute(request));
    }
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
    if (this.sessionMode === "simulate" && (command.type === "spawn" || command.type === "assignMesh")) {
      const actor = this.renderSlots.owner(command.slotId);
      if (actor) command = command.type === "spawn" ? { ...command, runtimeIdentity: this.getRuntimeInspector().identity(actor) } :
        { ...command, runtimeComponentTokens: actor.components.filter(component => !component.destroyed).map(component => ({
          componentGuid: component.guid, componentToken: this.getRuntimeInspector().identity(component).componentToken! })) };
    }
    const emission = this.materialEditEmission;
    if (emission && (command.type === "assignMaterial" || command.type === "setMaterialParameter") &&
      command.slotId === emission.preparation.slotId && command.componentId === emission.preparation.componentId &&
      command.materialAssetGuid === emission.preparation.materialGuid &&
      (emission.preparation.parameterName === undefined ? command.type === "assignMaterial" :
        command.type === "setMaterialParameter" && command.parameterName === emission.preparation.parameterName)) {
      command = { ...command, preparedEditToken: emission.preparation.editToken }; emission.emitted = true;
    }

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

  private canSpawnActorClass(classId: string): boolean {
    if (!shouldSpawnScriptedActor(classId)) return false;
    const classes = this.world.classRegistry;
    if (classes.isA(classId, "SceneLayerActor")) return false;
    // Registration copies the parent's kind; a repaired parent (see
    // registerScriptClass) can change it, so read it from the engine base.
    const engineBase = classes.ancestry(classId).find(isLockedEngineClassId);
    const kind = classes.get(engineBase ?? classId)?.kind;
    return kind !== "object" && kind !== "gameInstance";
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * Order scripts so a user parent class registers before its children; the
 * incoming order is kept otherwise. A parent that is missing, or reached again
 * through a parent cycle, falls back to `Actor` like any unknown parent.
 */
function parentFirstScriptOrder(
  scripts: readonly CompiledScript[],
  isRegistered: (classId: string) => boolean,
): CompiledScript[] {
  const indicesByClassId = new Map<string, number[]>();
  scripts.forEach((script, index) => {
    const indices = indicesByClassId.get(script.classId) ?? [];
    indices.push(index);
    indicesByClassId.set(script.classId, indices);
  });
  const visited = new Set<number>();
  const ordered: CompiledScript[] = [];
  const visit = (index: number): void => {
    if (visited.has(index)) return;
    visited.add(index);
    const script = scripts[index]!;
    const parentClassId = script.parentClassId?.trim();
    if (parentClassId && parentClassId !== script.classId && !isRegistered(parentClassId)) {
      for (const parentIndex of indicesByClassId.get(parentClassId) ?? []) visit(parentIndex);
    }
    ordered.push(script);
  };
  scripts.forEach((_, index) => visit(index));
  return ordered;
}
