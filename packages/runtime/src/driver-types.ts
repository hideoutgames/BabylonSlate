import type {
  CommandMessage,
  ControlMessage,
  DiagnosticOperationRequest,
  DiagnosticOperationResult,
  GameSessionMode,
  RuntimeInspectorRequest,
  RuntimeInspectorResult,
  RuntimeSceneContent,
  SessionBoundaryRequest,
  SessionBoundaryResult,
  SessionPauseReason,
  SimulationCaptureRequest,
  SimulationQuiesceRequest,
} from "@babylonslate/bridge";
import type { AnimClipCatalogEntry, AnimGraphDocument } from "@babylonslate/anim-graph";
import type { ModelPayload, SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import type { BehaviourTreeDocument, BlackboardDocument } from "@babylonslate/behaviour-tree";
import type {
  CollisionTriangleMesh,
  FocusNavigationSettings,
  InputAssetDefinition,
  MaterialParameterCatalog,
  OverlaySafeAreaInsets,
  RenderProjectSettings,
  RenderTargetPayload,
  RenderTargetTexturePayload,
  RuntimeAssetLoadState,
  SaveGameService,
  ScalabilityAcknowledgement,
  ScalabilityRequest,
  ScalabilityResult,
  ScalabilitySnapshot,
  SceneStreamingState,
  SerializedScene,
  SerializedSceneLayer,
  Transform,
  WaterDefinition,
} from "@babylonslate/core";
import type { RegisteredCommand, TraceBtState, TraceFrame, TracePayload, UserCommandDef } from "@babylonslate/debugger";
import type { InputBindingControls, InputMappings, RawInputEvent, ResolvedInputTick } from "@babylonslate/input";
import type { NavObstacleKind, NavPoint } from "@babylonslate/navigation";
import type { Actor, BObject, DebugInspectSnapshot, SceneLayer, World } from "@babylonslate/object-model";
import type { PhysicsWorldKind } from "@babylonslate/physics";
import type { RuntimeDiagnostic, SessionDiagnosticAggregator } from "./diagnostics";
import type { LogRingBuffer, LogSeverity } from "./log-ring";
import type { PhysicsWorldSync } from "./physics-sync";
import type { CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { AcquireRuntimeScene } from "./scene-source";
import type { CompiledScript } from "./script-host";
import type { RuntimeSaveGameOptions } from "./session-boundaries";
import type { SimulationSceneCaptureResult } from "./simulation-scene-capture";
import type { AnchorEntry } from "./stack-map";

// The runtime driver's public types. `driver.ts` and the package index
// re-export them, so existing imports keep working.

export interface RuntimeDriverOptions {
  sessionGeneration?: number;
  sessionMode?: GameSessionMode;
  /** Catalog identity only; registering an available class never reads its source. */
  classAssetGuids?: Readonly<Record<string, string>>;
  consoleCommands?: ReadonlyArray<import("@babylonslate/core").ConsoleCommandMetadata & { classId: string; assetGuid: string }>;
  /** JSON data and shared Structures snapshotted at session startup. */
  dataAssets?: import("@babylonslate/core").DataAssetCatalogEntry[];
  /** Packaged authored assets the Asset Registry nodes query; omitted means an empty catalog. */
  assetCatalog?: readonly import("@babylonslate/core").RuntimeAssetCatalogEntry[];
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
  /**
   * Demo actors exist so an empty project still shows motion in Preview. Without
   * a `playScene` they spawn at the first `realizePlayWorld` or `start`, never
   * during construction.
   */
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
   * Instantiate `playScene` with compiled script hooks (without one, the demo
   * actors unless `seedDemoActors` is false). Idempotent. Call after
   * `loadScripts` so Begin Play binds on spawn.
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
  /** A Scene Layer instance's own physics world; null when the layer did not enable physics. */
  getSceneLayerPhysicsSync(layerGuid: string): PhysicsWorldSync | null;
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
  /** Time dilation (`slomo`) from the next tick, clamped to `0..8`; non-finite rates are ignored. */
  setTimeDilation(rate: number): void;
  /** Behaviour tree evaluation and ownership only; `restoreFromTrace` resumes the whole frame. */
  restoreBtFromTrace(states: readonly TraceBtState[]): void;
  /** Resume a frame's time dilation, behaviour trees, Animation Graphs, sprite clips and voices. */
  restoreFromTrace(frame: TraceFrame): void;
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
