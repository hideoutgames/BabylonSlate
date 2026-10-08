import type { SimulationSceneCaptureResult } from "./simulation-scene-capture";
import { SimulationSession } from "./simulation-session";
import { RuntimeInspectorService } from "./runtime-inspector-service";
import { RuntimeDataCatalog } from "./data-catalog";
import type { SaveGameService } from "@babylonslate/core";
import { SessionBoundaries, type RuntimeSaveGameOptions } from "./session-boundaries";
import { RuntimeMaterialParameters } from "./runtime-material-parameters";
import { RuntimeAssetPreloads } from "./asset-preloads";
import type { RuntimeAssetLoadState } from "@babylonslate/core";
import { SceneLayerOverlay, createSceneLayerOverlayHostBindings } from "./scene-layer-overlay";
import { CableWorldSync } from "./cable-sync";
import { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import { MovementWorldSync } from "./movement";
import type { RenderTargetPayload, RenderTargetTexturePayload } from "@babylonslate/core";
import type { WaterDefinition } from "@babylonslate/core";
import { ScalabilitySession, type ScalabilityRequest, type ScalabilityResult, type ScalabilitySnapshot, type ScalabilityAcknowledgement, type RenderPath } from "@babylonslate/core";
import type { CollisionTriangleMesh } from "@babylonslate/core";
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
  BObject,
  SceneLayer,
  type DebugInspectSnapshot,
} from "@babylonslate/object-model";
import {
  type RenderPathStatus,
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
  type InputBindingControls,
  type RawInputEvent,
  type ResolvedInputTick,
} from "@babylonslate/input";
import { sceneRealizationCancelled, type CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { AcquireRuntimeScene } from "./scene-source";
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
import { Text2DAppearRuntime } from "./text2d-appear-runtime";
import { TweenRuntime } from "./tween-runtime";
import type { AnimGraphDocument } from "@babylonslate/anim-graph";
import type { BehaviourTreeDocument, BlackboardDocument } from "@babylonslate/behaviour-tree";
import { ScriptHost, type CompiledScript } from "./script-host";
import { ScriptRuntime } from "./script-runtime";
import type { PhysicsWorldSync } from "./physics-sync";
import { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import { RagdollWorldSync } from "./ragdoll-sync";
import { RuntimeConsole } from "./runtime-console";
import { actorGuidIndex } from "./actor-world-transform";
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
import { WaterClock } from "./water-world";
import {
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
import { RuntimeCamera } from "./runtime-camera";
import { RuntimePropertyWrites } from "./runtime-property-writes";
import { RuntimeContinuationCancelled, SimulationWaits } from "./simulation-waits";
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

/** The session class registry; `Enemy` is the class of the empty-Preview demo actor. */
function createClassRegistry(): ClassRegistry {
  const registry = new ClassRegistry();
  registry.register({
    id: "Enemy",
    parentClassId: "Actor",
    kind: "actor",
    variables: [{ name: "speed", type: "float", defaultValue: 1 }],
    implementedInterfaces: [],
  });
  return registry;
}

/**
 * The in-process runtime driver: it builds the session's subsystems, owns the
 * session state they read (stop, pause, boot loading, frame id, the Play Scene
 * and its library, input), runs the fixed-step tick phases and Stop, and
 * routes every command through `emit()`. Subsystems receive host callbacks at
 * construction and read replaceable driver fields lazily.
 */
class InProcessRuntime implements RuntimeDriver {
  // Session configuration, fixed at construction.
  private readonly sessionGeneration: number;
  private readonly sessionMode: GameSessionMode;
  private readonly demandAssetCatalog: boolean;
  private readonly onCommand?: (command: CommandMessage) => void;
  private readonly dt: number;
  private readonly seed: number;
  private readonly scalabilityProjectRenderPath: RenderPath;
  private readonly acquireScene?: AcquireRuntimeScene;
  private readonly deferSceneModelsReady: boolean;
  private readonly deferSceneLoadingPaint: boolean;
  private readonly cooperativeSceneLoading: CooperativeSceneLoadingOptions | null;

  // Session state the subsystems read through host callbacks.
  private running = false;
  private stopped = false;
  private bootLoading = false;
  /** An empty Preview's demo actors wait for `realizePlayWorld` or `start`. */
  private demoActorsPending = false;
  private paused = false;
  private readonly pauseReasons = new Set<SessionPauseReason>();
  private readonly pendingPauseChanges = new Map<SessionPauseReason, boolean>();
  private frameId = 0;
  private commandRevision = 0;
  private lifecycleId = 0;
  private timeDilation = 1;
  private lastRenderPathStatus: RenderPathStatus | null = null;
  private tilemapAnimationTimeMs = 0;
  private hasAnimatedTiles = false;
  /** Simulated water time: physics, buoyancy, script queries and Play water rendering share it. */
  private readonly waterClock = new WaterClock();
  /** Frame index (live actor per guid) the BT and crowd ticks share. */
  private navFrameActors: Map<string, Actor> | null = null;

  // Scene documents and render target sources.
  private playScene: SerializedScene | undefined;
  private playSceneGuid: string;
  private readonly sceneLibrary = new Map<string, SerializedScene>();
  private readonly sceneGuidByKey = new Map<string, string>();
  private readonly sceneLayerLibrary = new Map<string, SerializedSceneLayer>();
  private readonly sourceRenderTargets = new Map<string, RenderTargetPayload>();
  private readonly sourceRenderTargetTextures = new Map<string, RenderTargetTexturePayload>();

  // Input.
  private readonly input = new InputRingBuffer(512);
  private readonly resolver: InputResolver;
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

  // Logs and diagnostics.
  private readonly logs = new LogRingBuffer(512);
  private readonly diagnostics = new SessionDiagnosticAggregator();
  private readonly anchors = new Map<string, readonly AnchorEntry[]>();
  private readonly loopGuard: InfiniteLoopGuard;

  // Leaf services, built by field initializers: they take no other subsystem.
  private readonly assetPreloads = new RuntimeAssetPreloads(command => this.emit(command));
  private readonly painters = new Painter2DRuntime();
  private readonly textAppear = new Text2DAppearRuntime();
  private readonly tweens = new TweenRuntime((owner) => !this.stopped && !this.paused && !this.streams.blocking &&
    (!owner || this.admission.canRunActions(owner)));
  /**
   * Subsystems with lifecycle hooks. Registration order (`registerSubsystems`)
   * is the order Stop, Scene replacement and actor removal run their hooks.
   */
  private readonly subsystems = new RuntimeSubsystems();

  // Subsystems, built by the constructor in its phase order.
  private readonly admission: OwnerAdmission;
  private readonly renderSlots: RenderSlots;
  private readonly renderEmitter: RenderCommandEmitter;
  private readonly audioParticles: AudioParticleEmitter;
  private readonly delays: LatentDelays;
  private readonly navigation: RuntimeNavigation;
  private readonly streams: SceneStreams;
  private readonly sceneRealizer: SceneRealizer;
  private readonly boundaries: SessionBoundaries;
  private readonly animGraphs: AnimGraphRuntime;
  private readonly behaviourTrees: BehaviourTreeRuntime;
  private readonly actors: ActorRealization;
  private readonly camera: RuntimeCamera;
  private readonly waits: SimulationWaits;
  private readonly simulation: SimulationSession;
  private readonly scriptRuntime: ScriptRuntime;
  private readonly inspector: RuntimeInspectorService;
  private readonly materialParameters: RuntimeMaterialParameters;
  private readonly propertyWrites: RuntimePropertyWrites;
  private readonly scalability: ScalabilitySession;
  private readonly physics: RuntimePhysicsWorlds;
  private readonly console: RuntimeConsole;
  private readonly world: World;
  private readonly snapshots: SnapshotPublisher;
  private readonly ticks: TickPipeline;
  private readonly dynamicMeshes: DynamicRuntimeMeshSync;
  private readonly movement: MovementWorldSync;
  private readonly cables: CableWorldSync;
  private readonly ragdolls: RagdollWorldSync;
  private readonly uiControls: UIControls2DRuntime;
  private readonly overlay: SceneLayerOverlay;
  private readonly layers: SceneLayers;
  private readonly dataCatalog: RuntimeDataCatalog;
  private readonly scriptHost: ScriptHost;

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
    this.admission = this.createAdmission();
    this.renderSlots = new RenderSlots(this.subsystems, {
      ensureCapacity: (required) => this.snapshots.ensureCapacity(required),
      findActor: (guid) => this.world.findActor(guid),
    });
    this.renderEmitter = this.createRenderEmitter();
    this.audioParticles = new AudioParticleEmitter(this.admission, {
      slot: (actor) => this.actorSlot(actor),
      frameId: () => this.frameId,
      emit: (command) => this.emit(command),
    });
    this.delays = new LatentDelays(this.admission);
    this.navigation = this.createNavigation();
    this.streams = this.createStreams();
    this.sceneRealizer = this.createSceneRealizer();
    this.boundaries = this.createBoundaries();
    this.animGraphs = this.createAnimGraphs();
    this.behaviourTrees = this.createBehaviourTrees();
    this.actors = this.createActorRealization();
    this.camera = this.createCamera();
    this.waits = this.createWaits();

    // 2. Session identity, scripts and the inspector.
    this.simulation = this.createSimulation(options);
    this.sessionGeneration = options.sessionGeneration ?? 0;
    this.sessionMode = options.sessionMode ?? "play";
    this.demandAssetCatalog = options.classAssetGuids !== undefined;
    this.scriptRuntime = this.createScriptRuntime(options);
    this.inspector = this.createInspector(options);

    // 3. Render and physics settings, physics worlds and the Scene library.
    this.materialParameters = new RuntimeMaterialParameters(options.materialParameterCatalog, options.materialTextureAssetGuids);
    this.propertyWrites = this.createPropertyWrites(options);
    this.scalabilityProjectRenderPath = options.renderSettings?.renderPath ?? "forward";
    this.scalability = new ScalabilitySession(options.renderSettings, options.frameCap, options.playScene?.settings,
      (transaction) => this.emit({ type: "setScalability", transaction }));
    this.dt = options.dt ?? 1 / 60;
    this.seed = options.seed;
    this.onCommand = options.onCommand;
    const tilemaps = new Map(Object.entries(options.tilemaps ?? {}));
    const tilesets = new Map(Object.entries(options.tilesets ?? {}));
    this.physics = this.createPhysics(options, tilemaps, tilesets);
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
    this.console = this.createConsole(options);
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
    for (const [guid, document] of Object.entries(options.animGraphs ?? {})) this.animGraphs.register(guid, document);
    for (const [guid, document] of Object.entries(options.behaviourTrees ?? {})) this.behaviourTrees.register(guid, document);
    for (const [guid, document] of Object.entries(options.blackboards ?? {})) this.behaviourTrees.registerBlackboard(guid, document);
    this.hasAnimatedTiles = hasAnimatedTiles(tilemaps, tilesets);
    this.behaviourTrees.replaceAudioAssets((options.audioAssetGuids ?? []).filter((guid) => guid));
    this.behaviourTrees.replaceAnimClipCatalog((options.animClipCatalog ?? []).filter((entry) => entry.guid));
    const registry = createClassRegistry();
    this.resolver = new InputResolver(normalizeInputMappings(
      options.inputAssets !== undefined ? inputMappingsFromAssets(options.inputAssets) : options.inputMappings ?? createDefaultInputMappings(),
    ));
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
    this.world = this.createWorld(options, registry);
    this.snapshots = this.createSnapshots(options);
    this.ticks = this.createTickPipeline(options);
    this.dynamicMeshes = new DynamicRuntimeMeshSync({
      eligible: (actor) => !actor.sceneLayerId && this.admission.canRun(actor),
      slot: (actor) => this.actorSlot(actor),
      emit: (command) => this.emit(command),
    });
    this.movement = this.createMovement();
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
    this.uiControls = this.createUIControls();
    this.overlay = this.createOverlay(options);
    this.layers = this.createLayers();

    // 6. World input.
    this.world.setInputProvider(createWorldInputProvider({
      resolved: () => this.resolvedInput,
      connections: this.connectionBox,
      frameId: () => this.frameId,
      emit: (command) => this.emit(command),
    }));

    // 7. Script data and the ScriptHost.
    this.dataCatalog = new RuntimeDataCatalog(options.dataAssets);
    for (const [guid, value] of Object.entries(options.renderTargets ?? {})) this.sourceRenderTargets.set(guid, value);
    for (const [guid, value] of Object.entries(options.renderTargetTextures ?? {})) this.sourceRenderTargetTextures.set(guid, value);
    this.scriptHost = this.createScriptHost(options, registry);

    // 8. Lifecycle hooks, in Stop order.
    this.registerSubsystems();

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

  private createAdmission(): OwnerAdmission {
    return new OwnerAdmission({
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
  }

  private createRenderEmitter(): RenderCommandEmitter {
    return new RenderCommandEmitter({
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
  }

  private createNavigation(): RuntimeNavigation {
    return new RuntimeNavigation({
      world: () => this.world,
      worldKind: () => this.physics.kind,
      physics: () => this.physics.main,
      streamActorReady: (actor) => this.streams.actorReady(actor),
      isStreamActor: (actor) => this.streams.isStreamActor(actor),
      actorName: (actor) => this.debugActorName(actor),
      emit: (command) => this.emit(command),
    }, nowMs);
  }

  private createStreams(): SceneStreams {
    return new SceneStreams(this.admission, {
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
        this.waits.resumeWaiters();
      },
      emit: (command) => this.emit(command),
    });
  }

  private createSceneRealizer(): SceneRealizer {
    return new SceneRealizer(this.admission, {
      world: () => this.world,
      stopped: () => this.stopped,
      frameId: () => this.frameId,
      playScene: () => this.playScene,
      playSceneGuid: () => this.playSceneGuid,
      enterScene: (scene, guid) => {
        this.playScene = scene;
        this.scalability.setScene(scene.settings);
        this.playSceneGuid = guid;
        this.camera.resetPossession();
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
      possessViewTarget: () => this.camera.possessViewTarget(),
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
  }

  private createBoundaries(): SessionBoundaries {
    return new SessionBoundaries(this.admission, {
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
  }

  private createAnimGraphs(): AnimGraphRuntime {
    return new AnimGraphRuntime({
      actors: () => this.world.getActors(),
      stopped: () => this.stopped,
      canTick: (actor) => this.admission.canTickActor(actor),
      slot: (actor) => this.actorSlot(actor),
      hasRenderSlot: (actor) => this.renderSlots.recordedSlot(actor) !== undefined,
      playAnimationOwns: (slotId) => this.behaviourTrees.playAnimationOwns(slotId),
      scripts: () => this.scriptHost,
      setSpriteClip: (actor, clip) => this.setActorSpriteClip(actor, clip),
      emit: (command) => this.emit(command),
    });
  }

  private createBehaviourTrees(): BehaviourTreeRuntime {
    return new BehaviourTreeRuntime({
      world: () => this.world,
      frameActors: () => this.navFrameActors ?? undefined,
      stopped: () => this.stopped,
      canTick: (actor) => this.admission.canTickActor(actor),
      slot: (actor) => this.actorSlot(actor),
      navigation: () => this.navigation,
      worldKind: () => this.physics.kind,
      seed: () => this.seed,
      frameId: () => this.frameId,
      tickIndex: () => this.world.clock.tickIndex,
      scripts: () => this.scriptHost,
      setSpriteClip: (actor, clip) => this.setActorSpriteClip(actor, clip),
      actorName: (actor) => this.debugActorName(actor),
      recordDiagnostic: (diagnostic) => this.diagnostics.push(diagnostic),
      emit: (command) => this.emit(command),
    }, nowMs);
  }

  private createActorRealization(): ActorRealization {
    return new ActorRealization(this.admission, {
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
  }

  private createCamera(): RuntimeCamera {
    return new RuntimeCamera({
      world: () => this.world,
      playScene: () => this.playScene,
      frameId: () => this.frameId,
      slot: (actor) => this.actorSlot(actor),
      guidSlot: (guid) => this.guidSlot(guid),
      streams: () => this.streams,
      cursor: () => this.resolvedInput.cursor,
      overlay: () => this.overlay,
      physics: () => this.physics,
      emit: (command) => this.emit(command),
    });
  }

  private createWaits(): SimulationWaits {
    return new SimulationWaits(this.admission, {
      world: () => this.world,
      stopped: () => this.stopped,
      paused: () => this.paused,
      pauseChangePending: () => [...this.pendingPauseChanges.values()].some(Boolean),
      streams: () => this.streams,
      boundaries: () => this.boundaries,
      assetPreloads: () => this.assetPreloads,
    });
  }

  private createSimulation(options: RuntimeDriverOptions): SimulationSession {
    return new SimulationSession({
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
  }

  private createScriptRuntime(options: RuntimeDriverOptions): ScriptRuntime {
    return new ScriptRuntime(this.admission, {
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
  }

  private createInspector(options: RuntimeDriverOptions): RuntimeInspectorService {
    return new RuntimeInspectorService({
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
      refreshComponent: (component, propertyName) => this.propertyWrites.refreshComponent(component, propertyName),
      setMaterialParameter: (material, name, value) => this.propertyWrites.setMaterialParameter(material, name, value, true),
      publishSnapshot: () => this.snapshots.publish(),
      emit: (command) => this.emit(command),
    });
  }

  private createPropertyWrites(options: RuntimeDriverOptions): RuntimePropertyWrites {
    return new RuntimePropertyWrites(this.admission, {
      validateLegacyMeshParameters: options.materialParameterCatalog !== undefined,
    }, {
      world: () => this.world,
      simulation: () => this.simulation,
      materialParameters: () => this.materialParameters,
      renderSlots: () => this.renderSlots,
      renderEmitter: () => this.renderEmitter,
      uiControls: () => this.uiControls,
      overlay: () => this.overlay,
      textAppear: () => this.textAppear,
      ticks: () => this.ticks,
      audioParticles: () => this.audioParticles,
      navigation: () => this.navigation,
      physics: () => this.physics,
      ragdolls: () => this.ragdolls,
      layers: () => this.layers,
      sceneRealizer: () => this.sceneRealizer,
      emit: (command) => this.emit(command),
    });
  }

  private createPhysics(
    options: RuntimeDriverOptions,
    tilemaps: Map<string, TilemapPayload>,
    tilesets: Map<string, TilesetPayload>,
  ): RuntimePhysicsWorlds {
    return new RuntimePhysicsWorlds({
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
  }

  private createConsole(options: RuntimeDriverOptions): RuntimeConsole {
    return new RuntimeConsole({
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
      possessCamera: (actor) => this.camera.possess(actor),
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
  }

  /** World physics phase order: dynamic meshes, ragdolls, main and overlay steps, cables, contacts. */
  private createWorld(options: RuntimeDriverOptions, registry: ClassRegistry): World {
    let guidSeq = 0;
    return new World({
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
        if (this.admission.canTickScene()) this.physics.stepMain(ctx.dt, this.waterClock.stepTime, (sync) => this.movement.step(ctx.dt, sync));
        if (this.admission.hasReadyLayers()) this.physics.stepOverlay(ctx.dt, (sync) => this.movement.step(ctx.dt, sync));
        this.ragdolls.afterStep();
        if (this.admission.canTickScene()) this.cables.step(ctx.dt, this.physics.gravity, this.frameId + 1);
        this.physics.dispatchCollisionEvents();
      },
    });
  }

  private createSnapshots(options: RuntimeDriverOptions): SnapshotPublisher {
    return new SnapshotPublisher(options.maxActors ?? 256, this.world, this.renderSlots, {
      stopped: () => this.stopped,
      frameId: () => this.frameId,
      lastScriptMs: () => this.ticks.lastScriptMs,
      lastPhysicsMs: () => this.ticks.lastPhysicsMs,
      canPublish: () => this.admission.canTickScene() || this.admission.hasReadyLayers(),
      cameraActor: () => this.camera.cameraActor(),
      applyOverlayLayouts: () => this.overlay.applyLayouts(),
      retireDetachedStreams: () => this.streams.retireDetached(),
      removedActors: () => this.behaviourTrees.emitSnapshot(true),
      recorder: () => this.ticks.recorder,
      profilePublish: (milliseconds) => this.ticks.profilePublish(milliseconds),
      reportLog: (message, severity, category) => this.reportLog(message, severity, category),
      reportError: (error) => { this.reportError(error); },
      emit: (command) => this.emit(command),
    }, nowMs);
  }

  private createTickPipeline(options: RuntimeDriverOptions): TickPipeline {
    return new TickPipeline(this.world, this.snapshots, this.logs, {
      canTick: () => this.running && !this.paused && !this.boundaries.saveBoundaryActive && !this.streams.blocking,
      canAdvance: () => this.running && !this.paused && !this.streams.blocking,
      paused: () => this.paused,
      stopped: () => this.stopped,
      runTick: () => this.runTick(),
      settlePauseChanges: () => this.settlePauseChanges(),
      frameId: () => this.frameId,
      liveActors: () => this.renderSlots.size,
      btTraceStates: () => this.behaviourTrees.traceStates(),
      reportLog: (message, severity, category) => this.reportLog(message, severity, category),
      emit: (command) => this.emit(command),
    }, {
      dt: this.dt,
      seed: this.seed,
      generation: this.sessionGeneration,
      mode: this.sessionMode,
      diagnosticsEnabled: options.includeDebugCommands ?? true,
      traceByteBudget: options.traceByteBudget,
    }, nowMs);
  }

  private createMovement(): MovementWorldSync {
    return new MovementWorldSync({
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
  }

  private createUIControls(): UIControls2DRuntime {
    return new UIControls2DRuntime({
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
  }

  private createOverlay(options: RuntimeDriverOptions): SceneLayerOverlay {
    return new SceneLayerOverlay({
      world: this.world,
      focusNavigation: options.focusNavigation,
      admission: this.admission,
      uiControls: this.uiControls,
      render: this.renderEmitter,
      audioParticles: this.audioParticles,
      texturePixelSizes: options.texturePixelSizes ?? {},
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
  }

  private createLayers(): SceneLayers {
    return new SceneLayers(this.admission, this.overlay, {
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
      continueSimulation: (owner) => this.waits.continueSimulation(owner),
      setOverlayGravity: (gravity) => this.physics.setOverlayGravity(gravity),
      markUnsupportedInstance: (layerGuid) => this.simulation.markUnsupportedInstance("layer", layerGuid),
      createActor: (serialized, layerGuid) => createActorFromSerialized(this.world, serialized, this.actors.sceneActorHooks, layerGuid),
      publishSnapshot: () => this.snapshots.publish(),
      syncOverlayPhysics: () => this.physics.overlay.syncFromWorld(this.world),
      tryCompleteSceneLoad: () => this.sceneRealizer.tryCompleteSceneLoad(),
      removeActor: (actor) => this.actors.remove(actor),
      cancelInvalidTweens: () => this.tweens.cancelInvalid(),
      reportError: (error) => { this.reportError(error); },
      emit: (command) => this.emit(command),
    });
  }

  private createScriptHost(options: RuntimeDriverOptions, registry: ClassRegistry): ScriptHost {
    const projectName = options.project?.name ?? "";
    const projectVersion = options.project?.version ?? "";
    const emit = (command: CommandMessage): void => this.emit(command);
    const frameId = (): number => this.frameId;
    const slot = (actor: Actor): number | undefined => this.actorSlot(actor);
    const canRun = (owner: BObject): boolean => this.admission.canRun(owner);
    const continueSimulation = (owner: BObject | null): Promise<void> | undefined => this.waits.continueSimulation(owner);
    return new ScriptHost({
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
        waterTime: () => this.waterClock.time,
        projectCursorToScene: (channel, options) => this.camera.projectCursorToScene(channel, options),
      }),
      ...createScalabilityHostBindings({
        getScalability: () => this.getScalability(),
        requestScalability: (request) => this.requestScalability(request),
      }),
      ...createMaterialHostBindings({
        canRun,
        materialParameters: this.materialParameters,
        setMaterialParameter: (material, name, parameter) => this.propertyWrites.setMaterialParameter(material, name, parameter),
      }),
      ...createIlluminationHostBindings({
        slot,
        emitMeshAssignment: (actor, slotId) => this.renderEmitter.emitMeshAssignment(actor, slotId),
        possessCamera: (target) => this.camera.possess(target),
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
        refreshComponent: (component, propertyName) => this.propertyWrites.refreshComponent(component, propertyName),
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
      preloadAssets: (assets, owner, options) => this.waits.preloadForGameplay(assets, owner, options),
      waitForSimulation: (owner) => this.waits.continueSimulation(owner) ?? Promise.resolve(),
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
  }

  /**
   * Stop order: Delays resume in phase 1, then every scene stream retires;
   * physics-owning syncs release before the physics worlds, then the crowd
   * and the remaining debug overlays. Actor removal first retires a stream
   * the actor owns, then ragdolls, cables, dynamic meshes and animation
   * graphs; a released slot then drops its ragdoll/cable/mesh and BT state,
   * its owner's text reveal, its sent component-command state and, last,
   * a `RuntimeCamera` possession that targeted it. Scene Layers register next to
   * last: phase 1 cancels independent layer creation and removes its layers,
   * then the Scene realizer cancels the main Scene's realization and cleans
   * up what it acquired.
   */
  private registerSubsystems(): void {
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
    this.subsystems.register(this.camera);
    this.subsystems.register(this.layers);
    this.subsystems.register(this.sceneRealizer);
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

  /** The render slot this actor's own commands target (`RenderSlots.actorSlot`). */
  private actorSlot(actor: Actor): number | undefined {
    return this.renderSlots.actorSlot(actor);
  }

  /** The slot of the live actor with this guid. */
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
    this.realizeDemoActors();
    this.running = true;
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

  /**
   * One fixed step; `TickPipeline` owns the gate, timing, stats and trace
   * around it. The step (fixed step × time dilation) is captured once here and
   * passed to every phase (and advances the water clock with the World clock),
   * so a dilation change made during the tick applies from the next tick.
   * Phases, in order:
   * 1. Input: drain and resolve queued input, reset prints, log gamepad changes.
   * 2. World (timed): tweens, text reveal, painters, Scene Layer focus, the
   *    World tick (actors, then physics through `onPhysics`), deferred owner
   *    work and streamed Scenes. The tick ends here when it stopped the session.
   * 3. Scene systems (timed): tween cleanup, Delays, animation graphs, tile
   *    animation time, behaviour trees and the crowd.
   * 4. Component commands changed during the tick: painters, text reveal, deformers.
   * 5. Publish: advance the frame id, then the pose snapshot and debug views;
   *    `TickPipeline` records stats and the trace frame last.
   */
  private runTick(): void {
    const simDt = this.simulationDt();
    this.world.clock.dt = simDt;
    this.waterClock.advance(simDt);
    const pending = this.resolveTickInput(simDt);
    this.ticks.beginPhaseTiming();
    this.tickWorld(pending, simDt);
    if (this.stopped) return;
    this.tickSceneSystems(simDt);
    this.ticks.closePhaseTiming();
    this.flushComponentCommands();
    const completedFrameId = this.frameId;
    this.frameId += 1;
    this.publishTick();
    this.ticks.finishTick(completedFrameId, pending);
  }

  /** Tick phase 1: returns the raw events this tick consumed. */
  private resolveTickInput(simDt: number): RawInputEvent[] {
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
    return pending;
  }

  /** Tick phase 2. An infinite-loop abort ends the phase early. */
  private tickWorld(pending: readonly RawInputEvent[], simDt: number): void {
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
  }

  /** Tick phase 3. */
  private tickSceneSystems(simDt: number): void {
    this.tweens.cancelInvalid();
    this.delays.advance(simDt);
    if (this.admission.canTickScene() || this.admission.hasReadyLayers()) this.animGraphs.tick(simDt);
    if (this.admission.canTickScene() || this.admission.hasReadyLayers()) {
      this.tilemapAnimationTimeMs += simDt * 1000;
      if (this.hasAnimatedTiles) this.emit({ type: "tilemapAnimationTime", elapsedMs: this.tilemapAnimationTimeMs });
      // Only behaviour trees and the crowd read the frame index.
      this.navFrameActors = this.navigation.active || this.behaviourTrees.hasTrees ? actorGuidIndex(this.world.getActors()) : null;
      try {
        this.behaviourTrees.tick(simDt);
        if (this.navigation.active && this.admission.canTickScene()) {
          this.navigation.tickCrowd(this.navFrameActors ?? actorGuidIndex(this.world.getActors()), simDt);
        }
      } finally {
        this.navFrameActors = null;
      }
    }
  }

  /** Tick phase 4. */
  private flushComponentCommands(): void {
    this.flushPainters();
    this.flushTextAppear();
    this.renderEmitter.flushDeformers();
  }

  /** Tick phase 5, after the frame id advanced. */
  private publishTick(): void {
    if (this.admission.canTickScene() || this.admission.hasReadyLayers()) {
      this.snapshots.publishTick();
      this.physics.emitDebugColliders();
      this.navigation.emitDebug();
      this.behaviourTrees.emitSnapshot();
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

