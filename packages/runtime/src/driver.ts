import {
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type CommandMessage,
  type ControlMessage,
} from "@babylonslate/bridge";
import {
  ClassRegistry,
  World,
  createActorsFromSerializedScene,
  createActorsFromSerializedSceneLayer,
  createWorldSnapshot,
  createDebugInspectSnapshot,
  stringifyWorldSnapshot,
  Actor,
  ActorComponent,
  BObject,
  SceneLayer,
  isSceneLayerExclusiveComponent,
  sceneAssetClassId,
  type ClassKind,
  type DebugInspectSnapshot,
  type TickPhase,
} from "@babylonslate/object-model";
import {
  createDefaultSceneSettings,
  eulerDegreesToQuaternion,
  isSceneLayerDeniedComponent,
  parseSceneLayerAnchor,
  parseSceneLayerHitTest,
  parseOverlayPanelProperties,
  overlayPanelDestFromScale,
  parseSkyboxFaces,
  parseSkyboxSize,
  parseText2DProperties,
  parseText3DProperties,
  normalizeSceneLayer,
  sceneLayerRelativeAnchorWorldPosition,
  SCENE_LAYER_DEFAULT_LAYER_BOUNDS,
  deprojectCursorRay,
  type Transform,
  type SerializedActor,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import {
  InputRingBuffer,
  InputResolver,
  createDefaultInputMappings,
  normalizeInputMappings,
  decodeInputEvents,
  type InputMappings,
  type RawInputEvent,
  type ResolvedInputTick,
} from "@babylonslate/input";
import {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  SoftwarePhysicsBackend,
  type PhysicsWorldKind,
} from "@babylonslate/physics";
import {
  createCommandRegistry,
  createUserCommand,
  TraceRecorder,
  createInfiniteLoopGuard,
  isInfiniteLoopError,
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  DEFAULT_INFINITE_LOOP_COUNT,
  shouldEmitStatsCommand,
  type CommandRegistry,
  type ConsoleCommandHost,
  type InfiniteLoopGuard,
  type RegisteredCommand,
  type TraceBtState,
  type TracePayload,
  type UserCommandDef,
} from "@babylonslate/debugger";
import { LogRingBuffer } from "./log-ring";
import {
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
} from "./diagnostics";
import { mapStackToAnchor, type AnchorEntry } from "./stack-map";
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
import { ScriptHost, type CompiledScript } from "./script-host";
import { shouldSpawnScriptedActor } from "./play-load";
import { PhysicsWorldSync } from "./physics-sync";
import {
  formatDumpActors,
  formatInspectActor,
} from "./console-inspect";
import { actorParentGuid, actorWorldTransforms } from "./actor-world-transform";
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

export type TransportMode = "in-process" | "sab" | "transferable";

export interface RuntimeDriverOptions {
  seed: number;
  dt?: number;
  maxActors?: number;
  maxCatchUpSteps?: number;
  onCommand?: (command: CommandMessage) => void;
  /** Project Settings input mappings; defaults when omitted. */
  inputMappings?: InputMappings;
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
  /** Animation / Sprite Animation clip metadata for BT Play Animation. */
  animClipCatalog?: readonly AnimClipCatalogEntry[];
  /** AnimationGraph documents keyed by asset guid (worker `loadAnimGraphs`). */
  animGraphs?: Readonly<Record<string, AnimGraphDocument>>;
  /** BehaviourTree documents keyed by asset guid (worker `loadBehaviourTrees`). */
  behaviourTrees?: Readonly<Record<string, BehaviourTreeDocument>>;
  blackboards?: Readonly<Record<string, BlackboardDocument>>;
  tilemaps?: Readonly<Record<string, TilemapPayload>>;
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
  /**
   * Hold OnSceneFinishLoading until `notifySceneModelsReady`. Play overlay and
   * the exported player set this; in-process tests leave it false.
   */
  deferSceneModelsReady?: boolean;
}

export interface RuntimeDriver {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  tick(): void;
  /** Fixed-step catch-up from wall/accumulated time; capped. */
  advance(elapsedSeconds: number): void;
  pushInput(events: readonly RawInputEvent[]): void;
  pushInputBuffer(buffer: ArrayBuffer): void;
  setInputMappings(mappings: InputMappings): void;
  /** Most recent resolved input tick (empty before the first tick). */
  getResolvedInput(): ResolvedInputTick;
  copySnapshot(out: Float32Array): boolean;
  getWorld(): World;
  getLogRing(): LogRingBuffer;
  getDiagnostics(): SessionDiagnosticAggregator;
  registerAnchors(assetGuid: string, anchors: readonly AnchorEntry[]): void;
  reportError(
    error: unknown,
    frameId?: number,
    hint?: { btNodeId?: string; assetGuid?: string },
  ): RuntimeDiagnostic | null;
  /** Load compiled graph modules and register their source anchors. */
  loadScripts(scripts: readonly CompiledScript[]): Promise<void>;
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
  realizePlayWorld(): void;
  /** Complete a deferred scene load after the host finishes mesh instantiation. */
  notifySceneModelsReady(sceneAssetGuid: string): void;
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
  ): void;
  applySceneLayerPointer(
    message: Extract<ControlMessage, { type: "sceneLayerPointer" }>,
  ): void;
  applyAudioVoiceEnded(
    message: Extract<ControlMessage, { type: "audioVoiceEnded" }>,
  ): void;
  executeConsoleCommand(command: string): { success: boolean; output: string };
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
  readonly transportMode: TransportMode;
  readonly lastScriptMs: number;
  readonly lastPhysicsMs: number;
}

export function createInProcessRuntime(
  options: RuntimeDriverOptions,
): RuntimeDriver {
  return new InProcessRuntime(options, "in-process");
}

