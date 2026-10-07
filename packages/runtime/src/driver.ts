import { captureSimulationScene, type SimulationSceneCaptureResult, type SimulationCaptureIdentity } from "./simulation-scene-capture";
import { RuntimeMaterialEditGate } from "./runtime-material-edit-gate";
import { runtimeEditLocalTransform } from "./runtime-transform-edit";
import { RuntimeDiagnosticRecorder } from "./runtime-diagnostic-recorder";
import { RuntimeInspector } from "./runtime-inspector";
import { SceneLayerActorSwitchers } from "./scene-layer-actor-switcher";
import { RuntimeDataCatalog, dataTypeSchemas } from "./data-catalog";
import { overlayAnchorBindings } from "./overlay-anchor-layout";
import { SaveGameError, SaveGameService, type SaveGameServiceOptions } from "@babylonslate/core";
import { SaveGameWorld } from "./save-game-world";
import { RuntimeMaterialParameters } from "./runtime-material-parameters";
import { RuntimeAssetPreloads } from "./asset-preloads";
import type { RuntimeAssetLoadState, RuntimeAssetPreloadOptions, RuntimeAssetPreloadResult } from "@babylonslate/core";
import { SceneLayerFocusNavigation } from "./scene-layer-focus";
import { focusLayoutEntry, revealFocusedElement } from "./scene-layer-focus-layout";
import type { FocusNavigationSettings } from "@babylonslate/core";
import { CableWorldSync } from "./cable-sync";
import { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import { MovementWorldSync } from "./movement";
import { captureComponent, captureLocalTransform, captureProperties } from "./render-targets";
import { createDefaultRenderTargetCaptureProperties, normalizeRenderTargetPayload, normalizeRenderTargetTexturePayload, type RenderTargetPayload, type RenderTargetTexturePayload } from "@babylonslate/core";
import { normalizeWaterDefinition, normalizeWaterBody, normalizeWaterRemoval, waterKindForClass, type WaterDefinition } from "@babylonslate/core";
import { areaRectLightBindings, fogVolumeBindings, outlineBindings, deformerBindings, DEFORMER_PROPERTY_KEYS } from "@babylonslate/core";
import { ScalabilitySession, type ScalabilityRequest, type ScalabilityResult, type ScalabilitySnapshot, type ScalabilityAcknowledgement, type RenderPath, type RenderProjectSettings } from "@babylonslate/core";
import type { InputAssetDefinition } from "@babylonslate/core";
import { inputMappingsFromAssets } from "@babylonslate/input";
import {
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type CommandMessage,
  type ControlMessage,
  type RuntimeSceneContent,
  type DebugBehaviourTree,
  type DebugNavAgent,
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
  createWorldSnapshot,
  createDebugInspectSnapshot,
  stringifyWorldSnapshot,
  Actor,
  ActorComponent,
  BObject,
  GameInstance,
  GameSubsystem,
  MaterialObject,
  PostProcessMaterialObject,
  getPostProcessMaterialObject,
  type MaterialInstanceObject,
  Scene,
  SceneLayer,
  SceneStreamingActor,
  SceneSubsystem,
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  instantiableSubsystemClassIds,
  isLockedEngineClassId,
  isSceneLayerExclusiveComponent,
  sceneAssetClassId,
  hydrateClassVariableValue,
  hydrateScenePropertyReferences,
  type ClassKind,
  type DebugInspectSnapshot,
  type GameSubsystemHooks,
  type SceneSubsystemHooks,
  type Subsystem,
  type TickContext,
  type TickPhase,
  type SceneActorHooks,
} from "@babylonslate/object-model";
import {
  createDefaultSceneSettings,
  cloneSceneStreamingActorsSteps,
  DEFAULT_PLAY_FRAME_CAP,
  eulerDegreesToQuaternion,
  isSceneLayerDeniedComponent,
  parseSceneLayerAnchor,
  parseSceneLayerHitTest,
  parseOverlayPanelProperties,
  overlayPanelDestFromScale,
  parseSkyboxFaces,
  parseSkyboxSize,
  parseSpringArmProperties,
  SPRING_ARM_COMPONENT_CLASS_ID,
  parseText2DProperties,
  parseText3DProperties,
  normalizeSceneLayer,
  newGuid,
  sceneLayerRelativeAnchorWorldPosition,
  isSceneLayerAnchorActor,
  identityTransform,
  SCENE_LAYER_DEFAULT_LAYER_BOUNDS,
  deprojectCursorRay,
  type MaterialParameterCatalog,
  type MaterialParameterValue,
  type RenderPathStatus,
  type Transform,
  type SerializedActor,
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
import { runSceneRealizationWork, sceneRealizationCancelled, waitForSceneWork, type CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { AcquireRuntimeScene, RuntimeSceneSource } from "./scene-source";
import {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  parseColliderProperties,
  parseRigidBodyProperties,
  SoftwarePhysicsBackend,
  type PhysicsBackend,
  type PhysicsWorldKind,
} from "@babylonslate/physics";
import {
  createCommandRegistry,
  createUserCommand,
  tokenize,
  matchCommandName,
  parseCommandArgs,
  isReservedConsoleCommandName,
  TraceRecorder,
  createInfiniteLoopGuard,
  isInfiniteLoopError,
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  DEFAULT_INFINITE_LOOP_COUNT,
  shouldEmitStatsCommand,
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
import { componentIdFromColliderPhysicsId } from "./physics-collider-id";
import {
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
} from "./diagnostics";
import { mapStackToAnchor, type AnchorEntry } from "./stack-map";
import { parseJoystick2DProperties } from "@babylonslate/core";
import { Painter2DRuntime } from "./painter2d-runtime";
import { UIControls2DRuntime } from "./ui-controls2d-runtime";
import { isUIControl2DClass, isInteractiveUIControl2DClass } from "@babylonslate/core";
import { Text2DAppearRuntime } from "./text2d-appear-runtime";
import { TweenRuntime } from "./tween-runtime";
import { parseOverlayVisualStyle, supportsOverlayVisualStyle } from "@babylonslate/core";
import {
  animGraphScriptClassId,
  animRuleScriptClassId,
  clipForState,
  defaultAnimVariableValue,
  evaluateAnimGraph,
  type AnimClipCatalogEntry,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
} from "@babylonslate/anim-graph";
import {
  evaluateBehaviourTree,
  builtinClassId,
  type BehaviourTreeDocument,
  type BlackboardDocument,
  type BlackboardValues,
  type BtEvalState,
  type BtResult,
} from "@babylonslate/behaviour-tree";
import { ScriptHost, compiledScriptKey, compiledScriptSourceLabel, type CompiledScript } from "./script-host";
import { COMPILED_MODULE_LINE_OFFSET } from "./module-loader";
import { shouldSpawnScriptedActor } from "./play-load";
import { actorLocalPhysicsTransform, PhysicsWorldSync } from "./physics-sync";
import { RagdollWorldSync } from "./ragdoll-sync";
import {
  formatDumpActors,
  formatInspectActor,
} from "./console-inspect";
import { actorChainWorldTransform, actorLabel, actorParentGuid, breakParentCycles, composeActorWorldTransforms, firstSpawnedActorIndex, firstSpawnedWorldTransforms } from "./actor-world-transform";
import { SceneLayerLayout } from "./scene-layer-layout";
import { SceneLayerVirtualization } from "./scene-layer-virtualization";
import { isOverlayLayoutClass, isOverlayScrollClass, overlayLayoutKey, type OverlaySafeAreaInsets } from "@babylonslate/core";
import { composeParentChildTransform } from "./actor-world-transform";
import { blackboardInspectTypes, blackboardTargetPosition, snapshotBlackboard } from "./bt-blackboard";
import type { ModelPayload, SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import {
  createNavigationBackend,
  facingYawFromVelocity,
  initNavigation,
  parseNavAgentParams,
  parseNavMeshBlockerProperties,
  recastToWorld,
  rotatedBoxWorldAabb,
  worldToRecast,
  type NavigationBackend,
  type NavObstacleKind,
  type NavPoint,
} from "@babylonslate/navigation";

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
  complexMeshes?: Readonly<
    Record<
      string,
      { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
    >
  >;
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
      | Readonly<
          Record<
            string,
            { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
          >
        >
      | ReadonlyMap<
          string,
          { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
        >;
  }): void;
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

export type RuntimeSaveGameOptions = Omit<SaveGameServiceOptions,
  "atBoundary" | "captureState" | "stageState" | "applyState" | "resetState" | "onGameLoaded">;

export function createInProcessRuntime(
  options: RuntimeDriverOptions,
): RuntimeDriver {
  return new InProcessRuntime(options);
}

// Shallow BT memory copies retain this live activation, while trace JSON omits
// it. A resumed task writes to its current board and cannot finish a later run.
const BT_TASK_ACTIVATION = Symbol("btTaskActivation");
type BtTaskActivation = { active: boolean; blackboard: BlackboardValues; result?: "success" | "failure" };

interface SceneDeparture {
  guid: string;
  sceneInstance: Scene | null;
  actors: Actor[];
  layers: SceneLayer[];
  sources?: RuntimeSceneSource[];
}

interface SceneRealization {
  controller: AbortController;
  scene: SerializedScene | undefined;
  guid: string;
  loadId: number;
  actors: Actor[];
  layers: SceneLayer[];
  sceneInstance: Scene | null;
  promise: Promise<void> | null;
  finished: boolean;
  departure: SceneDeparture | null;
  painted: (() => void) | null;
  refreshNavigation: boolean;
}

interface SceneStream {
  actor: Actor;
  loadId: number;
  assetGuid: string;
  state: Exclude<SceneStreamingState, "Unloaded">;
  progress: number;
  actors: Set<Actor>;
  idMap: ReadonlyMap<string, string>;
  scene: Scene;
  controller: AbortController;
  realized: boolean;
  notified: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  unloadPromise?: Promise<void>;
  navObstacles: string[];
  origin?: Transform;
  source?: RuntimeSceneSource;
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
  private lastBoundaryRequestId = 0;
  private readonly diagnosticsEnabled: boolean;
  private diagnosticRecorder: RuntimeDiagnosticRecorder | null = null;
  private profileTickPublishMs = 0;
  private readonly deferMaterialEdits: boolean;
  private materialEditGate: RuntimeMaterialEditGate | null = null;
  private materialEditEmission: { preparation: RuntimeMaterialEditPreparation; emitted: boolean } | null = null;
  private runtimeInspector: RuntimeInspector | null = null;
  private inspectorScheduled = false;
  private lastInspectorRequestId = 0;
  private readonly inspectorRequests: Array<{ request: RuntimeInspectorRequest; resolve(result: RuntimeInspectorResult): void }> = [];
  private readonly boundaryRequests: Array<{ request: SessionBoundaryRequest; resolve(result: SessionBoundaryResult): void }> = [];
  private boundaryScheduled = false;
  private readonly pauseReasons = new Set<SessionPauseReason>();
  private readonly pendingPauseChanges = new Map<SessionPauseReason, boolean>();
  private resetElapsed = false;
  private readonly assetPreloads = new RuntimeAssetPreloads(command => this.emit(command));
  private readonly classAssetGuids = new Map<string, string>();
  private readonly demandAssetCatalog: boolean;
  private readonly layerReadinessWaiters = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();

  notifyAssetPreloadResult(result: { preloadId: string; success: boolean; error?: string; progress?: number }): void {
    this.assetPreloads.receive(result);
  }

  setAssetLoadStates(states: readonly { guid: string; state: RuntimeAssetLoadState }[]): void {
    this.assetPreloads.setStates(states);
  }
  private saveGameService?: SaveGameService;
  private saveGameWorld?: SaveGameWorld;
  private saveBoundaryActive = false;
  private saveOverlayLayoutPending = false;
  private readonly savedActors = new WeakSet<Actor>();
  private pendingGameLoaded: (() => void) | null = null;
  private readonly world: World;
  private snapshots: SeqLockSnapshotPair;
  private readonly input = new InputRingBuffer(512);
  private readonly resolver: InputResolver;
  private readonly focusNavigation: SceneLayerFocusNavigation;
  private readonly overlayLayout = new SceneLayerLayout();
  private readonly overlayVirtualization = new SceneLayerVirtualization();
  private applyingOverlayLayouts = false;
  private safeAreaInsetsPixels: OverlaySafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 };
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
  private readonly tweens = new TweenRuntime((owner) => !this.stopped && !this.paused && this.streamBlockingCount === 0 &&
    (!owner || this.canRunOwnerActions(owner)));
  private readonly onCommand?: (command: CommandMessage) => void;
  private readonly maxCatchUp = 4;
  private readonly dt: number;
  private physicsWorldKind: PhysicsWorldKind;
  private physicsGeneration = 0;
  private gravity: [number, number, number];
  private readonly havokWasmUrl: string | undefined;
  private readonly preferSoftwarePhysics: boolean;
  private accumulator = 0;
  private paused = false;
  private streamBlockingCount = 0;
  private streamLoadId = 0;
  private readonly sceneStreams = new Map<string, SceneStream>();
  private readonly actorStream = new WeakMap<Actor, SceneStream>();
  private readonly streamScenes = new WeakMap<Scene, SceneStream>();
  private readonly simulationWaiters = new Set<() => void>();
  private readonly scalability: ScalabilitySession;
  private lastRenderPathStatus: RenderPathStatus | null = null;
  private readonly scalabilityProjectRenderPath: RenderPath;
  private volume = 1;
  private timeDilation = 1;
  private showCollision = false;
  private running = false;
  private processingTick = false;
  private flushingConsoleActors = false;
  private frameId = 0;
  private slotByGuid = new Map<string, number>();
  private areaLightSlots = new Set<number>();
  private outlineSlots = new Set<number>();
  private readonly deformerSnapshots = new Map<number, string>();
  private readonly dirtyDeformerActors = new Set<Actor>();
  private deformerRevision = 0;
  private captureSlots = new Set<number>();
  private fogVolumeSlots = new Set<number>();
  private readonly slotOwners = new Map<number, Actor>();
  /** Each actor's own slot; `slotByGuid` holds a guid's latest-assigned one. */
  private readonly slotByActor = new WeakMap<Actor, number>();
  private readonly removingActors = new WeakSet<Actor>();
  private readonly componentsWithMaterialAssignment = new WeakSet<ActorComponent>();
  private readonly freeSlots: number[] = [];
  private nextUnusedSlot = 0;
  private _snapshotGeneration = 0;
  private _lastScriptMs = 0;
  private _lastPhysicsMs = 0;
  /** Most recent publish: overlay layout and removal pass, composition and buffer write (stats `publishMs`). */
  private _lastPublishMs = 0;
  /** True while `advance()` runs catch-up ticks; their snapshot writes wait for the burst to end. */
  private deferSnapshotWrites = false;
  /** Header of the last tick that reached its publish point while writes were deferred. */
  private readonly pendingSnapshotHeader = { frameId: 0, tickIndex: 0, scriptMs: 0, physicsMs: 0 };
  private snapshotWritePending = false;
  /** Removal-pass time already spent on the pending publish. */
  private pendingPublishMs = 0;
  private readonly liveAnimInitKeys = new Set<string>();
  private readonly liveAnimEvalKeys = new Set<string>();
  private readonly navPhysicalAgents = new Set<string>();
  private readonly navAgentActors: Actor[] = [];
  private phaseScriptMs = 0;
  private phasePhysicsMs = 0;
  private readonly scriptHost: ScriptHost;
  private readonly scriptSources = new Map<string, CompiledScript>();
  private scriptSourceWork: Promise<void> = Promise.resolve();
  private readonly dataCatalog: RuntimeDataCatalog;
  private readonly sourceRenderTargets = new Map<string, RenderTargetPayload>();
  private readonly sourceRenderTargetTextures = new Map<string, RenderTargetTexturePayload>();
  private physicsSync: PhysicsWorldSync;
  private overlayPhysicsSync: PhysicsWorldSync;
  private readonly ragdolls: RagdollWorldSync;
  private readonly cables: CableWorldSync;
  private readonly dynamicMeshes: DynamicRuntimeMeshSync;
  private readonly movement: MovementWorldSync;
  private readonly overlayGravity: [number, number, number];
  private readonly overlayDesignPose = new Map<string, { x: number; y: number }>();
  private playCanvasWidth = 1;
  private playCanvasHeight = 1;
  private playScene: SerializedScene | undefined;
  private playSceneGuid: string;
  private readonly gameInstanceClass: string;
  private readonly sceneLibrary = new Map<string, SerializedScene>();
  private readonly acquireScene?: AcquireRuntimeScene;
  private activeSceneSource?: RuntimeSceneSource;
  private pendingSceneSource?: AbortController;
  private readonly sceneGuidByKey = new Map<string, string>();
  private readonly sceneLayerSwitchers: SceneLayerActorSwitchers;
  private sceneLayerSpawnDepth = 0;
  private readonly sceneLayerLibrary = new Map<string, SerializedSceneLayer>();
  private playWorldRealized = false;
  private sceneLoadingProgress = 1;
  private readonly deferSceneModelsReady: boolean;
  private readonly deferSceneLoadingPaint: boolean;
  private readonly materialParameters: RuntimeMaterialParameters;
  private readonly validateLegacyMeshParameters: boolean;
  private sceneLoadId = 0;
  private layerLoadId = 0;
  private readonly layerLoads = new Map<string, { layer: SceneLayer; loadId: number; realized: boolean; presented: boolean; ready: boolean }>();
  private readonly independentLayerWork = new Map<string, { layer: SceneLayer; loadId: number; controller: AbortController; painted: () => void }>();
  private readonly pendingOwnerActions = new Map<BObject, Array<() => void>>();
  /** Nonzero while `flushOwnerActions` runs queued owner work. */
  private flushingOwnerActions = 0;
  private readonly createdScriptObjects = new WeakSet<BObject>();
  /**
   * Actors each SceneSubsystem heard enter play (Scene Actor Spawned); only
   * these report Scene Actor Destroyed to it.
   */
  private readonly sceneSubsystemActors = new WeakMap<SceneSubsystem, WeakSet<Actor>>();
  /** Streams announced as Streamed Scene Loaded; only these report Unloaded. */
  private readonly announcedSceneStreams = new WeakSet<SceneStream>();
  /**
   * Nonzero while the main Scene's own teardown removes its streams, layers
   * and actors: its SceneSubsystems hear none of those notifications.
   */
  private sceneTeardownDepth = 0;
  /** `Get <Subsystem>` matches by class id; cleared when live subsystems change. */
  private readonly subsystemMatches = new Map<string, readonly Subsystem[]>();
  private readonly ambiguousSubsystemWarnings = new Set<string>();
  private readonly cooperativeSceneLoading: CooperativeSceneLoadingOptions | null;
  private realization: SceneRealization | null = null;
  private sceneWorkBlocked = false;
  private bootLoading = false;
  private preparedBootScene: { work: SceneRealization; name: string } | null = null;
  private stopped = false;
  private lifecycleId = 0;
  private sceneChangeId = 0;
  private pendingSceneFinish: {
    name: string;
    guid: string;
    sceneLoadId: number;
    presented: boolean;
  } | null = null;
  private gameInstanceBound = false;
  /** A script `Possess Camera` outranks the authored per-camera option. */
  private cameraPossessedByScript = false;
  private possessedCameraSlotId: number | null = null;
  private readonly commands: CommandRegistry;
  private readonly commandClasses = new Map<string, { classId: string; assetGuid: string }>();
  private readonly consoleLifetime = new AbortController();
  private readonly loopGuard: InfiniteLoopGuard;
  private readonly trace: TraceRecorder;
  private lastTrace: TracePayload | null = null;
  private readonly seed: number;
  private tickPrints: Array<{ message: string; key: string }> = [];
  private readonly animGraphs = new Map<string, AnimGraphDocument>();
  private readonly animEvalByComponent = new Map<string, AnimEvalState>();
  private readonly animInitializedBySlot = new Set<string>();
  private readonly behaviourTrees = new Map<string, BehaviourTreeDocument>();
  private readonly blackboards = new Map<string, BlackboardDocument>();
  private readonly btEvalBySlot = new Map<number, BtEvalState>();
  private readonly btMissingWarned = new Set<string>();
  private currentBtNodeId: string | null = null;
  private currentBtAssetGuid: string | null = null;
  private tilemaps = new Map<string, TilemapPayload>();
  private waters = new Map<string, WaterDefinition>();
  private tilesets = new Map<string, TilesetPayload>();
  private tilemapAnimationTimeMs = 0;
  private hasAnimatedTiles = false;
  private sprites = new Map<string, SpritePayload>();
  private spriteAnimations = new Map<string, SpriteAnimationPayload>();
  private models = new Map<string, ModelPayload>();
  private complexMeshes = new Map<
    string,
    { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
  >();
  private pendingAnimJumpByComponent = new Map<string, string>();
  private pixelsPerUnit = 100;
  private readonly texturePixelSizes: Readonly<Record<string, { width: number; height: number }>>;
  private readonly delayWaiters: Array<{ remaining: number; resolve: () => void; owner?: BObject | null }> =
    [];
  private nav: NavigationBackend | null = null;
  private readonly sceneNavmeshBytes = new Map<string, Uint8Array>();
  private navSceneGuid: string | null = null;
  private navigationInitialized = false;
  private readonly navAgentByActor = new Map<string, string>();
  private readonly navYawByActor = new Map<string, number>();
  private readonly navTargetByActor = new Map<string, NavPoint>();
  private readonly navSteeredActors = new Set<string>();
  private navFrameActors: Map<string, Actor> | null = null;
  private readonly audioAssetGuids = new Set<string>();
  private readonly animClipCatalog = new Map<string, AnimClipCatalogEntry>();
  private readonly btPlayAnimOwnedSlots = new Set<number>();
  private readonly btVoiceByActor = new Map<string, string>();
  private lastStatsEmitMs: number | null = null;
  private readonly lastBtStateJson = new Map<number, string>();
  private showPathfinding = false;
  private showNavAgent = false;
  private lastNavigationDebugMs = -Infinity;
  private behaviourTreeDebug = false;
  private lastBehaviourTreeDebugMs = -Infinity;

  get lastScriptMs(): number {
    return this._lastScriptMs;
  }

  get lastPhysicsMs(): number {
    return this._lastPhysicsMs;
  }
  get snapshotCapacity(): number { return this.snapshots.maxActors; }
  get snapshotGeneration(): number { return this._snapshotGeneration; }

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
    this.trace = new TraceRecorder({ byteBudget: options.traceByteBudget });
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
    this.physicsWorldKind =
      options.physicsWorld ??
      options.playScene?.settings.physicsWorld ??
      "3d";
    this.gravity = options.gravity ?? [0, -9.81, 0];
    this.havokWasmUrl = options.havokWasmUrl;
    this.preferSoftwarePhysics = options.preferSoftwarePhysics ?? false;
    this.playScene = options.playScene;
    this.acquireScene = options.acquireScene;
    this.playSceneGuid = options.playSceneGuid ?? "play-scene";
    for (const [guid, bytes] of Object.entries(options.sceneNavmeshBytes ?? {})) this.sceneNavmeshBytes.set(guid, bytes);
    this.gameInstanceClass = options.gameInstanceClass ?? "GameInstance";
    this.deferSceneModelsReady = options.deferSceneModelsReady === true;
    this.deferSceneLoadingPaint = options.deferSceneLoadingPaint === true;
    this.cooperativeSceneLoading = options.cooperativeSceneLoading
      ? (options.cooperativeSceneLoading === true ? {} : options.cooperativeSceneLoading)
      : null;
    if (options.sceneLibrary && !this.acquireScene) {
      for (const [key, scene] of Object.entries(options.sceneLibrary)) {
        this.sceneLibrary.set(key, scene);
        const displayName =
          typeof scene.name === "string" ? scene.name.trim() : "";
        if (displayName && displayName !== key) {
          this.sceneLibrary.set(displayName, scene);
        }
      }
    }
    if (options.sceneGuidByKey) {
      for (const [key, guid] of Object.entries(options.sceneGuidByKey)) {
        this.sceneGuidByKey.set(key, guid);
      }
    }
    if (options.sceneLibrary) {
      for (const [key, scene] of Object.entries(options.sceneLibrary)) {
        if (!this.sceneGuidByKey.has(key)) {
          this.sceneGuidByKey.set(key, key);
        }
        const displayName =
          typeof scene.name === "string" ? scene.name.trim() : "";
        if (displayName && !this.sceneGuidByKey.has(displayName)) {
          this.sceneGuidByKey.set(
            displayName,
            this.sceneGuidByKey.get(key) ?? key,
          );
        }
      }
    }
    if (options.sceneLayerLibrary) {
      for (const [key, layer] of Object.entries(options.sceneLayerLibrary)) {
        this.sceneLayerLibrary.set(key, layer);
      }
    }
    if (options.playScene) {
      if (!this.acquireScene) this.sceneLibrary.set(this.playSceneGuid, options.playScene);
      this.sceneGuidByKey.set(this.playSceneGuid, this.playSceneGuid);
      if (options.playScene.name) {
        if (!this.acquireScene) this.sceneLibrary.set(options.playScene.name, options.playScene);
        this.sceneGuidByKey.set(options.playScene.name, this.playSceneGuid);
      }
    }
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
        this.animGraphs.set(guid, document);
      }
    }
    if (options.behaviourTrees) {
      for (const [guid, document] of Object.entries(options.behaviourTrees)) {
        this.behaviourTrees.set(guid, document);
      }
    }
    if (options.blackboards) {
      for (const [guid, document] of Object.entries(options.blackboards)) {
        this.blackboards.set(guid, document);
      }
    }
    this.texturePixelSizes = options.texturePixelSizes ?? {};
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
    if (options.tilemaps) {
      this.tilemaps = new Map(Object.entries(options.tilemaps));
    }
    if (options.tilesets) {
      this.tilesets = new Map(Object.entries(options.tilesets));
    }
    this.refreshTilemapAnimationContent();
    if (options.audioAssetGuids) {
      for (const guid of options.audioAssetGuids) {
        if (guid) this.audioAssetGuids.add(guid);
      }
    }
    if (options.animClipCatalog) {
      for (const entry of options.animClipCatalog) {
        if (entry.guid) this.animClipCatalog.set(entry.guid, entry);
      }
    }
    const maxActors = options.maxActors ?? 256;
    this.snapshots = SeqLockSnapshotPair.create(maxActors);

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

    this.overlayGravity = [...createDefaultSceneSettings("2d").gravity] as [
      number,
      number,
      number,
    ];
    this.physicsSync = new PhysicsWorldSync(
      createSoftwarePhysicsBackend(this.physicsWorldKind, {
        x: this.gravity[0],
        y: this.gravity[1],
        z: this.gravity[2],
      }),
      {
        actorFilter: (actor) => actor.sceneLayerId == null && this.streamActorReady(actor),
        deferUnsupportedConstraints: !this.preferSoftwarePhysics,
      },
    );
    this.overlayPhysicsSync = new PhysicsWorldSync(
      createSoftwarePhysicsBackend("2d", {
        x: this.overlayGravity[0],
        y: this.overlayGravity[1],
        z: this.overlayGravity[2],
      }),
      {
        actorFilter: (actor) => actor.sceneLayerId != null && this.canTickActor(actor, true),
        deferUnsupportedConstraints: !this.preferSoftwarePhysics,
      },
    );
    if (options.tilemaps || options.tilesets) {
      this.bindPhysicsContent(this.physicsSync);
      this.bindPhysicsContent(this.overlayPhysicsSync);
    }
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
      onPhase: (phase) => this.markPhase(phase),
      canTickScene: () => !this.stopped && this.streamBlockingCount === 0,
      canTickActor: (actor) => this.canTickActor(actor),
      componentHooksFor: (classId) => {
        if (!registry.isA(classId, "ActorComponent")) return undefined;
        return {
          onCreation: (self) => {
            this.movement.initialize(self);
            this.scriptHost.bindInterfaceHandlers(self);
            this.runOwnerCreation(self, () => this.scriptHost.hooksFor(classId)?.onCreation?.(self));
          },
          // Engine component classes never carry scripts, so they skip the
          // per-frame script lookup; project components keep it for reloads.
          onTick: isLockedEngineClassId(classId)
            ? undefined
            : (self, ctx) =>
                this.guardScript(() => this.scriptHost.hooksFor(classId)?.onTick?.(self, ctx)),
          onDestroyed: (self) => {
            this.runOwnerDestroyed(self, () => this.scriptHost.hooksFor(classId)?.onDestroyed?.(self));
            this.dynamicMeshes.remove(self);
            this.textAppear.remove(self);
          },
        };
      },
      sceneSubsystemHooksFor: (classId) => this.sceneSubsystemHooks(classId),
      // Strict gate: Tick only after On Init, while the main Scene may run.
      canTickSceneSubsystem: (subsystem) =>
        this.createdScriptObjects.has(subsystem) && this.canRunSceneSubsystem(subsystem),
      onPhysics: (ctx) => {
        this.dynamicMeshes.flush();
        this.ragdolls.sync();
        if (this.canTickScene()) {
          const time = ctx.tickIndex * ctx.dt;
          this.physicsSync.step(ctx.dt, this.world, time, -this.gravity[1], () => this.movement.step(ctx.dt, this.physicsSync));
          if (this.physicsSync.water.hasBodies) this.emit({ type: "waterTime", seconds: time });
        }
        if (this.hasReadyLayers()) this.overlayPhysicsSync.step(ctx.dt, this.world, undefined, undefined, () => this.movement.step(ctx.dt, this.overlayPhysicsSync));
        this.ragdolls.afterStep();
        if (this.canTickScene()) this.cables.step(ctx.dt, this.gravity, this.frameId + 1);
        this.dispatchCollisionEvents();
      },
    });
    this.sceneLayerSwitchers = new SceneLayerActorSwitchers({
      classes: registry,
      alive: (actor) => !this.stopped && !actor.destroyed && !this.removingActors.has(actor) &&
        !!actor.sceneLayerId && !!this.world.findSceneLayer(actor.sceneLayerId),
      spawn: (parent, classId, defaults) => this.spawnSceneLayerActor(parent, classId, defaults),
      remove: (actor) => this.removeSceneLayerActorSubtree(actor),
      event: (actor, event, args) => {
        // Switching during Tick queues the new actor's World spawn. Its Begin
        // Play and Switched To precede the switcher's completion notification.
        const readyOwner = event === "onSceneLayerActorSwitched" && args.currentActor instanceof Actor
          ? args.currentActor : actor;
        this.runOwnerAction(readyOwner, () =>
          this.guardScript(() => this.scriptHost.invokeEvent(actor.classId, event, actor, args)));
      },
    });
    this.dynamicMeshes = new DynamicRuntimeMeshSync({
      eligible: (actor) => !actor.sceneLayerId && this.canRunOwner(actor),
      slot: (actor) => {
        const slot = this.slotByGuid.get(actor.guid);
        return slot !== undefined && this.slotOwners.get(slot) === actor ? slot : undefined;
      },
      emit: (command) => this.emit(command),
    });
    this.movement = new MovementWorldSync({
      world: this.world,
      physics: (actor) => actor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync,
      eligible: (actor) => this.canTickActor(actor),
      gravity: (actor) => -(actor.sceneLayerId ? this.overlayGravity[1] : this.gravity[1]),
      warn: (component) => this.emit({ type: "log", severity: "warning", category: "Movement",
        message: `Movement on ${component.owner?.guid ?? "actor"} could not create its motor. Use one Movement component without Rigid Body, Nav Agent, Ragdoll or Water Buoyancy components.`, frameId: this.frameId }),
      event: (component, event, args) => {
        const actor = component.owner;
        if (actor) this.guardScript(() => this.scriptHost.invokeEvent(actor.classId, event, actor, args, component.guid));
      },
    });
    this.cables = new CableWorldSync({
      world: this.world,
      physics: () => this.physicsSync.getBackend(),
      eligible: (actor) => this.canTickActor(actor),
      slot: (actor) => {
        const slot = this.slotByGuid.get(actor.guid);
        return slot !== undefined && this.slotOwners.get(slot) === actor ? slot : undefined;
      },
      emit: (command) => this.emit(command),
    });
    this.ragdolls = new RagdollWorldSync({
      world: this.world,
      physics: () => this.physicsSync,
      slot: (actor) => {
        const slot = this.slotByGuid.get(actor.guid);
        return slot !== undefined && this.slotOwners.get(slot) === actor ? slot : undefined;
      },
      eligible: (actor) => this.canTickActor(actor),
      deferNative: !this.preferSoftwarePhysics,
      emit: (command) => this.emit(command),
      error: (error) => { this.reportError(error); },
    });
    this.uiControls = new UIControls2DRuntime({
      actors: () => this.world.getActors(),
      canRun: (actor) => !this.stopped && this.canTickActor(actor),
      update: (component, properties) => {
        const slotId = component.owner ? this.slotByGuid.get(component.owner.guid) : undefined;
        if (slotId !== undefined) this.emit({ type: "setUIControl2D", slotId, componentId: component.guid,
          uiControl: { classId: component.classId, properties } });
      },
      event: (component, event, args) => {
        const actor = component.owner;
        if (actor && !actor.destroyed && !component.destroyed && this.canTickActor(actor)) {
          this.scriptHost.invokeEvent(actor.classId, event, actor, args, component.guid);
        }
      },
    });
    this.focusNavigation = new SceneLayerFocusNavigation(this.world, options.focusNavigation, {
      canRun: (actor) => this.canTickActor(actor),
      event: (actor, component, event) => {
        if (isUIControl2DClass(component.classId) && (event === "onFocusEnter" || event === "onFocusLeave")) {
          const slotId = this.slotByGuid.get(actor.guid);
          if (slotId !== undefined) this.emit({ type: "setUIControl2D", slotId, componentId: component.guid,
            uiControl: { classId: component.classId, properties: this.uiControls.payload(component) }, focused: event === "onFocusEnter" });
        }
        if (event === "onFocusActivate") this.uiControls.activate(component);
        this.scriptHost.invokeEvent(actor.classId, event, actor, {}, component.guid);
      },
      bounds: (actor, component) => {
        const entry = focusLayoutEntry(this.overlayLayout, this.world, actor, component);
        const visual = entry?.componentId ? this.world.findActor(entry.actorId)?.components.find((target) => target.guid === entry.componentId) : undefined;
        if (visual?.getVariable("visible") === false || visual?.getVariable("enabled") === false) return null;
        return entry?.rect;
      },
      onFocusChange: (actor, component) => revealFocusedElement(this.overlayLayout, this.world, actor, component,
        (layerId, actorId, componentId, x, y) => this.applySceneLayerScroll(layerId, actorId, componentId, x, y)),
    });
    const resolved = () => this.resolvedInput;
    const connections = this.connectionBox;
    this.world.setInputProvider({
      isActionHeld: (action) => resolved().actions[action]?.held ?? false,
      wasActionPressed: (action) =>
        resolved().actions[action]?.pressed ?? false,
      wasActionReleased: (action) =>
        resolved().actions[action]?.released ?? false,
      getPressedKeys: () => resolved().pressedKeys,
      getAxis: (axis) => resolved().axes[axis] ?? 0,
      getAxis2D: (axis) => resolved().axes2D[axis] ?? { x: 0, y: 0 },
      getCursorPosition: () => resolved().cursor,
      setCursorVisible: (visible) => {
        this.emit({
          type: "setCursorVisible",
          visible: visible === true,
          frameId: this.frameId,
        });
      },
      get gamepadConnections() {
        return connections.current;
      },
      setGamepadRumble: (gamepadIndex, intensity, durationMs) => {
        this.emit({
          type: "log",
          severity: "log",
          category: "input",
          message: `rumble pad=${gamepadIndex} intensity=${intensity} ms=${durationMs}`,
          frameId: this.frameId,
        });
      },
    });

    this.dataCatalog = new RuntimeDataCatalog(options.dataAssets);
    for (const [guid, value] of Object.entries(options.renderTargets ?? {})) this.sourceRenderTargets.set(guid, value);
    for (const [guid, value] of Object.entries(options.renderTargetTextures ?? {})) this.sourceRenderTargetTextures.set(guid, value);
    this.scriptHost = new ScriptHost({
      data: this.dataCatalog,
      seed: options.seed,
      canRunOwner: (owner) => this.canRunOwner(owner),
      inputBindings: this.resolver.bindings,
      getInputState: (input) => this.resolver.getInputState(input),
      interfaceRegistry: this.world.interfaceRegistry,
      classRegistry: registry,
      checkInfiniteLoop: () => this.loopGuard.check(),
      log: (severity, category, message) => {
        this.emit({
          type: "log",
          severity,
          category,
          message,
          frameId: this.frameId,
        });
        if (severity === "error") {
          const stack = new Error().stack ?? "";
          const anchor = mapStackToAnchor(stack, this.anchors);
          const diag: RuntimeDiagnostic = {
            code: "runtime.log",
            message,
            severity: "error",
            assetGuid: anchor?.assetGuid,
            graphId: anchor?.graphId,
            nodeId: anchor?.nodeId,
            bodyLine: anchor?.bodyLine,
            stack,
            frameId: this.frameId,
            tickIndex: this.world.clock.tickIndex,
          };
          this.diagnostics.push(diag);
          this.emit({
            type: "diagnostic",
            code: diag.code,
            message: diag.message,
            assetGuid: diag.assetGuid,
            graphId: diag.graphId,
            nodeId: diag.nodeId,
            bodyLine: diag.bodyLine,
            stack: diag.stack,
            frameId: this.frameId,
            severity: "error",
          });
        }
      },
      print: (message, key, duration, color) => {
        this.tickPrints.push({ message, key });
        this.emit({
          type: "print",
          message,
          key,
          duration,
          color,
          frameId: this.frameId,
        });
      },
      drawDebug: (payload) => {
        this.emit({
          type: "debugDraw",
          ...(payload as Record<string, unknown>),
          frameId: this.frameId,
        } as CommandMessage);
      },
      setCursorVisible: (visible) => {
        this.emit({
          type: "setCursorVisible",
          visible: visible === true,
          frameId: this.frameId,
        });
      },
      destroyActor: (actor) => {
        if (!actor) return;
        this.emitAudioStops(actor);
        this.emitParticleStops(actor);
        this.world.destroyActor(actor.guid);
        this.tweens.cancelInvalid();
      },
      addComponent: (actor, classId, transform) => {
        const target = actor;
        if (this.stopped || !target || target.destroyed) return null;
        const id = String(classId ?? "").trim();
        if (!id) return null;
        const overlay = Boolean(target.sceneLayerId);
        if (overlay && isSceneLayerDeniedComponent(id)) return null;
        if (!overlay && isSceneLayerExclusiveComponent(id)) return null;
        const pose = coerceTransform(transform);
        const component = this.world.createComponent({
          classId: id,
          ...(pose ? { transform: pose } : {}),
        });
        this.scriptHost.bindInterfaceHandlers(component);
        target.attachComponent(component);
        return component;
      },
      animGraphControl: (target) => {
        if (
          !(target instanceof ActorComponent) ||
          target.classId !== "AnimationGraphComponent" ||
          target.destroyed
        ) {
          return null;
        }
        const owner = target.owner;
        if (!(owner instanceof Actor) || owner.destroyed) return null;
        const slotId = this.slotByActor.get(owner);
        const guid = this.animGraphGuid(target);
        const document = guid ? this.animGraphs.get(guid) : undefined;
        const evalKey = target.guid;
        return {
          getVariable: (name) => target.getVariable(name),
          setVariable: (name, value) => {
            target.setVariable(name, value);
          },
          getCurrentState: () => {
            const evalState = this.animEvalByComponent.get(evalKey);
            const stateId = evalState?.stateId ?? document?.entryStateId;
            if (!stateId || !document) return null;
            const state = document.states.find((row) => row.id === stateId);
            return { id: stateId, name: state?.name ?? stateId };
          },
          jumpToState: (state) => {
            if (!document || slotId === undefined) return;
            const match = document.states.find(
              (row) => row.id === state || row.name === state,
            );
            if (!match) return;
            this.pendingAnimJumpByComponent.set(evalKey, match.id);
          },
        };
      },
      spawnActor: (classId, transform, owner) => {
        const id = String(classId ?? "").trim();
        if (!id) return null;
        const guid = this.classAssetGuids.get(id);
        if (this.demandAssetCatalog && guid && this.assetPreloads.getState(guid) !== "ready") {
          throw new Error(`Class ${id} (${guid}) is not prepared; await ctx.spawnActorAsync or Preload Assets first`);
        }
        return this.spawnScriptedActor({
          classId: id,
          transform: coerceTransform(transform),
          streamOwner: owner,
        });
      },
      spawnActorAsync: async (classId, transform, owner) => {
        const id = String(classId ?? "").trim();
        if (!id || this.stopped || owner?.destroyed) return null;
        const guid = this.classAssetGuids.get(id);
        if (this.demandAssetCatalog && !guid && !isLockedEngineClassId(id)) throw new Error(`Class ${id} is missing from the asset catalog`);
        const preload = this.demandAssetCatalog && guid
          ? await this.assetPreloads.acquire([guid], owner?.guid ?? this.world.currentScene?.guid ?? "session") : null;
        if (this.stopped || owner?.destroyed) {
          if (preload) this.assetPreloads.release(preload.preloadId);
          throw sceneRealizationCancelled();
        }
        try {
          { const pending = this.continueSimulation(owner ?? null); if (pending) await pending; }
          if (preload && !preload.success) throw new Error(`Cannot spawn ${id} requested by ${owner?.guid ?? "session"}: ${preload.errorMessage}`);
          const actor = this.spawnScriptedActor({ classId: id, transform: coerceTransform(transform), streamOwner: owner });
          if (preload) {
            if (actor && !actor.destroyed) this.assetPreloads.transferOwner(preload.preloadId, actor.guid);
            else this.assetPreloads.release(preload.preloadId);
          }
          return actor;
        } catch (error) {
          if (preload) this.assetPreloads.release(preload.preloadId);
          throw error;
        }
      },
      getActors: () => this.world.getActors(),
      registerSaveActor: (actor, persistentId) => this.registerSaveActor(actor, persistentId),
      getSaveActorId: (actor) => this.saveGameWorld?.persistentId(actor) ?? actor.guid,
      resolveSaveActor: (id) => this.saveGameWorld?.findActor(id) ?? this.world.findActor(id),
      attachToBone: (actor, target, boneName) => {
        const slotId = this.slotByGuid.get(actor.guid);
        const targetSlotId = target ? this.slotByGuid.get(target.guid) : null;
        if (slotId === undefined || targetSlotId === undefined) return;
        this.emit({ type: "attachToBone", slotId, targetSlotId, boneName });
      },
      getSceneReference: (owner) => {
        // Subsystems have no stream, so they read the main Scene.
        const scene = this.streamForOwner(owner)?.scene ?? this.world.currentScene;
        return scene && !scene.destroyed ? scene : null;
      },
      getSubsystem: (classId) => this.findSubsystem(classId),
      getGameInstance: () => this.world.gameInstance,
      getSceneLoadingProgress: () => {
        const value = this.sceneLoadingProgress;
        if (!Number.isFinite(value)) return 0;
        return Math.min(1, Math.max(0, value));
      },
      getTargetSceneName: (target) => this.getTargetSceneName(target),
      loadScene: (target, blocking) => this.loadSceneStream(target, blocking),
      unloadScene: (target, blocking) => this.unloadSceneStream(target, blocking),
      preloadAssets: (assets, owner, options) => this.preloadForGameplay(assets, owner, options),
      prepareAssets: this.demandAssetCatalog ? async (assets, owner) => {
        try { await this.assetPreloads.prepare(assets, owner?.guid ?? this.world.currentScene?.guid ?? "session"); }
        catch (error) {
          const pending = this.continueSimulation(owner ?? null);
          if (pending) await pending;
          throw error;
        }
        { const pending = this.continueSimulation(owner ?? null); if (pending) await pending; }
      } : undefined,
      releasePreload: (preloadId) => this.assetPreloads.release(preloadId),
      getAssetLoadState: (assetGuid) => this.assetPreloads.getState(assetGuid),
      isSceneLoaded: (target) => this.getSceneState(target) === "Loaded",
      getSceneLoadProgress: (target) => this.getSceneLoadProgress(target),
      getSceneState: (target) => this.getSceneState(target),
      resolveInstanceId: (owner, id) => this.streamForOwner(owner)?.idMap.get(id) ?? id,
      waitForSimulation: (owner) => this.continueSimulation(owner) ?? Promise.resolve(),
      getProjectName: () => projectName,
      getProjectVersion: () => projectVersion,
      setWorldGravity: (gravity) => {
        this.setWorldGravity(gravity);
      },
      executeConsoleCommand: (command) => this.executeConsoleCommand(command),
      executeConsoleCommandAsync: (command) => this.executeConsoleCommandAsync(command),
      tween: (request) => this.tweens.start(request).then(async completed => {
        if (!completed) return false;
        { const pending = this.continueSimulation(request.owner ?? null); if (pending) await pending; }
        return true;
      }),
      isTweenSessionActive: () => !this.stopped,
      delay: (seconds, owner) =>
        new Promise<void>((resolve) => {
          if (this.stopped) { resolve(); return; }
          this.delayWaiters.push({
            remaining: Math.max(0, Number(seconds) || 0),
            resolve,
            owner,
          });
          // A boundary requested after the timer fired still holds the continuation.
        }).then(() => this.continueSimulation(owner ?? null)),
      reportError: (error) => {
        this.reportError(error);
      },
      findActor: (actorId) => {
        const actor = this.world.findActor(actorId);
        if (!actor || actor.destroyed) return undefined;
        return actor;
      },
      sampleWater: (position, actorId) =>
        // Current at call time in its own state (reused within the tick while nothing it read changed); the step
        // keeps its own evaluation and clock.
        this.physicsSync.water.query(this.world.getActors(), this.world.clock.tickIndex * this.dt, position, actorId),
      lineTrace: (start, end, options) =>
        this.physicsSync.lineTrace(start, end, options),
      projectCursorToScene: (channel, options) =>
        this.projectCursorToScene(channel, options),
      sphereOverlap: (center, radius, channel) =>
        this.physicsSync.sphereOverlap(center, radius, { channel }),
      shapeSweep: (shape, start, end, channel) =>
        this.physicsSync.shapeSweep(shape, start, end, { channel }),
      addImpulse: (actor, impulse, strength) => {
        const target = actor;
        if (!target) return;
        if (this.ragdolls.addImpulse(target, impulse, strength)) return;
        this.physicsSync.addImpulse(
          target.guid,
          impulse,
          strength,
        );
      },
      moveCharacter: (actor, translation, dt, offset) => {
        const target = actor;
        if (!target) return;
        const sync = target.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync;
        sync.moveCharacter(target, translation, dt, offset);
      },
      teleportActor: (actor, options) => {
        this.ragdolls.retire(actor);
        const sync = actor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync;
        sync.teleportActor(actor, this.world, options);
      },
      changeScene: (scene) => {
        this.applyChangeScene(scene);
      },
      createSceneLayer: (assetGuid, zOrder) =>
        this.createSceneLayer(assetGuid, zOrder),
      createSceneLayerAsync: (assetGuid, zOrder, owner) => this.createSceneLayerAsync(assetGuid, zOrder, owner),
      removeSceneLayer: (layerGuid) => {
        this.removeSceneLayer(layerGuid);
      },
      clearSceneLayers: () => {
        this.clearSceneLayers();
      },
      switchSceneLayerActor: (target, index) => this.sceneLayerSwitchers.switchTo(target, index),
      getCurrentSceneLayerActor: (target) => this.sceneLayerSwitchers.current(target),
      setFocusTarget: (target) => this.focusNavigation.setFocus(target),
      clearFocusTarget: (target) => this.focusNavigation.clearFocus(target),
      registerSceneLayerPostProcess: (layerGuid, materialGuid) => {
        this.registerSceneLayerPostProcess(layerGuid, materialGuid);
      },
      unregisterSceneLayerPostProcess: (layerGuid, materialGuid) => {
        this.unregisterSceneLayerPostProcess(layerGuid, materialGuid);
      },
      setRenderResolution: (width, height) => {
        this.requestScalability({ kind: "patch", render: { width, height, customResolution: true, blackBars: true } });
      },
      getScalability: () => this.getScalability(),
      requestScalability: (request) => this.requestScalability(request),
      getPostProcessEntry: (owner, entryId) => {
        if (!this.canRunOwner(owner)) return null;
        const material = getPostProcessMaterialObject(owner, entryId);
        return material && this.materialParameters.hasPostProcessDefinition(material) ? material : null;
      },
      getMaterialParameter: (material, name, kind) => this.canRunOwner(material)
        ? this.materialParameters.get(material, name, kind) : null,
      resetMaterialParameter: (material, name, kind) => {
        if (!this.canRunOwner(material)) return false;
        const value = this.materialParameters.resetValue(material, name, kind);
        return value !== null && this.setMaterialParameter(material, name, value);
      },
      setMaterialParameter: (material, name, parameter) => { this.setMaterialParameter(material, name, parameter); },
      possessCamera: (target) => {
        this.possessCamera(target);
      },
      getRenderTargetMode: (guid) => normalizeRenderTargetPayload(
        this.sourceRenderTargets.get(guid) ?? null,
      ).mode,
      getRenderTargetTextureTarget: (guid) => normalizeRenderTargetTexturePayload(
        this.sourceRenderTargetTextures.get(guid) ?? null,
      ).renderTargetGuid,
      captureRenderTarget: (target) => {
        if (!(target instanceof Actor) || !this.canRunOwner(target) || !captureComponent(target)) return;
        this.emit({ type: "captureRenderTarget", actorGuid: target.guid });
      },
      updateIllumination: (target) => {
        this.reemitIllumination(target);
      },
      paint2D: (component, operation, args) => {
        const changed = this.painters.execute(component, operation, args);
        if (!this.processingTick) this.flushPainters();
        return changed;
      },
      uiControlFunction: (component, name, args) => this.uiControls.invoke(component, name, args),
      dynamicMeshFunction: (component, name, args) => this.dynamicMeshes.invoke(component, name, args),
      movementFunction: (component, name, args) => this.movement.invoke(component, name, args),
      text2DAppearProgress: (component) => this.textAppear.progress(component),
      text2DAppear: (component, operation) => {
        this.textAppear.execute(component, operation);
        if (!this.processingTick) this.flushTextAppear();
      },
      refreshComponent: (component, propertyName) => this.refreshRuntimeComponent(component, propertyName),
      playSound: (asset, volume, options) => {
        this.emit({
          type: "playSound",
          assetGuid: String(asset ?? ""),
          volume: Number(volume ?? 1),
          frameId: this.frameId,
          emitterActorGuid: options?.emitterActorGuid ?? null,
          loop: options?.loop,
          voiceId: options?.voiceId,
        });
      },
      setParticlePlaying: (actorGuid, playing, componentId) => {
        this.emit({
          type: "setParticlePlaying",
          actorGuid: String(actorGuid ?? ""),
          playing: Boolean(playing),
          ...(componentId ? { componentId: String(componentId) } : {}),
        });
      },
      setChannelVolume: (channelGuid, volume) => {
        this.emit({
          type: "setChannelVolume",
          channelGuid: String(channelGuid ?? ""),
          volume: Number(volume ?? 1),
        });
      },
      setGlobalVolume: (volume) => {
        this.emit({
          type: "setGlobalVolume",
          volume: Number(volume ?? 1),
        });
      },
      findPathTo: (from, to) => this.findNavPath(from, to),
      moveTo: (actor, destination) => {
        if (!actor) return;
        this.setNavAgentTarget(actor.guid, destination);
      },
      stopMovement: (actor) => {
        if (!actor) return;
        this.stopNavAgent(actor.guid);
      },
      isPathValid: (from, to) => this.findNavPath(from, to).length > 1,
      getClosestNavigablePoint: (point) => {
        if (!this.nav) return null;
        const closest = this.nav.closestPoint(this.toNav(point));
        return closest ? this.fromNav(closest) : null;
      },
      getRandomPointInRadius: (center, radius) => {
        if (!this.nav) return null;
        const point = this.nav.randomPointInRadius(this.toNav(center), radius);
        return point ? this.fromNav(point) : null;
      },
      addObstacle: (kind, pose, size) =>
        this.addNavObstacle(kind === "cylinder" ? "cylinder" : "box", pose, size),
      removeObstacle: (id) => {
        this.removeNavObstacle(id);
      },
    });

    this.registerPlaySceneTypes();
    this.bindGameInstance();

    if (options.seedDemoActors !== false && !options.playScene) {
      this.seedDefaultActors();
    }
  }

  private streamForOwner(owner?: BObject | null): SceneStream | undefined {
    if (owner instanceof Scene) return this.streamScenes.get(owner);
    const actor = owner instanceof Actor ? owner : owner instanceof ActorComponent ? owner.owner : null;
    return actor ? this.actorStream.get(actor) : undefined;
  }

  private streamActorReady(actor: Actor): boolean {
    return this.sceneStreamReady(this.actorStream.get(actor));
  }

  private sceneStreamReady(stream: SceneStream | undefined): boolean {
    for (let owner = stream; owner; owner = this.actorStream.get(owner.actor)) {
      if (owner.state !== "Loaded" || this.sceneStreams.get(owner.actor.guid) !== owner) return false;
    }
    return true;
  }

  private streamingActor(target: unknown): Actor | null {
    return target instanceof Actor && !target.destroyed && target.world === this.world &&
      this.world.classRegistry.isA(target.classId, "SceneStreamingActor") ? target : null;
  }

  private streamingComponent(actor: Actor): ActorComponent | undefined {
    return actor.components.find((component) => !component.destroyed && component.classId === "SceneStreamingComponent");
  }

  getTargetSceneName(target: unknown): string {
    const actor = this.streamingActor(target);
    const component = actor && this.streamingComponent(actor);
    if (!component) return "";
    const guid = String(component.getVariable("sceneGuid") ?? "");
    return this.sceneLibrary.get(guid)?.name ?? String(component.getVariable("sceneName") ?? "");
  }

  getSceneState(target: unknown): SceneStreamingState {
    const actor = this.streamingActor(target);
    return actor ? this.sceneStreams.get(actor.guid)?.state ?? "Unloaded" : "Unloaded";
  }

  getSceneLoadProgress(target: unknown): number {
    const actor = this.streamingActor(target);
    return actor ? this.sceneStreams.get(actor.guid)?.progress ?? 0 : 0;
  }

  private withStreamBlock(operation: Promise<void>, blocking: boolean): Promise<void> {
    if (!blocking) return operation;
    this.streamBlockingCount++;
    if (this.streamBlockingCount === 1) this.emit({ type: "sceneStreamBlocking", blocking: true });
    return operation.finally(() => {
      this.streamBlockingCount--;
      if (this.streamBlockingCount === 0 && !this.stopped) this.emit({ type: "sceneStreamBlocking", blocking: false });
      this.accumulator = 0;
      this.flushOwnerActions();
      if (this.streamBlockingCount === 0) {
        const waiters = [...this.simulationWaiters];
        this.simulationWaiters.clear();
        for (const resume of waiters) resume();
      }
    });
  }

  private simulationBlocked(owner: BObject | null): boolean {
    return (this.streamBlockingCount > 0 || this.paused || this.boundaryRequests.some(
      ({ request }) => request.action.kind === "pause" && request.action.paused) ||
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
    if (this.stopped || owner?.destroyed || !this.sceneStreamReady(this.streamForOwner(owner)))
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
        if (active) this.guardScript(() => options.onProgress!(latest));
      };
      if (callbackOwner) this.runOwnerAction(callbackOwner, deliver);
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
    const actor = this.streamingActor(target);
    if (this.stopped || !actor) return Promise.reject(new Error("Scene streaming requires a live SceneStreamingActor Target."));
    const existing = this.sceneStreams.get(actor.guid);
    if (existing) {
      if (existing.state === "Unloading") return Promise.reject(new Error("The target scene is unloading."));
      if (existing.state === "Loaded") return Promise.resolve();
      return this.withStreamBlock(existing.promise, blocking);
    }
    const component = this.streamingComponent(actor);
    const key = String(component?.getVariable("sceneGuid") ?? "");
    const document = this.sceneLibrary.get(key);
    if (!document && (!key || !this.acquireScene)) return Promise.reject(new Error(`The target scene is not available: ${key || "No Scene Selected"}.`));
    if (document && document.settings.physicsWorld !== this.physicsWorldKind)
      return Promise.reject(new Error("Streamed scenes must use the parent scene's Physics World."));
    const guid = this.sceneGuidByKey.get(key) ?? key;
    for (let ancestor = this.actorStream.get(actor); ancestor; ancestor = this.actorStream.get(ancestor.actor)) {
      if (ancestor.state === "Unloading" || this.sceneStreams.get(ancestor.actor.guid) !== ancestor)
        return Promise.reject(new Error("The containing scene is unloading."));
      if (ancestor.assetGuid === guid) return Promise.reject(new Error("Recursive scene streaming is not supported."));
    }
    const loadId = ++this.streamLoadId;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Cancellation may happen before a graph attaches its awaited continuation.
    void promise.catch(() => {});
    const hooks = this.scriptHost.hooksFor(sceneAssetClassId(guid));
    const scene = new Scene({ guid: `stream:${actor.guid}:${loadId}`, assetGuid: guid, sceneName: document?.name ?? String(component?.getVariable("sceneName") ?? guid),
      hooks: hooks ? {
        onCreation: (self) => this.runOwnerCreation(self, () => hooks.onCreation?.(self)),
        onTick: (self, context) => this.guardScript(() => hooks.onTick?.(self, context)),
        onDestroyed: (self) => this.runOwnerDestroyed(self, () => hooks.onDestroyed?.(self)),
      } : undefined });
    const stream: SceneStream = { actor, loadId, assetGuid: guid, state: "Loading", progress: 0,
      actors: new Set(), idMap: new Map(), scene, controller: new AbortController(), realized: false, notified: false,
      promise, resolve, reject, navObstacles: [] };
    this.sceneStreams.set(actor.guid, stream);
    this.markUnsupportedSimulationInstance("stream", scene.guid);
    this.streamScenes.set(scene, stream);
    const operation = this.withStreamBlock(promise, blocking);
    this.emit({ type: "sceneStreamLoading", actorGuid: actor.guid, streamLoadId: loadId });
    void Promise.resolve().then(async () => {
      let prepared = document;
      if (this.acquireScene) {
        const acquisition = this.acquireScene(guid, { consumer: `SceneStreamingActor ${actor.guid} (${loadId})`, signal: stream.controller.signal,
          stream: { actorGuid: actor.guid, streamLoadId: loadId } }).then((source) => {
          if (stream.controller.signal.aborted || this.sceneStreams.get(actor.guid) !== stream) {
            source.release();
            throw sceneRealizationCancelled();
          }
          stream.source = source;
          return source.scene;
        });
        prepared = await waitForSceneWork(acquisition, stream.controller.signal);
      }
      stream.controller.signal.throwIfAborted();
      if (!prepared) throw new Error(`The target scene is not available: ${guid}.`);
      if (prepared.settings.physicsWorld !== this.physicsWorldKind)
        throw new Error("Streamed scenes must use the parent scene's Physics World.");
      stream.scene.setVariable("sceneName", prepared.name);
      await runSceneRealizationWork(this.realizeSceneStream(stream, prepared, component!), stream.controller.signal,
        this.cooperativeSceneLoading ?? {});
    }).catch((error: unknown) => {
      if (this.sceneStreams.get(actor.guid) !== stream || stream.state === "Unloading") return;
      this.retireSceneStream(stream, error);
    });
    return operation;
  }

  private *realizeSceneStream(stream: SceneStream, document: SerializedScene, component: ActorComponent): Generator<void, void, unknown> {
    const checkpoint = () => {
      stream.controller.signal.throwIfAborted();
      if (this.stopped || stream.actor.destroyed || stream.actor.world !== this.world) throw sceneRealizationCancelled();
    };
    checkpoint();
    const cloned = yield* cloneSceneStreamingActorsSteps(document.actors, { instanceId: stream.scene.guid, parentActorId: stream.actor.guid });
    stream.idMap = cloned.idMap;
    let origin = component.transform;
    let parentId = component.parentId;
    const visited = new Set([component.guid]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = stream.actor.components.find((entry) => entry.guid === parentId);
      if (!parent) break;
      origin = composeParentChildTransform(parent.transform, origin);
      parentId = parent.parentId;
    }
    stream.origin = origin;
    for (const serialized of cloned.actors) {
      checkpoint();
      const actor = createActorFromSerialized(this.world, serialized, this.sceneActorHooks);
      if (actor) {
        if (serialized.parentId === stream.actor.guid) actor.transform = composeParentChildTransform(origin, actor.transform);
        stream.actors.add(actor);
        this.actorStream.set(actor, stream);
      }
      yield;
    }
    hydrateScenePropertyReferences([...stream.actors]);
    let realized = 0;
    for (const actor of stream.actors) {
      checkpoint();
      this.scriptHost.bindInterfaceHandlers(actor);
      this.realizeActor(actor, checkpoint);
      stream.progress = ++realized / Math.max(1, stream.actors.size) * 0.5;
      yield;
    }
    checkpoint();
    // A streamed actor without a scene parent is a root of its instance.
    this.breakLoadedParentCycles(stream.actors, (actor) => {
      actor.setVariable("parentId", stream.actor.guid);
      actor.transform = composeParentChildTransform(origin, actor.transform);
    });
    this.scriptHost.bindInterfaceHandlers(stream.scene);
    stream.scene.callOnCreation();
    this.world.flushPending();
    stream.realized = true;
    stream.progress = 0.5;
    this.publishSceneStreamRealized(stream);
  }

  private publishSceneStreamRealized(stream: SceneStream): void {
    if (!stream.realized || stream.notified || stream.state !== "Loading" || !this.streamActorReady(stream.actor)) return;
    stream.notified = true;
    this.publishSnapshot();
    if (this.sceneStreams.get(stream.actor.guid) !== stream) return;
    this.emit({ type: "sceneStreamRealized", actorGuid: stream.actor.guid, streamLoadId: stream.loadId,
      slotIds: [...stream.actors].flatMap((actor) => { const slot = this.slotByGuid.get(actor.guid); return slot === undefined ? [] : [slot]; }) });
    if (!this.deferSceneModelsReady) this.notifySceneStreamReady(stream.actor.guid, stream.loadId);
  }

  notifySceneStreamProgress(actorGuid: string, streamLoadId: number, progress: number): void {
    const stream = this.sceneStreams.get(actorGuid);
    if (!stream || stream.loadId !== streamLoadId || stream.state !== "Loading" || !Number.isFinite(progress)) return;
    stream.progress = Math.max(stream.progress, 0.5 + Math.min(0.999, Math.max(0, progress)) * 0.5);
  }

  notifySceneStreamReady(actorGuid: string, streamLoadId: number): void {
    const stream = this.sceneStreams.get(actorGuid);
    if (this.stopped || !stream || stream.loadId !== streamLoadId || stream.state !== "Loading" || !stream.notified || !this.streamActorReady(stream.actor)) return;
    try {
      stream.state = "Loaded";
      this.physicsSync.syncFromWorld(this.world);
      this.registerNavAgents();
      this.registerNavObstacles([...stream.actors], stream.navObstacles);
      stream.progress = 1;
      stream.resolve();
      for (const pending of [...this.sceneStreams.values()]) this.publishSceneStreamRealized(pending);
      this.flushOwnerActions();
      // After the streamed actors' Begin Play, as Scene Loaded follows the main
      // scene's: the stream's Scene is admitted with its actors (not while paused).
      this.runOwnerAction(stream.scene, () => {
        if (this.sceneStreams.get(actorGuid) !== stream || stream.state !== "Loaded" ||
          !(stream.actor instanceof SceneStreamingActor)) return;
        this.announcedSceneStreams.add(stream);
        this.world.notifyStreamedSceneLoaded(stream.actor, stream.scene);
      });
    } catch (error) {
      this.retireSceneStream(stream, error);
    }
  }

  notifySceneStreamFailed(actorGuid: string, streamLoadId: number, message: string): void {
    const stream = this.sceneStreams.get(actorGuid);
    if (stream?.loadId === streamLoadId) this.retireSceneStream(stream, new Error(message));
  }

  unloadSceneStream(target: unknown, blocking = false): Promise<void> {
    const actor = this.streamingActor(target);
    if (!actor) return Promise.reject(new Error("Scene streaming requires a live SceneStreamingActor Target."));
    const stream = this.sceneStreams.get(actor.guid);
    if (!stream) return Promise.resolve();
    if (stream.unloadPromise) return this.withStreamBlock(stream.unloadPromise, blocking);
    stream.state = "Unloading";
    stream.progress = 0;
    stream.controller.abort(sceneRealizationCancelled());
    const controller = new AbortController();
    const operation = Promise.resolve().then(async () => {
      await runSceneRealizationWork(this.removeSceneStreamActors(stream), controller.signal, this.cooperativeSceneLoading ?? {});
      this.retireSceneStream(stream);
      if (!this.stopped) this.publishSnapshot();
    });
    stream.unloadPromise = operation;
    return this.withStreamBlock(operation, blocking);
  }

  private *removeSceneStreamActors(stream: SceneStream): Generator<void, void, unknown> {
    for (const child of stream.actors) {
      if (this.sceneStreams.get(stream.actor.guid) !== stream) return;
      const nested = this.sceneStreams.get(child.guid);
      if (nested) {
        nested.state = "Unloading";
        nested.progress = 0;
        nested.controller.abort(sceneRealizationCancelled());
        yield* this.removeSceneStreamActors(nested);
        this.retireSceneStream(nested);
      }
      // Another unload or Stop can drain this same subtree while we yield.
      if (this.sceneStreams.get(stream.actor.guid) !== stream) return;
      if (!stream.actors.has(child)) continue;
      this.removeSceneStreamActor(stream, child);
      yield;
    }
  }

  private removeSceneStreamActor(stream: SceneStream, actor: Actor): void {
    this.removeOwnedActor(actor);
    const agent = this.navAgentByActor.get(actor.guid);
    if (agent) this.nav?.removeAgent(agent);
    this.navAgentByActor.delete(actor.guid);
    this.navTargetByActor.delete(actor.guid);
    this.navYawByActor.delete(actor.guid);
    this.navSteeredActors.delete(actor.guid);
    stream.actors.delete(actor);
    // Destruction hooks belong to this actor's budget, not a final subtree batch.
    // flushPending drains queues; it does not rescan the remaining world itself.
    this.world.flushPending();
  }

  private retireSceneStream(stream: SceneStream, failure?: unknown): void {
    if (this.sceneStreams.get(stream.actor.guid) !== stream) return;
    this.assetPreloads.releaseOwner(stream.scene.guid);
    const wasLoaded = stream.state === "Loaded";
    stream.state = "Unloading";
    stream.progress = 0;
    stream.controller.abort(sceneRealizationCancelled());
    this.sceneStreams.delete(stream.actor.guid);
    this.emit({ type: "sceneStreamRemoved", actorGuid: stream.actor.guid, streamLoadId: stream.loadId });
    for (const actor of stream.actors) this.removeSceneStreamActor(stream, actor);
    this.world.flushPending();
    stream.scene.destroyed = true;
    this.tweens.cancelInvalid();
    stream.scene.callOnDestroyed();
    this.pendingOwnerActions.delete(stream.scene);
    // Paired with Streamed Scene Loaded; a stream that never became ready is silent.
    if (this.announcedSceneStreams.delete(stream) && stream.actor instanceof SceneStreamingActor) {
      this.world.notifyStreamedSceneUnloaded(stream.actor, stream.scene);
    }
    for (const obstacle of stream.navObstacles) this.nav?.removeObstacle(obstacle);
    // A graph may retain a destroyed actor reference. Its WeakMap ownership
    // must not retain the rest of the unloaded instance through this set.
    stream.actors.clear();
    stream.idMap = new Map();
    stream.navObstacles.length = 0;
    this.physicsSync.syncFromWorld(this.world);
    stream.source?.release();
    stream.source = undefined;
    if (failure || !wasLoaded) stream.reject(failure ?? sceneRealizationCancelled());
    else stream.resolve();
  }

  async loadPhysics(): Promise<void> {
    if (this.stopped) throw sceneRealizationCancelled();
    const lifecycleId = this.lifecycleId;
    const generation = this.physicsGeneration;
    const current = () => !this.stopped && lifecycleId === this.lifecycleId && generation === this.physicsGeneration;
    if (this.preferSoftwarePhysics) return;
    if (!(this.physicsSync.getBackend() instanceof SoftwarePhysicsBackend)) {
      return;
    }
    const backend = await createPhysicsBackend({
      kind: this.physicsWorldKind,
      gravity: {
        x: this.gravity[0],
        y: this.gravity[1],
        z: this.gravity[2],
      },
      havokWasmUrl: this.havokWasmUrl,
      allowSoftwareFallback: false,
    });
    if (!current()) {
      backend.dispose();
      throw sceneRealizationCancelled();
    }
    let overlayBackend: PhysicsBackend;
    try {
      overlayBackend = await createPhysicsBackend({
        kind: "2d",
        // Without layer documents this session cannot create overlay actors.
        preferSoftware: this.sceneLayerLibrary.size === 0,
        gravity: {
          x: this.overlayGravity[0],
          y: this.overlayGravity[1],
          z: this.overlayGravity[2],
        },
        allowSoftwareFallback: false,
      });
    } catch (error) {
      backend.dispose();
      throw error;
    }

    if (!current()) {
      backend.dispose();
      overlayBackend.dispose();
      throw sceneRealizationCancelled();
    }
    backend.setGravity({ x: this.gravity[0], y: this.gravity[1], z: this.gravity[2] });
    const physicsSync = new PhysicsWorldSync(backend, {
      actorFilter: (actor) => actor.sceneLayerId == null && this.streamActorReady(actor),
    });
    const overlayPhysicsSync = new PhysicsWorldSync(overlayBackend, {
      actorFilter: (actor) => actor.sceneLayerId != null && this.canTickActor(actor, true),
    });
    try {
      this.bindPhysicsContent(physicsSync);
      physicsSync.syncFromWorld(this.world);
      this.bindPhysicsContent(overlayPhysicsSync);
      overlayPhysicsSync.syncFromWorld(this.world);
    } catch (error) {
      physicsSync.dispose();
      overlayPhysicsSync.dispose();
      throw error;
    }
    this.physicsSync.dispose();
    this.overlayPhysicsSync.dispose();
    this.physicsSync = physicsSync;
    this.overlayPhysicsSync = overlayPhysicsSync;
  }

  getPhysicsSync(): PhysicsWorldSync | null {
    return this.physicsSync;
  }

  getOverlayPhysicsSync(): PhysicsWorldSync | null {
    return this.overlayPhysicsSync;
  }

  applyRagdollPoseCaptured(message: Extract<ControlMessage, { type: "ragdollPoseCaptured" }>): void {
    if (this.stopped) return;
    this.ragdolls.accept(message);
    this.physicsSync.syncFromWorld(this.world);
  }

  private setWorldGravity(gravity: { x: number; y: number; z: number }): void {
    const next: [number, number, number] = [
      Number.isFinite(gravity.x) ? gravity.x : 0,
      Number.isFinite(gravity.y) ? gravity.y : 0,
      Number.isFinite(gravity.z) ? gravity.z : 0,
    ];
    this.gravity = next;
    this.physicsSync.getBackend().setGravity({
      x: next[0],
      y: next[1],
      z: next[2],
    });
    if (this.playScene) {
      // Prepared authoring content is also the immutable Simulation baseline.
      this.playScene = { ...this.playScene, settings: { ...this.playScene.settings, gravity: next } };
    }
    const scene = this.world.currentScene;
    if (scene && !scene.destroyed) {
      scene.setVariable("gravity", { x: next[0], y: next[1], z: next[2] });
    }
  }

  private async createSceneLayerAsync(assetGuid: string, zOrder: number, owner: BObject | null): Promise<SceneLayer | null> {
    if (this.stopped || owner?.destroyed) throw sceneRealizationCancelled();
    const preload = this.demandAssetCatalog
      ? await this.assetPreloads.acquire([assetGuid], owner?.guid ?? this.world.currentScene?.guid ?? "session") : null;
    let layer: SceneLayer | null = null;
    try {
      { const pending = this.continueSimulation(owner); if (pending) await pending; }
      if (preload && !preload.success) throw new Error(`Cannot create SceneLayer ${assetGuid}: ${preload.errorMessage}`);
      if (this.stopped || owner?.destroyed) throw sceneRealizationCancelled();
      layer = this.createSceneLayer(assetGuid, zOrder);
      if (!layer || layer.destroyed) throw new Error(`SceneLayer ${assetGuid} could not be prepared`);
      if (preload) this.assetPreloads.transferOwner(preload.preloadId, layer.guid);
      if (!this.layerLoads.get(layer.guid)?.ready) {
        const layerId = layer.guid;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.layerReadinessWaiters.delete(layerId);
            reject(new Error(`SceneLayer ${assetGuid} did not become ready before the loading deadline`));
          }, 30_000);
          this.layerReadinessWaiters.set(layerId, {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: error => { clearTimeout(timer); reject(error); },
          });
        });
      }
      { const pending = this.continueSimulation(owner); if (pending) await pending; }
      return layer;
    } catch (error) {
      if (layer) this.removeSceneLayer(layer.guid);
      if (preload) this.assetPreloads.release(preload.preloadId);
      throw error;
    }
  }

  createSceneLayer(
    assetGuid: string,
    zOrder = 0,
    ownerSceneGuid: string | null = null,
  ): SceneLayer | null {
    if (this.stopped) return null;
    if (!this.cooperativeSceneLoading) {
      const steps = this.createSceneLayerSteps(assetGuid, zOrder, ownerSceneGuid);
      let next = steps.next();
      while (!next.done) next = steps.next();
      return next.value;
    }
    const controller = new AbortController();
    const created: SceneLayer[] = [];
    let paint!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const painted = this.deferSceneLoadingPaint ? new Promise<void>((resolve, reject) => {
      paint = resolve;
      timer = setTimeout(() => reject(new Error("SceneLayer Loading did not paint before the loading deadline.")), 30_000);
    }) : Promise.resolve();
    const fail = (error: unknown) => {
      const layer = created[0];
      const work = layer && this.independentLayerWork.get(layer.guid);
      if (!layer || !work || work.controller !== controller || controller.signal.aborted || this.stopped) return;
      this.emit({ type: "sceneLayerLoadFailed", layerId: layer.guid, layerLoadId: work.loadId,
        message: error instanceof Error ? error.message : String(error) });
      this.reportError(error);
    };
    const steps = this.createSceneLayerSteps(assetGuid, zOrder, ownerSceneGuid, undefined, {
      signal: controller.signal,
      created: (layer, loadId) => {
        created.push(layer);
        // The in-process host can acknowledge inside sceneLayerLoading emission.
        this.independentLayerWork.set(layer.guid, { layer, loadId, controller, painted: () => paint?.() });
      },
      failed: fail,
    });
    try {
      const first = steps.next();
      const layer = created[0];
      if (first.done === true || !layer) {
        clearTimeout(timer);
        return first.done === true ? first.value : null;
      }
      void (async () => {
        try {
          await waitForSceneWork(painted, controller.signal);
          clearTimeout(timer);
          const remaining = function* () { yield* steps; };
          await runSceneRealizationWork(remaining(), controller.signal, this.cooperativeSceneLoading!);
        } catch (error) { fail(error); }
        finally {
          clearTimeout(timer);
          try { steps.return(null); }
          finally { if (this.independentLayerWork.get(layer.guid)?.controller === controller) this.independentLayerWork.delete(layer.guid); }
        }
      })().catch((error: unknown) => { if (!this.stopped) this.reportError(error); });
      return layer;
    } catch (error) {
      clearTimeout(timer);
      steps.return(null);
      throw error;
    }
  }

  notifySceneLayerLoadingPainted(layerId: string, layerLoadId: number): void {
    const work = this.independentLayerWork.get(layerId);
    if (this.stopped || !work || work.loadId !== layerLoadId || work.controller.signal.aborted || this.world.findSceneLayer(layerId) !== work.layer) return;
    work.painted();
  }

  private *createSceneLayerSteps(
    assetGuid: string,
    zOrder = 0,
    ownerSceneGuid: string | null = null,
    work?: SceneRealization,
    independent?: { signal: AbortSignal; created: (layer: SceneLayer, loadId: number) => void; failed: (error: unknown) => void },
  ): Generator<void, SceneLayer | null, unknown> {
    let ownedLayer: SceneLayer | null = null;
    const checkpoint = () => {
      if (work) this.checkRealization(work);
      independent?.signal.throwIfAborted();
      if (ownedLayer && this.world.findSceneLayer(ownedLayer.guid) !== ownedLayer) throw sceneRealizationCancelled();
    };
    checkpoint();
    const guid = String(assetGuid ?? "").trim();
    const raw = this.sceneLayerLibrary.get(guid);
    if (!raw) {
      this.emit({
        type: "log",
        severity: "warning",
        category: "scene-layer",
        message: `createSceneLayer: no SceneLayer asset loaded for ${guid}`,
        frameId: this.frameId,
      });
      return null;
    }
    const document = normalizeSceneLayer({ ...raw, actors: [], folders: [] });
    if (this.world.getSceneLayers().length === 0) {
      this.overlayPhysicsSync.getBackend().setGravity({
        x: document.settings.gravity[0],
        y: document.settings.gravity[1],
        z: document.settings.gravity[2],
      });
    }
    const layer = this.world.createSceneLayer({
      assetGuid: guid,
      zOrder: Math.trunc(Number(zOrder) || 0),
      ownerSceneGuid,
      postProcessStack: document.settings.postProcessStack.map((entry) => ({
        ...entry,
      })),
      layerBounds: document.settings.layerBounds,
    });
    this.markUnsupportedSimulationInstance("layer", layer.guid);
    ownedLayer = layer;
    work?.layers.push(layer);
    const layerLoad = { layer, loadId: ++this.layerLoadId, realized: false, presented: false, ready: false };
    this.layerLoads.set(layer.guid, layerLoad);
    const actors: Actor[] = [];
    let completed = false;
    try {
    independent?.created(layer, layerLoad.loadId);
    this.emit({ type: "sceneLayerLoading", layerId: layer.guid, assetGuid: guid, layerLoadId: layerLoad.loadId });
    checkpoint();
    this.emit({
      type: "sceneLayerCreate",
      layerId: layer.guid,
      assetGuid: guid,
      zOrder: layer.zOrder,
      ownerSceneGuid: layer.ownerSceneGuid,
      postProcessStack: layer.postProcessStack.map((entry) => ({ ...entry })),
      layerBounds: { ...layer.layerBounds },
    });
    checkpoint();
    // Return the live loading identity before actor remapping or realization.
    yield;
    checkpoint();
    const serializedActors = normalizeSceneLayer(raw).actors;
    yield;
    checkpoint();
    const remapped = yield* remapOverlaySerializedActors(
      serializedActors,
      layer.guid,
      (id) => this.slotByGuid.has(id) || this.world.findActor(id) != null,
    );
    for (const serialized of remapped) {
      checkpoint();
      const actor = createActorFromSerialized(this.world, serialized, this.sceneActorHooks, layer.guid);
      if (actor) {
        actors.push(actor);
        work?.actors.push(actor);
      }
      yield;
    }
    hydrateScenePropertyReferences(actors);
    for (const actor of actors) {
      checkpoint();
      this.scriptHost.bindInterfaceHandlers(actor);
      this.applyActorDefaults(actor);
      this.assignSlot(actor);
      checkpoint();
      this.world.spawnActorNow(actor);
      checkpoint();
      yield;
    }
    for (const actor of actors) this.sceneLayerSwitchers.initialize(actor);
    this.breakLoadedParentCycles(actors);
    for (const actor of actors) {
      checkpoint();
      this.ensureOverlayDesignPose(actor);
      yield;
    }
    for (const _ of this.applyOverlayAnchors(actors)) {
      checkpoint();
      yield _;
    }
    for (const actor of actors) {
      checkpoint();
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      this.emitMeshAssignment(actor, slotId);
      checkpoint();
      this.emitAudioComponents(actor);
      checkpoint();
      this.emitParticleComponents(actor);
      checkpoint();
      yield;
    }
    layerLoad.realized = true;
    this.publishSnapshot();
    this.emit({ type: "sceneLayerRealized", layerId: layer.guid, layerLoadId: layerLoad.loadId });
    if (!this.deferSceneModelsReady) this.notifySceneLayerReady(layer.guid, layerLoad.loadId);
    completed = true;
    return layer;
    } catch (error) {
      independent?.failed(error);
      throw error;
    } finally {
      if (!completed) {
        // Creation and spawn are separate passes. An aborted creation pass can
        // own Actors which never entered the World or received a render slot.
        for (const actor of actors) if (!actor.destroyed && !actor.world) this.removeOwnedActor(actor);
        if (this.world.findSceneLayer(layer.guid) === layer) this.removeSceneLayer(layer.guid);
      }
    }
  }

  private applyOverlayLayouts(): void {
    // Virtual layout creates and retires ordinary UI actors. Their lifecycle
    // must run after restoration, outside the restored-world hook suppression.
    if (this.saveBoundaryActive) { this.saveOverlayLayoutPending = true; return; }
    if (this.applyingOverlayLayouts) return;
    this.applyingOverlayLayouts = true;
    try {
      for (const layer of this.world.getSceneLayers()) {
        const safeAreaInsets = {
          left: this.safeAreaInsetsPixels.left * layer.layerBounds.width / this.playCanvasWidth,
          right: this.safeAreaInsetsPixels.right * layer.layerBounds.width / this.playCanvasWidth,
          top: this.safeAreaInsetsPixels.top * layer.layerBounds.height / this.playCanvasHeight,
          bottom: this.safeAreaInsetsPixels.bottom * layer.layerBounds.height / this.playCanvasHeight,
        };
        let result = this.overlayLayout.update(layer.guid, this.world.getActors(), this.pixelsPerUnit, this.texturePixelSizes, safeAreaInsets);
        if (this.overlayVirtualization.sync(layer.guid, this.world.getActors(), result?.entries ?? this.overlayLayout.entries(layer.guid),
          (owner, classId, defaults) => this.spawnSceneLayerActor(owner, classId, defaults),
          (actor) => this.removeSceneLayerActorSubtree(actor))) {
          result = this.overlayLayout.update(layer.guid, this.world.getActors(), this.pixelsPerUnit, this.texturePixelSizes, safeAreaInsets) ?? result;
        }
        if (!result || layer.destroyed) continue;
        const transforms = new Map(result.actors.flatMap(actor => actor.components.map(component => [overlayLayoutKey(actor.id, component.id), component.transform] as const)));
        this.emit({ type: "sceneLayerLayout", layerId: layer.guid, entries: [...result.entries].flatMap(([key, entry]) => {
          const slotId = this.slotByGuid.get(entry.actorId);
          return slotId === undefined ? [] : [{ ...entry, slotId, transform: transforms.get(key) }];
        }) });
      }
    } finally { this.applyingOverlayLayouts = false; }
  }

  applySceneLayerScroll(layerId: string, actorId: string, componentId: string, deltaX: number, deltaY: number): void {
    const actor = this.world.findActor(actorId);
    if (!actor || actor.sceneLayerId !== layerId || !this.canTickActor(actor)) return;
    const component = actor.components.find(c => c.guid === componentId && isOverlayScrollClass(c.classId) && !c.destroyed);
    const state = this.overlayLayout.entries(layerId).get(overlayLayoutKey(actorId, componentId))?.scroll;
    if (!component || !state) return;
    component.setVariable("scrollX", Math.max(0, Math.min(state.maxX, state.x + (Number.isFinite(deltaX) ? deltaX : 0))));
    component.setVariable("scrollY", Math.max(0, Math.min(state.maxY, state.y + (Number.isFinite(deltaY) ? deltaY : 0))));
    this.applyOverlayLayouts();
    this.publishSnapshot();
  }

  removeSceneLayer(layerGuid: string): void {
    this.layerReadinessWaiters.get(layerGuid)?.reject(sceneRealizationCancelled());
    this.layerReadinessWaiters.delete(layerGuid);
    this.assetPreloads.releaseOwner(layerGuid);
    const layer = this.world.findSceneLayer(layerGuid);
    if (!layer) return;
    this.layerLoads.delete(layerGuid);
    this.overlayLayout.remove(layerGuid);
    this.overlayVirtualization.remove(layerGuid);
    this.focusNavigation.refresh();
    const work = this.independentLayerWork.get(layerGuid);
    if (work?.layer === layer) {
      this.independentLayerWork.delete(layerGuid);
      work.controller.abort(sceneRealizationCancelled());
    }
    for (const actor of [...this.world.getActors()]) {
      if (actor.sceneLayerId !== layer.guid) continue;
      if (this.world.findSceneLayer(layer.guid) !== layer) return;
      this.removeOwnedActor(actor);
    }
    if (this.world.findSceneLayer(layer.guid) !== layer) return;
    this.emit({ type: "sceneLayerRemove", layerId: layer.guid });
    if (this.world.findSceneLayer(layer.guid) === layer) this.world.destroySceneLayer(layer.guid);
    this.tweens.cancelInvalid();
  }

  clearSceneLayers(): void {
    for (const layer of [...this.world.getSceneLayers()]) {
      this.removeSceneLayer(layer.guid);
    }
    this.emit({ type: "sceneLayerClear" });
  }

  registerSceneLayerPostProcess(layerGuid: string, materialGuid: string): void {
    const layer = this.world.findSceneLayer(layerGuid);
    const guid = String(materialGuid ?? "").trim();
    if (!layer || !guid) return;
    layer.postProcessStack.push({ id: newGuid(), materialGuid: guid, enabled: true });
    this.emitSceneLayerPostProcess(layer);
  }

  unregisterSceneLayerPostProcess(
    layerGuid: string,
    materialGuid: string,
  ): void {
    const layer = this.world.findSceneLayer(layerGuid);
    const guid = String(materialGuid ?? "").trim();
    if (!layer || !guid) return;
    const index = layer.postProcessStack.findIndex(
      (entry) => entry.materialGuid === guid,
    );
    if (index < 0) {
      this.emit({
        type: "log",
        severity: "error",
        category: "scene-layer",
        message: `SceneLayer post-process ${guid} is not registered on layer ${layer.guid}`,
        frameId: this.frameId,
      });
      return;
    }
    layer.postProcessStack.splice(index, 1);
    this.emitSceneLayerPostProcess(layer);
  }

  applySceneLayerResize(
    frustumWidth: number,
    frustumHeight: number,
    canvasWidth?: number,
    canvasHeight?: number,
    safeAreaInsets?: Partial<OverlaySafeAreaInsets>,
  ): void {
    const width = Number(frustumWidth);
    const height = Number(frustumHeight);
    if (!Number.isFinite(width) || width <= 0) return;
    if (!Number.isFinite(height) || height <= 0) return;
    if (typeof canvasWidth === "number" && canvasWidth > 0) {
      this.playCanvasWidth = canvasWidth;
    }
    if (typeof canvasHeight === "number" && canvasHeight > 0) {
      this.playCanvasHeight = canvasHeight;
    }
    const inset = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
    this.safeAreaInsetsPixels = {
      left: inset(safeAreaInsets?.left),
      right: inset(safeAreaInsets?.right),
      top: inset(safeAreaInsets?.top),
      bottom: inset(safeAreaInsets?.bottom),
    };
    for (const _ of this.applyOverlayAnchors(this.world.getActors())) void _;
    this.applyOverlayLayouts();
    this.overlayPhysicsSync.syncFromWorld(this.world);
  }

  applySceneLayerFocusNavigate(reverse: boolean): void {
    const focused = this.focusNavigation.advance(reverse);
    const actor = focused?.owner;
    const slotId = actor ? this.slotByGuid.get(actor.guid) : undefined;
    // A single remaining target may not transition. Acknowledge it so the host
    // can reopen a text editor after Tab without inventing another focus order.
    if (focused && isUIControl2DClass(focused.classId) && slotId !== undefined) {
      this.emit({ type: "setUIControl2D", slotId, componentId: focused.guid,
        uiControl: { classId: focused.classId, properties: this.uiControls.payload(focused) }, focused: true, beginEditing: true });
    }
  }

  applySceneLayerControl(message: Extract<ControlMessage, { type: "sceneLayerControl" }>): void {
    const actor = this.world.findActor(message.actorGuid);
    if (!actor || actor.destroyed || actor.sceneLayerId !== message.layerId || !actor.sceneLayerId || !this.canTickActor(actor)) return;
    const component = actor.components.find((entry) => entry.guid === message.componentId || entry.sourceId === message.componentId);
    if (!component || component.destroyed || !isInteractiveUIControl2DClass(component.classId)) return;
    if (message.action === "focus") this.focusNavigation.setFocus(component);
    else if (message.action === "blur") this.focusNavigation.clearFocus(component);
    else this.uiControls.input(component, message);
  }

  applySceneLayerPointer(
    message: Extract<ControlMessage, { type: "sceneLayerPointer" }>,
  ): void {
    const actor = this.world.findActor(message.actorGuid);
    if (!actor || actor.destroyed || !actor.sceneLayerId) return;
    if (!this.canTickActor(actor)) return;
    const requested =
      typeof message.componentId === "string" ? message.componentId.trim() : "";
    const resolved = resolveOverlayPointerButton(this.world, actor, requested);
    if (!resolved) return;
    if (resolved.button?.getVariable("enabled") === false) return;
    if (message.event === "onPressStart" && resolved.button) this.focusNavigation.setFocus(resolved.button);
    this.scriptHost.invokeEvent(
      resolved.owner.classId,
      message.event,
      resolved.owner,
      {},
      resolved.button?.guid,
    );
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
      this.runOwnerAction(component, () => this.scriptHost.invokeEvent(
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
      this.runOwnerAction(owner, () => this.scriptHost.invokeEvent(owner.classId, "onScalabilityChanged", owner, { settings: snapshot }));
    }
  }

  private ensureOverlayDesignPose(actor: Actor): void {
    if (!actor.sceneLayerId) return;
    if (this.overlayDesignPose.has(actor.guid)) return;
    this.overlayDesignPose.set(actor.guid, {
      x: actor.transform.position.x,
      y: actor.transform.position.y,
    });
  }

  private readonly anchoredOverlayActors = new Set<string>();

  private *applyOverlayAnchors(actors: readonly Actor[]): Generator<void, void, unknown> {
    const bindings = overlayAnchorBindings(actors);
    for (const actor of actors) {
      if (!actor.sceneLayerId || actor.destroyed) continue;
      this.ensureOverlayDesignPose(actor);
      if (isSceneLayerAnchorActor(actor)) actor.transform = identityTransform();
      const anchor = bindings.get(actor);
      if (anchor) {
        this.applyRelativeOverlayAnchor(actor, anchor);
        this.anchoredOverlayActors.add(actor.guid);
      } else if (this.anchoredOverlayActors.delete(actor.guid)) {
        const authored = this.overlayDesignPose.get(actor.guid)!;
        actor.transform.position.x = authored.x;
        actor.transform.position.y = authored.y;
      }
      yield;
    }
  }

  private flushPainters(): void {
    this.painters.flush((component, painter) => {
      const slotId = component.owner ? this.slotByGuid.get(component.owner.guid) : undefined;
      if (slotId !== undefined) this.emit({ type: "setPainter2D", slotId, componentId: component.guid, painter });
    });
  }

  private flushTextAppear(): void {
    this.textAppear.flush((component, progress) => {
      const slotId = component.owner ? this.slotByGuid.get(component.owner.guid) : undefined;
      if (slotId !== undefined) this.emit({ type: "setText2DAppear", slotId, componentId: component.guid, progress });
    });
  }

  private applyRelativeOverlayAnchor(actor: Actor, anchorComp: ActorComponent): void {
    this.ensureOverlayDesignPose(actor);
    const authored = this.overlayDesignPose.get(actor.guid) ?? {
      x: actor.transform.position.x,
      y: actor.transform.position.y,
    };
    const layer = this.world.findSceneLayer(actor.sceneLayerId!);
    const bounds = layer?.layerBounds ?? SCENE_LAYER_DEFAULT_LAYER_BOUNDS;
    const pos = sceneLayerRelativeAnchorWorldPosition({
      anchor: parseSceneLayerAnchor(anchorComp.getVariable("anchor")),
      authoredX: authored.x,
      authoredY: authored.y,
      offsetX: Number(anchorComp.getVariable("offsetX")) || 0,
      offsetY: Number(anchorComp.getVariable("offsetY")) || 0,
      layerWidth: bounds.width,
      layerHeight: bounds.height,
      frustumWidth: bounds.width,
      frustumHeight: bounds.height,
    });
    actor.transform.position.x = pos.x;
    actor.transform.position.y = pos.y;
  }

  private emitSceneLayerPostProcess(layer: SceneLayer): void {
    this.emit({
      type: "sceneLayerPostProcess",
      layerId: layer.guid,
      postProcessStack: layer.postProcessStack.map((entry) => ({ ...entry })),
    });
  }

  private *spawnOwnedSceneLayers(work: SceneRealization): Generator<void, void, unknown> {
    for (const entry of work.scene?.settings.sceneLayers ?? []) {
      this.checkRealization(work);
      if (entry.enabled) {
        yield* this.createSceneLayerSteps(entry.assetGuid, entry.zOrder, work.guid, work);
      }
      yield;
    }
  }

  private bindPhysicsContent(sync: PhysicsWorldSync): void {
    sync.water.setContent(this.waters);
    sync.setTileContent({
      tilemaps: this.tilemaps,
      tilesets: this.tilesets,
      pixelsPerUnit: this.pixelsPerUnit,
    });
    sync.setSpriteContent({
      sprites: this.sprites,
      spriteAnimations: this.spriteAnimations,
      pixelsPerUnit: this.pixelsPerUnit,
    });
    sync.setModelContent({
      models: this.models,
      complexMeshes: this.complexMeshes,
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
        ...[...this.sceneStreams.values()].map((stream) => stream.scene)];
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
    const stream = this.streamForOwner(options.streamOwner);
    if (stream && (options.streamOwner?.destroyed || !this.sceneStreamReady(stream))) return null;
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
        onCreation: (self) => this.runOwnerCreation(self, () => hooks.onCreation?.(self)),
        onTick: (self, ctx) =>
          this.guardScript(() => hooks.onTick?.(self, ctx)),
        onDestroyed: (self) =>
          this.runOwnerDestroyed(self, () => hooks.onDestroyed?.(self)),
      },
    });
    if (stream) {
      stream.actors.add(actor);
      this.actorStream.set(actor, stream);
      actor.setVariable("parentId", stream.actor.guid);
      if (stream.origin) actor.transform = composeParentChildTransform(stream.origin, actor.transform);
    }
    this.scriptHost.bindInterfaceHandlers(actor);
    const components = this.scriptHost.scriptsFor(options.classId)
      .find((script) => script.components !== undefined)?.components;
    if (components) attachSerializedComponents(this.world, actor, components, { freshIds: true });
    this.savedActors.add(actor);
    try {
      this.realizeActor(actor);
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
    return actor;
  }

  /** Selection-owned descendants must never outlive their removed screen. */
  private removeSceneLayerActorSubtree(root: Actor): void {
    const descendants = [root];
    const seen = new Set<Actor>(descendants);
    const actors = [...this.world.getActors()];
    for (let index = 0; index < descendants.length; index++) {
      const parent = descendants[index]!;
      for (const actor of actors) {
        if (seen.has(actor) || actor.sceneLayerId !== root.sceneLayerId || actor.getVariable("parentId") !== parent.guid) continue;
        descendants.push(actor); seen.add(actor);
      }
    }
    for (const actor of descendants.reverse()) this.removeOwnedActor(actor);
  }

  /** Spawn a prefab in its owner's overlay; transforms stay local to the parent. */
  private spawnSceneLayerActor(parent: Actor, classId: string, defaults: Record<string, unknown> = {}): Actor | null {
    if (this.stopped || parent.destroyed || !parent.sceneLayerId || !this.world.findSceneLayer(parent.sceneLayerId) ||
      !this.world.classRegistry.isA(classId, "SceneLayerActor") || this.sceneLayerSpawnDepth >= 32) return null;
    this.sceneLayerSpawnDepth++;
    let actor: Actor | null = null;
    try {
      const variables = structuredClone(defaults);
      for (const variable of this.world.classRegistry.inheritedVariables(classId)) {
        if (!Object.hasOwn(variables, variable.name) || !variable.container) continue;
        variables[variable.name] = hydrateClassVariableValue({ ...variable, defaultValue: variables[variable.name] });
      }
      actor = this.world.createActor({
        classId, sceneLayerId: parent.sceneLayerId,
        variables: { ...variables, parentId: parent.guid },
        hooks: this.sceneActorHooks(classId),
      });
      const components = this.world.classRegistry.ancestry(classId)
        .flatMap((ancestor) => this.scriptHost.scriptsFor(ancestor))
        .find((script) => script.components !== undefined)?.components;
      if (components) attachSerializedComponents(this.world, actor, components, { freshIds: true });
      this.scriptHost.bindInterfaceHandlers(actor);
      this.ensureOverlayDesignPose(actor);
      for (const _ of this.applyOverlayAnchors([actor])) { void _; }
      this.realizeActor(actor);
      this.sceneLayerSwitchers.initialize(actor);
      return actor.destroyed ? null : actor;
    } catch (error) {
      if (actor) this.removeOwnedActor(actor);
      throw error;
    } finally {
      this.sceneLayerSpawnDepth--;
    }
  }

  private readonly sceneActorHooks: SceneActorHooks = (classId) => {
    const hooks = this.scriptHost.hooksFor(classId);
    return {
      onCreation: (self) => this.runOwnerCreation(self, () => hooks?.onCreation?.(self)),
      // Logic-free actors (Prefabs, scriptless classes) add no per-frame call.
      onTick: hooks?.onTick
        ? (self, ctx) => this.guardScript(() => hooks.onTick?.(self, ctx))
        : undefined,
      onDestroyed: (self) => {
        this.sceneLayerSwitchers.retire(self);
        this.runOwnerDestroyed(self, () => hooks?.onDestroyed?.(self));
      },
    };
  };

  private refreshRuntimeComponent(component: ActorComponent, propertyName?: string): void {
    const owner = component.owner;
    if (!owner || owner.destroyed) return;
    if (isUIControl2DClass(component.classId)) {
      this.uiControls.refresh(component);
      if (owner.sceneLayerId) this.applyOverlayLayouts();
      return;
    }
    if ((propertyName === "opacity" || propertyName === "tint") && supportsOverlayVisualStyle(component.classId)) {
      const slotId = this.slotByActor.get(owner);
      if (slotId !== undefined) this.emit({ type: "setOverlayVisualStyle", slotId, componentId: component.guid,
        style: parseOverlayVisualStyle(Object.fromEntries(component.variables)) });
      return;
    }
    if (component.classId === "2DRichTextComponent") this.textAppear.refresh(component);
    if (owner.sceneLayerId && component.classId === "2DAnchorComponent") {
      for (const _ of this.applyOverlayAnchors(this.world.getActors())) void _;
    }
    if (owner.sceneLayerId) this.applyOverlayLayouts();
    if (owner.sceneLayerId && isOverlayScrollClass(component.classId) &&
      (propertyName === "scroll.offset" || propertyName === "scrollX" || propertyName === "scrollY")) {
      const scroll = this.overlayLayout.entries(owner.sceneLayerId).get(overlayLayoutKey(owner.guid, component.guid))?.scroll;
      if (scroll) { component.setVariable("scrollX", scroll.x); component.setVariable("scrollY", scroll.y); }
    }
    if (owner.sceneLayerId && (isOverlayLayoutClass(component.classId) || component.classId === "2DAnchorComponent")) return;
    // Steering/tuning is consumed by the next motor tick; only dimensions
    // need immediate collider/query refresh after a property write.
    if (component.classId === "MovementComponent" && propertyName && propertyName !== "radius" && propertyName !== "height") return;
    const slotId = this.slotByActor.get(owner);
    if (component.classId === "DeformerComponent") {
      if (slotId !== undefined) {
        if (this.processingTick) this.dirtyDeformerActors.add(owner);
        else this.emitActorDeformers(owner, slotId);
      }
      return;
    }
    if (component.classId === "MeshComponent" && propertyName === "materialGuid") {
      // A staged material belongs to this existing native mesh. Re-emitting the
      // mesh assignment here would replace that owner between prepare/commit.
      if (slotId !== undefined) this.emitMaterialAssignments([component], slotId, true);
      return;
    }
    if (component.classId === "DynamicRuntimeMeshComponent" &&
      (propertyName === "materialGuid" || propertyName === "enableCollision" || propertyName === "layer" || propertyName === "mask")) {
      if (propertyName === "materialGuid" && slotId !== undefined) this.emitMaterialAssignments([component], slotId, true);
      // Geometry collision changes are coalesced by the next physics step.
      return;
    }
    if (slotId !== undefined) {
      if (component.classId === "RenderTargetCaptureComponent") this.emitRenderTargetCapture(owner, slotId);
      else if (component.classId === "OutlineComponent") this.emitActorOutlines(owner, slotId);
      else if (component.classId === "FogVolumeComponent") this.emitActorFogVolumes(owner, slotId);
      else if (propertyName === "transform") this.emitComponentTransforms(owner, slotId);
      else if (component.classId !== "PhysicsConstraintComponent" && component.classId !== "RagdollComponent" && component.classId !== "MovementComponent") this.emitMeshAssignment(owner, slotId);
    }
    if (component.classId === "ParticleComponent") {
      this.emitParticleComponents(owner);
    }
    if (component.classId === "AudioComponent") {
      const volume = Number(component.getVariable("volume") ?? 1);
      this.emit({
        type: "setVoiceGain",
        voiceId: component.guid,
        volume: Number.isFinite(volume) ? volume : 1,
      });
    }
    if (component.classId === "NavAgentComponent") {
      this.updateNavAgentParams(owner);
    }
    const sync = owner.sceneLayerId
      ? this.overlayPhysicsSync
      : this.physicsSync;
    if (component.classId === "RagdollComponent" || component.classId === "MeshComponent") {
      // Ragdoll and mesh-collision edits can create or retire the owner's
      // body; reconcile that one actor from its own chain.
      this.ragdolls.sync();
      sync.syncActor(owner, this.world);
    } else sync.applyComponent(component);
  }

  private canTickScene(): boolean {
    return !this.paused && !this.saveBoundaryActive && !this.sceneWorkBlocked && !this.bootLoading && !this.stopped && this.streamBlockingCount === 0;
  }

  private hasReadyLayers(): boolean {
    if (this.stopped || this.streamBlockingCount !== 0) return false;
    for (const load of this.layerLoads.values()) if (load.ready && !load.layer.destroyed) return true;
    return false;
  }

  private canTickActor(actor: Actor, ignorePause = false): boolean {
    if ((!ignorePause && this.paused) || this.stopped || actor.destroyed || this.streamBlockingCount > 0 || !this.streamActorReady(actor)) return false;
    if (!actor.sceneLayerId) return this.canTickScene();
    return this.layerLoads.get(actor.sceneLayerId)?.ready === true;
  }

  private setMaterialParameter(material: MaterialInstanceObject, parameterName: string, parameter: MaterialParameterValue, inspector = false): boolean {
    if (inspector ? !(material instanceof MaterialObject) || !material.component.owner || !this.inspectorActorReady(material.component.owner) : !this.canRunOwner(material)) return false;
    const validated = this.materialParameters.accepts(material, parameterName, parameter);
    if (!validated && (material instanceof PostProcessMaterialObject || this.validateLegacyMeshParameters)) return false;
    if (material instanceof PostProcessMaterialObject) {
      if (!material.entry.id) return false;
      const owner = material.owner;
      const target: Extract<CommandMessage, { type: "setPostProcessMaterialParameter" }>["owner"] = owner instanceof SceneLayer
        ? { kind: "sceneLayer", layerId: owner.guid, layerLoadId: this.layerLoads.get(owner.guid)!.loadId }
        : { kind: "scene", sceneAssetGuid: owner.assetGuid, sceneLoadId: this.sceneLoadId };
      this.emit({ type: "setPostProcessMaterialParameter", owner: target, entryId: material.entry.id,
        materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
    } else {
      const component = material.component;
      const owner = component.owner;
      if (!owner || owner.destroyed || component.destroyed || component.getVariable("materialObject") !== material) return false;
      const slotId = this.slotByActor.get(owner);
      if (slotId === undefined) return false;
      const skipButtonMesh = overlayButtonHasSiblingVisual(owner) || overlayButtonHasParentVisual(owner, this.world);
      if (!owner.components.some((entry) => entry === component && isPlayRenderable(entry, skipButtonMesh))) return false;
      this.emit({ type: "setMaterialParameter", slotId, componentId: component.guid,
        materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
    }
    if (validated) this.materialParameters.set(material, parameterName, parameter);
    return true;
  }

  private canRunOwner(owner: BObject): boolean {
    if (this.paused && !this.stopped) return false;
    if (this.saveBoundaryActive) return false;
    if (owner instanceof GameSubsystem) return this.canRunGameSubsystem(owner);
    // Callable from creation until its On End returns, even while its Scene
    // prepares or Play stops (a sibling's On End may still call it); its own
    // lifecycle waits for the Scene (canRunSceneSubsystem).
    if (owner instanceof SceneSubsystem) {
      return !owner.destroyed && owner.scene === this.world.currentScene &&
        (this.stopped || this.streamBlockingCount === 0);
    }
    if (this.stopped || owner.destroyed || this.streamBlockingCount > 0) return false;
    if (owner instanceof PostProcessMaterialObject)
      return owner.isCurrent() && this.canRunOwner(owner.owner);
    if (owner === this.world.gameInstance) return true;
    const actor = owner instanceof Actor ? owner : owner instanceof ActorComponent ? owner.owner
      : owner instanceof MaterialObject ? owner.component.owner : null;
    if (actor) return actor.world === this.world && this.canTickActor(actor);
    if (owner instanceof SceneLayer) return this.layerLoads.get(owner.guid)?.layer === owner && this.layerLoads.get(owner.guid)?.ready === true;
    if (owner instanceof Scene) {
      const stream = this.streamForOwner(owner);
      return (owner === this.world.currentScene || (!this.paused && stream !== undefined && this.sceneStreamReady(stream))) && this.canTickScene();
    }
    // Detached components and superseded GameInstances have no active owner.
    return !(owner instanceof ActorComponent || owner instanceof MaterialObject || owner instanceof GameInstance);
  }

  /**
   * GameSubsystems wrap the Game Instance: admitted like it while Play runs,
   * and through the whole Stop lifecycle until their own On End has run, so
   * the Game Instance's On End (which runs first) can still call them.
   */
  private canRunGameSubsystem(subsystem: GameSubsystem): boolean {
    if (subsystem.destroyed || !this.world.getGameSubsystems().includes(subsystem)) return false;
    return this.stopped || this.streamBlockingCount === 0;
  }

  /** A SceneSubsystem's On Init, Tick and notifications: its Scene may run. */
  private canRunSceneSubsystem(subsystem: SceneSubsystem): boolean {
    return !subsystem.ended && subsystem.scene === this.world.currentScene && this.canTickScene();
  }

  /**
   * Deferred owner work waits for the owner (a SceneSubsystem's for its
   * Scene). World actors and their components also wait while a current
   * SceneSubsystem has queued work (On Init first), so every subsystem hears
   * Spawned right before the actor's Begin Play.
   */
  private canRunOwnerActions(owner: BObject): boolean {
    if (owner instanceof SceneSubsystem) return this.canRunSceneSubsystem(owner);
    if (!this.canRunOwner(owner)) return false;
    const actor = owner instanceof Actor ? owner : owner instanceof ActorComponent ? owner.owner : null;
    return !actor || !!actor.sceneLayerId || this.world.getSceneSubsystems().every(
      (subsystem) => subsystem.ended || !this.pendingOwnerActions.get(subsystem)?.length);
  }

  private runOwnerAction(owner: BObject, action: () => void): void {
    if (this.canRunOwnerActions(owner)) { action(); return; }
    if (this.stopped || owner.destroyed) return;
    const actions = this.pendingOwnerActions.get(owner) ?? [];
    actions.push(action);
    this.pendingOwnerActions.set(owner, actions);
  }

  private runOwnerCreation(owner: BObject, create: () => void): void {
    // Restored actors already contain checkpoint values. Begin Play must not
    // overwrite them; On Game Loaded is their post-restoration lifecycle hook.
    if (this.saveBoundaryActive) { this.createdScriptObjects.add(owner); return; }
    this.runOwnerAction(owner, () => {
      // Spawned before a SceneSubsystem existed: it hears about it now.
      if (owner instanceof Actor) this.world.notifyActorEnteringPlay(owner);
      this.createdScriptObjects.add(owner);
      this.guardScript(create);
    });
  }

  private runOwnerDestroyed(owner: BObject, destroy: () => void): void {
    this.assetPreloads.releaseOwner(owner.guid);
    this.pendingOwnerActions.delete(owner);
    if (this.saveBoundaryActive) return;
    if (this.createdScriptObjects.has(owner)) this.guardScript(destroy);
  }

  private flushOwnerActions(): void {
    this.flushingOwnerActions++;
    try {
      // SceneSubsystems first: their On Init precedes the Begin Play it releases.
      for (const owner of this.pendingOwnerActions.keys()) {
        if (owner instanceof SceneSubsystem) this.drainOwnerActions(owner);
      }
      for (const owner of this.pendingOwnerActions.keys()) this.drainOwnerActions(owner);
    } finally {
      this.flushingOwnerActions--;
    }
  }

  private drainOwnerActions(owner: BObject): void {
    const actions = this.pendingOwnerActions.get(owner);
    if (!actions) return;
    if (owner.destroyed) { this.pendingOwnerActions.delete(owner); return; }
    while (actions.length && this.canRunOwnerActions(owner)) actions.shift()!();
    if (actions.length === 0 && this.pendingOwnerActions.get(owner) === actions) this.pendingOwnerActions.delete(owner);
  }

  notifySceneLayerReady(layerId: string, layerLoadId: number): void {
    const load = this.layerLoads.get(layerId);
    if (this.stopped || !load || load.loadId !== layerLoadId || !load.realized || load.ready ||
      this.world.findSceneLayer(layerId) !== load.layer) return;
    load.presented = true;
    if (this.bootLoading) return;
    load.ready = true;
    this.layerReadinessWaiters.get(layerId)?.resolve();
    this.layerReadinessWaiters.delete(layerId);
    this.overlayPhysicsSync.syncFromWorld(this.world);
    this.flushOwnerActions();
    this.tryCompleteSceneLoad();
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
    for (const load of [...this.layerLoads.values()]) {
      if (load.presented && !load.ready) this.notifySceneLayerReady(load.layer.guid, load.loadId);
    }
    const prepared = this.preparedBootScene;
    this.preparedBootScene = null;
    if (!prepared || this.realization !== prepared.work) return;
    this.checkRealization(prepared.work);
    // Game Instance may have changed poses or created actors during native boot.
    this.publishSnapshot();
    this.checkRealization(prepared.work);
    this.finishOrDeferSceneLoad(prepared.name, prepared.work.guid, prepared.work.loadId);
  }

  private checkRealization(work: SceneRealization): void {
    work.controller.signal.throwIfAborted();
    if (this.stopped || this.realization !== work) throw sceneRealizationCancelled();
  }

  /** Clean up only objects acquired by this preparation, including unspawned actors. */
  private cancelRealization(cleanup = true): SceneRealization | null {
    const work = this.realization;
    if (!work) return null;
    this.realization = null;
    if (this.preparedBootScene?.work === work) this.preparedBootScene = null;
    work.controller.abort(sceneRealizationCancelled());
    if (work.finished || !cleanup) return work;
    for (const actor of work.departure?.actors ?? []) this.removeOwnedActor(actor);
    for (const layer of work.departure?.layers ?? []) {
      if (this.world.findSceneLayer(layer.guid) === layer) this.removeSceneLayer(layer.guid);
    }
    for (const actor of work.actors) this.removeOwnedActor(actor);
    for (const layer of work.layers) {
      if (this.world.findSceneLayer(layer.guid) === layer) this.removeSceneLayer(layer.guid);
    }
    this.world.flushPending();
    return work;
  }

  private removeOwnedActor(actor: Actor): void {
    if (this.removingActors.has(actor)) return;
    this.removingActors.add(actor);
    this.sceneLayerSwitchers.retire(actor);
    const stream = this.sceneStreams.get(actor.guid);
    if (stream) this.retireSceneStream(stream);
    this.ragdolls.retire(actor);
    this.cables.retire(actor);
    this.dynamicMeshes.retire(actor);
    this.pendingOwnerActions.delete(actor);
    for (const component of actor.components) {
      this.pendingOwnerActions.delete(component);
      this.animEvalByComponent.delete(component.guid);
      this.pendingAnimJumpByComponent.delete(component.guid);
      for (const key of this.animInitializedBySlot) {
        if (key.startsWith(`${component.guid}:`)) this.animInitializedBySlot.delete(key);
      }
    }
    const slotId = this.slotByGuid.get(actor.guid);
    const ownsSlot = () => slotId !== undefined && this.slotOwners.get(slotId) === actor;
    try {
      if (ownsSlot()) this.emitAudioStops(actor);
      if (ownsSlot()) this.emitParticleStops(actor);
      if (ownsSlot()) this.emit({ type: "despawn", slotId: slotId!, actorGuid: actor.guid });
    } finally {
      if (ownsSlot()) this.releaseSlot(actor.guid, slotId!);
      if (this.world.findActor(actor.guid) === actor) {
        this.overlayDesignPose.delete(actor.guid);
        this.anchoredOverlayActors.delete(actor.guid);
      }
      this.world.destroyActorInstance(actor);
      this.tweens.cancelInvalid();
      this.removingActors.delete(actor);
    }
  }

  realizePlayWorld(): void | Promise<void> {
    if (this.stopped) {
      if (this.cooperativeSceneLoading) return Promise.reject(sceneRealizationCancelled());
      return;
    }
    if (!this.playWorldRealized) this.beginSceneRealization();
    if (this.cooperativeSceneLoading || this.realization?.promise) return this.waitForSceneRealization();
  }

  /** Follow a replacement begun by Game Instance while the boot caller awaits. */
  private async waitForSceneRealization(): Promise<void> {
    while (true) {
      const work = this.realization;
      if (!work || this.stopped) throw sceneRealizationCancelled();
      try {
        await work.promise;
      } catch (error) {
        if (this.realization === work || this.stopped) throw error;
        continue;
      }
      if (this.realization === work) return;
    }
  }

  private beginSceneRealization(departure: SceneDeparture | null = null): void {
    const changeId = this.sceneChangeId;
    const previous = this.cancelRealization(false);
    if (this.stopped || this.sceneChangeId !== changeId) return;
    if (previous && !previous.finished) {
      departure ??= { guid: previous.guid, sceneInstance: previous.sceneInstance, actors: [], layers: [] };
      departure.actors = [...new Set([...departure.actors, ...previous.actors, ...(previous.departure?.actors ?? [])])];
      departure.layers = [...new Set([...departure.layers, ...previous.layers, ...(previous.departure?.layers ?? [])])];
      departure.sources = [...new Set([...(departure.sources ?? []), ...(previous.departure?.sources ?? [])])];
    }
    this.playWorldRealized = true;
    this.sceneWorkBlocked = true;
    this.pendingSceneFinish = null;
    const work: SceneRealization = {
      controller: new AbortController(), scene: this.playScene, guid: this.playSceneGuid,
      loadId: ++this.sceneLoadId, actors: [], layers: [], sceneInstance: null,
      promise: null, finished: false, departure, painted: null,
      refreshNavigation: departure !== null,
    };
    this.realization = work;
    this.sceneLoadingProgress = 0;
    const steps = this.realizeSceneSteps(work);
    const retirement = this.retireSceneSteps(work);
    const nextKind = work.scene?.settings.physicsWorld ?? this.physicsWorldKind;
    const replaceNative = nextKind !== this.physicsWorldKind && !(this.physicsSync.getBackend() instanceof SoftwarePhysicsBackend);
    const initializeNavigation = this.sceneNavmeshBytes.has(work.guid) && !this.navigationInitialized;
    if (this.cooperativeSceneLoading || replaceNative || initializeNavigation) {
      work.promise = Promise.resolve().then(async () => {
        await this.prepareSceneLoading(work);
        await runSceneRealizationWork(retirement, work.controller.signal, this.cooperativeSceneLoading ?? {});
        if (nextKind !== this.physicsWorldKind && !(this.physicsSync.getBackend() instanceof SoftwarePhysicsBackend)) {
          const gravity = work.scene?.settings.gravity ?? this.gravity;
          const acquisition = createPhysicsBackend({ kind: nextKind, gravity: { x: gravity[0], y: gravity[1], z: gravity[2] },
            havokWasmUrl: this.havokWasmUrl, allowSoftwareFallback: false }).then((backend) => {
            try { this.checkRealization(work); } catch (error) { backend.dispose(); throw error; }
            return backend;
          });
          const backend = await waitForSceneWork(acquisition, work.controller.signal);
          this.installScenePhysics(work, backend);
        }
        if (initializeNavigation) {
          await waitForSceneWork(initNavigation(), work.controller.signal);
          this.navigationInitialized = true;
        }
        this.prepareSceneBackends(work);
        await runSceneRealizationWork(steps, work.controller.signal, this.cooperativeSceneLoading ?? {});
      }).catch((error: unknown) => {
        this.failRealization(work);
        throw error;
      });
      // Scene changes from scripts have no awaiting caller. Keep the failure
      // observable to boot waiters and report it once when it is still current.
      void work.promise.catch((error: unknown) => {
        if (this.realization === work && !work.controller.signal.aborted) {
          this.emit({ type: "sceneLoadFailed", sceneAssetGuid: work.guid, sceneLoadId: work.loadId,
            message: error instanceof Error ? error.message : String(error) });
          this.reportError(error);
        }
      });
      return;
    }
    try {
      while (!retirement.next().done) { /* Retire before replacing native ownership. */ }
      this.prepareSceneBackends(work);
      while (!steps.next().done) { /* Immediate consumers retain synchronous ordering. */ }
    } catch (error) {
      this.failRealization(work);
      if (!isInfiniteLoopError(error) && !work.controller.signal.aborted) throw error;
    } finally {
      retirement.return();
      steps.return();
    }
  }

  private installScenePhysics(work: SceneRealization, backend: PhysicsBackend): void {
    let sync: PhysicsWorldSync | undefined;
    try {
      this.checkRealization(work);
      sync = new PhysicsWorldSync(backend, {
        actorFilter: (actor) => actor.sceneLayerId == null && this.streamActorReady(actor),
        deferUnsupportedConstraints: !this.preferSoftwarePhysics && backend instanceof SoftwarePhysicsBackend,
      });
      this.bindPhysicsContent(sync);
      sync.syncFromWorld(this.world);
    } catch (error) {
      if (sync) sync.dispose(); else backend.dispose();
      throw error;
    }
    this.physicsSync.dispose();
    this.physicsSync = sync;
    this.physicsWorldKind = backend.kind;
    this.physicsGeneration++;
  }

  private prepareSceneBackends(work: SceneRealization): void {
    this.checkRealization(work);
    const kind = work.scene?.settings.physicsWorld ?? this.physicsWorldKind;
    if (kind !== this.physicsWorldKind) {
      const gravity = work.scene?.settings.gravity ?? this.gravity;
      this.installScenePhysics(work, createSoftwarePhysicsBackend(kind, { x: gravity[0], y: gravity[1], z: gravity[2] }));
    }
    const bytes = this.sceneNavmeshBytes.get(work.guid);
    if (bytes && (work.refreshNavigation || this.navSceneGuid !== work.guid)) {
      const nav = createNavigationBackend();
      try { nav.importNavMesh(bytes); } catch (error) { nav.dispose(); throw error; }
      this.clearNavAgents();
      this.nav?.dispose();
      this.nav = nav;
      this.navSceneGuid = work.guid;
    } else if (!bytes) {
      this.clearNavAgents();
      this.nav?.dispose();
      this.nav = null;
      this.navSceneGuid = null;
    }
  }

  private async prepareSceneLoading(work: SceneRealization): Promise<void> {
    this.checkRealization(work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const painted = this.deferSceneLoadingPaint ? new Promise<void>((resolve, reject) => {
      work.painted = resolve;
      timer = setTimeout(() => reject(new Error("Scene Loading did not paint before the loading deadline.")), 30_000);
    }) : Promise.resolve();
    try {
      // Install the latch before emitting: the in-process host can acknowledge immediately.
      this.emit({ type: "sceneLoading", sceneAssetGuid: work.guid, sceneLoadId: work.loadId });
      await waitForSceneWork(painted, work.controller.signal);
      this.checkRealization(work);
    } finally {
      clearTimeout(timer);
      work.painted = null;
    }
  }

  notifySceneLoadingPainted(sceneAssetGuid: string, sceneLoadId: number): void {
    const work = this.realization;
    if (this.stopped || !work || work.controller.signal.aborted || work.guid !== sceneAssetGuid || work.loadId !== sceneLoadId) return;
    work.painted?.();
  }

  private *retireSceneSteps(work: SceneRealization): Generator<void, void, unknown> {
    const departure = work.departure;
    if (!departure) return;
    if (departure.sceneInstance) this.assetPreloads.releaseOwner(departure.sceneInstance.guid);
    const checkpoint = () => this.checkRealization(work);
    checkpoint();
    if (this.world.currentScene === departure.sceneInstance) this.world.exitActiveScene();
    checkpoint();
    // Exit hooks can add objects to the departing Scene. Retain exact identities
    // so cancellation and a reentrant same-guid replacement cannot erase each other.
    departure.layers = [...new Set([...departure.layers, ...this.world.getSceneLayers().filter((layer) => layer.ownerSceneGuid === departure.guid)])];
    const departingLayers = new Set(departure.layers.map((layer) => layer.guid));
    departure.actors = [...new Set([...departure.actors, ...this.world.getActors().filter((actor) => !actor.sceneLayerId || departingLayers.has(actor.sceneLayerId))])];
    for (const actor of departure.actors) {
      checkpoint();
      this.removeOwnedActor(actor);
      this.world.flushPending();
      checkpoint();
      yield;
    }
    for (const layer of departure.layers) {
      checkpoint();
      if (this.world.findSceneLayer(layer.guid) === layer) this.removeSceneLayer(layer.guid);
      checkpoint();
      yield;
    }
    // Prune native bodies before new objects can reuse a departing guid. Global
    // SceneLayers remain in the World, retaining their bodies and motion.
    this.physicsSync.syncFromWorld(this.world);
    checkpoint();
    this.overlayPhysicsSync.syncFromWorld(this.world);
    checkpoint();
    // Actor removal releases only departing animation/BT state. Retained layers
    // continue from their existing graph state while the world is replaced.
    this.clearNavAgents();
    for (const source of departure.sources ?? []) source.release();
    departure.sources = undefined;
    work.departure = null;
  }

  private failRealization(work: SceneRealization): void {
    if (this.realization !== work) return;
    // Keep the failed promise/gate attached: a later ready acknowledgement must
    // never turn a partial scene into a successful load.
    this.pendingSceneFinish = null;
    // Objects leave before the Scene exits (its SceneSubsystems' On End), silently.
    this.duringSceneTeardown(() => {
      for (const actor of work.departure?.actors ?? []) this.removeOwnedActor(actor);
      for (const layer of work.departure?.layers ?? []) {
        if (this.world.findSceneLayer(layer.guid) === layer) this.removeSceneLayer(layer.guid);
      }
      for (const actor of work.actors) this.removeOwnedActor(actor);
      for (const layer of work.layers) {
        if (this.world.findSceneLayer(layer.guid) === layer) this.removeSceneLayer(layer.guid);
      }
      this.world.flushPending();
    });
    if (this.world.currentScene === work.sceneInstance) this.world.exitActiveScene();
    for (const source of work.departure?.sources ?? []) source.release();
    if (work.departure) work.departure.sources = undefined;
    this.activeSceneSource?.release();
    this.activeSceneSource = undefined;
  }

  private *realizeSceneSteps(work: SceneRealization): Generator<void, void, unknown> {
    const checkpoint = () => this.checkRealization(work);
    checkpoint();
    this.tilemapAnimationTimeMs = 0;
    if (this.hasAnimatedTiles) this.emit({ type: "tilemapAnimationTime", elapsedMs: 0 });
    this.loopGuard.reset();
    this.world.start();
    checkpoint();
    const { scene, guid, loadId } = work;
    const name = typeof scene?.name === "string" && scene.name.trim() ? scene.name : guid;
    if (scene) {
      this.sceneLoadingProgress = 0;
      this.world.beginSceneLoad(name);
      checkpoint();
      const authoredGravity = scene.settings?.gravity;
      const gravity = {
        x: Number(authoredGravity?.[0] ?? this.gravity[0]),
        y: Number(authoredGravity?.[1] ?? this.gravity[1]),
        z: Number(authoredGravity?.[2] ?? this.gravity[2]),
      };
      this.setWorldGravity(gravity);
      work.sceneInstance = this.world.createScene({ assetGuid: guid, sceneName: name,
        postProcessStack: scene.settings.postProcessStack, variables: { gravity } });
      if (this.sessionMode === "simulate" && !this.simulationStart) this.simulationStart = {
        sceneAssetGuid: guid, sceneInstanceId: work.sceneInstance.guid, sceneLoadId: loadId };
      checkpoint();
      this.emit({ type: "activeScene", sceneAssetGuid: guid, sceneLoadId: loadId });
      checkpoint();
      for (const serialized of scene.actors) {
        checkpoint();
        const actor = createActorFromSerialized(this.world, serialized, this.sceneActorHooks);
        if (actor) work.actors.push(actor);
        yield;
      }
      hydrateScenePropertyReferences(work.actors);
      let realized = 0;
      for (const actor of work.actors) {
        checkpoint();
        this.scriptHost.bindInterfaceHandlers(actor);
        this.realizeActor(actor, checkpoint);
        checkpoint();
        this.sceneLoadingProgress = (++realized / work.actors.length) * 0.5;
        yield;
      }
      this.breakLoadedParentCycles(work.actors);
      this.sceneLoadingProgress = 0.5;
    }
    checkpoint();
    this.registerNavAgents();
    this.registerNavObstacles();
    this.attemptPossessViewTarget();
    checkpoint();
    yield* this.spawnOwnedSceneLayers(work);
    checkpoint();
    // All actors, anchors, and renderer assignments precede the readiness latch.
    this.world.flushPending();
    checkpoint();
    this.publishSnapshot();
    checkpoint();
    work.finished = true;
    if (scene) {
      if (this.bootLoading) this.preparedBootScene = { work, name };
      else this.finishOrDeferSceneLoad(name, guid, loadId);
    } else this.sceneWorkBlocked = false;
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
    ) && this.slotByGuid.has(defaultActor.id)) return;
    for (const actor of this.playScene?.actors ?? []) {
      const opted = actor.components.some(
        (component) =>
          component.classId === "CameraComponent" &&
          component.properties.attemptPossessViewTarget === true,
      );
      if (!opted) continue;
      const slotId = this.slotByGuid.get(actor.id);
      if (slotId === undefined) continue;
      this.emit({ type: "possessCamera", slotId });
      this.possessedCameraSlotId = slotId;
      return;
    }
  }

  /** False when no loaded scene matches, so the console can report it. */
  private applyChangeScene(sceneKey: string): boolean {
    if (this.acquireScene) {
      // Prepared transitions resolve asynchronously and report their own failures.
      void this.changeSceneAsync(sceneKey).catch((error: unknown) => {
        if (!this.stopped && (error as { name?: string })?.name !== "AbortError") this.reportError(error);
      });
      return true;
    }
    return this.commitSceneChange(sceneKey);
  }

  async changeSceneAsync(sceneKey: string): Promise<void> {
    const key = String(sceneKey ?? "").trim();
    if (this.stopped) throw sceneRealizationCancelled();
    if (!key) throw new Error("Select a Scene before changing scenes.");
    if (!this.acquireScene) {
      if (!this.sceneLibrary.has(key)) throw new Error(`The target scene is not available: ${key}.`);
      this.commitSceneChange(key);
      await this.waitForSceneRealization();
      return;
    }
    this.pendingSceneSource?.abort(sceneRealizationCancelled());
    const controller = new AbortController();
    this.pendingSceneSource = controller;
    let acquired: RuntimeSceneSource | undefined;
    const acquisition = Promise.resolve().then(() => this.acquireScene!(this.sceneGuidByKey.get(key) ?? key, {
      consumer: `Scene transition from ${this.playSceneGuid}`, signal: controller.signal,
    })).then((source) => {
      if (this.stopped || controller.signal.aborted || this.pendingSceneSource !== controller) {
        source.release();
        throw sceneRealizationCancelled();
      }
      acquired = source;
      return source;
    });
    try {
      const source = await waitForSceneWork(acquisition, controller.signal);
      controller.signal.throwIfAborted();
      this.pendingSceneSource = undefined;
      this.commitSceneChange(key, source.scene, source);
      acquired = undefined;
      await this.waitForSceneRealization();
    } finally {
      acquired?.release();
      if (this.pendingSceneSource === controller) this.pendingSceneSource = undefined;
    }
  }

  private commitSceneChange(sceneKey: string, prepared?: SerializedScene, source?: RuntimeSceneSource): boolean {
    const key = String(sceneKey ?? "").trim();
    const next = prepared ?? this.sceneLibrary.get(key);
    if (!next) {
      this.emit({
        type: "log",
        severity: "warning",
        category: "scene",
        message: `changeScene: no scene asset loaded for ${key}`,
        frameId: this.frameId,
      });
      return false;
    }
    if (this.stopped) { source?.release(); return true; }
    if (this.sessionMode === "simulate") this.emit({ type: "simulationRetentionUnavailable", sessionGeneration: this.sessionGeneration,
      reason: "Keep cannot retain a scene transition into the starting scene document." });
    // The departing Scene's teardown starts here; its SceneSubsystems End at the exit.
    this.duringSceneTeardown(() => {
      for (const stream of [...this.sceneStreams.values()]) this.retireSceneStream(stream);
    });
    const changeId = ++this.sceneChangeId;
    const current = () => !this.stopped && this.sceneChangeId === changeId;
    this.sceneWorkBlocked = true;
    this.pendingSceneFinish = null;
    const departingSceneGuid = this.playSceneGuid;
    const departure: SceneDeparture = {
      guid: departingSceneGuid, sceneInstance: this.world.currentScene,
      actors: this.world.getActors().filter((actor) => !actor.sceneLayerId),
      layers: this.world.getSceneLayers().filter((layer) => layer.ownerSceneGuid === departingSceneGuid),
      sources: this.activeSceneSource ? [this.activeSceneSource] : undefined,
    };
    this.activeSceneSource = source;
    this.playScene = next;
    this.scalability.setScene(next.settings);
    this.playSceneGuid = this.sceneGuidByKey.get(key) ?? key;
    this.playWorldRealized = false;
    // The new scene owns its own camera choice.
    this.cameraPossessedByScript = false;
    this.possessedCameraSlotId = null;
    // The realization owns its rejection and diagnostics; script commands remain synchronous.
    this.beginSceneRealization(departure);
    if (!current()) return true;
    if (this.canTickScene()) {
      this.emitNavigationDebug(true);
      this.emitBehaviourTreeSnapshot(true);
    }
    return true;
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
    return this.lastTrace;
  }

  private finalizeTrace(reason: "requested" | "session-ended" = "requested"): void {
    const payload = this.trace.stop(reason);
    if (payload) {
      this.lastTrace = payload;
      this.emit({
        type: "trace",
        payload: payload as unknown as Record<string, unknown>,
      });
      if (payload.retention?.stopReason === "oversized-frame") {
        this.reportLog(
          `Trace recording stopped: an oversized frame exceeds the ${payload.retention.byteBudget}-byte retained-data budget. ` +
          `${payload.frames.length} complete frames retained; ${payload.retention.droppedFrames} frames dropped.`,
          "warning", "Trace",
        );
      }
    }
  }

  restoreBtFromTrace(states: readonly TraceBtState[]): void {
    this.btEvalBySlot.clear();
    this.lastBtStateJson.clear();
    for (const row of states) {
      this.btEvalBySlot.set(row.slotId, {
        stack: row.stack.map((frame) => ({ ...frame })),
        status: row.status as BtEvalState["status"],
        lastResults: { ...row.lastResults } as BtEvalState["lastResults"],
        btNodeId: row.btNodeId,
        blackboard: { ...row.blackboard },
        nodeMemory: Object.fromEntries(
          Object.entries(row.nodeMemory ?? {}).map(([id, memory]) => [
            id,
            { ...memory },
          ]),
        ),
      });
    }
  }

  registerAnimGraph(guid: string, document: AnimGraphDocument): void {
    this.animGraphs.set(guid, document);
  }

  registerBehaviourTree(guid: string, document: BehaviourTreeDocument): void {
    this.behaviourTrees.set(guid, document);
  }

  registerBlackboard(guid: string, document: BlackboardDocument): void {
    this.blackboards.set(guid, document);
  }

  registerSceneContent(content: RuntimeSceneContent): void {
    const retained = new Set(content.assetGuids);
    if (this.sessionMode === "simulate") {
      // Source scopes are acquired/released on demand. Retention must validate
      // against current owned source metadata, including newly prepared types.
      this.simulationOwnedAssets = retained;
      this.simulationDataAssets = content.dataAssets;
    }
    for (const map of [this.animGraphs, this.behaviourTrees, this.blackboards]) for (const guid of map.keys()) if (!retained.has(guid)) map.delete(guid);
    this.sceneLayerLibrary.clear();
    for (const entry of content.sceneLayers ?? []) this.sceneLayerLibrary.set(entry.guid, entry.layer);
    this.sceneNavmeshBytes.clear();
    for (const [guid, bytes] of Object.entries(content.sceneNavmeshBytes ?? {})) this.sceneNavmeshBytes.set(guid, bytes);
    this.animClipCatalog.clear();
    for (const entry of content.animClipCatalog ?? []) this.animClipCatalog.set(entry.guid, entry);
    this.audioAssetGuids.clear();
    for (const guid of content.audioAssetGuids ?? []) this.audioAssetGuids.add(guid);
    this.sourceRenderTargets.clear();
    for (const [guid, value] of Object.entries(content.renderTargets ?? {})) this.sourceRenderTargets.set(guid, value);
    this.sourceRenderTargetTextures.clear();
    for (const [guid, value] of Object.entries(content.renderTargetTextures ?? {})) this.sourceRenderTargetTextures.set(guid, value);
    this.materialParameters.replaceCatalog(content.materialParameterCatalog, content.materialTextureAssetGuids);
    this.dataCatalog.replace(content.dataAssets ?? []);
  }

  registerWaterContent(content: ReadonlyMap<string, WaterDefinition> | Readonly<Record<string, WaterDefinition>>): void {
    this.waters = new Map(Array.from(content instanceof Map ? content.entries() : Object.entries(content), ([guid, value]) => [guid, normalizeWaterDefinition(value)]));
    this.physicsSync.water.setContent(this.waters);
  }

  private refreshTilemapAnimationContent(): void {
    this.hasAnimatedTiles = this.tilemaps.size > 0 && [...this.tilesets.values()].some(
      (tileset) => tileset.tiles.some((tile) => tile.animation.length > 0),
    );
  }

  registerTileContent(options: {
    tilemaps: Readonly<Record<string, TilemapPayload>> | ReadonlyMap<string, TilemapPayload>;
    tilesets: Readonly<Record<string, TilesetPayload>> | ReadonlyMap<string, TilesetPayload>;
    pixelsPerUnit?: number;
  }): void {
    this.tilemaps =
      options.tilemaps instanceof Map
        ? new Map(options.tilemaps)
        : new Map(Object.entries(options.tilemaps));
    this.tilesets =
      options.tilesets instanceof Map
        ? new Map(options.tilesets)
        : new Map(Object.entries(options.tilesets));
    this.refreshTilemapAnimationContent();
    if (this.hasAnimatedTiles) this.emit({ type: "tilemapAnimationTime", elapsedMs: this.tilemapAnimationTimeMs });
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
    this.physicsSync.setTileContent({
      tilemaps: this.tilemaps,
      tilesets: this.tilesets,
      pixelsPerUnit: this.pixelsPerUnit,
    });
    this.overlayPhysicsSync.setTileContent({
      tilemaps: this.tilemaps,
      tilesets: this.tilesets,
      pixelsPerUnit: this.pixelsPerUnit,
    });
  }

  registerSpriteContent(options: {
    sprites: Readonly<Record<string, SpritePayload>> | ReadonlyMap<string, SpritePayload>;
    spriteAnimations:
      | Readonly<Record<string, SpriteAnimationPayload>>
      | ReadonlyMap<string, SpriteAnimationPayload>;
    pixelsPerUnit?: number;
  }): void {
    this.sprites =
      options.sprites instanceof Map
        ? new Map(options.sprites)
        : new Map(Object.entries(options.sprites));
    this.spriteAnimations =
      options.spriteAnimations instanceof Map
        ? new Map(options.spriteAnimations)
        : new Map(Object.entries(options.spriteAnimations));
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
    this.physicsSync.setSpriteContent({
      sprites: this.sprites,
      spriteAnimations: this.spriteAnimations,
      pixelsPerUnit: this.pixelsPerUnit,
    });
    this.overlayPhysicsSync.setSpriteContent({
      sprites: this.sprites,
      spriteAnimations: this.spriteAnimations,
      pixelsPerUnit: this.pixelsPerUnit,
    });
  }

  registerModelContent(options: {
    models: Readonly<Record<string, ModelPayload>> | ReadonlyMap<string, ModelPayload>;
    complexMeshes?:
      | Readonly<
          Record<
            string,
            { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
          >
        >
      | ReadonlyMap<
          string,
          { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
        >;
  }): void {
    this.models =
      options.models instanceof Map
        ? new Map(options.models)
        : new Map(Object.entries(options.models));
    this.complexMeshes = options.complexMeshes
      ? options.complexMeshes instanceof Map
        ? new Map(options.complexMeshes)
        : new Map(Object.entries(options.complexMeshes))
      : new Map();
    this.physicsSync.setModelContent({
      models: this.models,
      complexMeshes: this.complexMeshes,
    });
    this.overlayPhysicsSync.setModelContent({
      models: this.models,
      complexMeshes: this.complexMeshes,
    });
  }

  async loadNavMesh(bytes: Uint8Array): Promise<void> {
    const lifecycleId = this.lifecycleId;
    const sceneGuid = this.playSceneGuid;
    this.sceneNavmeshBytes.set(sceneGuid, bytes);
    await initNavigation();
    if (this.stopped || lifecycleId !== this.lifecycleId) throw sceneRealizationCancelled();
    this.navigationInitialized = true;
    if (sceneGuid !== this.playSceneGuid) return;
    this.nav ??= createNavigationBackend();
    this.nav.importNavMesh(bytes);
    this.navSceneGuid = sceneGuid;
    this.clearNavAgents();
    if (this.playWorldRealized) {
      this.registerNavAgents();
      this.registerNavObstacles();
    }
  }

  setNavAgentTarget(actorGuid: string, target: NavPoint): boolean {
    if (!this.nav) return false;
    const actor = this.world.findActor(actorGuid);
    if (!actor || actor.destroyed || !actor.components.some(
      (component) => component.classId === "NavAgentComponent" && !component.destroyed,
    )) return false;
    const destination = this.nav.closestPoint(this.toNav(target));
    if (!destination) return false;
    if (!this.navAgentByActor.has(actorGuid)) {
      this.registerNavAgent(actor);
    }
    const agentId = this.navAgentByActor.get(actorGuid);
    if (!agentId && !this.isDynamicNavActor(actor)) return false;
    if (agentId && !this.nav.setAgentTarget(agentId, destination)) return false;
    // A falling actor may not be close enough to a polygon yet. Keep its
    // request until physics brings it within reach of the mesh.
    this.navTargetByActor.set(actorGuid, { ...destination });
    this.emitNavigationDebug(true);
    return true;
  }

  findNavPath(from: NavPoint, to: NavPoint): NavPoint[] {
    if (!this.nav) return [];
    return this.nav.findPath(this.toNav(from), this.toNav(to)).map((point) =>
      this.fromNav(point),
    );
  }

  addNavObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint): string {
    if (!this.nav) return "";
    return this.nav.addObstacle(
      kind,
      this.toNavObstaclePose(pose),
      this.toNavObstacleSize(size),
    );
  }

  removeNavObstacle(id: string): void {
    this.nav?.removeObstacle(id);
  }

  stopNavAgent(actorGuid: string): void {
    this.navTargetByActor.delete(actorGuid);
    if (this.navSteeredActors.delete(actorGuid)) {
      this.physicsSync.setActorLinearVelocity(actorGuid, { x: 0, z: 0 });
    }
    const agentId = this.navAgentByActor.get(actorGuid);
    if (!agentId || !this.nav) return;
    this.nav.stopAgent(agentId);
    this.emitNavigationDebug(true);
  }

  private toNav(point: NavPoint): NavPoint {
    return this.physicsWorldKind === "2d" ? worldToRecast(point) : point;
  }

  private fromNav(point: NavPoint): NavPoint {
    return this.physicsWorldKind === "2d" ? recastToWorld(point) : point;
  }

  /** Recast obstacle pose: 2D XY sits on a 2-unit-tall volume centered at Y=1. */
  private toNavObstaclePose(point: NavPoint): NavPoint {
    if (this.physicsWorldKind !== "2d") return point;
    const recast = worldToRecast(point);
    return { x: recast.x, y: 1, z: recast.z };
  }

  /** Recast obstacle size: 2D (width, height) → Recast (X, up=2, Z). */
  private toNavObstacleSize(size: NavPoint): NavPoint {
    if (this.physicsWorldKind !== "2d") return size;
    return {
      x: Math.abs(size.x) || 1,
      y: 2,
      z: Math.abs(size.y) || 1,
    };
  }

  private clearNavAgents(): void {
    if (this.nav) {
      for (const agentId of this.navAgentByActor.values()) {
        this.nav.removeAgent(agentId);
      }
    }
    this.navAgentByActor.clear();
    this.navYawByActor.clear();
    this.navTargetByActor.clear();
    this.navSteeredActors.clear();
  }

  private isDynamicNavActor(actor: Actor): boolean {
    if (this.physicsWorldKind !== "3d") return false;
    const rigid = actor.components.find(
      (component) => component.classId === "RigidBodyComponent" && !component.destroyed,
    );
    return !!rigid && parseRigidBodyProperties(Object.fromEntries(rigid.variables)).motionType === "dynamic";
  }

  /** Current pose through the actor's own chain; parents resolve first-spawned. */
  private navActorWorldPosition(actor: Actor): NavPoint {
    return actorChainWorldTransform(actor, (guid) => this.world.findActor(guid))?.position ?? actor.transform.position;
  }

  /**
   * Resolve an actor through the frame index, which answers each guid with its
   * first-spawned live actor (`World.findActor`). An indexed actor destroyed
   * since the index was built falls back to the live World's answer.
   */
  private navFrameActor(index: ReadonlyMap<string, Actor>, guid: string): Actor | undefined {
    const indexed = index.get(guid);
    if (indexed && !indexed.destroyed && indexed.world === this.world) return indexed;
    return this.world.findActor(guid);
  }

  /** Compose NavAgent actors and their ancestors, not the whole world. */
  private navAgentWorldTransforms(index: ReadonlyMap<string, Actor>): Map<string, Transform> {
    const actors = this.world.getActors();
    const agents = this.navAgentActors;
    agents.length = 0;
    for (const actor of actors) {
      for (const component of actor.components) {
        if (component.classId === "NavAgentComponent" && !component.destroyed) {
          agents.push(actor);
          break;
        }
      }
    }
    try {
      return composeActorWorldTransforms((guid) => this.navFrameActor(index, guid), agents);
    } finally {
      agents.length = 0;
    }
  }

  private registerNavAgents(
    transforms = firstSpawnedWorldTransforms(this.world.getActors()),
  ): void {
    if (!this.nav) return;
    for (const actor of this.world.getActors()) {
      this.registerNavAgent(actor, transforms);
    }
  }

  private registerNavAgent(
    actor: Actor,
    transforms?: ReadonlyMap<string, Transform>,
  ): void {
    if (!this.nav || actor.destroyed || !this.streamActorReady(actor)) return;
    if (this.navAgentByActor.has(actor.guid)) return;
    // Agents are keyed by guid; only the guid's first-spawned actor owns one.
    if (this.world.findActor(actor.guid) !== actor) return;
    const component = actor.components.find(
      (entry) => entry.classId === "NavAgentComponent" && !entry.destroyed,
    );
    if (!component) return;
    const params = parseNavAgentParams(
      Object.fromEntries(component.variables),
    );
    const world = this.toNav(transforms?.get(actor.guid)?.position ?? this.navActorWorldPosition(actor));
    const position = this.isDynamicNavActor(actor) ? this.nav.closestPoint(world) : world;
    if (!position) return;
    const id = this.nav.addAgent(position, params);
    if (!id) return;
    this.navAgentByActor.set(actor.guid, id);
    const target = this.navTargetByActor.get(actor.guid);
    if (target) this.nav.setAgentTarget(id, target);
  }

  private updateNavAgentParams(actor: Actor): void {
    const agentId = this.navAgentByActor.get(actor.guid);
    if (!agentId || !this.nav) return;
    const component = actor.components.find(
      (entry) => entry.classId === "NavAgentComponent" && !entry.destroyed,
    );
    if (!component) return;
    this.nav.updateAgent(
      agentId,
      parseNavAgentParams(Object.fromEntries(component.variables)),
    );
  }

  private registerNavObstacles(actors: readonly Actor[] = this.world.getActors(), acquired?: string[]): void {
    if (!this.nav) return;
    const transforms = firstSpawnedWorldTransforms(this.world.getActors(), actors);
    for (const actor of actors) {
      if (actor.destroyed || !this.streamActorReady(actor)) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "NavMeshBlockerComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const props = parseNavMeshBlockerProperties(
        Object.fromEntries(component.variables),
      );
      const transform = transforms.get(actor.guid) ?? actor.transform;
      const aabb = rotatedBoxWorldAabb(
        [
          transform.position.x,
          transform.position.y,
          transform.position.z,
        ],
        [
          transform.rotation.x,
          transform.rotation.y,
          transform.rotation.z,
          transform.rotation.w,
        ],
        [
          transform.scale.x,
          transform.scale.y,
          transform.scale.z,
        ],
      );
      const pose = this.toNavObstaclePose(aabb.center);
      const navSize = this.toNavObstacleSize(aabb.size);
      if (props.area === "cost") {
        // Cost volumes mutate the parent's baked navmesh and cannot be removed.
        // Streamed instances therefore share its existing navigation costs.
        if (this.actorStream.has(actor)) continue;
        this.nav.applyCostVolume({
          id: actor.guid,
          kind: props.kind,
          pose,
          size: navSize,
          cost: props.cost,
        });
        continue;
      }
      if (!props.dynamic) continue;
      const obstacle = this.nav.addObstacle("box", pose, navSize);
      acquired?.push(obstacle);
    }
  }

  private syncNavCostVolumes(): void {
    if (!this.nav) return;
    for (const actor of this.world.getActors()) {
      if (actor.destroyed || this.actorStream.has(actor)) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "NavMeshBlockerComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const props = parseNavMeshBlockerProperties(
        Object.fromEntries(component.variables),
      );
      if (props.area !== "cost" || !props.dynamic) continue;
      const aabb = rotatedBoxWorldAabb(
        [
          actor.transform.position.x,
          actor.transform.position.y,
          actor.transform.position.z,
        ],
        [
          actor.transform.rotation.x,
          actor.transform.rotation.y,
          actor.transform.rotation.z,
          actor.transform.rotation.w,
        ],
        [
          actor.transform.scale.x,
          actor.transform.scale.y,
          actor.transform.scale.z,
        ],
      );
      this.nav.applyCostVolume({
        id: actor.guid,
        kind: props.kind,
        pose: this.toNavObstaclePose(aabb.center),
        size: this.toNavObstacleSize(aabb.size),
        cost: props.cost,
      });
    }
  }

  private tickCrowd(actors: ReadonlyMap<string, Actor>): void {
    if (!this.nav) return;
    this.syncNavCostVolumes();
    const worldTransforms = this.navAgentWorldTransforms(actors);
    this.registerNavAgents(worldTransforms);
    const physicalAgents = this.navPhysicalAgents;
    physicalAgents.clear();
    let removed = false;
    for (const [actorGuid, agentId] of this.navAgentByActor) {
      const actor = this.navFrameActor(actors, actorGuid);
      if (!actor || actor.destroyed || !this.streamActorReady(actor) || !actor.components.some((component) =>
        component.classId === "NavAgentComponent" && !component.destroyed)) {
        this.stopNavAgent(actorGuid);
        this.nav.removeAgent(agentId);
        this.navAgentByActor.delete(actorGuid);
        this.navYawByActor.delete(actorGuid);
        removed = true;
        continue;
      }
      if (!this.isDynamicNavActor(actor)) continue;
      const position = worldTransforms.get(actorGuid)?.position ?? actor.transform.position;
      if (this.nav.syncAgentPosition(agentId, position)) {
        physicalAgents.add(actorGuid);
      } else {
        // Physics may carry an actor away from the mesh (for example a jump).
        // Reattach with the pending target once its physical pose is reachable.
        this.nav.removeAgent(agentId);
        this.navAgentByActor.delete(actorGuid);
        removed = true;
        if (this.navSteeredActors.delete(actorGuid)) {
          this.physicsSync.setActorLinearVelocity(actorGuid, { x: 0, z: 0 });
        }
      }
    }
    this.nav.stepCrowd(this.simulationDt());
    for (const [actorGuid, agentId] of this.navAgentByActor) {
      const actor = this.navFrameActor(actors, actorGuid);
      if (!actor || actor.destroyed) continue;
      if (physicalAgents.has(actorGuid)) {
        if (this.navTargetByActor.has(actorGuid)) {
          const velocity = this.nav.agentVelocity(agentId) ?? { x: 0, y: 0, z: 0 };
          this.physicsSync.setActorLinearVelocity(actorGuid, { x: velocity.x, z: velocity.z });
          this.navSteeredActors.add(actorGuid);
        }
        continue;
      }
      const position = this.nav.agentPosition(agentId);
      if (!position) continue;
      const world = this.fromNav(position);
      const velocity = this.nav.agentVelocity(agentId) ?? { x: 0, y: 0, z: 0 };
      const previous = this.navYawByActor.get(actorGuid) ?? 0;
      const yaw = facingYawFromVelocity(velocity, previous);
      this.navYawByActor.set(actorGuid, yaw);
      const euler =
        this.physicsWorldKind === "2d"
          ? ([0, 0, (yaw * 180) / Math.PI] as [number, number, number])
          : ([0, (yaw * 180) / Math.PI, 0] as [number, number, number]);
      const quat = eulerDegreesToQuaternion(euler);
      const local = actorLocalPhysicsTransform({
        position: world,
        rotation: { x: quat[0], y: quat[1], z: quat[2], w: quat[3] },
      }, actor, worldTransforms);
      Object.assign(actor.transform.position, local.position);
      Object.assign(actor.transform.rotation, local.rotation);
    }
    physicalAgents.clear();
    if (removed) this.emitNavigationDebug(true);
  }

  private animGraphGuid(component: {
    assetGuid: string | null;
    getVariable(name: string): unknown;
  }): string | null {
    const graphGuid = component.getVariable("graphGuid");
    if (typeof graphGuid === "string" && graphGuid.length > 0) return graphGuid;
    return component.assetGuid;
  }

  private animInputsFromComponent(component: {
    getVariable(name: string): unknown;
  }): AnimGraphInputs {
    const conditions: Record<string, boolean> = {};
    const raw = component.getVariable("conditions");
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        conditions[key] = value === true;
      }
    }
    return { conditions };
  }

  private seedAnimVariables(
    component: ActorComponent,
    document: AnimGraphDocument,
  ): void {
    for (const variable of document.variables) {
      if (component.getVariable(variable.name) !== undefined) continue;
      component.setVariable(
        variable.name,
        variable.defaultValue !== undefined
          ? variable.defaultValue
          : defaultAnimVariableValue(variable.typeId),
      );
    }
  }

  private animVariablesFromComponent(
    component: ActorComponent,
    document: AnimGraphDocument,
  ): Record<string, unknown> {
    const variables: Record<string, unknown> = {
      ...this.animInputsFromComponent(component).conditions,
    };
    for (const variable of document.variables) {
      const value = component.getVariable(variable.name);
      if (value !== undefined) variables[variable.name] = value;
    }
    return variables;
  }

  private tickAnimGraphs(): void {
    if (this.animGraphs.size === 0) return;
    const liveKeys = this.liveAnimInitKeys;
    const liveEvalKeys = this.liveAnimEvalKeys;
    liveKeys.clear();
    liveEvalKeys.clear();
    for (const actor of this.world.getActors()) {
      if (this.stopped) return;
      if (!this.canTickActor(actor)) continue;
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      if (this.btPlayAnimOwnedSlots.has(slotId)) continue;
      for (const component of actor.components) {
        if (!this.canTickActor(actor)) break;
        if (
          component.classId !== "AnimationGraphComponent" ||
          component.destroyed
        ) {
          continue;
        }
        const guid = this.animGraphGuid(component);
        if (!guid) continue;
        const document = this.animGraphs.get(guid);
        if (!document) continue;
        const evalKey = component.guid;
        const initKey = `${evalKey}:${guid}`;
        liveKeys.add(initKey);
        liveEvalKeys.add(evalKey);
        this.seedAnimVariables(component, document);
        const jumpTo = this.pendingAnimJumpByComponent.get(evalKey);
        if (jumpTo) {
          this.pendingAnimJumpByComponent.delete(evalKey);
          const jumped = document.states.find((state) => state.id === jumpTo);
          if (jumped) {
            this.animEvalByComponent.set(evalKey, {
              stateId: jumped.id,
              normalisedTime: 0,
              blendWeights: { [jumped.id]: 1 },
              timeMs: 0,
              facts: {
                elapsedSeconds: 0,
                durationSeconds: 0,
                normalisedTime: 0,
                remainingSeconds: 0,
                remainingRatio: 1,
                looping: jumped.loop,
                loopCount: 0,
                justLooped: false,
                justFinished: false,
              },
              layers: [],
              blendFromStateId: null,
              blendFromTimeMs: 0,
              blendElapsedMs: 0,
              loopCount: 0,
            });
          }
        }
        const extras = {
          variableStore: component,
          animFacts: this.animEvalByComponent.get(evalKey)?.facts,
        };
        const objectClassId = animGraphScriptClassId(guid);
        if (!this.animInitializedBySlot.has(initKey)) {
          this.scriptHost.invokeAnimEvent(
            objectClassId,
            "onInitializeAnimation",
            actor,
            0,
            extras,
          );
          this.animInitializedBySlot.add(initKey);
        }
        this.scriptHost.invokeAnimEvent(
          objectClassId,
          "onUpdateAnimation",
          actor,
          this.simulationDt(),
          extras,
        );
        const next = evaluateAnimGraph(
          document,
          this.animEvalByComponent.get(evalKey) ?? null,
          this.simulationDt(),
          {
            variables: this.animVariablesFromComponent(component, document),
            ...this.animInputsFromComponent(component),
            decideTransition: (transition, facts) =>
              this.scriptHost.invokeAnimRule(
                animRuleScriptClassId(guid, transition.id),
                actor,
                { variableStore: component, animFacts: facts },
              ),
          },
        );
        this.animEvalByComponent.set(evalKey, next);
        const clip = clipForState(document, next.stateId);
        if (clip?.kind === "sprite" && clip.assetGuid) {
          (actor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync).setActorSpriteClip(actor, {
            assetGuid: clip.assetGuid,
            clipName: clip.clipName,
            normalisedTime: next.normalisedTime,
          });
        } else {
          (actor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync).setActorSpriteClip(actor, null);
        }
        const currentLayer =
          next.layers.find((layer) => layer.stateId === next.stateId) ??
          next.layers[next.layers.length - 1];
        this.emit({
          type: "animState",
          slotId,
          stateId: next.stateId,
          normalisedTime: next.normalisedTime,
          blendWeights: next.blendWeights,
          clipName: currentLayer?.clipName || clip?.clipName,
          clipKind: currentLayer?.clipKind ?? clip?.kind,
          clipAssetGuid: currentLayer?.clipAssetGuid || clip?.assetGuid,
          justFinished: next.facts.justFinished,
          justLooped: next.facts.justLooped,
          layers: next.layers,
        });
      }
    }
    // Deleting the visited entry keeps Set/Map iteration valid, so prune in place.
    for (const key of this.animInitializedBySlot) {
      if (!liveKeys.has(key)) this.animInitializedBySlot.delete(key);
    }
    for (const evalKey of this.animEvalByComponent.keys()) {
      if (!liveEvalKeys.has(evalKey)) this.animEvalByComponent.delete(evalKey);
    }
    liveKeys.clear();
    liveEvalKeys.clear();
  }

  private stringGuid(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private behaviourTreeGuid(component: {
    assetGuid: string | null;
    getVariable(name: string): unknown;
  }): string | null {
    return this.stringGuid(component.getVariable("treeGuid")) ?? component.assetGuid;
  }

  private blackboardDefaults(guid: string | null): BlackboardValues {
    if (!guid) return {};
    const document = this.blackboards.get(guid);
    if (!document) return {};
    const values: BlackboardValues = {};
    for (const key of document.keys) {
      if (key.defaultValue !== undefined) values[key.name] = key.defaultValue;
    }
    return values;
  }

  private tickBtTask(
    actor: Actor,
    node: { id: string; classId: string; properties?: Record<string, unknown> },
    blackboard: BlackboardValues,
    dtSeconds: number,
    memory: Record<string, unknown>,
  ): BtResult {
    this.currentBtNodeId = node.id;
    if (builtinClassId(node.classId) === "bt.task.moveTo") {
      return this.tickMoveTo(actor, node, memory);
    }
    if (builtinClassId(node.classId) === "bt.task.moveToBlackboardKey") {
      const key = typeof node.properties?.key === "string" ? node.properties.key : "";
      return this.tickMoveTo(actor, node, memory, blackboardTargetPosition(
        blackboard[key], this.world, this.navFrameActors ?? undefined,
      ));
    }
    if (builtinClassId(node.classId) === "bt.task.rotateToFace") {
      return this.tickRotateToFace(actor, node);
    }
    if (builtinClassId(node.classId) === "bt.task.playAnimation") {
      return this.tickPlayAnimation(actor, node, dtSeconds, memory);
    }
    if (builtinClassId(node.classId) === "bt.task.playSound") {
      return this.tickPlaySound(actor, node, memory);
    }
    if (!this.scriptHost.hasClass(node.classId)) return "failure";
    const liveMemory = memory as Record<string | symbol, unknown>;
    let activation = liveMemory[BT_TASK_ACTIVATION] as BtTaskActivation | undefined;
    if (!activation) {
      activation = { active: true, blackboard };
      liveMemory[BT_TASK_ACTIVATION] = activation;
      memory.__activated = false;
    }
    activation.blackboard = blackboard;
    const current = activation;
    const isLive = () => current.active && !actor.destroyed && !this.stopped;
    const extras = {
      btFinish: (result: "success" | "failure") => {
        if (isLive()) current.result = result;
      },
      btEvaluate: () => undefined,
      getBlackboard: (key: string) => current.blackboard[key],
      setBlackboard: (key: string, value: unknown) => {
        if (isLive()) current.blackboard[key] = value;
      },
    };
    if (memory.__activated !== true) {
      memory.__activated = true;
      this.scriptHost.invokeBtEvent(
        node.classId,
        "onActivate",
        actor,
        dtSeconds,
        extras,
      );
    }
    this.scriptHost.invokeBtEvent(node.classId, "onBtTick", actor, dtSeconds, extras);
    const result = current.result;
    if (result === "success" || result === "failure") {
      current.active = false;
      memory.__btResult = result;
      return result;
    }
    return "running";
  }

  private tickMoveTo(
    actor: Actor,
    node: { properties?: Record<string, unknown> },
    memory: Record<string, unknown>,
    dest: NavPoint | null = navPointFromUnknown(node.properties?.destination),
  ): BtResult {
    if (!dest) {
      this.stopNavAgent(actor.guid);
      return "failure";
    }
    const target = this.nav?.closestPoint(this.toNav(dest));
    if (!target) {
      this.stopNavAgent(actor.guid);
      return "failure";
    }
    const previous = navPointFromUnknown(memory.__moveDestination);
    if (memory.__moveRequested !== true || !previous ||
      previous.x !== dest.x || previous.y !== dest.y || previous.z !== dest.z) {
      if (!this.setNavAgentTarget(actor.guid, dest)) {
        this.stopNavAgent(actor.guid);
        return "failure";
      }
      memory.__moveRequested = true;
      memory.__moveDestination = { ...dest };
    }
    const agentId = this.navAgentByActor.get(actor.guid);
    const dynamic = this.isDynamicNavActor(actor);
    const world = dynamic ? this.navActorWorldPosition(actor) : null;
    const position = world
      ? this.nav?.closestPoint(this.toNav(world))
      : agentId ? this.nav?.agentPosition(agentId) : null;
    if (!position) return dynamic && this.navTargetByActor.has(actor.guid) ? "running" : "failure";
    const accept =
      typeof node.properties?.acceptRadius === "number" &&
      Number.isFinite(node.properties.acceptRadius)
        ? Math.max(0, node.properties.acceptRadius)
        : 0.75;
    if (world) {
      const navComponent = actor.components.find((component) =>
        component.classId === "NavAgentComponent" && !component.destroyed);
      const height = parseNavAgentParams(Object.fromEntries(navComponent?.variables ?? [])).height;
      // Root pivots can be at the feet or inside the collider. The crowd is
      // surface-based; do not report arrival for a distant airborne owner.
      if (Math.abs(world.y - position.y) > Math.max(height, accept)) return "running";
    }
    const distance = Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
    );
    if (distance > accept) return "running";
    this.stopNavAgent(actor.guid);
    return "success";
  }

  private tickRotateToFace(
    actor: Actor,
    node: { properties?: Record<string, unknown> },
  ): BtResult {
    const target = navPointFromUnknown(node.properties?.target);
    if (!target) return "failure";
    const position = actor.transform.position;
    const twoD = this.physicsWorldKind === "2d";
    const yawRad = twoD
      ? Math.atan2(target.y - position.y, target.x - position.x)
      : Math.atan2(target.x - position.x, target.z - position.z);
    const yawDeg = (yawRad * 180) / Math.PI;
    const euler: [number, number, number] = twoD
      ? [0, 0, yawDeg]
      : [0, yawDeg, 0];
    const quat = eulerDegreesToQuaternion(euler);
    actor.transform.rotation.x = quat[0];
    actor.transform.rotation.y = quat[1];
    actor.transform.rotation.z = quat[2];
    actor.transform.rotation.w = quat[3];
    if (this.navAgentByActor.has(actor.guid)) {
      this.navYawByActor.set(actor.guid, yawRad);
    }
    return "success";
  }

  private resolvePlayAnimationClip(
    properties: Record<string, unknown> | undefined,
  ): {
    guid: string;
    clipName: string;
    clipKind: "animation" | "sprite";
    durationMs: number;
  } | null {
    const guid =
      typeof properties?.clipAssetGuid === "string"
        ? properties.clipAssetGuid.trim()
        : "";
    if (!guid) return null;
    const entry = this.animClipCatalog.get(guid);
    if (!entry) return null;
    const requested =
      properties?.clipKind === "sprite"
        ? "sprite"
        : properties?.clipKind === "animation"
          ? "animation"
          : entry.type === "SpriteAnimation"
            ? "sprite"
            : "animation";
    if (requested === "sprite" && entry.type !== "SpriteAnimation") return null;
    if (requested === "animation" && entry.type !== "Animation") return null;
    const durationMs = entry.durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      return null;
    }
    const clipName =
      requested === "animation" && typeof entry.clipName === "string"
        ? entry.clipName
        : "";
    return { guid, clipName, clipKind: requested, durationMs };
  }

  private tickPlayAnimation(
    actor: Actor,
    node: { properties?: Record<string, unknown> },
    dtSeconds: number,
    memory: Record<string, unknown>,
  ): BtResult {
    const clip = this.resolvePlayAnimationClip(node.properties);
    const slotId = this.slotByGuid.get(actor.guid);
    if (!clip || slotId === undefined) {
      if (slotId !== undefined) this.btPlayAnimOwnedSlots.delete(slotId);
      return "failure";
    }
    const elapsed =
      (typeof memory.elapsedMs === "number" ? memory.elapsedMs : 0) +
      dtSeconds * 1000;
    memory.elapsedMs = elapsed;
    const normalisedTime = Math.min(1, elapsed / clip.durationMs);
    const justFinished = normalisedTime >= 1;
    this.btPlayAnimOwnedSlots.add(slotId);
    if (clip.clipKind === "sprite") {
      (actor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync).setActorSpriteClip(actor, {
        assetGuid: clip.guid,
        clipName: clip.clipName,
        normalisedTime,
      });
    } else {
      (actor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync).setActorSpriteClip(actor, null);
    }
    this.emit({
      type: "animState",
      slotId,
      stateId: "bt.playAnimation",
      normalisedTime,
      blendWeights: { "bt.playAnimation": 1 },
      clipName: clip.clipName,
      clipKind: clip.clipKind,
      clipAssetGuid: clip.guid,
      justFinished,
      justLooped: false,
      layers: [
        {
          stateId: "bt.playAnimation",
          clipAssetGuid: clip.guid,
          clipName: clip.clipName,
          clipKind: clip.clipKind,
          normalisedTime,
          weight: 1,
        },
      ],
    });
    if (!justFinished) return "running";
    this.btPlayAnimOwnedSlots.delete(slotId);
    return "success";
  }

  private tickPlaySound(
    actor: Actor,
    node: { id: string; properties?: Record<string, unknown> },
    memory: Record<string, unknown>,
  ): BtResult {
    const guid =
      typeof node.properties?.audioAssetGuid === "string"
        ? node.properties.audioAssetGuid.trim()
        : "";
    if (!guid || !this.audioAssetGuids.has(guid)) return "failure";
    const volumeRaw = Number(node.properties?.volume ?? 1);
    const volume = Number.isFinite(volumeRaw)
      ? Math.min(1, Math.max(0, volumeRaw))
      : 1;
    const voiceId = `bt:${actor.guid}:${node.id}`;
    if (memory.__soundPlayed !== true) {
      memory.__soundPlayed = true;
      this.btVoiceByActor.set(actor.guid, voiceId);
      this.emit({
        type: "playSound",
        assetGuid: guid,
        volume,
        frameId: this.frameId,
        emitterActorGuid: actor.guid,
        voiceId,
      });
    }
    return "success";
  }

  private stopBtPlaySound(actorGuid: string, nodeId?: string): void {
    const voiceId =
      nodeId !== undefined
        ? `bt:${actorGuid}:${nodeId}`
        : this.btVoiceByActor.get(actorGuid);
    if (!voiceId) return;
    this.emit({ type: "stopSound", voiceId });
    this.btVoiceByActor.delete(actorGuid);
  }

  private abortPlayAnimation(actor: Actor, memory: Record<string, unknown>): void {
    delete memory.elapsedMs;
    const slotId = this.slotByGuid.get(actor.guid);
    if (slotId !== undefined) this.btPlayAnimOwnedSlots.delete(slotId);
    (actor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync).setActorSpriteClip(actor, null);
  }

  private abortBtTask(
    actor: Actor,
    node: { id: string; classId: string },
    blackboard: BlackboardValues,
    memory: Record<string, unknown>,
  ): void {
    const liveMemory = memory as Record<string | symbol, unknown>;
    const activation = liveMemory[BT_TASK_ACTIVATION] as BtTaskActivation | undefined;
    if (activation) activation.active = false;
    delete liveMemory[BT_TASK_ACTIVATION];
    memory.__activated = false;
    delete memory.__btResult;
    delete memory.__moveRequested;
    delete memory.__soundPlayed;
    const classId = builtinClassId(node.classId);
    if (classId === "bt.task.moveTo" || classId === "bt.task.moveToBlackboardKey") {
      this.stopNavAgent(actor.guid);
    }
    if (classId === "bt.task.playAnimation") {
      this.abortPlayAnimation(actor, memory);
    }
    if (classId === "bt.task.playSound") {
      this.stopBtPlaySound(actor.guid, node.id);
    } else if (this.btVoiceByActor.has(actor.guid)) {
      this.stopBtPlaySound(actor.guid);
    }
    this.scriptHost.invokeBtEvent(node.classId, "onAbort", actor, this.simulationDt(), {
      btFinish: () => undefined,
      btEvaluate: () => undefined,
      getBlackboard: (key) => blackboard[key],
      setBlackboard: (key, value) => {
        blackboard[key] = value;
      },
    });
  }

  private evaluateBtDecorator(
    actor: Actor,
    classId: string,
    blackboard: BlackboardValues,
  ): boolean {
    if (!this.scriptHost.hasClass(classId)) return true;
    let result = true;
    this.scriptHost.invokeBtEvent(classId, "onEvaluate", actor, this.simulationDt(), {
      btFinish: () => undefined,
      btEvaluate: (value) => {
        result = Boolean(value);
      },
      getBlackboard: (key) => blackboard[key],
      setBlackboard: (key, value) => {
        blackboard[key] = value;
      },
    });
    return result;
  }

  private emitBtMissing(actorGuid: string, message: string): void {
    if (this.btMissingWarned.has(actorGuid)) return;
    this.btMissingWarned.add(actorGuid);
    const diag: RuntimeDiagnostic = {
      code: "bt.missing_tree",
      message,
      severity: "error",
      frameId: this.frameId,
      tickIndex: this.world.clock.tickIndex,
    };
    this.diagnostics.push(diag);
    this.emit({
      type: "diagnostic",
      code: diag.code,
      message: diag.message,
      frameId: this.frameId,
      severity: "error",
    });
  }

  private tickBehaviourTrees(): void {
    for (const actor of this.world.getActors()) {
      if (this.stopped) return;
      if (!this.canTickActor(actor)) continue;
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "BehaviourTreeComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const guid = this.behaviourTreeGuid(component);
      if (!guid) {
        this.emitBtMissing(actor.guid, "BehaviourTreeComponent has no treeGuid");
        continue;
      }
      this.currentBtAssetGuid = guid;
      const document = this.behaviourTrees.get(guid);
      if (!document) {
        this.emitBtMissing(actor.guid, `Behaviour tree not loaded: ${guid}`);
        continue;
      }
      const blackboardGuid = this.stringGuid(component.getVariable("blackboardGuid")) ?? document.blackboardGuid;
      const previous = this.btEvalBySlot.get(slotId) ?? null;
      const blackboard: BlackboardValues = previous
        ? { ...previous.blackboard }
        : this.blackboardDefaults(blackboardGuid);
      const next = evaluateBehaviourTree(document, previous, this.simulationDt(), {
        seed: this.seed,
        blackboard,
        host: {
          tick: (node, board, dtSeconds, memory) =>
            this.tickBtTask(actor, node, board, dtSeconds, memory),
          abort: (node, board, memory) =>
            this.abortBtTask(actor, node, board, memory),
        },
        decoratorHost: {
          evaluate: (decorator, _node, board) =>
            this.evaluateBtDecorator(actor, decorator.classId, board),
        },
        serviceHost: {
          tick: (service, _node, board, dtSeconds) => {
            this.scriptHost.invokeBtEvent(
              service.classId,
              "onBtTick",
              actor,
              dtSeconds,
              {
                btFinish: () => undefined,
                btEvaluate: () => undefined,
                getBlackboard: (key) => board[key],
                setBlackboard: (key, value) => {
                  board[key] = value;
                },
              },
            );
          },
        },
      });
      this.btEvalBySlot.set(slotId, next);
      this.currentBtNodeId = null;
      this.currentBtAssetGuid = null;
      const blackboardSnapshot = snapshotBlackboard(next.blackboard);
      const payload = JSON.stringify({
        status: next.status,
        btNodeId: next.btNodeId,
        lastResults: next.lastResults,
        blackboard: blackboardSnapshot,
        stack: next.stack,
      });
      if (this.lastBtStateJson.get(slotId) === payload) continue;
      this.lastBtStateJson.set(slotId, payload);
      this.emit({
        type: "btState",
        slotId,
        status: next.status,
        btNodeId: next.btNodeId,
        lastResults: next.lastResults,
        blackboard: blackboardSnapshot,
        stack: next.stack,
      });
    }
  }

  private simulationDt(): number {
    return this.dt * this.timeDilation;
  }

  private debugActorName(actor: Actor): string {
    const name = actor.getVariable("name");
    return typeof name === "string" && name.trim() ? name : actor.classId;
  }

  private emitNavigationDebug(force = false): void {
    if (!this.showPathfinding && !this.showNavAgent) return;
    const now = nowMs();
    if (!force && now - this.lastNavigationDebugMs < 200) return;
    this.lastNavigationDebugMs = now;
    const agents: DebugNavAgent[] = [];
    for (const [actorGuid, agentId] of this.navAgentByActor) {
      const actor = this.world.findActor(actorGuid);
      if (!actor || actor.destroyed) continue;
      const state = this.nav?.agentDebugState(agentId);
      if (!state) continue;
      agents.push({
        ...state,
        actorGuid,
        actorName: this.debugActorName(actor),
        position: this.fromNav(state.position),
        velocity: this.fromNav(state.velocity),
        target: state.target ? this.fromNav(state.target) : null,
        path: state.path.map((point) => this.fromNav(point)),
      });
    }
    this.emit({ type: "debugNavigation", agents, world: this.physicsWorldKind });
  }

  private emitBehaviourTreeSnapshot(force = false): void {
    if (!this.behaviourTreeDebug) return;
    const now = nowMs();
    if (!force && now - this.lastBehaviourTreeDebugMs < 200) return;
    this.lastBehaviourTreeDebugMs = now;
    const trees: DebugBehaviourTree[] = [];
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      const component = actor.components.find((entry) =>
        entry.classId === "BehaviourTreeComponent" && !entry.destroyed);
      if (!component) continue;
      const treeGuid = this.behaviourTreeGuid(component);
      const document = treeGuid ? this.behaviourTrees.get(treeGuid) : null;
      if (!treeGuid || !document) continue;
      const state = this.btEvalBySlot.get(slotId);
      const blackboardGuid = this.stringGuid(component.getVariable("blackboardGuid")) ?? document.blackboardGuid;
      const blackboardTypes = blackboardInspectTypes(blackboardGuid ? this.blackboards.get(blackboardGuid) : undefined);
      trees.push({
        actorGuid: actor.guid,
        actorName: this.debugActorName(actor),
        treeGuid,
        treeName: document.name || treeGuid,
        slotId,
        status: state?.status ?? "idle",
        btNodeId: state?.btNodeId ?? null,
        lastResults: { ...state?.lastResults },
        blackboard: snapshotBlackboard(state?.blackboard ?? this.blackboardDefaults(blackboardGuid)),
        ...(blackboardTypes ? { blackboardTypes } : {}),
        stack: state?.stack.map((frame) => ({ ...frame })) ?? [],
        nodes: document.nodes.map((node) => ({
          id: node.id, kind: node.kind, classId: node.classId,
          children: [...node.children],
          decorators: node.decorators.map(({ id, classId }) => ({ id, classId })),
          services: node.services.map(({ id, classId }) => ({ id, classId })),
        })),
      });
    }
    this.emit({ type: "behaviourTreeSnapshot", trees });
  }

  private emitDebugColliders(): void {
    if (!this.showCollision) return;
    this.emit({
      type: "debugColliders",
      colliders: this.physicsSync.getBackend().listDebugColliders(),
    });
  }

  private consoleHost(): ConsoleCommandHost {
    return {
      changeScene: (scene) => this.applyChangeScene(scene),
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
      setShowCollision: (enabled) => {
        this.showCollision = Boolean(enabled);
        this.emit({
          type: "setShowCollision",
          enabled: this.showCollision,
        });
        if (this.showCollision) this.emitDebugColliders();
        else this.emit({ type: "debugColliders", colliders: [] });
      },
      setShowBounds: (enabled) => {
        this.emit({ type: "setShowBounds", enabled: Boolean(enabled) });
      },
      setWireframe: (enabled) => {
        this.emit({ type: "setWireframe", enabled: Boolean(enabled) });
      },
      setShowNav: (enabled) => {
        this.emit({ type: "setShowNav", enabled: Boolean(enabled) });
      },
      setShowPathfinding: (enabled) => {
        this.showPathfinding = enabled;
        this.emit({ type: "setShowPathfinding", enabled });
        this.emitNavigationDebug(true);
        if (!this.showPathfinding && !this.showNavAgent) {
          this.emit({ type: "debugNavigation", agents: [], world: this.physicsWorldKind });
        }
      },
      setShowNavAgent: (enabled) => {
        this.showNavAgent = enabled;
        this.emit({ type: "setShowNavAgent", enabled });
        this.emitNavigationDebug(true);
        if (!this.showPathfinding && !this.showNavAgent) {
          this.emit({ type: "debugNavigation", agents: [], world: this.physicsWorldKind });
        }
      },
      setBehaviourTreeDebug: (enabled) => {
        this.behaviourTreeDebug = enabled;
        this.emit({ type: "setBehaviourTreeDebug", enabled });
        if (enabled) this.emitBehaviourTreeSnapshot(true);
        else this.emit({ type: "behaviourTreeSnapshot", trees: [] });
      },
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
        ) || !this.slotByGuid.has(target.guid)) {
          return { success: false, output: `actor '${query}' has no live camera` };
        }
        this.emit({ type: "setFreeCam", enabled: false });
        this.possessCamera(target);
        return { success: true, output: `possessed ${target.guid}` };
      },
      destroyActor: (query) => {
        const target = this.resolveConsoleActor(query);
        if (!(target instanceof Actor)) return target;
        this.emitAudioStops(target);
        this.emitParticleStops(target);
        this.world.destroyActor(target.guid);
        if (!this.processingTick && !this.flushingConsoleActors) {
          this.flushingConsoleActors = true;
          try {
            this.world.flushPending();
            this.physicsSync.syncFromWorld(this.world);
            this.overlayPhysicsSync.syncFromWorld(this.world);
            this.publishSnapshot();
            this.emitDebugColliders();
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
        if (this.diagnosticRecorder?.busy) return { success: false, output: "Stop the current profile or frame capture first." };
        this.trace.start({ seed: this.seed, dt: this.dt });
        this.lastTrace = null;
      },
      stopSnapshot: () => {
        this.finalizeTrace();
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

  private emitActorOutlines(actor: Actor, slotId: number): void {
    const components = actor.components.filter((component) => !component.destroyed && component.classId === "OutlineComponent");
    if (components.length || this.outlineSlots.has(slotId)) {
      const outlines = outlineBindings(actor.guid, components.map((component) => ({
        id: component.guid, classId: component.classId,
        properties: Object.fromEntries(["enabled", "color", "width", "throughMeshes"].map((key) =>
          [key, key === "color" && component.getVariable(key) != null ? rgbTuple(component.getVariable(key)) : component.getVariable(key)])),
      })));
      this.emit({ type: "setActorOutlines", slotId, actorId: actor.guid, outlines });
      if (outlines.length) this.outlineSlots.add(slotId); else this.outlineSlots.delete(slotId);
    }
  }

  private emitActorDeformers(actor: Actor, slotId: number): void {
    this.dirtyDeformerActors.delete(actor);
    const components = actor.components.filter((component) => !component.destroyed &&
      (component.classId === "DeformerComponent" || component.classId === "MeshComponent"));
    if (!components.some((component) => component.classId === "DeformerComponent") && !this.deformerSnapshots.has(slotId)) return;
    const deformers = actor.sceneLayerId ? [] : deformerBindings(actor.guid, components.map((component) => ({
      id: component.guid, classId: component.classId, ...(component.sourceId ? { sourceId: component.sourceId } : {}),
      properties: component.classId === "DeformerComponent"
        ? Object.fromEntries(DEFORMER_PROPERTY_KEYS.map((key) => [key, component.getVariable(key)])) : {},
    })));
    const snapshot = JSON.stringify(deformers);
    if (snapshot === this.deformerSnapshots.get(slotId) || (!deformers.length && !this.deformerSnapshots.has(slotId))) return;
    this.deformerSnapshots.set(slotId, snapshot);
    this.emit({ type: "setActorDeformers", slotId, actorId: actor.guid, revision: ++this.deformerRevision, deformers });
  }

  private flushDeformers(): void {
    for (const actor of this.dirtyDeformerActors) {
      const slotId = this.slotByGuid.get(actor.guid);
      if (!actor.destroyed && slotId !== undefined) this.emitActorDeformers(actor, slotId);
    }
    this.dirtyDeformerActors.clear();
  }

  private emitActorFogVolumes(actor: Actor, slotId: number): void {
    const hasVolume = !actor.sceneLayerId && actor.components.some((component) =>
      !component.destroyed && component.classId === "FogVolumeComponent");
    if (!hasVolume && !this.fogVolumeSlots.has(slotId)) return;
    const volumes = hasVolume ? fogVolumeBindings(actor.components.filter((component) => !component.destroyed).map((component) => {
      const { position, rotation, scale } = component.transform;
      const size = component.getVariable("size");
      return {
        id: component.guid, classId: component.classId, parentId: component.parentId,
        properties: component.classId === "FogVolumeComponent" ? {
          enabled: component.getVariable("enabled"), shape: component.getVariable("shape"),
          size: size == null ? undefined : rgbTuple(size), density: component.getVariable("density"),
          edgeFalloff: component.getVariable("edgeFalloff"),
        } : {},
        transform: { position: [position.x, position.y, position.z] as [number, number, number],
          rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as [number, number, number, number],
          scale: [scale.x, scale.y, scale.z] as [number, number, number] },
      };
    })) : [];
    this.emit({ type: "setFogVolumes", slotId, actorId: actor.guid, volumes });
    if (volumes.length) this.fogVolumeSlots.add(slotId); else this.fogVolumeSlots.delete(slotId);
  }

  private cameraAssignPayload(
    actor: Actor,
    camera: ActorComponent,
  ): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["camera"]> {
    const projection = camera.getVariable("projectionMode");
    const settings = this.playScene?.settings;
    return {
      projectionMode:
        projection === "orthographic" ? "orthographic" : "perspective",
      fieldOfView: Number(camera.getVariable("fieldOfView") ?? 60),
      orthographicSize: Number(camera.getVariable("orthographicSize") ?? 5),
      nearClip: Number(camera.getVariable("nearClip") ?? 0.1),
      farClip: Number(camera.getVariable("farClip") ?? 1000),
      isDefault:
        settings?.mainCameraActorId === actor.guid &&
        settings.mainCameraComponentId === camera.guid,
    };
  }

  private emitRenderTargetCapture(actor: Actor, slotId: number): void {
    const component = captureComponent(actor);
    if (!component && !this.captureSlots.has(slotId)) return;
    this.emit({
      type: "configureRenderTargetCapture", actorGuid: actor.guid, slotId,
      settings: component ? captureProperties(component) : null,
      ...(component ? { transform: captureLocalTransform(component) } : {}),
    });
    if (component) this.captureSlots.add(slotId); else this.captureSlots.delete(slotId);
  }

  private emitComponentTransforms(actor: Actor, slotId: number): void {
    const renderables = playRenderablesOf(actor.components,
      overlayButtonHasSiblingVisual(actor) || overlayButtonHasParentVisual(actor, this.world));
    const ids = new Set(renderables.map(component => component.guid));
    const components = new Map(actor.components.map(component => [component.guid, component]));
    this.emit({ type: "setComponentTransforms", slotId, parts: renderables.map(component => ({
      componentId: component.guid, parentId: nearestVisualParentId(component, components, ids),
      transform: { position: { ...component.transform.position }, rotation: { ...component.transform.rotation }, scale: { ...component.transform.scale } },
      parentTransforms: dynamicMeshParentTransforms(component, components, ids),
    })) });
  }

  private emitMeshAssignment(actor: Actor, slotId: number): void {
    if (this.world.classRegistry.isA(actor.classId, "SceneStreamingActor")) return;
    this.emitRenderTargetCapture(actor, slotId);
    this.emitActorOutlines(actor, slotId);
    this.emitActorDeformers(actor, slotId);
    this.emitActorFogVolumes(actor, slotId);
    const hasAreaLight = actor.components.some((component) => component.classId === "AreaRectLightComponent" && !component.destroyed);
    if (hasAreaLight || this.areaLightSlots.has(slotId)) {
    const lights = hasAreaLight ? areaRectLightBindings(actor.components.filter((component) => !component.destroyed).map((component) => {
      const { position, rotation, scale } = component.transform;
      return {
        id: component.guid, classId: component.classId, parentId: component.parentId,
        properties: component.classId === "AreaRectLightComponent" ? Object.fromEntries(["enabled", "width", "height", "color", "intensity", "textureGuid"].map((key) => [key, key === "color" ? rgbTuple(component.getVariable(key)) : component.getVariable(key)])) : {},
        transform: { position: [position.x, position.y, position.z] as [number, number, number], rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as [number, number, number, number], scale: [scale.x, scale.y, scale.z] as [number, number, number] },
      };
    })) : [];
    // A separate component command also handles actors with meshes, multiple
    // emitters and asynchronous model loading. It uses the same view owner.
    this.emit({ type: "setAreaLights", slotId, lights });
    if (lights.length) this.areaLightSlots.add(slotId); else this.areaLightSlots.delete(slotId);
    }
    const skipButtonMesh =
      overlayButtonHasSiblingVisual(actor) ||
      overlayButtonHasParentVisual(actor, this.world);
    const renderables = playRenderablesOf(this.actorStream.has(actor)
      ? actor.components.filter((component) => component.classId !== "SkyboxComponent")
      : actor.components, skipButtonMesh);
    if (renderables.length > 0) {
      const primary = renderables[0]!;
      const meshKind = playMeshKindOf(primary);
      const panelComp = renderables.find(
        (component) => component.classId === "2DPanelComponent",
      );
      const overlayPanel = panelComp
        ? {
            ...parseOverlayPanelProperties(overlayPanelVariables(panelComp)),
            ...overlayPanelDestFromScale(
              actor.transform.scale.x,
              actor.transform.scale.y,
            ),
          }
        : null;
      const componentAssetGuid =
        primary.assetGuid ?? primary.getVariable("assetGuid");
      const assetGuid =
        overlayPanel
          ? overlayPanel.source === "material"
            ? overlayPanel.materialGuid
            : overlayPanel.textureGuid
          : primary.classId === "MeshComponent"
            ? componentAssetGuid
            : (componentAssetGuid ??
              primary.getVariable("textureGuid") ??
              primary.getVariable("materialGuid"));
      const renderableIds = new Set(renderables.map((component) => component.guid));
      const componentsByGuid = new Map(
        actor.components.map((component) => [component.guid, component]),
      );
      const parts = playPartsNeeded(renderables) ||
        renderables.some((component) => component.classId === SPRING_ARM_COMPONENT_CLASS_ID)
        ? renderables.map((component) => ({
            ...playMeshPartOf(
              component,
              nearestVisualParentId(
                component,
                componentsByGuid,
                renderableIds,
              ),
            ),
            ...(supportsOverlayVisualStyle(component.classId) ? { overlayStyle: parseOverlayVisualStyle(Object.fromEntries(component.variables)) } : {}),
            ...(component.classId === "CableComponent" ? { cable: this.cables.assign(component) } : {}),
            ...(component.classId === "2DJoystickComponent" ? { joystick: parseJoystick2DProperties(Object.fromEntries(component.variables)) } : {}),
            ...(isUIControl2DClass(component.classId) ? { uiControl: { classId: component.classId, properties: this.uiControls.payload(component) } } : {}),
            ...(component.classId === "2DPainterComponent" ? { painter: this.painters.payload(component) } : {}),
            ...(component.classId === "2DRichTextComponent" ? { text2d: text2dAssignPayload(component, this.textAppear.progress(component)) } : {}),
            ...(component.classId === "DynamicRuntimeMeshComponent" ? { dynamicMesh: this.dynamicMeshes.assign(component) } : {}),
            ...(component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent" ? { light: lightAssignPayload(component) } : {}),
            ...(component.classId === "CameraComponent" ? { camera: this.cameraAssignPayload(actor, component) } : {}),
            parentTransforms: dynamicMeshParentTransforms(component, componentsByGuid, renderableIds),
          }))
        : undefined;
      const skyboxComp = renderables.find(
        (component) => component.classId === "SkyboxComponent",
      );
      const text3dComp = renderables.find(
        (component) => component.classId === "Text3DComponent",
      );
      const text2dComp = renderables.find(
        (component) =>
          component.classId === "2DTextComponent" ||
          component.classId === "2DRichTextComponent",
      );
      const cameras = renderables.filter(component => component.classId === "CameraComponent");
      const camera = cameras.find(component => this.cameraAssignPayload(actor, component).isDefault) ?? cameras[0];
      const light = renderables.find(component => component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent");
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
        meshKind,
        actorGuid: actor.guid,
        ...(!parts
          ? { primaryComponentId: primary.guid }
          : {}),
        ...(supportsOverlayVisualStyle(primary.classId) ? { overlayStyle: parseOverlayVisualStyle(Object.fromEntries(primary.variables)) } : {}),
        ...(meshKind === "sprite" || meshKind === "tilemap"
          ? playSortingOf(primary)
          : {}),
        ...(actor.sceneLayerId
          ? {
              sceneLayerId: actor.sceneLayerId,
              ...overlayMeshInteraction(actor, this.world),
            }
          : {}),
        ...(skyboxComp
          ? {
              skybox: {
                size: parseSkyboxSize(skyboxComp.getVariable("size")),
                faces: parseSkyboxFaces(skyboxComp.getVariable("faces")),
              },
            }
          : {}),
        ...(text3dComp
          ? {
              text3d: text3dAssignPayload(text3dComp),
            }
          : {}),
        ...(text2dComp ? { text2d: text2dAssignPayload(text2dComp,
          text2dComp.classId === "2DRichTextComponent" ? this.textAppear.progress(text2dComp) : 1) } : {}),
        ...(camera ? { camera: this.cameraAssignPayload(actor, camera) } : {}),
        ...(light ? { light: lightAssignPayload(light) } : {}),
        ...(overlayPanel ? { overlayPanel } : {}),
        ...(parts ? { parts } : {}),
      });
      this.emitMaterialAssignments(renderables, slotId, Boolean(parts));
      return;
    }
    const capture = captureComponent(actor);
    if (capture) {
      this.emit({ type: "assignMesh", slotId, actorGuid: actor.guid, meshAssetGuid: null, meshKind: "renderTargetCapture", parts: [playMeshPartOf(capture)] });
      return;
    }
    const audio = actor.components.find(
      (component) =>
        component.classId === "AudioComponent" && !component.destroyed,
    );
    if (audio) {
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "audio",
        parts: [playMeshPartOf(audio)],
      });
      return;
    }
    const particle = actor.components.find(
      (component) =>
        component.classId === "ParticleComponent" && !component.destroyed,
    );
    if (particle) {
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "particle",
        parts: [playMeshPartOf(particle)],
      });
      return;
    }
    const rigid = actor.components.find(
      (component) =>
        component.classId === "RigidBodyComponent" && !component.destroyed,
    );
    if (rigid) {
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "rigidbody",
        parts: [playMeshPartOf(rigid)],
      });
    } else if (this.fogVolumeSlots.has(slotId)) {
      this.emit({ type: "assignMesh", slotId, meshAssetGuid: null, meshKind: null });
    }
  }


  private applyActorDefaults(actor: Actor): void {
    for (const component of actor.components) {
      this.scriptHost.bindInterfaceHandlers(component);
    }
    const script = this.scriptHost.scriptsFor(actor.classId)[0];
    const defaults = script?.actorDefaults;
    if (!defaults) return;
    if (typeof defaults.generateHitEvents === "boolean") {
      actor.generateHitEvents = defaults.generateHitEvents;
    }
    if (typeof defaults.generateOverlapEvents === "boolean") {
      actor.generateOverlapEvents = defaults.generateOverlapEvents;
    }
  }

  private dispatchCollisionEvents(): void {
    this.dispatchPhysicsContacts(this.physicsSync);
    this.dispatchPhysicsContacts(this.overlayPhysicsSync);
  }

  private dispatchPhysicsContacts(sync: PhysicsWorldSync): void {
    const events = sync.getBackend().pollContacts();
    for (const event of events) {
      const actorA = this.world.findActor(event.actorAId);
      const actorB = this.world.findActor(event.actorBId);
      if (!actorA || !actorB || actorA.destroyed || actorB.destroyed) continue;
      if (!this.canTickActor(actorA) || !this.canTickActor(actorB)) continue;
      if (event.kind === "hit") {
        this.dispatchHit(
          actorA,
          actorB,
          event.location,
          event.normal,
          event.colliderAId,
        );
        this.dispatchHit(actorB, actorA, event.location, {
          x: -event.normal.x,
          y: -event.normal.y,
          z: -event.normal.z,
        }, event.colliderBId);
      } else if (event.kind === "overlapBegin") {
        this.dispatchOverlap(actorA, actorB, "onBeginOverlap", event.colliderAId);
        this.dispatchOverlap(actorB, actorA, "onBeginOverlap", event.colliderBId);
      } else if (event.kind === "overlapEnd") {
        this.dispatchOverlap(actorA, actorB, "onEndOverlap", event.colliderAId);
        this.dispatchOverlap(actorB, actorA, "onEndOverlap", event.colliderBId);
      }
    }
  }

  private dispatchHit(
    self: Actor,
    other: Actor,
    location: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
    colliderId?: string,
  ): void {
    if (!self.generateHitEvents) return;
    this.scriptHost.invokeEvent(
      self.classId,
      "onHit",
      self,
      {
        hitResult: {
          Hit: true,
          Location: location,
          Normal: normal,
          Actor: other,
          Distance: 0,
        },
        otherActor: other,
        location: location,
        normal: normal,
      },
      componentIdFromColliderPhysicsId(colliderId),
    );
  }

  private dispatchOverlap(
    self: Actor,
    other: Actor,
    event: "onBeginOverlap" | "onEndOverlap",
    colliderId?: string,
  ): void {
    if (!self.generateOverlapEvents) return;
    this.scriptHost.invokeEvent(
      self.classId,
      event,
      self,
      {
        instigator: other,
      },
      componentIdFromColliderPhysicsId(colliderId),
    );
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
    if (!this.saveBoundaryActive) this.saveGameWorld?.register(actor, this.savedActors.has(actor));
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
        parseColliderProperties({ shape }, actor.sceneLayerId ? "2d" : this.physicsWorldKind);
      } catch (error) {
        throw new Error(`${actorLabel(actor)} / ${component.guid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const slotId = this.assignSlot(actor);
    checkpoint();
    this.emitMeshAssignment(actor, slotId);
    checkpoint();
    this.emitAudioComponents(actor);
    checkpoint();
    this.emitParticleComponents(actor);
    checkpoint();
    this.world.spawnActorNow(actor);
    checkpoint();
    // Spawned from queued work (an On Init or Begin Play): only this actor's
    // work runs now; other owners wait until that handler returns.
    if (this.flushingOwnerActions > 0) {
      for (const owner of [actor, ...actor.components]) this.drainOwnerActions(owner);
    } else this.flushOwnerActions();
    checkpoint();
    // The frame index answers first-spawned: a new actor enters only when no
    // earlier live actor already holds its guid.
    if (this.world.findActor(actor.guid) === actor) this.navFrameActors?.set(actor.guid, actor);
  }

  private emitAudioComponents(actor: Actor): void {
    if (!this.canRunOwner(actor)) {
      this.runOwnerAction(actor, () => this.emitAudioComponents(actor));
      return;
    }
    for (const component of actor.components) {
      if (component.destroyed || component.classId !== "AudioComponent") continue;
      const playOnStart = component.getVariable("playOnStart") !== false;
      const assetGuid =
        (typeof component.getVariable("audioAssetGuid") === "string"
          ? component.getVariable("audioAssetGuid")
          : null) ?? component.assetGuid;
      if (!playOnStart || typeof assetGuid !== "string" || !assetGuid) continue;
      const volume = Number(component.getVariable("volume") ?? 1);
      this.emit({
        type: "playSound",
        assetGuid,
        volume: Number.isFinite(volume) ? volume : 1,
        frameId: this.frameId,
        loop: component.getVariable("loop") === true,
        voiceId: component.guid,
        emitterActorGuid: actor.guid,
      });
    }
  }

  private emitAudioStops(actor: Actor): void {
    for (const component of actor.components) {
      if (component.classId !== "AudioComponent") continue;
      this.emit({ type: "stopSound", voiceId: component.guid });
    }
  }

  private emitParticleComponents(actor: Actor): void {
    const slotId = this.slotByGuid.get(actor.guid);
    if (slotId === undefined) return;
    for (const component of actor.components) {
      if (component.destroyed || component.classId !== "ParticleComponent") {
        continue;
      }
      const assetGuid =
        (typeof component.getVariable("particleSystemGuid") === "string"
          ? component.getVariable("particleSystemGuid")
          : null) ?? component.assetGuid;
      if (typeof assetGuid !== "string" || !assetGuid) continue;
      const sortingLayer = component.getVariable("sortingLayer");
      const orderInLayer = component.getVariable("orderInLayer");
      this.emit({
        type: "assignParticle",
        slotId,
        actorGuid: actor.guid,
        componentId: component.guid,
        particleSystemGuid: assetGuid,
        play: this.canRunOwner(actor) && component.getVariable("playOnStart") !== false,
        sortingLayer:
          typeof sortingLayer === "string" && sortingLayer.trim() !== ""
            ? sortingLayer
            : "Default",
        orderInLayer:
          typeof orderInLayer === "number" && Number.isFinite(orderInLayer)
            ? Math.round(orderInLayer)
            : 0,
      });
      if (component.getVariable("playOnStart") !== false && !this.canRunOwner(actor)) {
        this.runOwnerAction(actor, () => this.emit({ type: "setParticlePlaying", actorGuid: actor.guid,
          componentId: component.guid, playing: true }));
      }
    }
  }

  private emitParticleStops(actor: Actor): void {
    const slotId = this.slotByGuid.get(actor.guid) ?? 0;
    for (const component of actor.components) {
      if (component.classId !== "ParticleComponent") continue;
      this.emit({
        type: "assignParticle",
        slotId,
        actorGuid: actor.guid,
        componentId: component.guid,
        particleSystemGuid: null,
      });
    }
  }

  private emitMaterialAssignments(
    renderables: readonly ActorComponent[],
    slotId: number,
    multipart: boolean,
  ): void {
    for (const component of renderables) {
      if (component.classId === "2DTextComponent" || component.classId === "2DRichTextComponent") continue;
      const value = component.getVariable("materialGuid");
      const guid = typeof value === "string" && value.trim() ? value : null;
      if (guid) this.componentsWithMaterialAssignment.add(component);
      else if (
        !this.componentsWithMaterialAssignment.delete(component) &&
        component.getVariable("materialSource") !== "override"
      ) {
        // Untouched model components retain their authored material slots.
        continue;
      }
      this.emit({
        type: "assignMaterial",
        slotId,
        materialAssetGuid: guid,
        ...(multipart || component.classId === "MeshComponent"
          ? { componentId: component.guid }
          : {}),
      });
      const material = component.getVariable("materialObject");
      if (component.materialInstance?.materialGuid === guid && material instanceof MaterialObject) {
        for (const [parameterName, parameter] of Object.entries(this.materialParameters.captureOverrides(material) ?? {})) {
          this.emit({ type: "setMaterialParameter", slotId, componentId: component.guid,
            materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
        }
      }
    }
  }

  private possessCamera(target: unknown): void {
    const actor = actorFromIlluminationTarget(target);
    if (!actor) return;
    const slotId = this.slotByGuid.get(actor.guid);
    if (slotId === undefined) return;
    this.cameraPossessedByScript = true;
    this.possessedCameraSlotId = slotId;
    this.emit({ type: "possessCamera", slotId });
  }

  private playCameraActor(): Actor | null {
    if (this.possessedCameraSlotId != null) {
      for (const actor of this.world.getActors()) {
        if (actor.destroyed) continue;
        if (this.slotByGuid.get(actor.guid) === this.possessedCameraSlotId) {
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
      if (actor.destroyed || actor.sceneLayerId || this.actorStream.has(actor)) continue;
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
      { width: this.playCanvasWidth, height: this.playCanvasHeight },
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
    const hit = this.physicsSync.lineTrace(ray.origin, ray.end, { channel });
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

  private reemitIllumination(target: unknown): void {
    const actor = actorFromIlluminationTarget(target);
    if (!actor) return;
    const slotId = this.slotByGuid.get(actor.guid);
    if (slotId === undefined) return;
    this.emitMeshAssignment(actor, slotId);
  }

  private guardScript(run: () => void): void {
    try {
      run();
    } catch (error) {
      if (isInfiniteLoopError(error)) {
        // Stop must finish tearing down every owner even if On End loops.
        if (!this.stopped) throw error;
        return;
      }
      this.reportError(error);
    }
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

  private phaseMark = 0;
  private currentTimingPhase: TickPhase | null = null;

  private markPhase(phase: TickPhase): void {
    const now = nowMs();
    if (this.currentTimingPhase !== null) {
      const elapsed = now - this.phaseMark;
      if (this.currentTimingPhase === "physics") {
        this.phasePhysicsMs += elapsed;
      } else {
        this.phaseScriptMs += elapsed;
      }
    }
    this.currentTimingPhase = phase;
    this.phaseMark = now;
  }

  private closePhaseTiming(): void {
    const now = nowMs();
    if (this.currentTimingPhase !== null) {
      const elapsed = now - this.phaseMark;
      if (this.currentTimingPhase === "physics") {
        this.phasePhysicsMs += elapsed;
      } else {
        this.phaseScriptMs += elapsed;
      }
    }
    this.currentTimingPhase = null;
  }

  private assignSlot(actor: Actor): number {
    const slotId = this.freeSlots.pop() ?? this.nextUnusedSlot;
    this.ensureSnapshotCapacity(slotId + 1);
    if (slotId === this.nextUnusedSlot) this.nextUnusedSlot += 1;
    this.slotByGuid.set(actor.guid, slotId);
    this.slotOwners.set(slotId, actor);
    this.slotByActor.set(actor, slotId);
    const stream = this.actorStream.get(actor);
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

  private ensureSnapshotCapacity(required: number): void {
    if (required <= this.snapshots.maxActors) return;
    let capacity = Math.max(1, this.snapshots.maxActors);
    while (capacity < required) capacity *= 2;
    try {
      this.snapshots = SeqLockSnapshotPair.grow(this.snapshots, capacity);
      this._snapshotGeneration += 1;
      this.emit({ type: "snapshotLayout", capacity, generation: this._snapshotGeneration });
    } catch (error) {
      const message = `Unable to grow Actor snapshot capacity to ${capacity}: ${error instanceof Error ? error.message : String(error)}`;
      this.reportError(new Error(message));
      throw new Error(message);
    }
  }

  private releaseSlot(actorGuid: string, slotId: number): void {
    const owner = this.slotOwners.get(slotId);
    if (owner) {
      this.ragdolls.retire(owner);
      this.cables.retire(owner);
      this.dynamicMeshes.retire(owner);
      for (const component of owner.components) this.textAppear.remove(component);
    }
    this.areaLightSlots.delete(slotId);
    this.outlineSlots.delete(slotId);
    this.deformerSnapshots.delete(slotId);
    if (owner) this.dirtyDeformerActors.delete(owner);
    this.captureSlots.delete(slotId);
    this.fogVolumeSlots.delete(slotId);
    if (this.slotByGuid.get(actorGuid) === slotId) this.slotByGuid.delete(actorGuid);
    if (owner && this.slotByActor.get(owner) === slotId) this.slotByActor.delete(owner);
    this.slotOwners.delete(slotId);
    this.btEvalBySlot.delete(slotId);
    this.lastBtStateJson.delete(slotId);
    if (this.possessedCameraSlotId === slotId) {
      this.possessedCameraSlotId = null;
      this.cameraPossessedByScript = false;
    }
    this.freeSlots.push(slotId);
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
      this.runOwnerAction(self, () => this.guardScript(() => this.scriptHost.invokeEvent(classId, event, self, { sceneName })));
    };
    return {
      onCreation: (self) => {
        const hooks = this.scriptHost.hooksFor(classId);
        this.runOwnerCreation(self, () => hooks?.onCreation?.(self));
      },
      onTick: (self, ctx) => {
        const hooks = this.scriptHost.hooksFor(classId);
        this.guardScript(() => hooks?.onTick?.(self, ctx));
      },
      onGameEnd: (self) => {
        this.guardScript(() =>
          this.scriptHost.invokeGameShutdownEvent(classId, "onEnd", self),
        );
      },
      onSceneStartLoading: sceneEvent("onSceneStartLoading"),
      onSceneFinishLoading: sceneEvent("onSceneFinishLoading"),
      onFirstSceneLoaded: sceneEvent("onFirstSceneLoaded"),
      onSceneExit: (self, sceneName) => {
        this.guardScript(() => {
          if (this.stopped) {
            this.scriptHost.invokeGameShutdownEvent(classId, "onSceneExit", self, { sceneName });
          } else {
            this.runOwnerAction(self, () => this.scriptHost.invokeEvent(classId, "onSceneExit", self, { sceneName }));
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
        this.runOwnerCreation(self, () => this.scriptHost.hooksFor(classId)?.onCreation?.(self));
      },
      onTick: (self, ctx) =>
        this.guardScript(() => this.scriptHost.hooksFor(classId)?.onTick?.(self, ctx)),
      onEnd: (self) => {
        this.subsystemMatches.clear();
        this.pendingOwnerActions.delete(self);
        this.guardScript(() => this.scriptHost.invokeGameShutdownEvent(classId, "onEnd", self));
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
        this.runOwnerAction(actor, () => {
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
    const dispatch = () =>
      this.guardScript(() => this.scriptHost.invokeEvent(classId, event, subsystem, args));
    // An empty queue is one being drained (its On Init may be running).
    const queued = this.pendingOwnerActions.get(subsystem);
    if (queued && queued.length > 0) queued.push(dispatch);
    else this.runOwnerAction(subsystem, dispatch);
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

  private finishOrDeferSceneLoad(
    name: string,
    guid: string,
    sceneLoadId: number,
  ): void {
    // Install the latch first: an in-process host may acknowledge synchronously
    // from sceneRealized, after the full world and owned-layer assignment batch.
    this.pendingSceneFinish = { name, guid, sceneLoadId, presented: !this.deferSceneModelsReady };
    this.emit({ type: "sceneRealized", sceneAssetGuid: guid, sceneLoadId });
    if (
      !this.deferSceneModelsReady &&
      this.pendingSceneFinish?.sceneLoadId === sceneLoadId
    )
      this.tryCompleteSceneLoad();
  }

  private tryCompleteSceneLoad(): void {
    const pending = this.pendingSceneFinish;
    if (this.stopped || !pending?.presented) return;
    for (const load of this.layerLoads.values()) {
      if (load.layer.ownerSceneGuid === pending.guid && !load.ready) return;
    }
    this.sceneLoadingProgress = 1;
    this.sceneWorkBlocked = false;
    this.pendingSceneFinish = null;
    this.flushOwnerActions();
    // Authored creation may immediately replace this Scene or stop Play.
    const owner = this.world.currentScene;
    if (!this.stopped && owner && this.sceneLoadId === pending.sceneLoadId) this.runOwnerAction(owner, () => {
      if (this.world.currentScene === owner && this.sceneLoadId === pending.sceneLoadId) this.world.finishSceneLoad(pending.name);
    });
  }

  notifySceneModelsReady(sceneAssetGuid: string, sceneLoadId: number): void {
    const pending = this.pendingSceneFinish;
    if (!pending) return;
    if (sceneAssetGuid !== pending.guid || sceneLoadId !== pending.sceneLoadId)
      return;
    pending.presented = true;
    this.tryCompleteSceneLoad();
  }

  configureSaveGame(options: RuntimeSaveGameOptions): SaveGameService {
    if (this.saveGameService) throw new SaveGameError("invalid", "Save Game is already configured for this session.");
    const state = new SaveGameWorld({
      world: this.world,
      sceneId: () => this.world.currentScene?.assetGuid ?? this.playSceneGuid,
      eligible: (actor) => !actor.sceneLayerId && !this.actorStream.has(actor),
      isSpawned: (actor) => this.savedActors.has(actor),
      classAssetGuid: (classId) => this.scriptHost.scriptsFor(classId)[0]?.assetGuid,
      resolveClass: (classId, assetGuid) => {
        if (!assetGuid) return this.scriptHost.scriptsFor(classId).length === 0 && this.world.classRegistry.get(classId) ? classId : null;
        const candidates = this.scriptHost.classIds().filter((id) => this.scriptHost.scriptsFor(id).some((script) => script.assetGuid === assetGuid));
        return candidates.length === 1 ? candidates[0]! : null;
      },
      prepare: (id, classId, spawned) => {
        if (!spawned) {
          const scene = this.playScene ?? this.sceneLibrary.get(this.world.currentScene?.assetGuid ?? this.playSceneGuid);
          const row = scene?.actors.find((actor) => actor.id === id && actor.classId === classId);
          const actor = row ? createActorFromSerialized(this.world, row, this.sceneActorHooks) : null;
          if (actor) this.scriptHost.bindInterfaceHandlers(actor);
          return actor;
        }
        if (!this.canSpawnActorClass(classId) || !this.scriptHost.hooksFor(classId)) return null;
        const actor = this.world.createActor({ guid: id, classId, hooks: this.sceneActorHooks(classId) });
        this.scriptHost.bindInterfaceHandlers(actor);
        const components = this.scriptHost.scriptsFor(classId).find((script) => script.components !== undefined)?.components;
        if (components) attachSerializedComponents(this.world, actor, components, { freshIds: true });
        this.savedActors.add(actor);
        return actor;
      },
      realize: (actor) => this.realizeActor(actor),
      remove: (actor) => this.removeOwnedActor(actor),
      synchronize: (actors) => {
        this.physicsSync.syncFromWorld(this.world);
        for (const actor of actors) this.physicsSync.teleportActor(actor, this.world);
        this.publishSnapshot();
      },
      reportError: (error) => { this.reportError(error); },
    });
    this.saveGameWorld = state;
    for (const actor of this.world.getActors()) state.register(actor, this.savedActors.has(actor));
    const service = new SaveGameService({
      ...options,
      atBoundary: async (operation) => {
        // Promise scheduling enters after the entire synchronous tick, including
        // World's deferred spawn/destroy flush, even when called by a Tick graph.
        await Promise.resolve();
        if (this.stopped) throw new SaveGameError("unavailable", "The game session has stopped.");
        if (this.sceneWorkBlocked || this.streamBlockingCount > 0 || (this.realization && !this.realization.finished)) {
          throw new SaveGameError("unavailable", "Wait for scene loading to finish before saving or loading.");
        }
        this.saveBoundaryActive = true;
        try { return await operation(); }
        finally {
          this.saveBoundaryActive = false;
          const loaded = this.pendingGameLoaded;
          this.pendingGameLoaded = null;
          const publishOverlays = this.saveOverlayLayoutPending;
          this.saveOverlayLayoutPending = false;
          if (!this.stopped) {
            // User callbacks run after commit. They cannot turn an applied
            // checkpoint into an apparent load failure.
            for (const notify of [publishOverlays ? () => this.publishSnapshot() : null, loaded, () => this.flushOwnerActions()]) {
              try { notify?.(); }
              catch (error) {
                try { this.reportError(error); } catch { /* The host may be disconnected. */ }
              }
            }
          }
        }
      },
      captureState: (data) => {
        state.validateDataReferences(data, options.definition);
        return state.capture();
      },
      stageState: (saved, data) => {
        const staged = state.stage(saved);
        state.validateDataReferences(data, options.definition, staged);
        return staged;
      },
      applyState: (staged) => state.apply(staged),
      resetState: () => state.reset(),
      onGameLoaded: (info) => {
        this.pendingGameLoaded = () => {
          const owners: Array<BObject | null> = [this.world.gameInstance, this.world.currentScene,
            ...this.world.getGameSubsystems(), ...this.world.getSceneSubsystems(),
            ...this.world.getActors().flatMap((actor) => [actor, ...actor.components])];
          for (const owner of owners) {
            if (owner && !owner.destroyed) this.runOwnerAction(owner, () => this.guardScript(() =>
              this.scriptHost.invokeEvent(owner.classId, "onGameLoaded", owner, { ...info })));
          }
        };
      },
    });
    this.saveGameService = service;
    this.scriptHost.setSaveGameService(service);
    return service;
  }

  getSaveGameService(): SaveGameService | undefined { return this.saveGameService; }

  registerSaveActor(actor: BObject, persistentId?: string): void {
    if (!this.saveGameWorld) throw new SaveGameError("unavailable", "Select a default Save Game definition in Project Settings.");
    if (!(actor instanceof Actor) || actor.world !== this.world || actor.destroyed) {
      throw new SaveGameError("invalid", "Register a live actor from this game session.");
    }
    this.saveGameWorld.register(actor, this.savedActors.has(actor), persistentId);
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
    for (const waiter of this.layerReadinessWaiters.values()) waiter.reject(sceneRealizationCancelled());
    this.layerReadinessWaiters.clear();
    this.stopped = true;
    this.diagnosticRecorder?.stop();
    this.materialEditGate?.cancel("The game session has stopped.");
    if (this.inspectorRequests.length) this.flushInspectorRequests();
    this.flushBoundaryRequests();
    this.pendingPauseChanges.clear();
    this.tweens.stop();
    this.focusNavigation.clearFocus();
    this.overlayLayout.clear();
    this.overlayVirtualization.clear();
    this.lifecycleId++;
    this.sceneChangeId++;
    this.pendingSceneSource?.abort(sceneRealizationCancelled());
    this.pendingSceneSource = undefined;
    this.running = false;
    for (const resume of this.simulationWaiters) resume();
    this.simulationWaiters.clear();
    for (const waiter of this.delayWaiters.splice(0)) waiter.resolve();
    for (const stream of [...this.sceneStreams.values()]) this.retireSceneStream(stream);
    for (const work of [...this.independentLayerWork.values()]) {
      work.controller.abort(sceneRealizationCancelled());
      // Finish live ownership cleanup before Stop returns; a later rejected
      // paint/yield continuation must not emit commands into a disposed host.
      if (this.world.findSceneLayer(work.layer.guid) === work.layer) this.removeSceneLayer(work.layer.guid);
    }
    this.independentLayerWork.clear();
    const retiring = this.cancelRealization();
    this.sceneLoadId++;
    this.pendingSceneFinish = null;
    this.finalizeTrace("session-ended");
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
    for (const source of retiring?.departure?.sources ?? []) source.release();
    this.activeSceneSource?.release();
    this.activeSceneSource = undefined;
    this.playScene = undefined;
    this.sceneLibrary.clear();
    this.pendingOwnerActions.clear();
    this.layerLoads.clear();
    this.ragdolls.dispose();
    this.cables.dispose();
    this.dynamicMeshes.dispose();
    this.movement.dispose();
    this.physicsSync.dispose();
    this.overlayPhysicsSync.dispose();
    this.clearNavAgents();
    this.nav?.dispose();
    this.nav = null;
    this.sceneNavmeshBytes.clear();
    if (this.showPathfinding || this.showNavAgent) {
      this.emit({ type: "debugNavigation", agents: [], world: this.physicsWorldKind });
    }
    if (this.behaviourTreeDebug) this.emit({ type: "behaviourTreeSnapshot", trees: [] });
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
    if (this.processingTick) { this.pendingPauseChanges.set(reason, paused); return; }
    const wasPaused = this.paused;
    if (paused) this.pauseReasons.add(reason); else this.pauseReasons.delete(reason);
    this.paused = this.pauseReasons.size > 0;
    if (this.paused === wasPaused) return;
    this.accumulator = 0;
    if (this.paused) { this.resetInputState(); return; }
    this.resetElapsed = true;
    this.flushOwnerActions();
    if (this.streamBlockingCount === 0) {
      const waiters = [...this.simulationWaiters];
      this.simulationWaiters.clear();
      for (const resume of waiters) resume();
    }
  }

  requestSessionBoundary(request: SessionBoundaryRequest): Promise<SessionBoundaryResult> {
    const invalid = request.sessionGeneration !== this.sessionGeneration ? "Stale session generation." :
      !Number.isSafeInteger(request.requestId) || request.requestId <= this.lastBoundaryRequestId ? "Invalid or superseded request ID." :
      request.action?.kind !== "resetInput" && (request.action?.kind !== "pause" ||
        !["user", "lifecycle", "loading"].includes(request.action.reason) || typeof request.action.paused !== "boolean") ? "Unsupported session boundary operation." :
      this.stopped ? "The game session has stopped." :
      this.boundaryRequests.length >= 64 ? "Session boundary queue is full." : null;
    if (invalid) return Promise.resolve(this.boundaryResult(request, invalid));
    this.lastBoundaryRequestId = request.requestId;
    // A microtask runs after the complete synchronous tick and its deferred
    // snapshot publication, including reentrant host requests from onCommand.
    const result = new Promise<SessionBoundaryResult>(resolve => {
      this.boundaryRequests.push({ request: { ...request, action: { ...request.action } }, resolve });
    });
    if (!this.boundaryScheduled) {
      this.boundaryScheduled = true;
      queueMicrotask(() => this.flushBoundaryRequests());
    }
    return result;
  }

  requestDiagnosticOperation(request: DiagnosticOperationRequest): Promise<DiagnosticOperationResult> {
    this.diagnosticRecorder ??= new RuntimeDiagnosticRecorder({ generation: this.sessionGeneration, mode: this.sessionMode,
      enabled: this.diagnosticsEnabled, traceActive: () => this.trace.isRecording, now: nowMs, emit: command => this.emit(command) });
    if (this.stopped) this.diagnosticRecorder.stop();
    return this.diagnosticRecorder.request(request);
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
      if (invalid) { resolve(this.boundaryResult(boundaryRequest, invalid)); return; }
      this.lastCaptureRequestId = request.requestId;
      this.setPauseReason("loading", true);
      this.materialEditGate?.cancel("Simulation is stopping; the pending material edit was cancelled.");
      this.simulationQuiescent = true;
      this.resetInputState();
      if (this.inspectorRequests.length) this.flushInspectorRequests();
      this.flushDeferredSnapshotWrite();
      resolve(this.boundaryResult(boundaryRequest));
    }));
  }

  captureSimulationState(request: SimulationCaptureRequest): Promise<SimulationSceneCaptureResult> {
    return new Promise(resolve => queueMicrotask(() => {
      const identity: SimulationCaptureIdentity = { generation: this.sessionGeneration, sceneAssetGuid: this.playSceneGuid,
        sceneInstanceId: this.world.currentScene?.guid ?? "", sceneLoadId: this.sceneLoadId,
        tickIndex: this.world.clock.tickIndex, commandRevision: this.commandRevision };
      const fail = (reason: string, code: "boundary" | "ownership" | "budget" | "resource" = "boundary") => resolve({ ok: false, code, path: "scene", reason, identity });
      if (request.sessionGeneration !== this.sessionGeneration || !Number.isSafeInteger(request.requestId) || request.requestId <= this.lastCaptureRequestId) { fail("Stale or superseded capture request."); return; }
      this.lastCaptureRequestId = request.requestId;
      if (this.stopped || !this.simulationQuiescent || !this.simulationBaseline || !this.simulationStart || this.sessionMode !== "simulate") { fail("A live Simulation must acknowledge its final quiescent boundary before capture."); return; }
      if (this.materialEditGate?.busy || this.materialEditGate?.ownershipFailure) { fail(this.materialEditGate.ownershipFailure ?? "A material edit is still pending.", "ownership"); return; }
      if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 64 * 1024 * 1024)) { fail("Invalid final scene capture budget.", "budget"); return; }
      try {
        const scene = this.world.currentScene;
        if (!scene || this.sceneWorkBlocked || this.bootLoading || this.streamBlockingCount > 0) { fail("Scene loading has not reached a complete final boundary."); return; }
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
          sceneSettings: { ...this.simulationBaseline.settings, gravity: [this.gravity[0], this.gravity[1], this.gravity[2]], postProcessStack },
          ownership: actor => actor.sceneLayerId ? "layer" : this.actorStream.has(actor) ? "stream" : "root",
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
    if (this.simulationQuiescent || this.stopped || this.saveBoundaryActive || actor.destroyed || actor.world !== this.world || this.world.findActorInstances(actor.guid).length !== 1 || this.streamBlockingCount > 0 || !this.streamActorReady(actor)) return false;
    return actor.sceneLayerId ? this.layerLoads.get(actor.sceneLayerId)?.ready === true : !this.sceneWorkBlocked && !this.bootLoading;
  }

  private getRuntimeInspector(): RuntimeInspector {
    return this.runtimeInspector ??= new RuntimeInspector({
      world: this.world, materials: this.materialParameters, sessionGeneration: this.sessionGeneration,
      canWrite: () => this.sessionMode === "simulate" && !this.simulationQuiescent, stopped: () => this.stopped,
      ready: actor => this.inspectorActorReady(actor),
      renderSlot: actor => this.slotByActor.get(actor),
      resolvePick: (guid, slot) => { const actor = this.slotOwners.get(slot); return actor && !actor.destroyed && actor.world === this.world && actor.guid === guid ? actor : null; },
      sceneIdentity: actor => {
        const stream = this.actorStream.get(actor);
        if (stream) return `stream:${stream.actor.guid}:${stream.loadId}`;
        if (actor.sceneLayerId) return `layer:${actor.sceneLayerId}:${this.layerLoads.get(actor.sceneLayerId)?.loadId ?? -1}`;
        return `scene:${this.playSceneGuid}:${this.sceneLoadId}:${this.world.currentScene?.guid ?? ""}`;
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
            this.ragdolls.retire(affectedActor);
            const sync = affectedActor.sceneLayerId ? this.overlayPhysicsSync : this.physicsSync;
            sync.teleportActor(affectedActor, this.world);
          }
        };
        target.transform = runtimeEditLocalTransform(this.world, target, transform, space);
        try { apply(); } catch (error) { target.transform = prior; apply(); throw error; }
        if (target instanceof ActorComponent) {
          const slotId = this.slotByActor.get(actor);
          if (slotId !== undefined) this.emitComponentTransforms(actor, slotId);
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
      slot: component => component.owner ? this.slotByActor.get(component.owner) : undefined,
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
        const actor = component.owner; const slot = actor ? this.slotByActor.get(actor) : undefined;
        if (slot === undefined) throw new Error("Material owner is unavailable.");
        this.emitMaterialAssignments([component], slot, true);
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
    const slotId = this.slotByActor.get(actor);
    if (slotId !== undefined) this.emit({ type: "resetActorInterpolation", actorGuid: actor.guid, slotId, frameId: this.frameId });
    this.publishSnapshot();
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

  private boundaryResult(request: SessionBoundaryRequest, reason?: string): SessionBoundaryResult {
    const pauseReasons = new Set(this.pauseReasons);
    if (this.streamBlockingCount > 0) pauseReasons.add("loading");
    return { sessionGeneration: request.sessionGeneration, requestId: request.requestId, success: !reason,
      ...(reason ? { reason } : {}), paused: pauseReasons.size > 0, pauseReasons: [...pauseReasons],
      tickIndex: this.world.clock.tickIndex, sceneAssetGuid: this.playSceneGuid,
      sceneLoadId: this.sceneLoadId, commandRevision: this.commandRevision };
  }

  private flushBoundaryRequests(): void {
    this.boundaryScheduled = false;
    for (const { request, resolve } of this.boundaryRequests.splice(0)) {
      if (this.stopped) { resolve(this.boundaryResult(request, "The game session has stopped.")); continue; }
      try {
        if (request.action.kind === "pause") this.setPauseReason(request.action.reason, request.action.paused);
        else this.resetInputState();
        resolve(this.boundaryResult(request));
      } catch (error) {
        resolve(this.boundaryResult(request, error instanceof Error ? error.message : "Session boundary operation failed."));
      }
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
    if (!this.running || this.paused || this.saveBoundaryActive || this.streamBlockingCount > 0 || this.processingTick) return;
    this.processingTick = true;
    const profiling = this.diagnosticRecorder?.recording === true;
    const profileStarted = profiling ? nowMs() : 0;
    const previousTick = profiling ? this.world.clock.tickIndex : 0;
    if (profiling) this.profileTickPublishMs = 0;
    try {
      this.runTick();
    } catch (error) {
      // Animation and other script phases also abort via the already-reported
      // loop sentinel; keep it inside the runtime boundary, like Actor ticks.
      if (!isInfiniteLoopError(error)) throw error;
    } finally {
      this.processingTick = false;
      if (profiling && this.world.clock.tickIndex > previousTick) this.diagnosticRecorder?.record(this.world.clock.tickIndex,
        nowMs() - profileStarted, this._lastScriptMs, this._lastPhysicsMs, this.profileTickPublishMs);
      if (this.pendingPauseChanges.size) {
        for (const [reason, paused] of this.pendingPauseChanges) this.setPauseReason(reason, paused);
        this.pendingPauseChanges.clear();
      }
    }
  }

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
    this.tickPrints = [];
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

    this.phaseScriptMs = 0;
    this.phasePhysicsMs = 0;
    this.currentTimingPhase = null;
    this.phaseMark = nowMs();

    this.loopGuard.reset();
    this.tweens.advance(simDt);
    this.textAppear.advance(this.world.getActors(), simDt, (actor) => this.canTickActor(actor));
    this.painters.beginFrame(this.world.getActors(), (actor) => this.canTickActor(actor));
    try {
      this.focusNavigation.tick(pending, this.resolvedInput, simDt);
      this.world.tick();
      // World committed actors queued by this tick; deliver their deferred
      // notifications after actor and component creation hooks have completed.
      this.flushOwnerActions();
      if (this.canTickScene()) {
        for (const stream of this.sceneStreams.values()) {
          if (!this.canTickScene()) break;
          if (this.sceneStreamReady(stream)) this.scriptHost.hooksFor(stream.scene.classId)?.onTick?.(stream.scene, {
            dt: simDt, tickIndex: this.world.clock.tickIndex, world: this.world,
          });
        }
      }
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
    if (this.stopped) return;
    this.tweens.cancelInvalid();
    this.advanceDelays();
    if (this.canTickScene() || this.hasReadyLayers()) this.tickAnimGraphs();
    if (this.canTickScene() || this.hasReadyLayers()) {
      this.tilemapAnimationTimeMs += simDt * 1000;
      if (this.hasAnimatedTiles) this.emit({ type: "tilemapAnimationTime", elapsedMs: this.tilemapAnimationTimeMs });
      // Only behaviour trees and the crowd read the frame index.
      this.navFrameActors = this.nav || this.behaviourTrees.size > 0 ? firstSpawnedActorIndex(this.world.getActors()) : null;
      try {
        this.tickBehaviourTrees();
        if (this.nav && this.canTickScene()) this.tickCrowd(this.navFrameActors ?? firstSpawnedActorIndex(this.world.getActors()));
      } finally {
        this.navFrameActors = null;
      }
    }
    this.closePhaseTiming();

    this._lastScriptMs = this.phaseScriptMs;
    this._lastPhysicsMs = this.phasePhysicsMs;

    this.flushPainters();
    this.flushTextAppear();
    this.flushDeformers();
    const completedFrameId = this.frameId;
    this.frameId += 1;
    if (this.canTickScene() || this.hasReadyLayers()) {
      if (this.deferSnapshotWrites) this.deferSnapshotWrite();
      else this.publishSnapshot();
      this.emitDebugColliders();
      this.emitNavigationDebug();
      this.emitBehaviourTreeSnapshot();
    }
    const statsNow = nowMs();
    if (shouldEmitStatsCommand(statsNow, this.lastStatsEmitMs)) {
      this.lastStatsEmitMs = statsNow;
      this.emit({
        type: "stats",
        frameId: this.frameId,
        tickIndex: this.world.clock.tickIndex,
        scriptMs: this._lastScriptMs,
        physicsMs: this._lastPhysicsMs,
        publishMs: this._lastPublishMs,
        liveActors: this.slotByGuid.size,
        snapshotCapacity: this.snapshots.maxActors,
      });
    }
    if (this.trace.isRecording) {
      const recordedTick = this.world.clock.tickIndex;
      this.trace.recordFrame({
        tickIndex: recordedTick,
        scriptMs: this._lastScriptMs,
        physicsMs: this._lastPhysicsMs,
        logs: this.logs
          .entries()
          .filter((entry) => entry.frameId === completedFrameId)
          .map((entry) => ({
            severity: entry.severity,
            category: entry.category,
            message: entry.message,
          })),
        prints: [...this.tickPrints],
        snapshotText: stringifyWorldSnapshot({
          ...createWorldSnapshot(this.world),
          dt: this.dt,
        }),
        inputEvents: pending.map((event) => {
          if (event.kind === "key") {
            return {
              type: "key",
              code: event.code,
              down: event.phase === "down",
              tick: event.tick,
            };
          }
          return { type: event.kind, tick: event.tick };
        }),
        bt: [...this.btEvalBySlot.entries()].map(([slotId, state]) => ({
          slotId,
          status: state.status,
          btNodeId: state.btNodeId,
          lastResults: { ...state.lastResults },
          blackboard: snapshotBlackboard(state.blackboard),
          stack: state.stack.map((frame) => ({ ...frame })),
          nodeMemory: Object.fromEntries(
            Object.entries(state.nodeMemory).map(([id, memory]) => [
              id,
              { ...memory },
            ]),
          ),
        })),
      });
      if (!this.trace.isRecording) this.finalizeTrace();
    }
  }

  advance(elapsedSeconds: number): void {
    if (!this.running || this.paused || this.streamBlockingCount > 0) return;
    if (this.resetElapsed) { this.resetElapsed = false; elapsedSeconds = 0; }
    this.accumulator += Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
    let steps = 0;
    // Hosts copy the snapshot once after advance(), so catch-up ticks keep their
    // overlay layout and removal pass but compose and write only the burst's
    // final frame. Any tick may pause or block the session; the flush below still runs.
    const outermost = !this.deferSnapshotWrites;
    this.deferSnapshotWrites = true;
    try {
      while (!this.paused && !this.stopped && this.accumulator >= this.dt && steps < this.maxCatchUp) {
        this.tick();
        this.accumulator = Math.max(0, this.accumulator - this.dt);
        steps += 1;
      }
    } finally {
      if (outermost) this.deferSnapshotWrites = false;
    }
    if (outermost) this.flushDeferredSnapshotWrite();
    if (steps === this.maxCatchUp) {
      this.accumulator = 0;
    }
  }

  copySnapshot(out: Float32Array): boolean {
    if (this.stopped || (this.sceneWorkBlocked && !this.realization?.finished &&
      ![...this.layerLoads.values()].some((load) => load.realized))) return false;
    if (out.length < this.snapshots.floatCount) return false;
    return this.snapshots.tryRead(out);
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
      assetGuid: hint?.assetGuid ?? this.currentBtAssetGuid ?? location?.assetGuid ?? anchor?.assetGuid,
      graphId: location?.graphId ?? anchor?.graphId,
      nodeId: hint?.btNodeId ? undefined : location?.nodeId ?? anchor?.nodeId,
      bodyLine: anchor?.bodyLine,
      btNodeId: hint?.btNodeId ?? this.currentBtNodeId ?? anchor?.btNodeId,
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

  private advanceDelays(): void {
    if (this.delayWaiters.length === 0) return;
    const remaining: typeof this.delayWaiters = [];
    const due: Array<() => void> = [];
    for (const waiter of this.delayWaiters) {
      if (waiter.owner?.destroyed) continue;
      // A SceneSubsystem's time runs with its Scene, not with its call admission.
      if (waiter.owner && !this.canRunOwnerActions(waiter.owner)) {
        remaining.push(waiter);
        continue;
      }
      waiter.remaining -= this.simulationDt();
      if (waiter.remaining <= 0) due.push(waiter.resolve);
      else remaining.push(waiter);
    }
    this.delayWaiters.length = 0;
    this.delayWaiters.push(...remaining);
    for (const resolve of due) resolve();
  }

  private snapshotOrigin = { x: 0, y: 0, z: 0 };
  private snapshotOriginGeneration = 0;

  /** Publish now; a newer complete frame supersedes any write deferred by `advance()`. */
  private publishSnapshot(): void {
    const start = nowMs();
    this.snapshotWritePending = false;
    this.pendingPublishMs = 0;
    this.runPublishPrelude();
    this.writeSnapshot(this.frameId, this.world.clock.tickIndex, this._lastScriptMs, this._lastPhysicsMs);
    this._lastPublishMs = nowMs() - start;
    if (this.diagnosticRecorder?.recording) this.profileTickPublishMs += this._lastPublishMs;
  }

  /** Per-tick part of a deferred publish: overlay layout, removals and their commands happen in this tick. */
  private deferSnapshotWrite(): void {
    const start = nowMs();
    this.runPublishPrelude();
    const header = this.pendingSnapshotHeader;
    header.frameId = this.frameId;
    header.tickIndex = this.world.clock.tickIndex;
    header.scriptMs = this._lastScriptMs;
    header.physicsMs = this._lastPhysicsMs;
    this.snapshotWritePending = true;
    const publishMs = nowMs() - start;
    this.pendingPublishMs += publishMs;
    if (this.diagnosticRecorder?.recording) this.profileTickPublishMs += publishMs;
  }

  /**
   * Write the frame deferred by the last publishing tick of a burst, with that
   * tick's header. Later ticks that no-op (pause, blocking stream) leave it as is.
   */
  private flushDeferredSnapshotWrite(): void {
    if (!this.snapshotWritePending) return;
    this.snapshotWritePending = false;
    const spent = this.pendingPublishMs;
    this.pendingPublishMs = 0;
    if (this.stopped) return;
    const start = nowMs();
    // A later tick stopped before its publish point (blocking load, scene change)
    // leaves its removals to the next publish, as per-tick writes did; the write
    // below already omits actors that left the World. Its scripts may have moved
    // layout-managed overlay actors, so lay them out first, as every write does.
    // Otherwise the last publishing tick laid them out and nothing ran after it.
    if (this.canTickScene() || this.hasReadyLayers()) this.retireRemovedSnapshotActors();
    else this.applyOverlayLayouts();
    const header = this.pendingSnapshotHeader;
    this.writeSnapshot(header.frameId, header.tickIndex, header.scriptMs, header.physicsMs);
    const publishMs = nowMs() - start;
    this._lastPublishMs = spent + publishMs;
    this.diagnosticRecorder?.addPublishCost(header.tickIndex, publishMs);
  }

  /**
   * Publish work every publishing tick runs before its write. Overlay layout
   * moves SceneLayer actors that the next tick's focus navigation and scripts
   * read, so it stays per tick like removals.
   */
  private runPublishPrelude(): void {
    this.applyOverlayLayouts();
    this.retireRemovedSnapshotActors();
  }

  /** Retire detached streams, then despawn and release slots of actors no longer in the World. */
  private retireRemovedSnapshotActors(): void {
    for (const stream of this.sceneStreams.values()) {
      if (!this.sceneStreamDetached(stream)) continue;
      // Retirement can reenter and change the table; retire from a stable copy.
      for (const candidate of [...this.sceneStreams.values()]) {
        if (this.sceneStreamDetached(candidate)) this.retireSceneStream(candidate);
      }
      break;
    }
    let removedActors = false;
    for (const [actorGuid, slotId] of this.slotByGuid) {
      // The World's guid index answers "any live actor has this guid".
      if (this.world.findActor(actorGuid)) continue;
      this.emit({ type: "despawn", slotId, actorGuid });
      this.releaseSlot(actorGuid, slotId);
      removedActors = true;
    }
    if (removedActors) this.emitBehaviourTreeSnapshot(true);
  }

  private sceneStreamDetached(stream: SceneStream): boolean {
    return stream.actor.destroyed || stream.actor.world !== this.world;
  }

  private writeSnapshot(frameId: number, tickIndex: number, scriptMs: number, physicsMs: number): void {
    const actors = this.world.getActors();
    const buf = this.snapshots.beginWrite();
    const findActor = (guid: string) => this.world.findActor(guid);
    const worldTransforms = composeActorWorldTransforms(findActor, actors);
    const cameraActor = this.playCameraActor();
    const cameraPosition = cameraActor ? worldTransforms.get(cameraActor.guid)?.position : undefined;
    if (cameraPosition) {
      const next = { x: Math.floor(cameraPosition.x / 1024) * 1024, y: Math.floor(cameraPosition.y / 1024) * 1024, z: Math.floor(cameraPosition.z / 1024) * 1024 };
      if (next.x !== this.snapshotOrigin.x || next.y !== this.snapshotOrigin.y || next.z !== this.snapshotOrigin.z) { this.snapshotOrigin = next; this.snapshotOriginGeneration++; }
    }
    let count = 0;
    for (const actor of actors) {
      // Layout-only anchors must not create fallback visuals from pose snapshots.
      if (isSceneLayerAnchorActor(actor)) continue;
      // Only a guid's first-spawned live actor (the one parents, physics and
      // the crowd resolve) writes its own slot; later duplicates' slots get no
      // entry, although `slotByGuid` holds the latest-assigned one.
      if (findActor(actor.guid) !== actor) continue;
      const slotId = this.slotByActor.get(actor);
      if (slotId === undefined) continue;
      const world = worldTransforms.get(actor.guid);
      if (!world) continue;
      writeActorSlot(buf, count, {
        slotId,
        position: world.position,
        rotation: world.rotation,
        scale: world.scale,
        flags:
          (actor.getVariable("visible") === false
            ? 0
            : SNAPSHOT_FLAG_VISIBLE) |
          (actor.sceneLayerId ? SNAPSHOT_FLAG_OVERLAY : 0),
      }, this.snapshotOrigin);
      count += 1;
    }
    writeSnapshotHeader(buf, {
      frameId,
      tickIndex,
      actorCount: count,
      scriptMs,
      physicsMs,
      layoutGeneration: this._snapshotGeneration,
      origin: this.snapshotOrigin,
      originGeneration: this.snapshotOriginGeneration,
    });
    this.snapshots.publish();
  }

  private emit(command: CommandMessage): void {
    if (this.sessionMode === "simulate" && (command.type === "spawn" || command.type === "assignMesh")) {
      const actor = this.slotOwners.get(command.slotId);
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

const OVERLAY_BUTTON_VISUAL_CLASS_IDS = new Set([
  "2DPainterComponent",
  "2DJoystickComponent",
  "2DTextureComponent",
  "2DMaterialComponent",
  "2DPanelComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "SpriteComponent",
  "MeshComponent",
]);

function overlayButtonHasSiblingVisual(actor: Actor): boolean {
  return overlayActorHasVisual(actor);
}

function overlayActorHasVisual(actor: Actor): boolean {
  return actor.components.some(
    (component) =>
      !component.destroyed && (OVERLAY_BUTTON_VISUAL_CLASS_IDS.has(component.classId) || isUIControl2DClass(component.classId)),
  );
}

function overlayButtonHasParentVisual(actor: Actor, world: World): boolean {
  const parentId = actorParentGuid(actor);
  if (!parentId) return false;
  const parent = world.findActor(parentId);
  return parent ? overlayActorHasVisual(parent) : false;
}

function liveOverlayButtons(actor: Actor): ActorComponent[] {
  return actor.components.filter(
    (component) =>
      component.classId === "2DButtonComponent" && !component.destroyed,
  );
}

function overlayMeshInteraction(
  actor: Actor,
  world: World,
): {
  hitTest: "ignore" | "block" | "passThrough";
  hasButton: boolean;
  buttonComponentId?: string;
} {
  const buttons = liveOverlayButtons(actor);
  // Own buttons take precedence. Share one child scan across all metadata.
  if (buttons.length === 0) {
    for (const child of world.getActors()) {
      if (actorParentGuid(child) === actor.guid) {
        buttons.push(...liveOverlayButtons(child));
      }
    }
  }
  return {
    hitTest: overlayHitTestOf(actor, buttons[0]),
    hasButton: buttons.length > 0,
    ...(buttons.length === 1 ? { buttonComponentId: buttons[0]!.guid } : {}),
  };
}

function findOverlayButton(
  buttons: readonly ActorComponent[],
  requested: string,
): ActorComponent | undefined {
  return buttons.find(
    (component) =>
      component.guid === requested || component.sourceId === requested,
  );
}

function resolveOverlayPointerButton(
  world: World,
  actor: Actor,
  requested: string,
): { owner: Actor; button: ActorComponent | undefined } | null {
  const own = liveOverlayButtons(actor);
  if (own.length > 0) {
    const button = requested
      ? findOverlayButton(own, requested)
      : own.length === 1
        ? own[0]
        : undefined;
    if (requested && !button) return null;
    return { owner: actor, button };
  }
  const children = world
    .getActors()
    .filter((child) => actorParentGuid(child) === actor.guid);
  if (requested) {
    for (const child of children) {
      const button = findOverlayButton(liveOverlayButtons(child), requested);
      if (button) return { owner: child, button };
    }
    return null;
  }
  const withButtons = children.filter(
    (child) => liveOverlayButtons(child).length > 0,
  );
  if (withButtons.length === 0) return null;
  const owner = withButtons[0]!;
  const buttons = liveOverlayButtons(owner);
  return {
    owner,
    button: buttons.length === 1 ? buttons[0] : undefined,
  };
}

function overlayPanelVariables(component: ActorComponent): Record<string, unknown> {
  return {
    source: component.getVariable("source"),
    textureGuid: component.getVariable("textureGuid"),
    materialGuid: component.getVariable("materialGuid"),
    marginLeft: component.getVariable("marginLeft"),
    marginRight: component.getVariable("marginRight"),
    marginTop: component.getVariable("marginTop"),
    marginBottom: component.getVariable("marginBottom"),
    hitTest: component.getVariable("hitTest"),
  };
}

function isPlayRenderable(
  component: ActorComponent,
  skipButtonMesh: boolean,
): boolean {
  if (component.destroyed || component.getVariable("editorOnly") === true) return false;
  if (isUIControl2DClass(component.classId)) return !!component.owner?.sceneLayerId;
  if (isOverlayLayoutClass(component.classId)) return true;
  if (component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent" || component.classId === "CameraComponent" || component.classId === SPRING_ARM_COMPONENT_CLASS_ID) return true;
  if (waterKindForClass(component.classId) || component.classId === "WaterRemovalVolumeComponent") return true;
  if (component.classId === "2DButtonComponent") return !skipButtonMesh;
  if (
    component.classId === "LandscapeComponent" ||
    component.classId === "FoliageComponent" ||
    component.classId === "CableComponent" ||
    component.classId === "DynamicRuntimeMeshComponent" ||
    component.classId === "MeshComponent" ||
    component.classId === "SpriteComponent" ||
    component.classId === "TilemapComponent" ||
    component.classId === "SkyboxComponent" ||
    component.classId === "Text3DComponent" ||
    component.classId === "2DJoystickComponent" ||
    component.classId === "2DTextureComponent" ||
    component.classId === "2DMaterialComponent" ||
    component.classId === "2DPanelComponent" ||
    component.classId === "2DPainterComponent" ||
    component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
  ) {
    return true;
  }
  return (
    component.classId === "ColliderComponent" &&
    component.getVariable("renderInGame") === true
  );
}

/** Components that contribute visuals, illumination or camera poses to Play. */
function playRenderablesOf(
  components: readonly ActorComponent[],
  skipButtonMesh: boolean,
): ActorComponent[] {
  return components.filter(component => isPlayRenderable(component, skipButtonMesh));
}

function overlayHitTestOf(
  actor: Actor,
  button: ActorComponent | undefined,
): "ignore" | "block" | "passThrough" {
  if (button) {
    return parseSceneLayerHitTest(button.getVariable("hitTest"), "block");
  }
  if (actor.components.some(component => component.classId === "2DJoystickComponent" && !component.destroyed && component.getVariable("enabled") !== false)) return "block";
  if (actor.components.some(component => isInteractiveUIControl2DClass(component.classId) && !component.destroyed && component.getVariable("enabled") !== false)) return "block";
  const visual = actor.components.find(
    (component) =>
      (component.classId === "2DTextureComponent" ||
        component.classId === "2DMaterialComponent" ||
        component.classId === "2DPanelComponent" ||
        component.classId === "2DPainterComponent" ||
        component.classId === "2DTextComponent" ||
        component.classId === "2DRichTextComponent") &&
      !component.destroyed,
  );
  if (visual) {
    return parseSceneLayerHitTest(visual.getVariable("hitTest"), "ignore");
  }
  return "ignore";
}

function playSortingOf(component: ActorComponent): {
  sortingLayer: string;
  orderInLayer: number;
} {
  const layer = component.getVariable("sortingLayer");
  const order = component.getVariable("orderInLayer");
  return {
    sortingLayer:
      typeof layer === "string" && layer.trim() !== "" ? layer : "Default",
    orderInLayer:
      typeof order === "number" && Number.isFinite(order) ? Math.round(order) : 0,
  };
}

function playMeshKindOf(component: ActorComponent): string | null {
  if (isUIControl2DClass(component.classId)) return "2dcontrol";
  if (isOverlayLayoutClass(component.classId)) return "2dlayout";
  if (component.classId === "CableComponent") return "cable";
  if (component.classId === "DynamicRuntimeMeshComponent") return "dynamicRuntimeMesh";
  if (waterKindForClass(component.classId)) return "water";
  if (component.classId === "WaterRemovalVolumeComponent") return "waterRemoval";
  if (component.classId === "LandscapeComponent") return "landscape";
  if (component.classId === "FoliageComponent") return "foliage";
  if (component.classId === "SpriteComponent") return "sprite";
  if (component.classId === "TilemapComponent") return "tilemap";
  if (component.classId === "SkyboxComponent") return "skybox";
  if (component.classId === "Text3DComponent") return "text3d";
  if (component.classId === "2DTextComponent") return "2dtext";
  if (component.classId === "2DRichTextComponent") return "2drichtext";
  if (component.classId === "2DJoystickComponent") return "2djoystick";
  if (component.classId === "2DTextureComponent") return "2dtexture";
  if (component.classId === "2DMaterialComponent") return "2dmaterial";
  if (component.classId === "2DPanelComponent") return "2dpanel";
  if (component.classId === "2DPainterComponent") return "2dpainter";
  if (component.classId === "2DButtonComponent") return "2dbutton";
  if (component.classId === "ColliderComponent") {
    const shape = component.getVariable("shape");
    return `collider:${JSON.stringify(shape ?? {})}`;
  }
  if (component.classId === "HemisphericFillLightComponent") {
    return "light:hemispheric";
  }
  if (component.classId === "LightComponent") {
    const kind = component.getVariable("lightKind");
    return `light:${typeof kind === "string" ? kind : "point"}`;
  }
  if (component.classId === "CameraComponent") return "camera";
  if (component.classId === "RenderTargetCaptureComponent") return "renderTargetCapture";
  if (component.classId === SPRING_ARM_COMPONENT_CLASS_ID) return "springarm";
  if (component.classId === "AudioComponent") return "audio";
  if (component.classId === "ParticleComponent") return "particle";
  if (component.classId === "RigidBodyComponent") return "rigidbody";
  const meshKind = component.getVariable("meshKind");
  return typeof meshKind === "string" ? meshKind : null;
}

function isIdentityComponentTransform(component: ActorComponent): boolean {
  const { position, rotation, scale } = component.transform;
  return (
    position.x === 0 &&
    position.y === 0 &&
    position.z === 0 &&
    rotation.x === 0 &&
    rotation.y === 0 &&
    rotation.z === 0 &&
    rotation.w === 1 &&
    scale.x === 1 &&
    scale.y === 1 &&
    scale.z === 1
  );
}

function playPartsNeeded(components: readonly ActorComponent[]): boolean {
  return (
    components.some((component) => isUIControl2DClass(component.classId)) ||
    components.some((component) => isOverlayLayoutClass(component.classId) || component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent" || component.classId === "CameraComponent") ||
    components.some((component) => component.classId === "2DJoystickComponent") ||
    components.some((component) => component.classId === "2DPainterComponent") ||
    components.some((component) => component.classId === "CableComponent") ||
    components.some((component) => component.classId === "DynamicRuntimeMeshComponent") ||
    components.some((component) => waterKindForClass(component.classId) !== null || component.classId === "WaterRemovalVolumeComponent") ||
    components.length > 1 ||
    components.some((component) => component.classId === "LandscapeComponent" || component.classId === "FoliageComponent") ||
    components.some((component) => !isIdentityComponentTransform(component))
  );
}

function text3dAssignPayload(
  component: ActorComponent,
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["text3d"]> {
  return parseText3DProperties({
    text: component.getVariable("text"),
    size: component.getVariable("size"),
    depth: component.getVariable("depth"),
    color: component.getVariable("color"),
    fontAssetGuid: component.getVariable("fontAssetGuid"),
    alignment: component.getVariable("alignment"),
  });
}

function text2dAssignPayload(
  component: ActorComponent,
  appearProgress = 1,
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["text2d"]> {
  const parsed = parseText2DProperties(
    {
      text: component.getVariable("text"),
      materialGuid: component.getVariable("materialGuid"),
      materialUv: component.getVariable("materialUv"),
      fontAssetGuid:
        component.getVariable("fontAssetGuid") ?? component.assetGuid,
      size: component.getVariable("size"),
      color: component.getVariable("color"),
      renderer: component.getVariable("renderer"),
      outline: component.getVariable("outline"),
      outlineColor: component.getVariable("outlineColor"),
      alignment: component.getVariable("alignment"),
      verticalAlignment: component.getVariable("verticalAlignment"),
      bold: component.getVariable("bold"),
      italic: component.getVariable("italic"),
      underline: component.getVariable("underline"),
      wrapWidth: component.getVariable("wrapWidth"),
      wrapHeight: component.getVariable("wrapHeight"),
      appearModes: component.getVariable("appearModes"),
      appearTransition: component.getVariable("appearTransition"),
      appearInterval: component.getVariable("appearInterval"),
      appearDuration: component.getVariable("appearDuration"),
      appearStart: component.getVariable("appearStart"),
    },
    { rich: component.classId === "2DRichTextComponent" },
  );
  return {
    text: parsed.text,
    materialGuid: parsed.materialGuid,
    materialUv: parsed.materialUv,
    fontAssetGuid: parsed.fontAssetGuid,
    size: parsed.size,
    color: parsed.color,
    renderer: parsed.renderer,
    outline: parsed.outline,
    outlineColor: parsed.outlineColor,
    alignment: parsed.alignment,
    verticalAlignment: parsed.verticalAlignment,
    bold: parsed.bold,
    italic: parsed.italic,
    underline: parsed.underline,
    wrapWidth: parsed.wrapWidth,
    wrapHeight: parsed.wrapHeight,
    appearModes: parsed.appearModes,
    appearTransition: parsed.appearTransition,
    appearInterval: parsed.appearInterval,
    appearDuration: parsed.appearDuration,
    appearStart: parsed.appearStart,
    appearProgress,
  };
}

function lightAssignPayload(component: ActorComponent): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["light"]> {
  const fill = component.classId === "HemisphericFillLightComponent";
  const ground = component.getVariable("groundColor");
  return {
    color: rgbTuple(component.getVariable("color")),
    intensity: Number(component.getVariable("intensity") ?? (fill ? 0.9 : 1)),
    enabled: component.getVariable("enabled") !== false,
    ...(fill ? { groundColor: ground == null ? [0, 0, 0] as [number, number, number] : rgbTuple(ground) } : {
      range: Number(component.getVariable("range") ?? 10),
      innerAngle: Number(component.getVariable("innerAngle") ?? 30),
      outerAngle: Number(component.getVariable("outerAngle") ?? 45),
      castShadows: component.getVariable("castShadows") === true,
      shadowPriority: Number(component.getVariable("shadowPriority") ?? 0),
    }),
  };
}

function playMeshPartOf(
  component: ActorComponent,
  parentId = component.parentId,
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["parts"]>[number] {
  const assetGuid = component.assetGuid ?? component.getVariable("assetGuid");
  const { position, rotation, scale } = component.transform;
  return {
    componentId: component.guid,
    ...(component.classId === "LandscapeComponent" ? { landscape: parseLandscapeProperties(Object.fromEntries(
      ["width", "depth", "subdivisions", "heights", "weights", "materialGuid", "collisionsEnabled"].map((key) => [key, component.getVariable(key)]),
    )) } : {}),
    ...(component.classId === "FoliageComponent" ? { foliage: parseFoliageProperties({ groupId: component.getVariable("groupId"), batches: component.getVariable("batches") }) } : {}),
    castShadows: component.getVariable("castShadows") !== false,
    receiveShadows: component.getVariable("receiveShadows") !== false,
    meshKind: playMeshKindOf(component),
    meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
    parentId,
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
    ...(waterKindForClass(component.classId) ? { water: normalizeWaterBody(Object.fromEntries(component.variables), waterKindForClass(component.classId)!) } : {}),
    ...(component.classId === "WaterRemovalVolumeComponent" ? { waterRemoval: normalizeWaterRemoval(Object.fromEntries(component.variables)) } : {}),
    ...(component.classId === "Text3DComponent"
      ? {
          text3d: text3dAssignPayload(component),
        }
      : {}),
    ...(component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
      ? { text2d: text2dAssignPayload(component) }
      : {}),
    ...(component.classId === "SpriteComponent" ||
    component.classId === "TilemapComponent"
      ? playSortingOf(component)
      : {}),
    ...(component.classId === SPRING_ARM_COMPONENT_CLASS_ID
      ? { springArm: springArmAssignPayload(component) }
      : {}),
  };
}

function springArmAssignPayload(
  component: ActorComponent,
): ReturnType<typeof parseSpringArmProperties> {
  return parseSpringArmProperties({
    armLength: component.getVariable("armLength"),
    enableLocationLag: component.getVariable("enableLocationLag"),
    locationLagSpeed: component.getVariable("locationLagSpeed"),
    maxLocationLagDistance: component.getVariable("maxLocationLagDistance"),
    enableRotationLag: component.getVariable("enableRotationLag"),
    rotationLagSpeed: component.getVariable("rotationLagSpeed"),
    drawDebugLag: component.getVariable("drawDebugLag"),
  });
}

function dynamicMeshParentTransforms(component: ActorComponent, components: ReadonlyMap<string, ActorComponent>, renderableIds: ReadonlySet<string>): Transform[] {
  const transforms: Transform[] = [];
  const visited = new Set<string>([component.guid]);
  let parentId = component.parentId;
  while (parentId && !visited.has(parentId) && !renderableIds.has(parentId)) {
    visited.add(parentId);
    const parent = components.get(parentId);
    if (!parent || parent.destroyed) break;
    transforms.push({ position: { ...parent.transform.position }, rotation: { ...parent.transform.rotation }, scale: { ...parent.transform.scale } });
    parentId = parent.parentId;
  }
  return transforms;
}

function nearestVisualParentId(
  component: ActorComponent,
  componentsByGuid: ReadonlyMap<string, ActorComponent>,
  renderableIds: ReadonlySet<string>,
): string | null {
  const visited = new Set<string>();
  let parentId = component.parentId;
  while (parentId && !visited.has(parentId)) {
    if (renderableIds.has(parentId)) return parentId;
    visited.add(parentId);
    parentId = componentsByGuid.get(parentId)?.parentId ?? null;
  }
  return null;
}

function rgbTuple(value: unknown): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    return [
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
    ];
  }
  if (value && typeof value === "object") {
    const row = value as { x?: unknown; y?: unknown; z?: unknown };
    if (typeof row.x === "number") {
      return [
        row.x,
        typeof row.y === "number" ? row.y : 0,
        typeof row.z === "number" ? row.z : 0,
      ];
    }
  }
  return [1, 1, 1];
}

function coerceTransform(value: unknown): Transform | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as {
    position?: { x?: unknown; y?: unknown; z?: unknown };
    rotation?: { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
    scale?: { x?: unknown; y?: unknown; z?: unknown };
  };
  if (!row.position && !row.rotation && !row.scale) return undefined;
  const position = row.position ?? {};
  const rotation = row.rotation ?? {};
  const scale = row.scale ?? {};
  return {
    position: {
      x: typeof position.x === "number" && Number.isFinite(position.x) ? position.x : 0,
      y: typeof position.y === "number" && Number.isFinite(position.y) ? position.y : 0,
      z: typeof position.z === "number" && Number.isFinite(position.z) ? position.z : 0,
    },
    rotation: {
      x: typeof rotation.x === "number" && Number.isFinite(rotation.x) ? rotation.x : 0,
      y: typeof rotation.y === "number" && Number.isFinite(rotation.y) ? rotation.y : 0,
      z: typeof rotation.z === "number" && Number.isFinite(rotation.z) ? rotation.z : 0,
      w: typeof rotation.w === "number" && Number.isFinite(rotation.w) ? rotation.w : 1,
    },
    scale: {
      x: typeof scale.x === "number" && Number.isFinite(scale.x) ? scale.x : 1,
      y: typeof scale.y === "number" && Number.isFinite(scale.y) ? scale.y : 1,
      z: typeof scale.z === "number" && Number.isFinite(scale.z) ? scale.z : 1,
    },
  };
}

function actorFromIlluminationTarget(target: unknown): Actor | null {
  if (!target || typeof target !== "object") return null;
  if (target instanceof Actor) return target;
  if (target instanceof ActorComponent) return target.owner;
  return null;
}

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

function navPointFromUnknown(value: unknown): NavPoint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof row.x !== "number" || !Number.isFinite(row.x)) return null;
  return {
    x: row.x,
    y: typeof row.y === "number" && Number.isFinite(row.y) ? row.y : 0,
    z: typeof row.z === "number" && Number.isFinite(row.z) ? row.z : 0,
  };
}

function* remapOverlaySerializedActors(
  actors: readonly SerializedActor[],
  layerId: string,
  isTaken: (id: string) => boolean,
): Generator<void, SerializedActor[], unknown> {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const actor of actors) {
    let id = actor.id;
    if (isTaken(id) || used.has(id)) {
      id = `${layerId}:${actor.id}`;
    }
    idMap.set(actor.id, id);
    used.add(id);
    yield;
  }
  const remapped: SerializedActor[] = [];
  for (const actor of actors) {
    remapped.push({
    ...actor,
    id: idMap.get(actor.id) ?? actor.id,
    parentId: actor.parentId
      ? (idMap.get(actor.parentId) ?? actor.parentId)
      : null,
    components: actor.components.map((component) => ({
      ...component,
      properties: Object.fromEntries(Object.entries(component.properties).map(([key, value]) => [
        key,
        ["focusUp", "focusDown", "focusLeft", "focusRight"].includes(key) && typeof value === "string"
          ? idMap.get(value) ?? value : value,
      ])),
    })),
    });
    yield;
  }
  return remapped;
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
import { parseLandscapeProperties, parseFoliageProperties } from "@babylonslate/core";
