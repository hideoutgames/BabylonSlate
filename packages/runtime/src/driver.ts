import {
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type CommandMessage,
} from "@babylonslate/bridge";
import {
  ClassRegistry,
  World,
  createActorsFromSerializedScene,
  createWorldSnapshot,
  stringifyWorldSnapshot,
  Actor,
  ActorComponent,
  type ClassKind,
  type TickPhase,
} from "@babylonslate/object-model";
import { eulerDegreesToQuaternion, type SerializedScene, type Transform } from "@babylonslate/core";
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
import { PhysicsWorldSync } from "./physics-sync";
import type { TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import {
  createNavigationBackend,
  facingYawFromVelocity,
  initNavigation,
  parseNavAgentParams,
  parseNavMeshBlockerProperties,
  recastToWorld,
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
  /** When false, debug-tier console commands are stripped (non-debug export stand-in). */
  includeDebugCommands?: boolean;
  /** Editor Play / bundled debugger: abort scripts that exceed `loopCount`. */
  infiniteLoopDetection?: boolean;
  /** Iterations in one tick that count as infinite when detection is on. */
  loopCount?: number;
  /** AnimationGraph documents keyed by asset guid (worker `loadAnimGraphs`). */
  animGraphs?: Readonly<Record<string, AnimGraphDocument>>;
  /** BehaviourTree documents keyed by asset guid (worker `loadBehaviourTrees`). */
  behaviourTrees?: Readonly<Record<string, BehaviourTreeDocument>>;
  blackboards?: Readonly<Record<string, BlackboardDocument>>;
  tilemaps?: Readonly<Record<string, TilemapPayload>>;
  tilesets?: Readonly<Record<string, TilesetPayload>>;
  pixelsPerUnit?: number;
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
  }): Actor | null;
  /**
   * Instantiate `playScene` (if any) with compiled script hooks.
   * Idempotent. Call after `loadScripts` so Begin Play binds on spawn.
   */
  realizePlayWorld(): void;
  /** Upgrade from software to Havok/Rapier when available. */
  loadPhysics(): Promise<void>;
  getPhysicsSync(): PhysicsWorldSync | null;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  invokeScriptEvent(
    classId: string,
    event: string,
    self?: Actor | null,
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
  private readonly gravity: [number, number, number];
  private readonly havokWasmUrl: string | undefined;
  private readonly preferSoftwarePhysics: boolean;
  private accumulator = 0;
  private paused = false;
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
  private playScene: SerializedScene | undefined;
  private playSceneGuid: string;
  private readonly gameInstanceClass: string;
  private readonly sceneLibrary = new Map<string, SerializedScene>();
  private readonly sceneGuidByKey = new Map<string, string>();
  private playWorldRealized = false;
  /** A script `Possess Camera` outranks the authored per-camera option. */
  private cameraPossessedByScript = false;
  private readonly commands: CommandRegistry;
  private readonly loopGuard: InfiniteLoopGuard;
  private readonly trace = new TraceRecorder();
  private lastTrace: TracePayload | null = null;
  private readonly seed: number;
  private tickPrints: Array<{ message: string; key: string }> = [];
  private readonly animGraphs = new Map<string, AnimGraphDocument>();
  private readonly animEvalBySlot = new Map<number, AnimEvalState>();
  private readonly animInitializedBySlot = new Set<string>();
  private readonly behaviourTrees = new Map<string, BehaviourTreeDocument>();
  private readonly blackboards = new Map<string, BlackboardDocument>();
  private readonly btEvalBySlot = new Map<number, BtEvalState>();
  private readonly btMissingWarned = new Set<string>();
  private currentBtNodeId: string | null = null;
  private currentBtAssetGuid: string | null = null;
  private uiInstanceSeq = 0;
  private tilemaps = new Map<string, TilemapPayload>();
  private tilesets = new Map<string, TilesetPayload>();
  private pixelsPerUnit = 100;
  private readonly delayWaiters: Array<{ remaining: number; resolve: () => void }> =
    [];
  private nav: NavigationBackend | null = null;
  private readonly navAgentByActor = new Map<string, string>();
  private readonly navYawByActor = new Map<string, number>();

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
    if (options.sceneLibrary) {
      for (const [key, scene] of Object.entries(options.sceneLibrary)) {
        this.sceneLibrary.set(key, scene);
      }
    }
    if (options.sceneGuidByKey) {
      for (const [key, guid] of Object.entries(options.sceneGuidByKey)) {
        this.sceneGuidByKey.set(key, guid);
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

    this.physicsSync = new PhysicsWorldSync(
      createSoftwarePhysicsBackend(this.physicsWorldKind, {
        x: this.gravity[0],
        y: this.gravity[1],
        z: this.gravity[2],
      }),
    );
    if (options.tilemaps || options.tilesets) {
      this.physicsSync.setTileContent({
        tilemaps: options.tilemaps ?? {},
        tilesets: options.tilesets ?? {},
        pixelsPerUnit: options.pixelsPerUnit,
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
      destroyActor: (actor) => {
        if (actor) this.world.destroyActor(actor.guid);
      },
      addComponent: (actor, classId) => {
        const target = actor;
        if (!target || target.destroyed) return null;
        const id = String(classId ?? "").trim();
        if (!id) return null;
        const component = this.world.createComponent({ classId: id });
        target.attachComponent(component);
        return component;
      },
      spawnActor: (classId) => {
        const id = String(classId ?? "").trim();
        if (!id) return null;
        return this.spawnScriptedActor({ classId: id });
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
      lineTrace: (start, end) => this.physicsSync.lineTrace(start, end),
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
      setWidgetVisible: (widget, visible) => {
        this.emit({ type: "uiSetVisible", widgetId: widget, visible });
      },
      applyUserInterface: (assetGuid) => {
        const guid = String(assetGuid ?? "").trim();
        if (!guid) return "";
        const instanceId = `ui-${++this.uiInstanceSeq}`;
        this.emit({ type: "uiApply", instanceId, assetGuid: guid });
        return instanceId;
      },
      removeUserInterface: (instanceId) => {
        const id = String(instanceId ?? "").trim();
        if (!id) return;
        this.emit({ type: "uiRemove", instanceId: id });
      },
      changeScene: (scene) => {
        this.applyChangeScene(scene);
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
      playSound: (asset, volume) => {
        this.emit({
          type: "playSound",
          assetGuid: String(asset ?? ""),
          volume: Number(volume ?? 1),
          frameId: this.frameId,
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
    this.physicsSync = new PhysicsWorldSync(backend);
    this.physicsSync.setTileContent({
      tilemaps: this.tilemaps,
      tilesets: this.tilesets,
      pixelsPerUnit: this.pixelsPerUnit,
    });
    this.physicsSync.syncFromWorld(this.world);
  }

  getPhysicsSync(): PhysicsWorldSync | null {
    return this.physicsSync;
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
    const requestedParent = script.parentClassId?.trim() || "Actor";
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
      })),
      implementedInterfaces: [...(script.implementedInterfaces ?? [])],
    });
  }

  spawnScriptedActor(options: {
    classId: string;
    variables?: Record<string, unknown>;
    implementedInterfaces?: string[];
  }): Actor | null {
    const hooks = this.scriptHost.hooksFor(options.classId);
    if (!hooks) return null;
    const actor = this.world.createActor({
      classId: options.classId,
      variables: options.variables,
      implementedInterfaces: options.implementedInterfaces,
      hooks: {
        onCreation: (self) => this.guardScript(() => hooks.onCreation?.(self)),
        onTick: (self, ctx) =>
          this.guardScript(() => hooks.onTick?.(self, ctx)),
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
      if (this.playScene) {
        const actors = createActorsFromSerializedScene(
          this.world,
          this.playScene,
          (classId) => {
            const hooks = this.scriptHost.hooksFor(classId);
            if (!hooks) return undefined;
            return {
              onCreation: (self) => this.guardScript(() => hooks.onCreation?.(self)),
              onTick: (self, ctx) =>
                this.guardScript(() => hooks.onTick?.(self, ctx)),
            };
          },
        );
        for (const actor of actors) {
          this.scriptHost.bindInterfaceHandlers(actor);
          this.realizeActor(actor);
        }
      }
      this.registerNavAgents();
      this.registerNavObstacles();
      this.attemptPossessViewTarget();
      this.world.loadScene(this.playSceneGuid);
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
      this.world.loadScene(key);
      return;
    }
    for (const actor of [...this.world.getActors()]) {
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId !== undefined) {
        this.emit({ type: "despawn", slotId, actorGuid: actor.guid });
        this.slotByGuid.delete(actor.guid);
      }
      this.world.destroyActor(actor.guid);
    }
    this.world.flushPending();
    this.animEvalBySlot.clear();
    this.animInitializedBySlot.clear();
    this.btEvalBySlot.clear();
    this.clearNavAgents();
    this.playScene = next;
    this.playSceneGuid = this.sceneGuidByKey.get(key) ?? key;
    this.playWorldRealized = false;
    // The new scene owns its own camera choice.
    this.cameraPossessedByScript = false;
    this.emit({ type: "activeScene", sceneAssetGuid: this.playSceneGuid });
    this.realizePlayWorld();
  }

  executeConsoleCommand(command: string): { success: boolean; output: string } {
    return this.commands.execute(command, this.consoleHost());
  }

  invokeScriptEvent(
    classId: string,
    event: string,
    self?: Actor | null,
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

  restoreBtFromTrace(states: readonly TraceBtState[]): void {
    this.btEvalBySlot.clear();
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
    const agentId = this.navAgentByActor.get(actorGuid);
    if (!agentId || !this.nav) return false;
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
      if (actor.destroyed) continue;
      const component = actor.components.find(
        (entry) => entry.classId === "NavAgentComponent" && !entry.destroyed,
      );
      if (!component || this.navAgentByActor.has(actor.guid)) continue;
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
      if (!id) continue;
      this.navAgentByActor.set(actor.guid, id);
    }
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
      if (!props.dynamic || props.area === "cost") continue;
      const size = {
        x: Math.abs(actor.transform.scale.x) || 1,
        y: Math.abs(actor.transform.scale.y) || 1,
        z: Math.abs(actor.transform.scale.z) || 1,
      };
      this.nav.addObstacle(
        props.kind,
        this.toNavObstaclePose({
          x: actor.transform.position.x,
          y: actor.transform.position.y,
          z: actor.transform.position.z,
        }),
        this.toNavObstacleSize(size),
      );
    }
  }

  private tickCrowd(): void {
    if (!this.nav) return;
    this.nav.stepCrowd(this.dt);
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
    for (const actor of this.world.getActors()) {
      if (actor.destroyed) continue;
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "AnimationGraphComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const guid = this.animGraphGuid(component);
      if (!guid) continue;
      const document = this.animGraphs.get(guid);
      if (!document) continue;
      const initKey = `${slotId}:${guid}`;
      liveKeys.add(initKey);
      this.seedAnimVariables(component, document);
      const extras = {
        variableStore: component,
        animFacts: this.animEvalBySlot.get(slotId)?.facts,
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
        this.dt,
        extras,
      );
      const next = evaluateAnimGraph(
        document,
        this.animEvalBySlot.get(slotId) ?? null,
        this.dt,
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
      this.animEvalBySlot.set(slotId, next);
      const clip = clipForState(document, next.stateId);
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
    for (const key of [...this.animInitializedBySlot]) {
      if (!liveKeys.has(key)) this.animInitializedBySlot.delete(key);
    }
    for (const slotId of [...this.animEvalBySlot.keys()]) {
      const stillLive = [...liveKeys].some((key) =>
        key.startsWith(`${slotId}:`),
      );
      if (!stillLive) this.animEvalBySlot.delete(slotId);
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

  private abortBtTask(
    actor: Actor,
    node: { classId: string },
    blackboard: BlackboardValues,
    memory: Record<string, unknown>,
  ): void {
    memory.__activated = false;
    delete memory.__btResult;
    delete memory.__moveRequested;
    if (builtinClassId(node.classId) === "bt.task.moveTo") {
      this.stopNavAgent(actor.guid);
    }
    this.scriptHost.invokeBtEvent(node.classId, "onAbort", actor, this.dt, {
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
    this.scriptHost.invokeBtEvent(classId, "onEvaluate", actor, this.dt, {
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
      const next = evaluateBehaviourTree(document, previous, this.dt, {
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
      setRenderQuality: (level) => emitSetting("renderquality", level),
      setShadowQuality: (level) => {
        emitSetting("shadowquality", level);
        this.emit({ type: "setShadowQuality", level: String(level) });
      },
      setResolutionScale: (scale) => emitSetting("resolutionscale", scale),
      setFrameCap: (fps) => emitSetting("framecap", fps),
      setVolume: (volume) => emitSetting("volume", volume),
      quit: () => {
        this.stop();
      },
      setShowFps: (enabled) => emitSetting("showfps", enabled),
      setStat: (name, enabled) => emitSetting(`stat.${name}`, enabled),
      setShowCollision: (enabled) => emitSetting("showcollision", enabled),
      setShowBounds: (enabled) => emitSetting("showbounds", enabled),
      setWireframe: (enabled) => emitSetting("wireframe", enabled),
      pause: () => {
        this.pause();
      },
      step: () => {
        this.tick();
      },
      setTimeDilation: (rate) => emitSetting("slomo", rate),
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
        this.lastTrace = this.trace.stop();
        if (this.lastTrace) {
          this.emit({
            type: "trace",
            payload: this.lastTrace as unknown as Record<string, unknown>,
          });
        }
      },
    };
  }

  private emitMeshAssignment(actor: Actor, slotId: number): void {
    const renderables = actor.components.filter(
      (component) =>
        !component.destroyed &&
        (component.classId === "MeshComponent" ||
          component.classId === "SpriteComponent" ||
          component.classId === "TilemapComponent"),
    );
    if (renderables.length > 0) {
      const primary = renderables[0]!;
      const meshKind = playMeshKindOf(primary);
      const assetGuid = primary.assetGuid ?? primary.getVariable("assetGuid");
      const parts = playPartsNeeded(renderables)
        ? renderables.map((component) => playMeshPartOf(component))
        : undefined;
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
        meshKind,
        ...(parts ? { parts } : {}),
      });
      this.emitMaterialAssignments(renderables, slotId, Boolean(parts));
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
    }
  }

  private realizeActor(actor: Actor): void {
    const slotId = this.assignSlot(actor);
    this.emitMeshAssignment(actor, slotId);
    this.world.spawnActorNow(actor);
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
    this.emit({ type: "possessCamera", slotId });
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
    });
    return slotId;
  }

  private bindGameInstance(): void {
    const classId = this.gameInstanceClass;
    const hooks = this.scriptHost.hooksFor(classId);
    this.world.setGameInstance(
      this.world.createGameInstance({
        classId,
        guid: "runtime-gi",
        variables: { ticks: 0 },
        hooks: {
          onCreation: (self) => {
            this.guardScript(() =>
              hooks?.onCreation?.(self as unknown as Actor),
            );
          },
          onTick: (self, ctx) => {
            self.setVariable(
              "ticks",
              Number(self.getVariable("ticks")) + 1,
            );
            this.guardScript(() =>
              hooks?.onTick?.(self as unknown as Actor, ctx),
            );
          },
        },
      }),
    );
  }

  start(): void {
    this.bindGameInstance();
    this.running = true;
    this.paused = false;
    this.world.start();
  }

  stop(): void {
    this.running = false;
    this.world.end();
    this.physicsSync.dispose();
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
    this.emit({
      type: "stats",
      frameId: this.frameId,
      tickIndex: this.world.clock.tickIndex,
      scriptMs: this._lastScriptMs,
      physicsMs: this._lastPhysicsMs,
    });
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
        snapshotText: stringifyWorldSnapshot(createWorldSnapshot(this.world)),
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
      waiter.remaining -= this.dt;
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
    let count = 0;
    for (const actor of actors) {
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      const world = worldTransformOf(actor, actors);
      writeActorSlot(buf, count, {
        slotId,
        position: world.position,
        rotation: world.rotation,
        scale: world.scale,
        flags: 1,
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
}

function playMeshKindOf(component: ActorComponent): string | null {
  if (component.classId === "SpriteComponent") return "sprite";
  if (component.classId === "TilemapComponent") return "tilemap";
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

function playMeshPartOf(
  component: ActorComponent,
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["parts"]>[number] {
  const assetGuid = component.assetGuid ?? component.getVariable("assetGuid");
  const { position, rotation, scale } = component.transform;
  return {
    componentId: component.guid,
    meshKind: playMeshKindOf(component),
    meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
    parentId: component.parentId,
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
  };
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

function actorParentGuid(actor: Actor): string | null {
  const parentId = actor.getVariable("parentId");
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

function worldTransformOf(
  actor: Actor,
  actors: readonly Actor[],
): Transform {
  const byGuid = new Map(actors.map((entry) => [entry.guid, entry]));
  const chain: Actor[] = [];
  const visited = new Set<string>();
  let current: Actor | undefined = actor;
  while (current && !visited.has(current.guid)) {
    visited.add(current.guid);
    chain.push(current);
    const parentId = actorParentGuid(current);
    current = parentId ? byGuid.get(parentId) : undefined;
  }
  let world: Transform = copyTransform(chain[chain.length - 1]!.transform);
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    world = composeParentChildTransform(world, chain[index]!.transform);
  }
  return world;
}

function copyTransform(value: Transform): Transform {
  return {
    position: { ...value.position },
    rotation: { ...value.rotation },
    scale: { ...value.scale },
  };
}

function composeParentChildTransform(
  parent: Transform,
  local: Transform,
): Transform {
  const scaled = {
    x: local.position.x * parent.scale.x,
    y: local.position.y * parent.scale.y,
    z: local.position.z * parent.scale.z,
  };
  const rotated = rotateVecByQuat(parent.rotation, scaled);
  return {
    position: {
      x: parent.position.x + rotated.x,
      y: parent.position.y + rotated.y,
      z: parent.position.z + rotated.z,
    },
    rotation: multiplyQuat(parent.rotation, local.rotation),
    scale: {
      x: parent.scale.x * local.scale.x,
      y: parent.scale.y * local.scale.y,
      z: parent.scale.z * local.scale.z,
    },
  };
}

function multiplyQuat(
  a: Transform["rotation"],
  b: Transform["rotation"],
): Transform["rotation"] {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function rotateVecByQuat(
  q: Transform["rotation"],
  v: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
