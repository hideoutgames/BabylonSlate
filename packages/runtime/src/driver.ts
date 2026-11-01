import type { SimulationSceneCaptureResult } from "./simulation-scene-capture";
import type { SimulationSession } from "./simulation-session";
import type { RuntimeInspectorService } from "./runtime-inspector-service";
import { RuntimeDataCatalog } from "./data-catalog";
import type { CurveAssetCatalogEntry, SaveGameService } from "@haptic/core";
import type { SessionBoundaries, RuntimeSaveGameOptions } from "./session-boundaries";
import { RuntimeMaterialParameters } from "./runtime-material-parameters";
import { RuntimeAssetPreloads } from "./asset-preloads";
import type { RuntimeAssetLoadState } from "@haptic/core";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import type { CableWorldSync } from "./cable-sync";
import type { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import type { MovementWorldSync } from "./movement";
import type { RenderTargetPayload, RenderTargetTexturePayload } from "@haptic/core";
import type { WaterDefinition } from "@haptic/core";
import type { ScalabilitySession, ScalabilityRequest, ScalabilityResult, ScalabilitySnapshot, ScalabilityAcknowledgement } from "@haptic/core";
import type { CollisionTriangleMesh } from "@haptic/core";
import { inputMappingsFromAssets } from "@haptic/input";
import type {
  CommandMessage,
  ControlMessage,
  RuntimeSceneContent,
  GameSessionMode,
  SessionPauseReason,
  SessionBoundaryRequest,
  SessionBoundaryResult,
  RuntimeInspectorRequest,
  RuntimeInspectorResult,
  SimulationQuiesceRequest,
  SimulationCaptureRequest,
  DiagnosticOperationRequest,
  DiagnosticOperationResult,
  DebugObserveTarget,
  Breakpoint,
} from "@haptic/bridge";
import type { ScriptDebugObserver } from "./script-debug";
import { ScriptBreakpoints } from "./script-breakpoints";
import {
  type World,
  createDebugInspectSnapshot,
  type Actor,
  type EngineObject,
  SceneLayer,
  type DebugInspectSnapshot,
} from "@haptic/object-model";
import {
  idleDeviceMotion,
  type SerializedScene,
  type SerializedSceneLayer,
  type SceneStreamingState,
} from "@haptic/core";
import {
  InputRingBuffer,
  InputResolver,
  createDefaultInputMappings,
  normalizeInputMappings,
  mappingsUseDeviceMotion,
  decodeInputEvents,
  type InputBindingControls,
  type RawInputEvent,
  type ResolvedInputTick,
} from "@haptic/input";
import { sceneRealizationCancelled, type CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { AcquireRuntimeScene } from "./scene-source";
import {
  createInfiniteLoopGuard,
  isInfiniteLoopError,
  DEFAULT_INFINITE_LOOP_COUNT,
  MAX_TIME_DILATION,
  type CommandResult,
  type InfiniteLoopGuard,
  type RegisteredCommand,
  type TraceFrame,
  type TracePayload,
  type UserCommandDef,
} from "@haptic/debugger";
import { LogRingBuffer, type LogSeverity } from "./log-ring";
import {
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
} from "./diagnostics";
import type { AnchorEntry } from "./stack-map";
import { Painter2DRuntime } from "./painter2d-runtime";
import type { UIControls2DRuntime } from "./ui-controls2d-runtime";
import { Text2DAppearRuntime } from "./text2d-appear-runtime";
import { TweenRuntime } from "./tween-runtime";
import { TimelineRuntime } from "./timeline-runtime";
import { findComponentById, ownedSceneActor } from "./script-host-helpers";
import type { AnimGraphDocument } from "@haptic/anim-graph";
import type { BehaviourTreeDocument, BlackboardDocument } from "@haptic/behaviour-tree";
import type { ScriptHost, CompiledScript } from "./script-host";
import type { ScriptRuntime } from "./script-runtime";
import type { PhysicsWorldSync } from "./physics-sync";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { RagdollWorldSync } from "./ragdoll-sync";
import type { RuntimeConsole } from "./runtime-console";
import type { ActorRealization, ScriptedActorSpawn } from "./actor-realization";
import type { OverlaySafeAreaInsets } from "@haptic/core";
import type { ModelPayload, SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@haptic/assets";
import { initNavigation, type NavObstacleKind, type NavPoint } from "@haptic/navigation";
import { RuntimeSubsystems } from "./runtime-subsystems";
import type { RenderSlots } from "./render-slots";
import type { TickPipeline } from "./tick-pipeline";
import type { SnapshotPublisher } from "./snapshot-publisher";
import type { RenderCommandEmitter } from "./render-command-emitter";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import { RuntimeVoices } from "./runtime-voices";
import { SpriteClipTrace, type SpriteClipState } from "./sprite-clip-trace";
import { WaterClock } from "./water-world";
import { indexSceneLibrary, registerSceneAssetClasses } from "./scene-library";
import type { RuntimeNavigation } from "./runtime-navigation";
import type { SceneStreams } from "./scene-streams";
import type { SceneLayers } from "./scene-layers";
import type { SceneRealizer } from "./scene-realizer";
import type { OwnerAdmission } from "./owner-admission";
import type { AnimGraphRuntime } from "./anim-graph-runtime";
import type { BehaviourTreeRuntime } from "./behaviour-tree-runtime";
import { LatentDelays } from "./latent-delays";
import type { RuntimeCamera } from "./runtime-camera";
import type { RuntimePropertyWrites } from "./runtime-property-writes";
import { SimulationBlocks } from "./simulation-blocks";
import type { SimulationWaits } from "./simulation-waits";
import { DEFAULT_GARBAGE_COLLECTION_INTERVAL_TICKS, RuntimeObjectLifetime } from "./object-lifetime";
import { createClassRegistry, registerRuntimeSubsystems, type RuntimeComposition } from "./runtime-composition";
import {
  createActorRealization,
  createAdmission,
  createBoundaries,
  createLayers,
  createOverlay,
  createSceneRealizer,
  createSimulation,
  createStreams,
  createWaits,
} from "./runtime-composition-scene";
import {
  createAnimGraphs,
  createAudioParticles,
  createBehaviourTrees,
  createCables,
  createCamera,
  createConsole,
  createDynamicMeshes,
  createInspector,
  createMovement,
  createNavigation,
  createPhysics,
  createPropertyWrites,
  createRagdolls,
  createRenderEmitter,
  createRenderSlots,
  createScalability,
  createScriptDebug,
  createScriptRuntime,
  createSnapshots,
  createTickPipeline,
  createUIControls,
  createWorld,
  installWorldInputProvider,
} from "./runtime-composition-systems";
import { createScriptHost } from "./runtime-composition-script-host";
import { breakpointHit, reportRuntimeError } from "./runtime-error-reporting";
import type { RuntimeDriver, RuntimeDriverOptions } from "./driver-types";

export type { RuntimeDriver, RuntimeDriverOptions, RuntimeSaveGameOptions } from "./driver-types";

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

/** The graph debugger's views: editor-bound, not scene state, so they stay out of the command revision a final capture compares. */
const DEBUG_VIEW_COMMANDS: ReadonlySet<string> = new Set(["debugRoster", "executionTrace", "debugVariables", "btState"]);

/**
 * The in-process runtime driver: it builds the session's subsystems, owns the
 * session state they read (stop, pause, boot loading, frame id, the Play Scene
 * and its library, input), runs the fixed-step tick phases and Stop, and
 * routes every command through `emit()`. Subsystems receive host callbacks at
 * construction and read replaceable driver fields lazily. The wiring that
 * builds them (`runtime-composition-*.ts`), the tick phases
 * (`runtime-tick-phases.ts`) and error reporting (`runtime-error-reporting.ts`)
 * take the driver as a `RuntimeComposition`; members outside `RuntimeDriver`
 * are that contract, for those modules only.
 */
class InProcessRuntime implements RuntimeDriver, RuntimeComposition {
  // Session configuration, fixed at construction.
  readonly sessionGeneration: number;
  readonly sessionMode: GameSessionMode;
  readonly demandAssetCatalog: boolean;
  private readonly onCommand?: (command: CommandMessage) => void;
  readonly dt: number;
  readonly seed: number;
  readonly acquireScene?: AcquireRuntimeScene;
  readonly deferSceneModelsReady: boolean;
  readonly deferSceneLoadingPaint: boolean;
  readonly cooperativeSceneLoading: CooperativeSceneLoadingOptions | null;

  // Session state the subsystems read through host callbacks.
  running = false;
  stopped = false;
  bootLoading = false;
  /** An empty Preview's demo actors wait for `realizePlayWorld` or `start`. */
  private demoActorsPending = false;
  paused = false;
  readonly pauseReasons = new Set<SessionPauseReason>();
  readonly pendingPauseChanges = new Map<SessionPauseReason, boolean>();
  frameId = 0;
  commandRevision = 0;
  lifecycleId = 0;
  timeDilation = 1;
  tilemapAnimationTimeMs = 0;
  hasAnimatedTiles = false;
  /** Simulated water time: physics, buoyancy, script queries and Play water rendering share it. */
  readonly waterClock = new WaterClock();
  /** Frame index (live actor per guid) the BT and crowd ticks share. */
  navFrameActors: Map<string, Actor> | null = null;
  /**
   * The guid index built at `revision`. The live actor behind a guid changes only when an actor spawns or is destroyed,
   * both of which bump `structuralRevision`, so ticks without such a change reuse one index. Entries an actor joins
   * the frame index with (`ActorRealization.realize`) follow a spawn, which already outdates it.
   */
  guidIndexCache: { revision: number; index: Map<string, Actor> } | null = null;

  // Scene documents and render target sources.
  playScene: SerializedScene | undefined;
  playSceneGuid: string;
  readonly sceneLibrary = new Map<string, SerializedScene>();
  readonly sceneGuidByKey = new Map<string, string>();
  readonly sceneLayerLibrary = new Map<string, SerializedSceneLayer>();
  readonly sourceRenderTargets = new Map<string, RenderTargetPayload>();
  readonly sourceRenderTargetTextures = new Map<string, RenderTargetTexturePayload>();

  // Input.
  readonly input = new InputRingBuffer(512);
  readonly resolver: InputResolver;
  resolvedInput: ResolvedInputTick = {
    inputs: {},
    actions: {},
    axes: {},
    axes2D: {},
    gamepadConnections: [],
    pressedKeys: [],
    cursor: { x: 0, y: 0, pressed: false },
    touches: [],
    touchEvents: [],
    deviceMotion: idleDeviceMotion(),
  };
  /** Bindings read tilt or shake, so the first tick asks the host for motion input. */
  readonly bindingsUseDeviceMotion: boolean;
  deviceMotionRequested = false;
  /** Mutable box so TickContext can read connections without aliasing `this`. */
  readonly connectionBox: {
    current: ResolvedInputTick["gamepadConnections"];
  } = { current: [] };

  // Logs and diagnostics.
  readonly logs = new LogRingBuffer(512);
  readonly diagnostics = new SessionDiagnosticAggregator();
  /** Simulation's Pause On Errors, and the error sources (as the session report groups them) that already paused it. */
  readonly pauseOnErrors: boolean;
  readonly pausedErrorSources = new Set<string>();
  /** Node breakpoints (Simulation and editor Play), and whether one already stopped this tick: the first hit is the one shown. */
  readonly breakpoints = new ScriptBreakpoints((hit) => breakpointHit(this, hit));
  breakpointReported = false;
  readonly anchors = new Map<string, readonly AnchorEntry[]>();
  readonly loopGuard: InfiniteLoopGuard;

  // Leaf services, built by field initializers: they take no other subsystem.
  /** Voices `emit` started and has not stopped, for trace frames and restore; draws their clip and pitch. */
  readonly voices = new RuntimeVoices(() => this.seed);
  /** Sprite Animation clips actors show, for trace frames and restore. */
  readonly spriteClips = new SpriteClipTrace();
  readonly assetPreloads = new RuntimeAssetPreloads(command => this.emit(command));
  /** Blocking Scene stream and asset loads hold the simulation here; a settled hold resumes it. */
  readonly blocks = new SimulationBlocks({
    stopped: () => this.stopped,
    emit: (command) => this.emit(command),
    settled: () => {
      this.ticks.resetAccumulator();
      this.admission.flush();
      this.waits.resumeWaiters();
    },
  });
  readonly painters = new Painter2DRuntime();
  readonly textAppear = new Text2DAppearRuntime();
  /** Timeline Clips of the main Scene and every loaded Scene Layer copy. */
  readonly timelines = new TimelineRuntime({
    clipsFor: (owner) => owner instanceof SceneLayer ? this.sceneLayerLibrary.get(owner.assetGuid)?.timelineClips
      : owner === this.world.currentScene ? this.playScene?.timelineClips : undefined,
    ownedActor: (owner, id) => ownedSceneActor(owner, id, (guid) => this.world.findActor(guid), (scene, actorId) => this.streams.resolveInstanceId(scene, actorId)),
    findActor: (guid) => this.world.findActor(guid),
    component: (actor, id) => findComponentById(actor, id),
    teleportActor: (actor) => this.scriptHost.teleportActor(actor),
    refreshComponent: (component, property) => this.propertyWrites.refreshComponent(component, property),
  });
  readonly tweens = new TweenRuntime((owner) => !this.stopped && !this.paused && !this.blocks.active &&
    (!owner || this.admission.canRunActions(owner)));
  /**
   * Subsystems with lifecycle hooks. Registration order (`registerRuntimeSubsystems`)
   * is the order Stop, Scene replacement and actor removal run their hooks.
   */
  readonly subsystems = new RuntimeSubsystems();

  // Subsystems, built by the constructor in its phase order.
  readonly admission: OwnerAdmission;
  readonly renderSlots: RenderSlots;
  readonly renderEmitter: RenderCommandEmitter;
  readonly audioParticles: AudioParticleEmitter;
  readonly delays: LatentDelays;
  readonly navigation: RuntimeNavigation;
  readonly streams: SceneStreams;
  readonly sceneRealizer: SceneRealizer;
  readonly boundaries: SessionBoundaries;
  readonly animGraphs: AnimGraphRuntime;
  readonly behaviourTrees: BehaviourTreeRuntime;
  readonly actors: ActorRealization;
  readonly camera: RuntimeCamera;
  readonly waits: SimulationWaits;
  readonly simulation: SimulationSession;
  readonly scriptRuntime: ScriptRuntime;
  readonly inspector: RuntimeInspectorService;
  readonly materialParameters: RuntimeMaterialParameters;
  readonly propertyWrites: RuntimePropertyWrites;
  readonly scalability: ScalabilitySession;
  readonly physics: RuntimePhysicsWorlds;
  readonly console: RuntimeConsole;
  readonly world: World;
  readonly snapshots: SnapshotPublisher;
  readonly ticks: TickPipeline;
  readonly dynamicMeshes: DynamicRuntimeMeshSync;
  readonly movement: MovementWorldSync;
  readonly cables: CableWorldSync;
  readonly ragdolls: RagdollWorldSync;
  readonly uiControls: UIControls2DRuntime;
  readonly overlay: SceneLayerOverlay;
  readonly layers: SceneLayers;
  readonly dataCatalog: RuntimeDataCatalog;
  /** Curve assets of the current sources, by guid; absent means not loaded. */
  readonly curveCatalog = new Map<string, CurveAssetCatalogEntry>();
  readonly scriptHost: ScriptHost;
  readonly objectLifetime: RuntimeObjectLifetime;
  readonly scriptDebug: ScriptDebugObserver;

  get lastScriptMs(): number {
    return this.ticks.lastScriptMs;
  }

  get lastPhysicsMs(): number {
    return this.ticks.lastPhysicsMs;
  }
  get snapshotCapacity(): number { return this.snapshots.capacity; }
  get snapshotGeneration(): number { return this.snapshots.generation; }

  /**
   * Builds the session in phases. Subsystem constructors build only their own
   * state and call no host callback; host callbacks read driver fields when
   * called, so a callback may name a subsystem built later. Order matters where
   * a constructor takes another subsystem directly or a construction-time call
   * reads one:
   *
   * 1. Core subsystems: `OwnerAdmission` first, because Delays, audio/particle
   *    playback, scene streams, the Scene realizer, Session boundaries, actor
   *    realization and simulation waits take it directly; `RenderSlots` takes
   *    `RuntimeSubsystems`. `RuntimeCamera` takes no subsystem directly.
   * 2. Session identity: `SimulationSession` snapshots the Simulate baseline,
   *    then `ScriptRuntime`, whose Class asset guid map the console's startup
   *    command bindings (phase 4) and the ScriptHost actor bindings (phase 7)
   *    read, then `RuntimeInspectorService`, which `emit()` asks to annotate
   *    every command, so it exists before anything can emit.
   * 3. Render and physics settings (material parameters, then the property
   *    write path, which takes `OwnerAdmission` directly), physics worlds and
   *    the Scene library.
   * 4. Console (with startup user commands), loop guard, startup animation
   *    graph, behaviour tree and Blackboard documents, input resolver and
   *    physics content.
   * 5. The World, then what takes it directly: snapshots, the tick pipeline,
   *    component runtimes, the Scene Layer overlay and Scene Layers.
   * 6. The World input provider.
   * 7. ScriptHost last: its services take most subsystems directly.
   * 8. `RuntimeSubsystems` registration, in Stop order.
   * 9. Startup: Scene asset Classes and the Game Instance. An empty Preview's
   *    demo actors wait for `realizePlayWorld` or `start`, so construction
   *    emits no command.
   */
  constructor(options: RuntimeDriverOptions) {
    // 1. Core subsystems.
    this.admission = createAdmission(this);
    this.renderSlots = createRenderSlots(this);
    this.renderEmitter = createRenderEmitter(this);
    this.audioParticles = createAudioParticles(this);
    this.delays = new LatentDelays(this.admission);
    this.navigation = createNavigation(this);
    this.streams = createStreams(this);
    this.sceneRealizer = createSceneRealizer(this);
    this.boundaries = createBoundaries(this);
    this.animGraphs = createAnimGraphs(this);
    this.behaviourTrees = createBehaviourTrees(this);
    this.actors = createActorRealization(this);
    this.camera = createCamera(this, options);
    this.waits = createWaits(this);

    // 2. Session identity, scripts and the inspector.
    this.simulation = createSimulation(this, options);
    this.sessionGeneration = options.sessionGeneration ?? 0;
    this.sessionMode = options.sessionMode ?? "play";
    this.demandAssetCatalog = options.classAssetGuids !== undefined;
    this.scriptRuntime = createScriptRuntime(this, options);
    this.inspector = createInspector(this, options);

    // 3. Render and physics settings, physics worlds and the Scene library.
    this.materialParameters = new RuntimeMaterialParameters(options.materialParameterCatalog, options.materialTextureAssetGuids);
    this.propertyWrites = createPropertyWrites(this, options);
    this.scalability = createScalability(this, options);
    this.dt = options.dt ?? 1 / 60;
    this.seed = options.seed;
    this.onCommand = options.onCommand;
    const tilemaps = new Map(Object.entries(options.tilemaps ?? {}));
    const tilesets = new Map(Object.entries(options.tilesets ?? {}));
    this.physics = createPhysics(this, options, tilemaps, tilesets);
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

    // 4. Console, loop guard, startup documents, input and physics content.
    this.console = createConsole(this, options);
    for (const command of options.consoleCommands ?? []) {
      this.scriptRuntime.setClassAssetGuid(command.classId, command.assetGuid);
      this.bindUserCommand({ ...command, name: command.name || command.classId.toLowerCase() });
    }
    this.pauseOnErrors = options.pauseOnErrors === true;
    this.loopGuard = createInfiniteLoopGuard({
      enabled:
        (options.includeDebugCommands ?? true) &&
        options.infiniteLoopDetection !== false,
      loopCount: options.loopCount ?? DEFAULT_INFINITE_LOOP_COUNT,
    });
    for (const [guid, document] of Object.entries(options.animGraphs ?? {})) this.animGraphs.register(guid, document);
    for (const [guid, document] of Object.entries(options.behaviourTrees ?? {})) this.behaviourTrees.register(guid, document);
    for (const [guid, document] of Object.entries(options.blackboards ?? {})) this.behaviourTrees.registerBlackboard(guid, document);
    this.hasAnimatedTiles = hasAnimatedTiles(tilemaps, tilesets);
    this.behaviourTrees.replaceAudioAssets((options.audioAssetGuids ?? []).filter((guid) => guid));
    this.behaviourTrees.replaceAnimClipCatalog((options.animClipCatalog ?? []).filter((entry) => entry.guid));
    const registry = createClassRegistry();
    const mappings = normalizeInputMappings(
      options.inputAssets !== undefined ? inputMappingsFromAssets(options.inputAssets) : createDefaultInputMappings(),
    );
    this.resolver = new InputResolver(mappings);
    this.bindingsUseDeviceMotion = mappingsUseDeviceMotion(mappings);
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

    // 5. The World and the subsystems that take it directly.
    this.world = createWorld(this, options, registry);
    this.snapshots = createSnapshots(this, options);
    this.ticks = createTickPipeline(this, options);
    this.dynamicMeshes = createDynamicMeshes(this);
    this.movement = createMovement(this);
    this.cables = createCables(this);
    this.ragdolls = createRagdolls(this);
    this.uiControls = createUIControls(this);
    this.overlay = createOverlay(this, options);
    this.layers = createLayers(this);

    // 6. World input.
    installWorldInputProvider(this);

    // 7. Script data and the ScriptHost.
    this.dataCatalog = new RuntimeDataCatalog(options.dataAssets);
    for (const entry of options.curveAssets ?? []) this.curveCatalog.set(entry.guid, entry);
    for (const [guid, value] of Object.entries(options.renderTargets ?? {})) this.sourceRenderTargets.set(guid, value);
    for (const [guid, value] of Object.entries(options.renderTargetTextures ?? {})) this.sourceRenderTargetTextures.set(guid, value);
    this.scriptHost = createScriptHost(this, options, registry);
    this.breakpoints.set(options.breakpoints ?? []);
    this.scriptHost.setBreakpoints(this.breakpoints);
    this.scriptDebug = createScriptDebug(this);
    this.objectLifetime = new RuntimeObjectLifetime({
      world: () => this.world,
      roots: () => this.scriptRuntime.liveObjects(),
      intervalTicks: () => options.garbageCollectionIntervalTicks ?? DEFAULT_GARBAGE_COLLECTION_INTERVAL_TICKS,
      now: () => performance.now(),
    });
    this.objectLifetime.collector.addRootSource((visit) => this.scriptHost.latentFrames.forEach(visit));
    this.objectLifetime.collector.addRootSource((visit) => this.behaviourTrees.forEachBlackboardValue(visit));
    this.objectLifetime.collector.onRelease((object) => {
      this.admission.drop(object);
      this.scriptHost.releaseObject(object);
    });

    // 8. Lifecycle hooks, in Stop order.
    registerRuntimeSubsystems(this);

    // 9. Startup objects.
    registerSceneAssetClasses(this.world.classRegistry, this.playSceneGuid, this.sceneGuidByKey.values());
    this.scriptRuntime.bindGameInstance();
    this.demoActorsPending = options.seedDemoActors !== false && !options.playScene;
  }

  /**
   * An empty Preview's demo actors spawn where a Play Scene's actors would:
   * at `realizePlayWorld`, or `start` for a host that starts without it. Their
   * `spawn` commands then never reach `onCommand` during construction.
   */
  private realizeDemoActors(): void {
    if (!this.demoActorsPending || this.stopped) return;
    this.demoActorsPending = false;
    this.actors.seedDemoActors();
  }

  notifyAssetPreloadResult(result: { preloadId: string; success: boolean; error?: string; progress?: number }): void {
    this.assetPreloads.receive(result);
  }

  setAssetLoadStates(states: readonly { guid: string; state: RuntimeAssetLoadState }[]): void {
    this.assetPreloads.setStates(states);
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

  getSceneLayerPhysicsSync(layerGuid: string): PhysicsWorldSync | null {
    return this.physics.layer(layerGuid);
  }

  applyRagdollPoseCaptured(message: Extract<ControlMessage, { type: "ragdollPoseCaptured" }>): void {
    if (this.stopped) return;
    this.ragdolls.accept(message);
    this.physics.main.syncFromWorld(this.world);
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
    // Two-finger drags are measured in the view's shorter side.
    if (canvasWidth !== undefined && canvasHeight !== undefined) this.resolver.setViewSize(canvasWidth, canvasHeight);
  }

  applySceneLayerFocusNavigate(reverse: boolean): void {
    this.overlay.focusNavigate(reverse);
  }

  applyDebugObserve(target: DebugObserveTarget | null, instanceId: string | null): void {
    if (this.stopped) return;
    this.scriptDebug.observe(target, instanceId);
  }

  applyBreakpoints(breakpoints: readonly Breakpoint[]): void {
    if (this.stopped) return;
    this.breakpoints.set(breakpoints);
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
    this.voices.ended(voiceId);
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
      const component = actor.components.find(
        (entry) =>
          !entry.destroyed &&
          entry.classId === "AudioComponent" &&
          entry.guid === voiceId,
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

  async loadScripts(scripts: readonly CompiledScript[]): Promise<void> {
    return this.updateScriptSources(scripts, false);
  }

  replaceScriptSources(scripts: readonly CompiledScript[]): Promise<void> {
    return this.updateScriptSources(scripts, true);
  }

  private async updateScriptSources(scripts: readonly CompiledScript[], replace: boolean): Promise<void> {
    try {
      await this.scriptRuntime.updateSources(scripts, replace);
    } finally {
      // Which classes handle Hit and Overlap events, and so need contact reporting, may have changed.
      this.physics.scriptsChanged();
    }
  }

  spawnScriptedActor(options: ScriptedActorSpawn): Actor | null {
    return this.actors.spawnScripted(options);
  }

  prepareScriptedActor(options: ScriptedActorSpawn): Actor | null {
    return this.actors.prepareScripted(options);
  }

  createScriptedObject(classId: string): EngineObject | null {
    return this.scriptRuntime.createObject(classId, (object) => this.objectLifetime.collector.register(object));
  }

  finishScriptedActor(actor: Actor): Actor | null {
    return this.actors.finishScripted(actor);
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
    this.realizeDemoActors();
    return this.sceneRealizer.realizePlayWorld();
  }

  notifySceneLoadingPainted(sceneAssetGuid: string, sceneLoadId: number): void {
    this.sceneRealizer.notifyLoadingPainted(sceneAssetGuid, sceneLoadId);
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
    self?: EngineObject | null,
    args?: Record<string, unknown>,
  ): void {
    this.scriptHost.invokeEvent(classId, event, self ?? null, args ?? {});
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

  setTimeDilation(rate: number): void {
    if (Number.isFinite(rate)) this.timeDilation = Math.min(MAX_TIME_DILATION, Math.max(0, rate));
  }

  /**
   * Resume a trace frame's time dilation, behaviour trees, Animation Graphs,
   * sprite clips and voices on the live World (actors match by guid, BT rows by
   * render slot). Order: dilation, BT evaluation and ownership, Animation Graph
   * evaluation, then each live actor's sprite clip in World order (`animState` for a recorded clip,
   * collider clip cleared otherwise), then `stopSound` for live voices the
   * frame lacks and `playSound` at the recorded offset, clip and pitch for each
   * recorded voice.
   */
  restoreFromTrace(frame: TraceFrame): void {
    this.setTimeDilation(frame.timeDilation);
    this.behaviourTrees.restoreFromTrace(frame.bt ?? []);
    this.animGraphs.restoreFromTrace(frame.animGraphs ?? []);
    const recordedClips = new Map((frame.sprites ?? []).map((clip) => [clip.actorGuid, clip]));
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
      const recorded = recordedClips.get(actor.guid);
      if (!recorded) {
        if (this.spriteClips.get(actor)) this.setActorSpriteClip(actor, null);
        continue;
      }
      const { assetGuid, clipName, normalisedTime, stateId } = recorded;
      this.setActorSpriteClip(actor, { assetGuid, clipName, normalisedTime, stateId });
      const slotId = this.actorSlot(actor);
      if (slotId === undefined) continue;
      this.emit({
        type: "animState", slotId, stateId, normalisedTime, blendWeights: { [stateId]: 1 },
        clipName, clipKind: "sprite", clipAssetGuid: assetGuid, justFinished: false, justLooped: false,
        layers: [{ stateId, clipAssetGuid: assetGuid, clipName, clipKind: "sprite", normalisedTime, weight: 1 }],
      });
    }
    const audio = frame.audio ?? { voices: [], nextScriptVoice: 1 };
    for (const command of this.voices.restoreCommands(audio, this.frameId)) this.emit(command);
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
    this.curveCatalog.clear();
    for (const entry of content.curveAssets ?? []) this.curveCatalog.set(entry.guid, entry);
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

  async loadNavMesh(bytes?: Uint8Array): Promise<void> {
    const lifecycleId = this.lifecycleId;
    const sceneGuid = this.playSceneGuid;
    // A host that already sent `sceneNavmeshBytes` omits the startup mesh here instead of sending it twice.
    const navmesh = bytes ?? this.navigation.sceneNavMesh(sceneGuid);
    if (!navmesh) return;
    if (bytes) this.navigation.setSceneNavMesh(sceneGuid, bytes);
    await initNavigation();
    if (this.stopped || lifecycleId !== this.lifecycleId) throw sceneRealizationCancelled();
    this.navigation.markInitialized();
    if (sceneGuid !== this.playSceneGuid) return;
    this.navigation.importNavMesh(sceneGuid, navmesh);
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

  stopNavAgent(actorGuid: string): void {
    this.navigation.stopAgent(actorGuid);
  }

  /** Animation graphs and BT Play Animation drive sprite clips in the actor's physics world. */
  setActorSpriteClip(actor: Actor, clip: SpriteClipState | null): void {
    this.spriteClips.set(actor, clip);
    this.physics.forActor(actor)?.setActorSpriteClip(actor, clip &&
      { assetGuid: clip.assetGuid, clipName: clip.clipName, normalisedTime: clip.normalisedTime });
  }

  /** The render slot this actor's own commands target (`RenderSlots.actorSlot`). */
  actorSlot(actor: Actor): number | undefined {
    return this.renderSlots.actorSlot(actor);
  }

  /** The slot of the live actor with this guid. */
  guidSlot(guid: string): number | undefined {
    return this.renderSlots.guidSlot(guid);
  }

  notifySceneModelsReady(sceneAssetGuid: string, sceneLoadId: number): void {
    this.sceneRealizer.notifyModelsReady(sceneAssetGuid, sceneLoadId);
  }

  configureSaveGame(options: RuntimeSaveGameOptions): SaveGameService {
    return this.boundaries.configureSaveGame(options);
  }

  getSaveGameService(): SaveGameService | undefined { return this.boundaries.saveGameService; }

  registerSaveActor(actor: EngineObject, persistentId?: string): void {
    this.boundaries.registerSaveActor(actor, persistentId);
  }

  start(): void {
    if (this.stopped) return;
    this.realizeDemoActors();
    this.running = true;
    this.breakpointReported = false;
    try {
      this.world.start();
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
  }

  /**
   * Ends the session once, in order:
   * - Still running: dispose asset preloads, end the console lifetime and
   *   reject Scene Layer readiness waiters.
   * - Mark stopped, then end diagnostics, the inspector queue, the boundary
   *   queue, pending pause changes, tweens and the overlay.
   * - Cancel: invalidate in-flight async loads (lifecycle id), cancel a Scene
   *   change, stop running, release `SimulationWaits` waiters, then every registered
   *   subsystem's `cancelPending` (`RuntimeSubsystem` Stop phase 1; the Scene
   *   realizer last).
   * - Finalize the trace.
   * - End the World: destroy live components, then `World.end`.
   * - Release scripts: dispose ScriptHost, unregister script Classes, drop
   *   anchors, release Scene sources and forget the Play Scene and library.
   * - Dispose: clear owner queues and the Scene Layer table, then every
   *   registered subsystem's `dispose` (`RuntimeSubsystem` Stop phase 2).
   */
  stop(): void {
    if (this.stopped) return;
    // Still running.
    this.assetPreloads.dispose();
    this.console.stop();
    this.layers.rejectWaiters();
    // Mark stopped.
    this.stopped = true;
    this.ticks.stopDiagnostics();
    this.inspector.stop();
    this.boundaries.flush();
    this.pendingPauseChanges.clear();
    this.tweens.stop();
    this.timelines.reset();
    this.overlay.clear();
    // Cancel.
    this.lifecycleId++;
    this.sceneRealizer.cancelSceneChange();
    this.running = false;
    this.waits.releaseAll();
    this.subsystems.cancelPending();
    // Finalize the trace.
    this.ticks.finalizeTrace("session-ended");
    // End the World.
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
    // Release scripts.
    this.scriptDebug.dispose();
    this.scriptHost.dispose();
    this.scriptRuntime.unregisterClasses();
    this.anchors.clear();
    this.sceneRealizer.releaseSceneSources();
    this.playScene = undefined;
    this.sceneLibrary.clear();
    // Dispose.
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

  setPauseReason(reason: SessionPauseReason, paused: boolean): void {
    if (this.stopped) return;
    if (this.simulation.quiescent && !paused) return;
    if (this.ticks.processing) { this.pendingPauseChanges.set(reason, paused); return; }
    const wasPaused = this.paused;
    const wasBlockingInput = this.blocksInput();
    if (paused) this.pauseReasons.add(reason); else this.pauseReasons.delete(reason);
    this.paused = this.pauseReasons.size > 0;
    // A `rendering` hold is a time pause only: held keys and buttons stay held and releases still arrive.
    if (!wasBlockingInput && this.blocksInput()) this.resetInputState();
    if (this.paused === wasPaused) return;
    this.ticks.resetAccumulator();
    if (this.paused) return;
    this.ticks.discardNextElapsed();
    this.admission.flush();
    this.waits.resumeWaiters();
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

  resetInputState(): void {
    this.input.drain();
    this.resolvedInput = this.resolver.reset();
    this.connectionBox.current = this.resolvedInput.gamepadConnections;
  }

  /** Whether a pause reason other than a render hold drops input: only those reset and refuse it. */
  private blocksInput(): boolean {
    for (const reason of this.pauseReasons) if (reason !== "rendering") return true;
    return false;
  }

  pushInput(events: readonly RawInputEvent[]): void {
    if (this.stopped || this.blocksInput()) return;
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

  settlePauseChanges(): void {
    if (this.pendingPauseChanges.size) {
      for (const [reason, paused] of this.pendingPauseChanges) this.setPauseReason(reason, paused);
      this.pendingPauseChanges.clear();
    }
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
    return reportRuntimeError(this, error, frameId, hint);
  }

  emit(command: CommandMessage): void {
    command = this.voices.prepare(this.inspector.annotate(command));

    // Debug views carry no scene state; counting them would break a final-capture fence.
    if (!DEBUG_VIEW_COMMANDS.has(command.type)) this.commandRevision++;
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
    this.voices.observe(command);
    this.onCommand?.(command);
  }
}

