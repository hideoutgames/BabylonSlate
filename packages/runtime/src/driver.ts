import {
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type CommandMessage,
} from "@babylonslate/bridge";
import {
  ClassRegistry,
  GameInstance,
  World,
  createActorsFromSerializedScene,
  createWorldSnapshot,
  stringifyWorldSnapshot,
  type Actor,
  type TickPhase,
} from "@babylonslate/object-model";
import type { SerializedScene } from "@babylonslate/core";
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
  type CommandRegistry,
  type ConsoleCommandHost,
  type RegisteredCommand,
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
  clipForState,
  evaluateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
} from "@babylonslate/anim-graph";
import { ScriptHost, type CompiledScript } from "./script-host";
import { PhysicsWorldSync } from "./physics-sync";
import type { TilemapPayload, TilesetPayload } from "@babylonslate/assets";

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
  /** When false, debug-tier console commands are stripped (non-debug export stand-in). */
  includeDebugCommands?: boolean;
  /** AnimationGraph documents keyed by asset guid (worker `loadAnimGraphs`). */
  animGraphs?: Readonly<Record<string, AnimGraphDocument>>;
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
  reportError(error: unknown, frameId?: number): RuntimeDiagnostic | null;
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
  invokeScriptEvent(classId: string, event: string): void;
  registerUserCommand(def: UserCommandDef): void;
  bindUserCommand(
    def: Omit<UserCommandDef, "run"> & { classId: string },
  ): void;
  listConsoleCommands(): readonly RegisteredCommand[];
  stopTrace(): TracePayload | null;
  registerAnimGraph(guid: string, document: AnimGraphDocument): void;
  registerTileContent(options: {
    tilemaps: Readonly<Record<string, TilemapPayload>> | ReadonlyMap<string, TilemapPayload>;
    tilesets: Readonly<Record<string, TilesetPayload>> | ReadonlyMap<string, TilesetPayload>;
    pixelsPerUnit?: number;
  }): void;
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
  private playWorldRealized = false;
  private readonly commands: CommandRegistry;
  private readonly trace = new TraceRecorder();
  private lastTrace: TracePayload | null = null;
  private readonly seed: number;
  private tickPrints: Array<{ message: string; key: string }> = [];
  private readonly animGraphs = new Map<string, AnimGraphDocument>();
  private readonly animEvalBySlot = new Map<number, AnimEvalState>();
  private uiInstanceSeq = 0;
  private tilemaps = new Map<string, TilemapPayload>();
  private tilesets = new Map<string, TilesetPayload>();
  private pixelsPerUnit = 100;
  private readonly delayWaiters: Array<{ remaining: number; resolve: () => void }> =
    [];

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
    this.physicsWorldKind = options.physicsWorld ?? "3d";
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
    if (options.playScene) {
      this.sceneLibrary.set(this.playSceneGuid, options.playScene);
      if (options.playScene.name) {
        this.sceneLibrary.set(options.playScene.name, options.playScene);
      }
    }
    this.commands = createCommandRegistry({
      includeDebug: options.includeDebugCommands ?? true,
    });
    if (options.animGraphs) {
      for (const [guid, document] of Object.entries(options.animGraphs)) {
        this.animGraphs.set(guid, document);
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
    this.world.spawnActorNow(actor);
    const slotId = this.assignSlot(actor);
    this.emitMeshAssignment(actor, slotId);
    return actor;
  }

  realizePlayWorld(): void {
    if (this.playWorldRealized) return;
    this.playWorldRealized = true;
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
        this.world.spawnActorNow(actor);
        const slotId = this.assignSlot(actor);
        this.emitMeshAssignment(actor, slotId);
      }
    }
    this.world.loadScene(this.playSceneGuid);
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
    this.playScene = next;
    this.playSceneGuid = key;
    this.playWorldRealized = false;
    this.realizePlayWorld();
  }

  executeConsoleCommand(command: string): { success: boolean; output: string } {
    return this.commands.execute(command, this.consoleHost());
  }

  invokeScriptEvent(classId: string, event: string): void {
    this.scriptHost.invokeEvent(classId, event);
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

  registerAnimGraph(guid: string, document: AnimGraphDocument): void {
    this.animGraphs.set(guid, document);
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

  private tickAnimGraphs(): void {
    if (this.animGraphs.size === 0) return;
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
      const next = evaluateAnimGraph(
        document,
        this.animEvalBySlot.get(slotId) ?? null,
        this.dt,
        this.animInputsFromComponent(component),
      );
      this.animEvalBySlot.set(slotId, next);
      const clip = clipForState(document, next.stateId);
      this.emit({
        type: "animState",
        slotId,
        stateId: next.stateId,
        normalisedTime: next.normalisedTime,
        blendWeights: next.blendWeights,
        clipName: clip?.clipName,
        clipKind: clip?.kind,
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
      setShadowQuality: (level) => emitSetting("shadowquality", level),
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
    const mesh = actor.components.find(
      (component) => component.classId === "MeshComponent" && !component.destroyed,
    );
    const sprite = actor.components.find(
      (component) =>
        component.classId === "SpriteComponent" && !component.destroyed,
    );
    if (mesh) {
      const meshKind = mesh.getVariable("meshKind");
      const assetGuid = mesh.assetGuid ?? mesh.getVariable("assetGuid");
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
        meshKind: typeof meshKind === "string" ? meshKind : null,
      });
      return;
    }
    if (sprite) {
      const assetGuid = sprite.assetGuid ?? sprite.getVariable("assetGuid");
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
        meshKind: "sprite",
      });
      return;
    }
    const tilemap = actor.components.find(
      (component) =>
        component.classId === "TilemapComponent" && !component.destroyed,
    );
    if (tilemap) {
      const assetGuid = tilemap.assetGuid ?? tilemap.getVariable("assetGuid");
      this.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
        meshKind: "tilemap",
      });
    }
  }

  private guardScript(run: () => void): void {
    try {
      run();
    } catch (error) {
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
      new GameInstance({
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
    const tickIndex = this.world.clock.tickIndex;
    const pending = this.input.drain().filter((e) => e.tick <= tickIndex + 1);
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

    this.world.tick();
    this.advanceDelays();
    this.tickAnimGraphs();
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

  reportError(error: unknown, frameId = this.frameId): RuntimeDiagnostic | null {
    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack ?? "";
    const anchor = mapStackToAnchor(stack, this.anchors);
    const diag: RuntimeDiagnostic = {
      code: "runtime.uncaught",
      message: err.message,
      severity: "error",
      assetGuid: anchor?.assetGuid,
      graphId: anchor?.graphId,
      nodeId: anchor?.nodeId,
      bodyLine: anchor?.bodyLine,
      btNodeId: anchor?.btNodeId,
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
      writeActorSlot(buf, count, {
        slotId,
        position: actor.transform.position,
        rotation: actor.transform.rotation,
        scale: actor.transform.scale,
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

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}