class InProcessRuntime implements RuntimeDriver {
  readonly transportMode: TransportMode;
  private readonly world: World;
  private readonly snapshots: SeqLockSnapshotPair;
  private readonly input = new InputRingBuffer(512);
  private readonly resolver: InputResolver;
  private resolvedInput: ResolvedInputTick = {
    actions: {},
    axes: {},
    axes2D: {},
    gamepadConnections: [],
    cursor: { x: 0, y: 0, pressed: false },
  };
  /** Mutable box so TickContext can read connections without aliasing `this`. */
  private readonly connectionBox: {
    current: ResolvedInputTick["gamepadConnections"];
  } = { current: [] };
  private readonly logs = new LogRingBuffer(512);
  private readonly diagnostics = new SessionDiagnosticAggregator();
  private readonly anchors = new Map<string, readonly AnchorEntry[]>();
  private readonly onCommand?: (command: CommandMessage) => void;
  private readonly maxCatchUp: number;
  private readonly dt: number;
  private readonly physicsWorldKind: PhysicsWorldKind;
  private gravity: [number, number, number];
  private readonly havokWasmUrl: string | undefined;
  private readonly preferSoftwarePhysics: boolean;
  private accumulator = 0;
  private paused = false;
  private renderQuality = "high";
  private shadowQuality = "1024";
  private resolutionScale = 1;
  private frameCap = 60;
  private volume = 1;
  private timeDilation = 1;
  private showCollision = false;
  private running = false;
  private frameId = 0;
  private slotByGuid = new Map<string, number>();
  private nextSlot = 0;
  private _lastScriptMs = 0;
  private _lastPhysicsMs = 0;
  private phaseScriptMs = 0;
  private phasePhysicsMs = 0;
  private readonly scriptHost: ScriptHost;
  private physicsSync: PhysicsWorldSync;
  private overlayPhysicsSync: PhysicsWorldSync;
  private readonly overlayGravity: [number, number, number];
  private readonly overlayDesignPose = new Map<string, { x: number; y: number }>();
  private playCanvasWidth = 1;
  private playCanvasHeight = 1;
  private playScene: SerializedScene | undefined;
  private playSceneGuid: string;
  private readonly gameInstanceClass: string;
  private readonly sceneLibrary = new Map<string, SerializedScene>();
  private readonly sceneGuidByKey = new Map<string, string>();
  private readonly sceneLayerLibrary = new Map<string, SerializedSceneLayer>();
  private playWorldRealized = false;
  private sceneLoadingProgress = 1;
  private readonly deferSceneModelsReady: boolean;
  private pendingSceneFinish: { name: string; guid: string } | null = null;
  private gameInstanceBound = false;
  /** A script `Possess Camera` outranks the authored per-camera option. */
  private cameraPossessedByScript = false;
  private possessedCameraSlotId: number | null = null;
  private readonly commands: CommandRegistry;
  private readonly loopGuard: InfiniteLoopGuard;
  private readonly trace = new TraceRecorder();
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
  private tilesets = new Map<string, TilesetPayload>();
  private sprites = new Map<string, SpritePayload>();
  private spriteAnimations = new Map<string, SpriteAnimationPayload>();
  private models = new Map<string, ModelPayload>();
  private complexMeshes = new Map<
    string,
    { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
  >();
  private pendingAnimJumpByComponent = new Map<string, string>();
  private pixelsPerUnit = 100;
  private readonly delayWaiters: Array<{ remaining: number; resolve: () => void }> =
    [];
  private nav: NavigationBackend | null = null;
  private readonly navAgentByActor = new Map<string, string>();
  private readonly navYawByActor = new Map<string, number>();
  private readonly audioAssetGuids = new Set<string>();
  private readonly animClipCatalog = new Map<string, AnimClipCatalogEntry>();
  private readonly btPlayAnimOwnedSlots = new Set<number>();
  private readonly btVoiceByActor = new Map<string, string>();
  private lastStatsEmitMs: number | null = null;
  private readonly lastBtStateJson = new Map<number, string>();

  get lastScriptMs(): number {
    return this._lastScriptMs;
  }

  get lastPhysicsMs(): number {
    return this._lastPhysicsMs;
  }

  constructor(options: RuntimeDriverOptions, mode: TransportMode) {
    this.transportMode = mode;
    this.dt = options.dt ?? 1 / 60;
    this.seed = options.seed;
    this.maxCatchUp = options.maxCatchUpSteps ?? 4;
    this.onCommand = options.onCommand;
    this.physicsWorldKind =
      options.physicsWorld ??
      options.playScene?.settings.physicsWorld ??
      "3d";
    this.gravity = options.gravity ?? [0, -9.81, 0];
    this.havokWasmUrl = options.havokWasmUrl;
    this.preferSoftwarePhysics = options.preferSoftwarePhysics ?? false;
    this.playScene = options.playScene;
    this.playSceneGuid = options.playSceneGuid ?? "play-scene";
    this.gameInstanceClass = options.gameInstanceClass ?? "GameInstance";
    this.deferSceneModelsReady = options.deferSceneModelsReady === true;
    if (options.sceneLibrary) {
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
      this.sceneLibrary.set(this.playSceneGuid, options.playScene);
      this.sceneGuidByKey.set(this.playSceneGuid, this.playSceneGuid);
      if (options.playScene.name) {
        this.sceneLibrary.set(options.playScene.name, options.playScene);
        this.sceneGuidByKey.set(options.playScene.name, this.playSceneGuid);
      }
    }
    this.commands = createCommandRegistry({
      includeDebug: options.includeDebugCommands ?? true,
    });
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
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
    if (options.tilemaps) {
      this.tilemaps = new Map(Object.entries(options.tilemaps));
    }
    if (options.tilesets) {
      this.tilesets = new Map(Object.entries(options.tilesets));
    }
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
      options.inputMappings ?? createDefaultInputMappings(),
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
      { actorFilter: (actor) => actor.sceneLayerId == null },
    );
    this.overlayPhysicsSync = new PhysicsWorldSync(
      createSoftwarePhysicsBackend("2d", {
        x: this.overlayGravity[0],
        y: this.overlayGravity[1],
        z: this.overlayGravity[2],
      }),
      { actorFilter: (actor) => actor.sceneLayerId != null },
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
      onPhysics: (ctx) => {
        this.physicsSync.step(ctx.dt, this.world);
        this.overlayPhysicsSync.step(ctx.dt, this.world);
        this.dispatchCollisionEvents();
      },
    });
    const resolved = () => this.resolvedInput;
    const connections = this.connectionBox;
    this.world.setInputProvider({
      isActionHeld: (action) => resolved().actions[action]?.held ?? false,
      wasActionPressed: (action) =>
        resolved().actions[action]?.pressed ?? false,
      wasActionReleased: (action) =>
        resolved().actions[action]?.released ?? false,
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

    this.scriptHost = new ScriptHost({
      interfaceRegistry: this.world.interfaceRegistry,
      classRegistry: registry,
      checkInfiniteLoop: () => this.loopGuard.check(),
      log: (severity, category, message) => {
        this.logs.push({
          severity,
          category,
          message,
          frameId: this.frameId,
          tickIndex: this.world.clock.tickIndex,
        });
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
      },
      addComponent: (actor, classId, transform) => {
        const target = actor;
        if (!target || target.destroyed) return null;
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
        const slotId = this.slotByGuid.get(owner.guid);
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
      spawnActor: (classId, transform) => {
        const id = String(classId ?? "").trim();
        if (!id) return null;
        return this.spawnScriptedActor({
          classId: id,
          transform: coerceTransform(transform),
        });
      },
      getActors: () => this.world.getActors(),
      getSceneReference: () => {
        const scene = this.world.currentScene;
        return scene && !scene.destroyed ? scene : null;
      },
      getSceneLoadingProgress: () => {
        const value = this.sceneLoadingProgress;
        if (!Number.isFinite(value)) return 0;
        return Math.min(1, Math.max(0, value));
      },
      setWorldGravity: (gravity) => {
        this.setWorldGravity(gravity);
      },
      executeConsoleCommand: (command) => this.executeConsoleCommand(command),
      delay: (seconds) =>
        new Promise<void>((resolve) => {
          this.delayWaiters.push({
            remaining: Math.max(0, Number(seconds) || 0),
            resolve,
          });
        }),
      reportError: (error) => {
        this.reportError(error);
      },
      findActor: (actorId) => {
        const actor = this.world.findActor(actorId);
        if (!actor || actor.destroyed) return undefined;
        return actor;
      },
      lineTrace: (start, end) => this.physicsSync.lineTrace(start, end),
      projectCursorToScene: (channel, options) =>
        this.projectCursorToScene(channel, options),
      sphereOverlap: (center, radius) =>
        this.physicsSync.sphereOverlap(center, radius),
      shapeSweep: (shape, start, end) =>
        this.physicsSync.shapeSweep(shape, start, end),
      addImpulse: (actor, impulse, strength) => {
        const target = actor;
        if (!target) return;
        this.physicsSync.addImpulse(
          target.guid,
          impulse,
          strength,
        );
      },
      moveCharacter: (actor, translation, dt, offset) => {
        const target = actor;
        if (!target) return;
        this.physicsSync.moveCharacter(target, translation, dt, offset);
      },
      changeScene: (scene) => {
        this.applyChangeScene(scene);
      },
      createSceneLayer: (assetGuid, zOrder) =>
        this.createSceneLayer(assetGuid, zOrder),
      removeSceneLayer: (layerGuid) => {
        this.removeSceneLayer(layerGuid);
      },
      clearSceneLayers: () => {
        this.clearSceneLayers();
      },
      registerSceneLayerPostProcess: (layerGuid, materialGuid) => {
        this.registerSceneLayerPostProcess(layerGuid, materialGuid);
      },
      unregisterSceneLayerPostProcess: (layerGuid, materialGuid) => {
        this.unregisterSceneLayerPostProcess(layerGuid, materialGuid);
      },
      setRenderResolution: (width, height) => {
        const nextWidth = Math.max(1, Math.round(Number(width) || 0));
        const nextHeight = Math.max(1, Math.round(Number(height) || 0));
        this.emit({
          type: "setRenderResolution",
          width: nextWidth,
          height: nextHeight,
        });
      },
      possessCamera: (target) => {
        this.possessCamera(target);
      },
      updateIllumination: (target) => {
        this.reemitIllumination(target);
      },
      refreshComponent: (component) => {
        const owner = component.owner;
        if (!owner || owner.destroyed) return;
        this.applyOverlayAnchor(owner);
        const slotId = this.slotByGuid.get(owner.guid);
        if (slotId !== undefined) {
          this.emitMeshAssignment(owner, slotId);
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
        sync.applyComponent(component);
      },
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

  async loadPhysics(): Promise<void> {
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
    });
    this.physicsSync.dispose();
    this.physicsSync = new PhysicsWorldSync(backend, {
      actorFilter: (actor) => actor.sceneLayerId == null,
    });
    this.bindPhysicsContent(this.physicsSync);
    this.physicsSync.syncFromWorld(this.world);

    const overlayBackend = await createPhysicsBackend({
      kind: "2d",
      gravity: {
        x: this.overlayGravity[0],
        y: this.overlayGravity[1],
        z: this.overlayGravity[2],
      },
    });
    this.overlayPhysicsSync.dispose();
    this.overlayPhysicsSync = new PhysicsWorldSync(overlayBackend, {
      actorFilter: (actor) => actor.sceneLayerId != null,
    });
    this.bindPhysicsContent(this.overlayPhysicsSync);
    this.overlayPhysicsSync.syncFromWorld(this.world);
  }

  getPhysicsSync(): PhysicsWorldSync | null {
    return this.physicsSync;
  }

  getOverlayPhysicsSync(): PhysicsWorldSync | null {
    return this.overlayPhysicsSync;
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
      this.playScene.settings.gravity = next;
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
    const document = normalizeSceneLayer(raw);
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
    this.emit({
      type: "sceneLayerCreate",
      layerId: layer.guid,
      assetGuid: guid,
      zOrder: layer.zOrder,
      ownerSceneGuid: layer.ownerSceneGuid,
      postProcessStack: layer.postProcessStack.map((entry) => ({ ...entry })),
      layerBounds: { ...layer.layerBounds },
    });
    const remapped = remapOverlaySerializedActors(
      document.actors,
      layer.guid,
      (id) => this.world.findActor(id) != null,
    );
    const actors = createActorsFromSerializedSceneLayer(
      this.world,
      { ...document, actors: remapped },
      layer.guid,
      (classId) => {
        const hooks = this.scriptHost.hooksFor(classId);
        if (!hooks) return undefined;
        return {
          onCreation: (self) => this.guardScript(() => hooks.onCreation?.(self)),
          onTick: (self, ctx) =>
            this.guardScript(() => hooks.onTick?.(self, ctx)),
          onDestroyed: (self) =>
            this.guardScript(() => hooks.onDestroyed?.(self)),
        };
      },
    );
    for (const actor of actors) {
      this.scriptHost.bindInterfaceHandlers(actor);
      this.applyActorDefaults(actor);
      this.assignSlot(actor);
      this.world.spawnActorNow(actor);
    }
    for (const actor of actors) {
      this.ensureOverlayDesignPose(actor);
    }
    for (const actor of actors) {
      this.applyOverlayAnchor(actor);
    }
    for (const actor of actors) {
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      this.emitMeshAssignment(actor, slotId);
      this.emitAudioComponents(actor);
      this.emitParticleComponents(actor);
    }
    return layer;
  }

  removeSceneLayer(layerGuid: string): void {
    const layer = this.world.findSceneLayer(layerGuid);
    if (!layer) return;
    for (const actor of [...this.world.getActors()]) {
      if (actor.sceneLayerId !== layer.guid) continue;
      this.emitAudioStops(actor);
      this.emitParticleStops(actor);
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId !== undefined) {
        this.emit({ type: "despawn", slotId, actorGuid: actor.guid });
        this.slotByGuid.delete(actor.guid);
      }
      this.overlayDesignPose.delete(actor.guid);
    }
    this.world.destroySceneLayer(layer.guid);
    this.emit({ type: "sceneLayerRemove", layerId: layer.guid });
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
    layer.postProcessStack.push({ materialGuid: guid, enabled: true });
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
    for (const actor of this.world.getActors()) {
      this.ensureOverlayDesignPose(actor);
      this.applyOverlayAnchor(actor);
    }
    this.overlayPhysicsSync.syncFromWorld(this.world);
  }

  applySceneLayerPointer(
    message: Extract<ControlMessage, { type: "sceneLayerPointer" }>,
  ): void {
    const actor = this.world.findActor(message.actorGuid);
    if (!actor || actor.destroyed || !actor.sceneLayerId) return;
    const requested =
      typeof message.componentId === "string" ? message.componentId.trim() : "";
    const resolved = resolveOverlayPointerButton(this.world, actor, requested);
    if (!resolved) return;
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
      this.scriptHost.invokeEvent(
        actor.classId,
        "onAudioFinished",
        actor,
        {},
        component.guid,
      );
      return;
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

  private applyOverlayAnchor(actor: Actor): void {
    if (!actor.sceneLayerId) return;
    const ownAnchor = liveOverlayAnchor(actor);
    const parentId = actorParentGuid(actor);
    const parent = parentId ? this.world.findActor(parentId) : undefined;
    if (ownAnchor && parent?.sceneLayerId) {
      if (!liveOverlayAnchor(parent)) {
        this.applyRelativeOverlayAnchor(parent, ownAnchor);
      }
      actor.transform.position.x = 0;
      actor.transform.position.y = 0;
      return;
    }
    if (!ownAnchor) return;
    this.applyRelativeOverlayAnchor(actor, ownAnchor);
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

  private spawnOwnedSceneLayers(): void {
    for (const entry of this.playScene?.settings.sceneLayers ?? []) {
      if (!entry.enabled) continue;
      this.createSceneLayer(entry.assetGuid, entry.zOrder, this.playSceneGuid);
    }
  }

  private bindPhysicsContent(sync: PhysicsWorldSync): void {
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
    for (const script of scripts) {
      this.registerScriptClass(script);
      await this.scriptHost.load(script);
      if (script.anchors.length > 0) {
        this.registerAnchors(script.assetGuid, script.anchors);
      }
      if (script.command) {
        this.bindUserCommand({
          ...script.command,
          classId: script.classId,
        });
      }
    }
  }

  private registerScriptClass(script: CompiledScript): void {
    const requestedParent =
      script.parentClassId?.trim() || "Actor";
    const parentClassId = this.world.classRegistry.has(requestedParent)
      ? requestedParent
      : "Actor";
    const kind: ClassKind =
      this.world.classRegistry.get(parentClassId)?.kind ?? "actor";
    this.world.classRegistry.ensure({
      id: script.classId,
      parentClassId,
      kind,
      variables: (script.variables ?? []).map((variable) => ({
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
      implementedInterfaces: [...(script.implementedInterfaces ?? [])],
    });
  }

  spawnScriptedActor(options: {
    classId: string;
    variables?: Record<string, unknown>;
    implementedInterfaces?: string[];
    transform?: Transform;
  }): Actor | null {
    if (!this.canSpawnActorClass(options.classId)) return null;
    const hooks = this.scriptHost.hooksFor(options.classId);
    if (!hooks) return null;
    const actor = this.world.createActor({
      classId: options.classId,
      variables: options.variables,
      implementedInterfaces: options.implementedInterfaces,
      transform: options.transform,
      hooks: {
        onCreation: (self) => this.guardScript(() => hooks.onCreation?.(self)),
        onTick: (self, ctx) =>
          this.guardScript(() => hooks.onTick?.(self, ctx)),
        onDestroyed: (self) =>
          this.guardScript(() => hooks.onDestroyed?.(self)),
      },
    });
    this.scriptHost.bindInterfaceHandlers(actor);
    try {
      this.realizeActor(actor);
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
    return actor;
  }

  realizePlayWorld(): void {
    if (this.playWorldRealized) return;
    this.playWorldRealized = true;
    this.loopGuard.reset();
    try {
      this.world.start();
      const scene = this.playScene;
      const guid = this.playSceneGuid;
      const name =
        typeof scene?.name === "string" && scene.name.trim()
          ? scene.name
          : guid;
      if (scene) {
        this.sceneLoadingProgress = 0;
        this.world.beginSceneLoad(name);
        const authoredGravity = scene.settings?.gravity;
        const gravity = {
          x: Number(authoredGravity?.[0] ?? this.gravity[0]),
          y: Number(authoredGravity?.[1] ?? this.gravity[1]),
          z: Number(authoredGravity?.[2] ?? this.gravity[2]),
        };
        this.setWorldGravity(gravity);
        this.world.createScene({
          assetGuid: guid,
          sceneName: name,
          variables: { gravity },
        });
        this.emit({ type: "activeScene", sceneAssetGuid: guid });
      }
      if (scene) {
        const actors = createActorsFromSerializedScene(
          this.world,
          scene,
          (classId) => {
            const hooks = this.scriptHost.hooksFor(classId);
            if (!hooks) return undefined;
            return {
              onCreation: (self) => this.guardScript(() => hooks.onCreation?.(self)),
              onTick: (self, ctx) =>
                this.guardScript(() => hooks.onTick?.(self, ctx)),
              onDestroyed: (self) =>
                this.guardScript(() => hooks.onDestroyed?.(self)),
            };
          },
        );
        const total = actors.length;
        let realized = 0;
        for (const actor of actors) {
          this.scriptHost.bindInterfaceHandlers(actor);
          this.realizeActor(actor);
          realized += 1;
          this.sceneLoadingProgress =
            total > 0 ? (realized / total) * 0.5 : 0.5;
        }
        if (total === 0) this.sceneLoadingProgress = 0.5;
      }
      this.registerNavAgents();
      this.registerNavObstacles();
      this.attemptPossessViewTarget();
      if (scene) {
        this.finishOrDeferSceneLoad(name, guid);
      }
      this.spawnOwnedSceneLayers();
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
  }

  /**
   * Opt-in per camera (`attemptPossessViewTarget`). Runs after every actor has
   * spawned so the slot exists, and yields to a Begin Play `Possess Camera`
   * because an explicit script choice outranks the authored default.
   */
  private attemptPossessViewTarget(): void {
    if (this.cameraPossessedByScript) return;
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

  private applyChangeScene(sceneKey: string): void {
    const key = String(sceneKey ?? "").trim();
    const next = this.sceneLibrary.get(key);
    if (!next) {
      this.emit({
        type: "log",
        severity: "warning",
        category: "scene",
        message: `changeScene: no scene asset loaded for ${key}`,
        frameId: this.frameId,
      });
      return;
    }
    this.pendingSceneFinish = null;
    this.world.exitActiveScene();
    const departingSceneGuid = this.playSceneGuid;
    for (const layer of [...this.world.getSceneLayers()]) {
      if (layer.ownerSceneGuid === departingSceneGuid) {
        this.removeSceneLayer(layer.guid);
      }
    }
    for (const actor of [...this.world.getActors()]) {
      if (actor.sceneLayerId) continue;
      const slotId = this.slotByGuid.get(actor.guid);
      this.emitAudioStops(actor);
      this.emitParticleStops(actor);
      if (slotId !== undefined) {
        this.emit({ type: "despawn", slotId, actorGuid: actor.guid });
        this.slotByGuid.delete(actor.guid);
      }
      this.world.destroyActor(actor.guid);
    }
    this.world.flushPending();
    this.animEvalByComponent.clear();
    this.animInitializedBySlot.clear();
    this.pendingAnimJumpByComponent.clear();
    this.btEvalBySlot.clear();
    this.lastBtStateJson.clear();
    this.clearNavAgents();
    this.playScene = next;
    this.playSceneGuid = this.sceneGuidByKey.get(key) ?? key;
    this.playWorldRealized = false;
    // The new scene owns its own camera choice.
    this.cameraPossessedByScript = false;
    this.possessedCameraSlotId = null;
    this.realizePlayWorld();
  }

  executeConsoleCommand(command: string): { success: boolean; output: string } {
    return this.commands.execute(command, this.consoleHost());
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

  private finalizeTrace(): void {
    if (!this.trace.isRecording) return;
    this.lastTrace = this.trace.stop();
    if (this.lastTrace) {
      this.emit({
        type: "trace",
        payload: this.lastTrace as unknown as Record<string, unknown>,
      });
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
    await initNavigation();
    this.nav ??= createNavigationBackend();
    this.nav.importNavMesh(bytes);
    this.clearNavAgents();
    if (this.playWorldRealized) {
      this.registerNavAgents();
      this.registerNavObstacles();
    }
  }

  setNavAgentTarget(actorGuid: string, target: NavPoint): boolean {
    if (!this.nav) return false;
    if (!this.navAgentByActor.has(actorGuid)) {
      const actor = this.world.findActor(actorGuid);
      if (actor) this.registerNavAgent(actor);
    }
    const agentId = this.navAgentByActor.get(actorGuid);
    if (!agentId) return false;
    return this.nav.setAgentTarget(agentId, this.toNav(target));
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
    const agentId = this.navAgentByActor.get(actorGuid);
    if (!agentId || !this.nav) return;
    this.nav.stopAgent(agentId);
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
  }

  private registerNavAgents(): void {
    if (!this.nav) return;
    for (const actor of this.world.getActors()) {
      this.registerNavAgent(actor);
    }
  }

  private registerNavAgent(actor: Actor): void {
    if (!this.nav || actor.destroyed) return;
    if (this.navAgentByActor.has(actor.guid)) return;
    const component = actor.components.find(
      (entry) => entry.classId === "NavAgentComponent" && !entry.destroyed,
    );
    if (!component) return;
    const params = parseNavAgentParams(
      Object.fromEntries(component.variables),
    );
    const id = this.nav.addAgent(
      this.toNav({
        x: actor.transform.position.x,
        y: actor.transform.position.y,
        z: actor.transform.position.z,
      }),
      params,
    );
    if (!id) return;
    this.navAgentByActor.set(actor.guid, id);
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

  private registerNavObstacles(): void {
    if (!this.nav) return;
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "NavMeshBlockerComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const props = parseNavMeshBlockerProperties(
        Object.fromEntries(component.variables),
      );
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
      const pose = this.toNavObstaclePose(aabb.center);
      const navSize = this.toNavObstacleSize(aabb.size);
      if (props.area === "cost") {
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
      this.nav.addObstacle("box", pose, navSize);
    }
  }

  private syncNavCostVolumes(): void {
    if (!this.nav) return;
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
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

  private tickCrowd(): void {
    if (!this.nav) return;
    this.syncNavCostVolumes();
    this.nav.stepCrowd(this.simulationDt());
    for (const [actorGuid, agentId] of this.navAgentByActor) {
      const actor = this.world.findActor(actorGuid);
      if (!actor || actor.destroyed) continue;
      const position = this.nav.agentPosition(agentId);
      if (!position) continue;
      const world = this.fromNav(position);
      actor.transform.position.x = world.x;
      actor.transform.position.y = world.y;
      actor.transform.position.z = world.z;
      const velocity = this.nav.agentVelocity(agentId) ?? { x: 0, y: 0, z: 0 };
      const previous = this.navYawByActor.get(actorGuid) ?? 0;
      const yaw = facingYawFromVelocity(velocity, previous);
      this.navYawByActor.set(actorGuid, yaw);
      const euler =
        this.physicsWorldKind === "2d"
          ? ([0, 0, (yaw * 180) / Math.PI] as [number, number, number])
          : ([0, (yaw * 180) / Math.PI, 0] as [number, number, number]);
      const quat = eulerDegreesToQuaternion(euler);
      actor.transform.rotation.x = quat[0];
      actor.transform.rotation.y = quat[1];
      actor.transform.rotation.z = quat[2];
      actor.transform.rotation.w = quat[3];
    }
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
    const liveKeys = new Set<string>();
    const liveEvalKeys = new Set<string>();
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      if (this.btPlayAnimOwnedSlots.has(slotId)) continue;
      for (const component of actor.components) {
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
          this.physicsSync.setActorSpriteClip(actor.guid, {
            assetGuid: clip.assetGuid,
            clipName: clip.clipName,
            normalisedTime: next.normalisedTime,
          });
        } else {
          this.physicsSync.setActorSpriteClip(actor.guid, null);
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
    for (const key of [...this.animInitializedBySlot]) {
      if (!liveKeys.has(key)) this.animInitializedBySlot.delete(key);
    }
    for (const evalKey of [...this.animEvalByComponent.keys()]) {
      if (!liveEvalKeys.has(evalKey)) this.animEvalByComponent.delete(evalKey);
    }
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
    const extras = {
      btFinish: (result: "success" | "failure") => {
        memory.__btResult = result;
      },
      btEvaluate: () => undefined,
      getBlackboard: (key: string) => blackboard[key],
      setBlackboard: (key: string, value: unknown) => {
        blackboard[key] = value;
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
    const result = memory.__btResult;
    if (result === "success" || result === "failure") return result;
    return "running";
  }

  private tickMoveTo(
    actor: Actor,
    node: { properties?: Record<string, unknown> },
    memory: Record<string, unknown>,
  ): BtResult {
    const dest = navPointFromUnknown(node.properties?.destination);
    if (!dest) return "failure";
    const target = this.toNav(dest);
    if (memory.__moveRequested !== true) {
      memory.__moveRequested = true;
      if (!this.setNavAgentTarget(actor.guid, dest)) return "failure";
    }
    const agentId = this.navAgentByActor.get(actor.guid);
    const position = agentId ? this.nav?.agentPosition(agentId) : null;
    if (!position) return "failure";
    const accept =
      typeof node.properties?.acceptRadius === "number" &&
      Number.isFinite(node.properties.acceptRadius)
        ? node.properties.acceptRadius
        : 0.75;
    const distance = Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
    );
    return distance <= accept ? "success" : "running";
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
      this.physicsSync.setActorSpriteClip(actor.guid, {
        assetGuid: clip.guid,
        clipName: clip.clipName,
        normalisedTime,
      });
    } else {
      this.physicsSync.setActorSpriteClip(actor.guid, null);
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
    this.physicsSync.setActorSpriteClip(actor.guid, null);
  }

  private abortBtTask(
    actor: Actor,
    node: { id: string; classId: string },
    blackboard: BlackboardValues,
    memory: Record<string, unknown>,
  ): void {
    memory.__activated = false;
    delete memory.__btResult;
    delete memory.__moveRequested;
    delete memory.__soundPlayed;
    const classId = builtinClassId(node.classId);
    if (classId === "bt.task.moveTo") {
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
      if (actor.destroyed) continue;
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
      const blackboardGuid = this.stringGuid(component.getVariable("blackboardGuid"));
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
      const payload = JSON.stringify({
        status: next.status,
        btNodeId: next.btNodeId,
        lastResults: next.lastResults,
        blackboard: next.blackboard,
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
        blackboard: next.blackboard,
        stack: next.stack,
      });
    }
  }

  private simulationDt(): number {
    return this.dt * this.timeDilation;
  }

  private emitDebugColliders(): void {
    if (!this.showCollision) return;
    this.emit({
      type: "debugColliders",
      colliders: this.physicsSync.getBackend().listDebugColliders(),
    });
  }

  private consoleHost(): ConsoleCommandHost {
    const emitSetting = (key: string, value: string | number | boolean) => {
      this.emit({
        type: "log",
        severity: "log",
        category: "console",
        message: `${key}=${value}`,
        frameId: this.frameId,
      });
    };
    return {
      changeScene: (scene) => {
        this.applyChangeScene(scene);
      },
      setRenderQuality: (level) => {
        this.renderQuality = String(level);
        this.emit({ type: "setRenderQuality", level: this.renderQuality });
      },
      getRenderQuality: () => this.renderQuality,
      setShadowQuality: (level) => {
        this.shadowQuality = String(level);
        emitSetting("shadowquality", this.shadowQuality);
        this.emit({ type: "setShadowQuality", level: this.shadowQuality });
      },
      getShadowQuality: () => this.shadowQuality,
      setResolutionScale: (scale) => {
        this.resolutionScale = Math.min(2, Math.max(1, Number(scale)));
        this.emit({ type: "setResolutionScale", scale: this.resolutionScale });
      },
      getResolutionScale: () => this.resolutionScale,
      setFrameCap: (fps) => {
        this.frameCap = Number(fps);
        this.emit({ type: "setFrameCap", fps: this.frameCap });
      },
      getFrameCap: () => this.frameCap,
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
        this.emit({ type: "setShowFps", enabled: true });
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
      setShowAudioDebug: (enabled) => {
        this.emit({ type: "setShowAudioDebug", enabled: Boolean(enabled) });
      },
      dumpActors: () => formatDumpActors(this.inspectWorld()),
      inspectActor: (query) =>
        formatInspectActor(this.inspectWorld(), query, null),
      setFreeCam: (enabled) => {
        this.emit({ type: "setFreeCam", enabled: Boolean(enabled) });
      },
      pause: () => {
        this.pause();
        this.emit({ type: "sessionPaused", paused: true });
      },
      resume: () => {
        this.resume();
        this.emit({ type: "sessionPaused", paused: false });
      },
      step: () => {
        const wasPaused = this.paused;
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
        this.lastTrace = null;
        this.trace.start({ seed: this.seed, dt: this.dt });
      },
      stopSnapshot: () => {
        this.finalizeTrace();
      },
    };
  }

  private emitMeshAssignment(actor: Actor, slotId: number): void {
    const skipButtonMesh =
      overlayButtonHasSiblingVisual(actor) ||
      overlayButtonHasParentVisual(actor, this.world);
    const renderables = actor.components.filter((component) =>
      isPlayRenderable(component, skipButtonMesh),
    );
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
      const assetGuid =
        overlayPanel
          ? overlayPanel.source === "material"
            ? overlayPanel.materialGuid
            : overlayPanel.textureGuid
          : (primary.assetGuid ??
            primary.getVariable("assetGuid") ??
            primary.getVariable("textureGuid") ??
            primary.getVariable("materialGuid"));
      const renderableIds = new Set(renderables.map((component) => component.guid));
      const componentsByGuid = new Map(
        actor.components.map((component) => [component.guid, component]),
      );
      const parts = playPartsNeeded(renderables)
        ? renderables.map((component) =>
            playMeshPartOf(
              component,
              nearestVisualParentId(
                component,
                componentsByGuid,
                renderableIds,
              ),
            ),
          )
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
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
        meshKind,
        actorGuid: actor.guid,
        ...(meshKind === "sprite" || meshKind === "tilemap"
          ? playSortingOf(primary)
          : {}),
        ...(actor.sceneLayerId
          ? {
              sceneLayerId: actor.sceneLayerId,
              hitTest: overlayHitTestOf(actor, this.world),
              hasButton: overlayActorOrChildHasButton(actor, this.world),
              ...(overlayButtonComponentId(actor, this.world)
                ? { buttonComponentId: overlayButtonComponentId(actor, this.world) }
                : {}),
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
        ...(text2dComp ? { text2d: text2dAssignPayload(text2dComp) } : {}),
        ...(overlayPanel ? { overlayPanel } : {}),
        ...(parts ? { parts } : {}),
      });
      this.emitMaterialAssignments(renderables, slotId, Boolean(parts));
      return;
    }
    const fill = actor.components.find(
      (component) =>
        component.classId === "HemisphericFillLightComponent" &&
        !component.destroyed,
    );
    if (fill) {
      const color = rgbTuple(fill.getVariable("color"));
      const ground = fill.getVariable("groundColor");
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "light:hemispheric",
        light: {
          color,
          intensity: Number(fill.getVariable("intensity") ?? 0.9),
          enabled: fill.getVariable("enabled") !== false,
          groundColor: ground == null ? [0, 0, 0] : rgbTuple(ground),
        },
        parts: [playMeshPartOf(fill)],
      });
      return;
    }
    const light = actor.components.find(
      (component) =>
        component.classId === "LightComponent" && !component.destroyed,
    );
    if (light) {
      const kind = light.getVariable("lightKind");
      const color = rgbTuple(light.getVariable("color"));
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: `light:${typeof kind === "string" ? kind : "point"}`,
        light: {
          color,
          intensity: Number(light.getVariable("intensity") ?? 1),
          enabled: light.getVariable("enabled") !== false,
          range: Number(light.getVariable("range") ?? 10),
          innerAngle: Number(light.getVariable("innerAngle") ?? 30),
          outerAngle: Number(light.getVariable("outerAngle") ?? 45),
          castShadows: light.getVariable("castShadows") === true,
        },
        parts: [playMeshPartOf(light)],
      });
      return;
    }
    const camera = actor.components.find(
      (component) =>
        component.classId === "CameraComponent" && !component.destroyed,
    );
    if (camera) {
      const projection = camera.getVariable("projectionMode");
      const settings = this.playScene?.settings;
      const isDefault =
        settings?.mainCameraActorId === actor.guid &&
        settings.mainCameraComponentId === camera.guid;
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "camera",
        camera: {
          projectionMode:
            projection === "orthographic" ? "orthographic" : "perspective",
          fieldOfView: Number(camera.getVariable("fieldOfView") ?? 60),
          orthographicSize: Number(camera.getVariable("orthographicSize") ?? 5),
          nearClip: Number(camera.getVariable("nearClip") ?? 0.1),
          farClip: Number(camera.getVariable("farClip") ?? 1000),
          isDefault,
        },
        parts: [playMeshPartOf(camera)],
      });
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
    }
  }


  private applyActorDefaults(actor: Actor): void {
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

  private realizeActor(actor: Actor): void {
    this.applyActorDefaults(actor);
    const slotId = this.assignSlot(actor);
    this.emitMeshAssignment(actor, slotId);
    this.emitAudioComponents(actor);
    this.emitParticleComponents(actor);
    this.world.spawnActorNow(actor);
  }

  private emitAudioComponents(actor: Actor): void {
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
        play: component.getVariable("playOnStart") !== false,
        sortingLayer:
          typeof sortingLayer === "string" && sortingLayer.trim() !== ""
            ? sortingLayer
            : "Default",
        orderInLayer:
          typeof orderInLayer === "number" && Number.isFinite(orderInLayer)
            ? Math.round(orderInLayer)
            : 0,
      });
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
      const guid = component.getVariable("materialGuid");
      if (typeof guid !== "string" || guid === "") continue;
      this.emit({
        type: "assignMaterial",
        slotId,
        materialAssetGuid: guid,
        ...(multipart ? { componentId: component.guid } : {}),
      });
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
      if (actor.destroyed || actor.sceneLayerId) continue;
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
    _channel?: string,
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
    const ray = deprojectCursorRay(
      this.resolvedInput.cursor,
      { width: this.playCanvasWidth, height: this.playCanvasHeight },
      {
        position: camera.transform.position,
        rotation: camera.transform.rotation,
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
    this.physicsSync.syncFromWorld(this.world);
    const hit = this.physicsSync.lineTrace(ray.origin, ray.end);
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
      if (isInfiniteLoopError(error)) throw error;
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
    const slotId = this.nextSlot++;
    this.slotByGuid.set(actor.guid, slotId);
    this.emit({
      type: "spawn",
      slotId,
      actorGuid: actor.guid,
      classId: actor.classId,
      ...(actor.sceneLayerId ? { sceneLayerId: actor.sceneLayerId } : {}),
    });
    return slotId;
  }

  private bindGameInstance(): void {
    if (this.gameInstanceBound) return;
    this.gameInstanceBound = true;
    const classId = this.gameInstanceClass;
    this.world.setGameInstance(
      this.world.createGameInstance({
        classId,
        guid: "runtime-gi",
        variables: { ticks: 0 },
        hooks: {
          onCreation: (self) => {
            const hooks = this.scriptHost.hooksFor(classId);
            this.guardScript(() => hooks?.onCreation?.(self));
          },
          onTick: (self, ctx) => {
            self.setVariable(
              "ticks",
              Number(self.getVariable("ticks")) + 1,
            );
            const hooks = this.scriptHost.hooksFor(classId);
            this.guardScript(() => hooks?.onTick?.(self, ctx));
          },
          onGameEnd: (self) => {
            this.guardScript(() =>
              this.scriptHost.invokeEvent(classId, "onEnd", self),
            );
          },
          onSceneStartLoading: (self, sceneName) => {
            this.guardScript(() =>
              this.scriptHost.invokeEvent(
                classId,
                "onSceneStartLoading",
                self,
                { sceneName },
              ),
            );
          },
          onSceneFinishLoading: (self, sceneName) => {
            this.guardScript(() =>
              this.scriptHost.invokeEvent(
                classId,
                "onSceneFinishLoading",
                self,
                { sceneName },
              ),
            );
          },
          onFirstSceneLoaded: (self, sceneName) => {
            this.guardScript(() =>
              this.scriptHost.invokeEvent(
                classId,
                "onFirstSceneLoaded",
                self,
                { sceneName },
              ),
            );
          },
          onSceneExit: (self, sceneName) => {
            this.guardScript(() =>
              this.scriptHost.invokeEvent(classId, "onSceneExit", self, {
                sceneName,
              }),
            );
          },
        },
      }),
    );
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

  private finishOrDeferSceneLoad(name: string, guid: string): void {
    if (this.deferSceneModelsReady) {
      this.pendingSceneFinish = { name, guid };
      return;
    }
    this.completeSceneLoad(name);
  }

  private completeSceneLoad(name: string): void {
    this.sceneLoadingProgress = 1;
    this.pendingSceneFinish = null;
    this.world.finishSceneLoad(name);
  }

  notifySceneModelsReady(sceneAssetGuid: string): void {
    const pending = this.pendingSceneFinish;
    if (!pending) return;
    const guid = String(sceneAssetGuid ?? "").trim();
    if (guid && guid !== pending.guid) return;
    this.completeSceneLoad(pending.name);
  }

  start(): void {
    this.running = true;
    this.paused = false;
    this.world.start();
  }

  stop(): void {
    this.running = false;
    this.pendingSceneFinish = null;
    this.finalizeTrace();
    this.world.end();
    this.physicsSync.dispose();
    this.overlayPhysicsSync.dispose();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  pushInput(events: readonly RawInputEvent[]): void {
    for (const event of events) {
      this.input.push(event);
    }
  }

  pushInputBuffer(buffer: ArrayBuffer): void {
    this.pushInput(decodeInputEvents(buffer));
  }

  setInputMappings(mappings: InputMappings): void {
    this.resolver.setMappings(normalizeInputMappings(mappings));
  }

  getResolvedInput(): ResolvedInputTick {
    return this.resolvedInput;
  }

  tick(): void {
    if (!this.running || this.paused) return;
    const simDt = this.simulationDt();
    this.world.clock.dt = simDt;
    // Consume every event queued since the last tick. Gating on event.tick
    // dropped Play worker input: the host stamped with a wall-clock index
    // (performance.now()/16.67) while World.clock.tickIndex stayed small,
    // and drain() discarded the "future" events instead of deferring them.
    // Replay still works because it feeds one tick of events at a time.
    const pending = this.input.drain();
    this.resolvedInput = this.resolver.resolve(pending);
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
    try {
      this.world.tick();
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
    this.advanceDelays();
    this.tickAnimGraphs();
    this.tickBehaviourTrees();
    this.tickCrowd();
    this.closePhaseTiming();

    this._lastScriptMs = this.phaseScriptMs;
    this._lastPhysicsMs = this.phasePhysicsMs;

    this.frameId += 1;
    this.publishSnapshot();
    this.emitDebugColliders();
    const statsNow = nowMs();
    if (shouldEmitStatsCommand(statsNow, this.lastStatsEmitMs)) {
      this.lastStatsEmitMs = statsNow;
      this.emit({
        type: "stats",
        frameId: this.frameId,
        tickIndex: this.world.clock.tickIndex,
        scriptMs: this._lastScriptMs,
        physicsMs: this._lastPhysicsMs,
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
          .filter((entry) => entry.frameId === this.frameId)
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
          blackboard: { ...state.blackboard },
          stack: state.stack.map((frame) => ({ ...frame })),
          nodeMemory: Object.fromEntries(
            Object.entries(state.nodeMemory).map(([id, memory]) => [
              id,
              { ...memory },
            ]),
          ),
        })),
      });
    }
  }

  advance(elapsedSeconds: number): void {
    if (!this.running || this.paused) return;
    this.accumulator += elapsedSeconds;
    let steps = 0;
    while (this.accumulator >= this.dt && steps < this.maxCatchUp) {
      this.tick();
      this.accumulator -= this.dt;
      steps += 1;
    }
    if (steps === this.maxCatchUp) {
      this.accumulator = 0;
    }
  }

  copySnapshot(out: Float32Array): boolean {
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

  registerAnchors(assetGuid: string, anchors: readonly AnchorEntry[]): void {
    this.anchors.set(assetGuid, anchors);
  }

  reportError(
    error: unknown,
    frameId = this.frameId,
    hint?: { btNodeId?: string; assetGuid?: string },
  ): RuntimeDiagnostic | null {
    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack ?? "";
    const anchor = mapStackToAnchor(stack, this.anchors);
    const diag: RuntimeDiagnostic = {
      code: isInfiniteLoopError(err)
        ? INFINITE_LOOP_DIAGNOSTIC_CODE
        : "runtime.uncaught",
      message: err.message,
      severity: "error",
      assetGuid: hint?.assetGuid ?? this.currentBtAssetGuid ?? anchor?.assetGuid,
      graphId: anchor?.graphId,
      nodeId: hint?.btNodeId ? undefined : anchor?.nodeId,
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
    const remaining: Array<{ remaining: number; resolve: () => void }> = [];
    const due: Array<() => void> = [];
    for (const waiter of this.delayWaiters) {
      waiter.remaining -= this.simulationDt();
      if (waiter.remaining <= 0) due.push(waiter.resolve);
      else remaining.push(waiter);
    }
    this.delayWaiters.length = 0;
    this.delayWaiters.push(...remaining);
    for (const resolve of due) resolve();
  }

  private publishSnapshot(): void {
    const buf = this.snapshots.beginWrite();
    const actors = this.world.getActors();
    const worldTransforms = actorWorldTransforms(actors);
    let count = 0;
    for (const actor of actors) {
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      const world = worldTransforms.get(actor.guid);
      if (!world) continue;
      writeActorSlot(buf, count, {
        slotId,
        position: world.position,
        rotation: world.rotation,
        scale: world.scale,
        flags:
          SNAPSHOT_FLAG_VISIBLE |
          (actor.sceneLayerId ? SNAPSHOT_FLAG_OVERLAY : 0),
      });
      count += 1;
    }
    writeSnapshotHeader(buf, {
      frameId: this.frameId,
      tickIndex: this.world.clock.tickIndex,
      actorCount: count,
      scriptMs: this._lastScriptMs,
      physicsMs: this._lastPhysicsMs,
    });
    this.snapshots.publish();
  }

  private emit(command: CommandMessage): void {
    this.onCommand?.(command);
  }

  private canSpawnActorClass(classId: string): boolean {
    if (!shouldSpawnScriptedActor(classId)) return false;
    if (this.world.classRegistry.isA(classId, "SceneLayerActor")) return false;
    const kind = this.world.classRegistry.get(classId)?.kind;
    return kind !== "object" && kind !== "gameInstance";
  }
}

const OVERLAY_BUTTON_VISUAL_CLASS_IDS = new Set([
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
      !component.destroyed && OVERLAY_BUTTON_VISUAL_CLASS_IDS.has(component.classId),
  );
}

function overlayButtonHasParentVisual(actor: Actor, world: World): boolean {
  const parentId = actorParentGuid(actor);
  if (!parentId) return false;
  const parent = world.findActor(parentId);
  return parent ? overlayActorHasVisual(parent) : false;
}

function overlayActorOrChildHasButton(actor: Actor, world: World): boolean {
  if (liveOverlayButtons(actor).length > 0) return true;
  return world.getActors().some(
    (child) =>
      actorParentGuid(child) === actor.guid && liveOverlayButtons(child).length > 0,
  );
}

function liveOverlayAnchor(actor: Actor): ActorComponent | undefined {
  return actor.components.find(
    (component) =>
      component.classId === "2DAnchorComponent" && !component.destroyed,
  );
}

function liveOverlayButtons(actor: Actor): ActorComponent[] {
  return actor.components.filter(
    (component) =>
      component.classId === "2DButtonComponent" && !component.destroyed,
  );
}

function overlayButtonComponentId(
  actor: Actor,
  world?: World,
): string | undefined {
  const buttons = liveOverlayButtons(actor);
  if (buttons.length === 1) return buttons[0]!.guid;
  if (buttons.length > 1 || !world) return undefined;
  const childButtons = world.getActors()
    .filter((child) => actorParentGuid(child) === actor.guid)
    .flatMap((child) => liveOverlayButtons(child));
  return childButtons.length === 1 ? childButtons[0]!.guid : undefined;
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

function componentIdFromColliderPhysicsId(
  colliderId: string | undefined,
): string | undefined {
  if (!colliderId) return undefined;
  return colliderId.startsWith("collider:")
    ? colliderId.slice("collider:".length)
    : colliderId;
}

function isPlayRenderable(
  component: ActorComponent,
  skipButtonMesh: boolean,
): boolean {
  if (component.destroyed) return false;
  if (component.classId === "2DButtonComponent") return !skipButtonMesh;
  if (
    component.classId === "MeshComponent" ||
    component.classId === "SpriteComponent" ||
    component.classId === "TilemapComponent" ||
    component.classId === "SkyboxComponent" ||
    component.classId === "Text3DComponent" ||
    component.classId === "2DTextureComponent" ||
    component.classId === "2DMaterialComponent" ||
    component.classId === "2DPanelComponent" ||
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

function overlayHitTestOf(
  actor: Actor,
  world?: World,
): "ignore" | "block" | "passThrough" {
  const button = liveOverlayButtons(actor)[0];
  if (button) {
    return parseSceneLayerHitTest(button.getVariable("hitTest"), "block");
  }
  if (world) {
    const childButtons = world
      .getActors()
      .filter((child) => actorParentGuid(child) === actor.guid)
      .flatMap((child) => liveOverlayButtons(child));
    if (childButtons.length > 0) {
      return parseSceneLayerHitTest(
        childButtons[0]!.getVariable("hitTest"),
        "block",
      );
    }
  }
  const visual = actor.components.find(
    (component) =>
      (component.classId === "2DTextureComponent" ||
        component.classId === "2DMaterialComponent" ||
        component.classId === "2DPanelComponent" ||
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
  if (component.classId === "SpriteComponent") return "sprite";
  if (component.classId === "TilemapComponent") return "tilemap";
  if (component.classId === "SkyboxComponent") return "skybox";
  if (component.classId === "Text3DComponent") return "text3d";
  if (component.classId === "2DTextComponent") return "2dtext";
  if (component.classId === "2DRichTextComponent") return "2drichtext";
  if (component.classId === "2DTextureComponent") return "2dtexture";
  if (component.classId === "2DMaterialComponent") return "2dmaterial";
  if (component.classId === "2DPanelComponent") return "2dpanel";
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
    components.length > 1 ||
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
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["text2d"]> {
  const parsed = parseText2DProperties(
    {
      text: component.getVariable("text"),
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
    },
    { rich: component.classId === "2DRichTextComponent" },
  );
  return {
    text: parsed.text,
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
    meshKind: playMeshKindOf(component),
    meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
    parentId,
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
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
  };
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

function remapOverlaySerializedActors(
  actors: readonly SerializedActor[],
  layerId: string,
  isTaken: (id: string) => boolean,
): SerializedActor[] {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const actor of actors) {
    let id = actor.id;
    if (isTaken(id) || used.has(id)) {
      id = `${layerId}:${actor.id}`;
    }
    idMap.set(actor.id, id);
    used.add(id);
  }
  return actors.map((actor) => ({
    ...actor,
    id: idMap.get(actor.id) ?? actor.id,
    parentId: actor.parentId
      ? (idMap.get(actor.parentId) ?? actor.parentId)
      : null,
  }));
}

