import {
  createSeededRng,
  type Guid,
  type GuidFactory,
  type Rng,
  type ScenePostProcessEntry,
} from "@babylonslate/core";
import { ClassRegistry, hydrateClassVariableValue } from "./class-registry";
import { InterfaceRegistry } from "./interfaces";
import {
  Actor,
  ActorComponent,
  GameInstance,
  GameSubsystem,
  Scene,
  SceneLayer,
  SceneStreamingActor,
  SceneLayerActorSwitcher,
  SceneSubsystem,
  type GameInstanceHooks,
  type GameSubsystemHooks,
  type LifecycleHooks,
  type SceneSubsystemHooks,
  type Subsystem,
  type TickContext,
} from "./objects";
import {
  compareClassIds,
  gameSubsystemGuid,
  sceneSubsystemGuid,
} from "./subsystems";
import { TICK_PHASES, TickClock, type PhaseHook, type TickPhase } from "./tick";

export type WorldInputProvider = Pick<
  TickContext,
  | "isActionHeld"
  | "wasActionPressed"
  | "wasActionReleased"
  | "getPressedKeys"
  | "getAxis"
  | "getAxis2D"
  | "getCursorPosition"
  | "setCursorVisible"
  | "setGamepadRumble"
  | "gamepadConnections"
>;

export interface WorldOptions {
  seed: number;
  dt: number;
  classRegistry: ClassRegistry;
  interfaceRegistry?: InterfaceRegistry;
  guidFactory?: GuidFactory;
  onPhase?: PhaseHook;
  /** Optional physics step (P7). Called during the named `physics` phase. */
  onPhysics?: (ctx: TickContext) => void;
  /** Resolved input for this world; filled by the runtime driver each tick. */
  input?: WorldInputProvider;
  /** Rechecked after Game Instance and between scene objects during loading. */
  canTickScene?: () => boolean;
  /** Owner readiness, independent for world actors and each SceneLayer. */
  canTickActor?: (actor: Actor) => boolean;
  /** Script lifecycle binding shared by authored and dynamically added components. */
  componentHooksFor?: (classId: string) => LifecycleHooks<ActorComponent> | undefined;
  /**
   * Hooks for each SceneSubsystem the World creates in `createScene`. The
   * World calls `onCreation` (On Init) synchronously; a host that must wait
   * for scene readiness defers its script dispatch inside the hook.
   */
  sceneSubsystemHooksFor?: (classId: string) => SceneSubsystemHooks | undefined;
  /** Owner gate for the `sceneSubsystems` tick phase, after `canTickScene`. */
  canTickSceneSubsystem?: (subsystem: SceneSubsystem) => boolean;
}

/** Spawning an actor whose guid a live (or queued) actor already holds. */
export class DuplicateActorGuidError extends Error {
  readonly guid: Guid;

  constructor(actor: Actor, existing: Actor | null) {
    const holder = existing
      ? `live ${existing.classId} actor${existing.sceneLayerId ? ` in SceneLayer ${existing.sceneLayerId}` : ""}`
      : "queued actor";
    super(`Cannot spawn ${actor.classId} actor "${actor.guid}": a ${holder} already uses this guid. ` +
      "Actor guids must be unique; destroy the previous actor before spawning its replacement.");
    this.name = "DuplicateActorGuidError";
    this.guid = actor.guid;
  }
}

/** An in-progress actor/component phase's view of the actor list. */
type ActorIteration = { list: readonly Actor[]; length: number };

export class World {
  /** Identity/hierarchy revision; no properties or world snapshots are collected. */
  structuralRevision = 0;
  markStructureChanged(): void { this.structuralRevision++; }

  readonly classRegistry: ClassRegistry;
  readonly interfaceRegistry: InterfaceRegistry;
  readonly clock: TickClock;
  readonly rng: Rng;
  private readonly guidFactory?: GuidFactory;
  private readonly onPhase?: PhaseHook;
  private readonly onPhysics?: (ctx: TickContext) => void;
  private inputProvider: WorldInputProvider | null;
  private readonly canTickScene: () => boolean;
  private readonly canTickActor: (actor: Actor) => boolean;
  private readonly componentHooksFor?: WorldOptions["componentHooksFor"];
  private readonly sceneSubsystemHooksFor?: WorldOptions["sceneSubsystemHooksFor"];
  private readonly canTickSceneSubsystem: (subsystem: SceneSubsystem) => boolean;

  gameInstance: GameInstance | null = null;
  currentScene: Scene | null = null;
  /** Session GameSubsystems in class-id order. */
  private gameSubsystems: GameSubsystem[] = [];
  /** Current main Scene's SceneSubsystems in class-id order. */
  private sceneSubsystems: SceneSubsystem[] = [];
  private sceneSubsystemClassIds: string[] = [];
  /** Main Scene creations this session; numbers SceneSubsystem guids. */
  private mainSceneCreations = 0;
  /** Objects whose Spawned / Added the live SceneSubsystems received. */
  private announcedToSceneSubsystems = new WeakSet<Actor | SceneLayer>();
  /** Actors in spawn order — never iterate a Map for tick/snapshot. */
  private readonly actors: Actor[] = [];
  /** Live actors by guid, including ones queued for destruction. Guids are unique. */
  private readonly actorsByGuid = new Map<Guid, Actor>();
  /** Guids reserved by queued spawns until each commits or is cancelled. */
  private readonly pendingSpawnGuids = new Set<Guid>();
  private readonly sceneLayers: SceneLayer[] = [];
  /** Earliest `actors` position whose spawnIndex a removal shifted and has not yet reassigned. */
  private staleSpawnIndexFrom = Number.POSITIVE_INFINITY;
  /** Phase views by re-entrancy depth; reused so ticking allocates no actor/component copies. */
  private readonly actorIterations: ActorIteration[] = [];
  private actorIterationDepth = 0;
  private readonly componentScratch: Array<Array<ActorComponent | undefined>> = [];
  /** Deferred queues; entries before each cursor are already consumed by the running flush. */
  private readonly pendingSpawn: Actor[] = [];
  private spawnCursor = 0;
  private readonly pendingDestroy: Array<Guid | Actor> = [];
  private destroyCursor = 0;
  private started = false;
  /** True while a tick phase is executing (before deferred flush). */
  private ticking = false;
  private firstSceneLoaded = false;
  /** Bumped by every scene load step; a re-entrant load supersedes the outer one. */
  private sceneLoadGeneration = 0;
  private activeSceneName: string | null = null;
  private loadingSceneName: string | null = null;

  constructor(options: WorldOptions) {
    this.classRegistry = options.classRegistry;
    this.interfaceRegistry = options.interfaceRegistry ?? new InterfaceRegistry();
    this.clock = new TickClock(options.dt);
    this.rng = createSeededRng(options.seed);
    this.guidFactory = options.guidFactory;
    this.onPhase = options.onPhase;
    this.onPhysics = options.onPhysics;
    this.inputProvider = options.input ?? null;
    this.canTickScene = options.canTickScene ?? (() => true);
    this.canTickActor = options.canTickActor ?? (() => true);
    this.componentHooksFor = options.componentHooksFor;
    this.sceneSubsystemHooksFor = options.sceneSubsystemHooksFor;
    this.canTickSceneSubsystem = options.canTickSceneSubsystem ?? (() => true);
  }

  setInputProvider(provider: WorldInputProvider | null): void {
    this.inputProvider = provider;
  }

  rngNextFloat(): number {
    return this.rng.nextFloat();
  }

  setGameInstance(instance: GameInstance): void {
    this.gameInstance = instance;
  }

  /**
   * Install the session's GameSubsystems, kept in class-id order. Must run
   * before `start()`: their On Init precedes the Game Instance's, which a late
   * install could no longer honour.
   */
  setGameSubsystems(subsystems: readonly GameSubsystem[]): void {
    if (this.started) {
      throw new Error("GameSubsystems must be installed before World.start()");
    }
    this.gameSubsystems = [...subsystems].sort((a, b) =>
      compareClassIds(a.classId, b.classId),
    );
  }

  getGameSubsystems(): readonly GameSubsystem[] {
    return this.gameSubsystems;
  }

  /**
   * SceneSubsystem classes every later main `createScene` instantiates, kept in
   * class-id order. Streamed sub-scenes and SceneLayers never create them.
   */
  setSceneSubsystemClasses(classIds: readonly string[]): void {
    this.sceneSubsystemClassIds = [...new Set(classIds)].sort(compareClassIds);
  }

  /** The current main Scene's SceneSubsystems (empty between scenes). */
  getSceneSubsystems(): readonly SceneSubsystem[] {
    return this.sceneSubsystems;
  }

  /**
   * Live (not ended) subsystems whose class isA `classId`: GameSubsystems, then
   * the current main Scene's SceneSubsystems, each in class-id order. The
   * first entry is the deterministic `Get` result; more than one is ambiguous.
   */
  findSubsystems(classId: string): Subsystem[] {
    return [...this.gameSubsystems, ...this.sceneSubsystems].filter(
      (subsystem) =>
        !subsystem.ended && this.classRegistry.isA(subsystem.classId, classId),
    );
  }

  /** Host notification: a streamed sub-scene became ready in the main scene. */
  notifyStreamedSceneLoaded(streamingActor: SceneStreamingActor, scene: Scene): void {
    for (const subsystem of this.liveSceneSubsystems()) {
      subsystem.callOnStreamedSceneLoaded(streamingActor, scene);
    }
  }

  /** Host notification: a streamed sub-scene was retired. */
  notifyStreamedSceneUnloaded(streamingActor: SceneStreamingActor, scene: Scene): void {
    for (const subsystem of this.liveSceneSubsystems()) {
      subsystem.callOnStreamedSceneUnloaded(streamingActor, scene);
    }
  }

  /**
   * Host notification: a world actor whose `onCreation` the host held back
   * enters play. SceneSubsystems created after its spawn commit hear Spawned
   * now; an actor they already heard about is not reported again.
   */
  notifyActorEnteringPlay(actor: Actor): void {
    if (actor.world === this && !actor.destroyed) this.announceSceneActor(actor);
  }

  /** GameSubsystems' On Init (class-id order), then the Game Instance's. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const subsystem of this.liveGameSubsystems()) subsystem.callOnCreation();
    this.gameInstance?.callOnCreation();
  }

  /** Scene exit, Game Instance On End, then GameSubsystems' On End in reverse. */
  end(): void {
    this.exitActiveScene();
    this.gameInstance?.callOnGameEnd();
    for (const subsystem of this.liveGameSubsystems().reverse()) {
      subsystem.callOnGameEnd();
    }
  }

  loadScene(sceneName: string): void {
    this.exitActiveScene();
    this.beginSceneLoad(sceneName);
    this.finishSceneLoad(sceneName);
  }

  beginSceneLoad(sceneName: string): void {
    this.sceneLoadGeneration++;
    this.loadingSceneName = sceneName;
    this.gameInstance?.callOnSceneStartLoading(sceneName);
    for (const subsystem of this.liveGameSubsystems()) {
      subsystem.callOnSceneStartLoading(sceneName);
    }
  }

  /**
   * Game Instance then GameSubsystems hear Finish Loading (and First Scene
   * Loaded once); the main Scene's SceneSubsystems hear Scene Loaded last.
   * A handler that loads another scene re-entrantly ends this announcement:
   * the replacement announces itself.
   */
  finishSceneLoad(sceneName: string): void {
    this.activeSceneName = sceneName;
    this.loadingSceneName = null;
    const scene = this.currentScene;
    const generation = ++this.sceneLoadGeneration;
    const current = () =>
      this.sceneLoadGeneration === generation && this.currentScene === scene;
    this.gameInstance?.callOnSceneFinishLoading(sceneName);
    for (const subsystem of this.liveGameSubsystems()) {
      if (!current()) return;
      subsystem.callOnSceneFinishLoading(sceneName);
    }
    if (!this.firstSceneLoaded && current()) {
      this.firstSceneLoaded = true;
      // Once per session, so every GameSubsystem hears it even after the Game
      // Instance's handler moved on to another scene.
      this.gameInstance?.callOnFirstSceneLoaded(sceneName);
      for (const subsystem of this.liveGameSubsystems()) {
        subsystem.callOnFirstSceneLoaded(sceneName);
      }
    }
    for (const subsystem of this.liveSceneSubsystems()) {
      if (!current()) return;
      subsystem.callOnSceneLoaded(sceneName);
    }
  }

  /**
   * Tear down the main Scene (SceneSubsystems' On End, then the Scene), then
   * the Game Instance and GameSubsystems hear Scene Exit.
   */
  exitActiveScene(): void {
    this.sceneLoadGeneration++;
    const name = this.activeSceneName ?? this.loadingSceneName;
    this.activeSceneName = null;
    this.loadingSceneName = null;
    this.clearCurrentScene();
    if (!name) return;
    this.gameInstance?.callOnSceneExit(name);
    for (const subsystem of this.liveGameSubsystems()) {
      subsystem.callOnSceneExit(name);
    }
  }

  private liveGameSubsystems(): GameSubsystem[] {
    return this.gameSubsystems.filter((subsystem) => !subsystem.ended);
  }

  private liveSceneSubsystems(): SceneSubsystem[] {
    return this.sceneSubsystems.filter((subsystem) => !subsystem.ended);
  }

  /** World (not SceneLayer overlay) actors are announced to SceneSubsystems. */
  private isWorldSceneActor(actor: Actor): boolean {
    return (
      actor.sceneLayerId == null &&
      !this.classRegistry.isA(actor.classId, "SceneLayerActor")
    );
  }

  /** Scene Actor Spawned, once per SceneSubsystem generation. */
  private announceSceneActor(actor: Actor): void {
    if (
      this.sceneSubsystems.length === 0 ||
      !this.isWorldSceneActor(actor) ||
      this.announcedToSceneSubsystems.has(actor)
    ) {
      return;
    }
    this.announcedToSceneSubsystems.add(actor);
    for (const subsystem of this.liveSceneSubsystems()) {
      subsystem.callOnSceneActorSpawned(actor);
    }
  }

  /**
   * Queue actor for spawn; applied after the current phase / at end of tick.
   * Throws `DuplicateActorGuidError` when its guid is live or already queued.
   */
  spawnActor(actor: Actor): Actor {
    this.queueSpawn(actor);
    return actor;
  }

  /** Immediately spawn if not mid-tick; otherwise queues like `spawnActor`. */
  spawnActorNow(actor: Actor): Actor {
    if (this.ticking) {
      this.queueSpawn(actor);
      return actor;
    }
    this.assertGuidAvailable(actor);
    this.commitSpawn(actor);
    return actor;
  }

  /**
   * Two live actors never share a guid. An actor queued for destruction stays
   * live until that destruction commits and a queued spawn reserves its guid,
   * so a replacement spawns only after its predecessor's destruction commits.
   */
  private assertGuidAvailable(actor: Actor): void {
    const live = this.actorsByGuid.get(actor.guid);
    if (live) throw new DuplicateActorGuidError(actor, live);
    if (this.pendingSpawnGuids.has(actor.guid)) throw new DuplicateActorGuidError(actor, null);
  }

  private queueSpawn(actor: Actor): void {
    this.assertGuidAvailable(actor);
    this.pendingSpawnGuids.add(actor.guid);
    this.pendingSpawn.push(actor);
  }

  destroyActor(guid: Guid): void {
    this.pendingDestroy.push(guid);
  }

  /**
   * Destroy this actor object, or cancel its unspawned preparation. Unlike
   * `destroyActor(guid)`, a stale cleanup never reaches a successor that
   * reuses the guid after this actor left.
   */
  destroyActorInstance(actor: Actor): void {
    if (actor.world === this) {
      this.pendingDestroy.push(actor);
      return;
    }
    if (actor.world || actor.destroyed) return;
    const pending = this.pendingSpawn.indexOf(actor, this.spawnCursor);
    if (pending >= 0) {
      this.pendingSpawn.splice(pending, 1);
      this.pendingSpawnGuids.delete(actor.guid);
    }
    // An unspawned actor never received creation hooks and has no live world.
    for (const component of actor.components) {
      component.destroyed = true;
      component.owner = null;
    }
    actor.components.length = 0;
    actor.destroyed = true;
  }

  getActors(): readonly Actor[] {
    return this.actors;
  }

  getSceneLayers(): readonly SceneLayer[] {
    return this.sceneLayers;
  }

  findSceneLayer(guid: Guid): SceneLayer | undefined {
    return this.sceneLayers.find((layer) => layer.guid === guid);
  }

  createSceneLayer(options: {
    classId?: string;
    guid?: Guid;
    assetGuid: string;
    zOrder: number;
    ownerSceneGuid?: string | null;
    postProcessStack?: ScenePostProcessEntry[];
    layerBounds?: { width: number; height: number };
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
  }): SceneLayer {
    const layer = new SceneLayer({
      ...options,
      guidFactory: this.guidFactory,
    });
    this.sceneLayers.push(layer);
    layer.callOnCreation();
    const subsystems = this.liveSceneSubsystems();
    if (!layer.destroyed && subsystems.length > 0) {
      this.announcedToSceneSubsystems.add(layer);
      for (const subsystem of subsystems) subsystem.callOnSceneLayerAdded(layer);
    }
    return layer;
  }

  destroySceneLayer(guid: Guid): void {
    const index = this.sceneLayers.findIndex((layer) => layer.guid === guid);
    if (index < 0) return;
    const layer = this.sceneLayers[index]!;
    this.sceneLayers.splice(index, 1);
    // Unlinked but intact: re-entrant destruction of this layer is a no-op.
    if (this.announcedToSceneSubsystems.delete(layer)) {
      for (const subsystem of this.liveSceneSubsystems()) {
        subsystem.callOnSceneLayerRemoved(layer);
      }
    }
    for (const actor of [...this.actors]) {
      if (actor.sceneLayerId === guid) {
        this.commitDestroy(actor);
      }
    }
    layer.destroyed = true;
    layer.callOnDestroyed();
  }

  createScene(options: {
    classId?: string;
    guid?: Guid;
    assetGuid: string;
    sceneName: string;
    postProcessStack?: ScenePostProcessEntry[];
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
  }): Scene {
    // A SceneSubsystem's On End may install a scene re-entrantly; retire it too
    // so no main Scene (or its subsystems) is orphaned without End.
    do {
      this.clearCurrentScene();
    } while (this.currentScene);
    const scene = new Scene({
      ...options,
      guidFactory: this.guidFactory,
    });
    this.currentScene = scene;
    this.markStructureChanged();
    scene.callOnCreation();
    if (this.currentScene === scene) this.createSceneSubsystems(scene);
    return scene;
  }

  /**
   * Every SceneSubsystem is constructed (and findable) before the first On
   * Init runs; On Init then runs in class-id order before any actor spawns.
   */
  private createSceneSubsystems(scene: Scene): void {
    const creation = ++this.mainSceneCreations;
    if (this.sceneSubsystemClassIds.length === 0) return;
    this.announcedToSceneSubsystems = new WeakSet();
    const subsystems = this.sceneSubsystemClassIds.map((classId) => {
      const defaults = this.classDefaults(classId, {});
      return new SceneSubsystem({
        classId,
        guid: sceneSubsystemGuid(classId, creation),
        scene,
        variables: defaults.variables,
        implementedInterfaces: defaults.implementedInterfaces,
        hooks: this.sceneSubsystemHooksFor?.(classId),
      });
    });
    this.sceneSubsystems = subsystems;
    for (const subsystem of subsystems) {
      if (!subsystem.ended) subsystem.callOnCreation();
    }
  }

  /**
   * The one place every main-Scene exit passes through (scene change, failed
   * realization, `end()`, direct `createScene` replacement): SceneSubsystems'
   * On End in reverse order while the Scene is still current, then the Scene.
   */
  private clearCurrentScene(): void {
    const scene = this.currentScene;
    const subsystems = this.sceneSubsystems;
    for (let index = subsystems.length - 1; index >= 0; index--) {
      subsystems[index]!.callOnEnd();
    }
    // An On End hook may have changed scene re-entrantly: only clear the slots
    // this call still owns, never the replacement scene or its subsystems.
    if (this.sceneSubsystems === subsystems) this.sceneSubsystems = [];
    if (!scene) return;
    if (this.currentScene === scene) this.currentScene = null;
    if (scene.destroyed) return;
    scene.destroyed = true;
    scene.callOnDestroyed();
  }

  /** The live actor with this guid, including one queued for destruction. */
  findActor(guid: Guid): Actor | undefined {
    return this.actorsByGuid.get(guid);
  }

  private commitSpawn(actor: Actor): void {
    if (actor.destroyed) return;
    actor.world = this;
    actor.spawnIndex = this.actors.length;
    this.actors.push(actor);
    this.markStructureChanged();
    this.actorsByGuid.set(actor.guid, actor);
    this.announceSceneActor(actor);
    actor.callOnCreation();
    for (const component of actor.components) component.callOnCreation();
  }

  /**
   * Drains both queues, including entries hooks enqueue meanwhile. Cursors live
   * on the World so a re-entrant flush consumes the same entries a nested
   * `shift()` would; a drained queue is truncated in place.
   */
  private flushDeferred(): void {
    while (
      this.spawnCursor < this.pendingSpawn.length ||
      this.destroyCursor < this.pendingDestroy.length
    ) {
      while (this.spawnCursor < this.pendingSpawn.length) {
        const actor = this.pendingSpawn[this.spawnCursor++]!;
        this.pendingSpawnGuids.delete(actor.guid);
        this.commitSpawn(actor);
      }
      this.pendingSpawn.length = 0;
      this.spawnCursor = 0;
      while (this.destroyCursor < this.pendingDestroy.length) {
        this.commitDestroy(this.pendingDestroy[this.destroyCursor++]!);
      }
      this.pendingDestroy.length = 0;
      this.destroyCursor = 0;
    }
  }

  /** O(1) while spawn indices are dense; scans only while a removal is still settling. */
  private actorIndex(actor: Actor): number {
    const index = actor.spawnIndex;
    return this.actors[index] === actor ? index : this.actors.indexOf(actor);
  }

  private commitDestroy(target: Guid | Actor): void {
    const actor = typeof target === "string" ? this.findActor(target) : target;
    if (!actor) return;
    const index = this.actorIndex(actor);
    if (index < 0) return;
    this.detachActorIterations();
    this.actors.splice(index, 1);
    this.staleSpawnIndexFrom = Math.min(this.staleSpawnIndexFrom, index);
    this.markStructureChanged();
    this.actorsByGuid.delete(actor.guid);
    // Unlinked but intact, before its own teardown; announced actors only.
    if (this.announcedToSceneSubsystems.delete(actor)) {
      for (const subsystem of this.liveSceneSubsystems()) {
        subsystem.callOnSceneActorDestroyed(actor);
      }
    }
    actor.destroyed = true;
    for (const component of [...actor.components].reverse()) {
      if (!component.destroyed) {
        component.destroyed = true;
        component.callOnDestroyed();
      }
      component.owner = null;
    }
    actor.components.length = 0;
    actor.destroyed = true;
    actor.callOnDestroyed();
    actor.world = null;
    // Reassign dense spawn indices so order stays contiguous after removal.
    // Hooks above still saw the shifted indices, as before; positions ahead of
    // the earliest unsettled removal (including a re-entrant one) never moved.
    for (let i = this.staleSpawnIndexFrom; i < this.actors.length; i++) {
      this.actors[i]!.spawnIndex = i;
    }
    this.staleSpawnIndexFrom = Number.POSITIVE_INFINITY;
  }

  /**
   * A phase ticks the actors present when it started. The live array only
   * grows at its end until a removal, so a phase reads it in place and copies
   * its starting prefix only when an actor is removed mid-phase.
   */
  private beginActorIteration(): ActorIteration {
    const depth = this.actorIterationDepth++;
    const iteration = (this.actorIterations[depth] ??= { list: this.actors, length: 0 });
    iteration.list = this.actors;
    iteration.length = this.actors.length;
    return iteration;
  }

  private endActorIteration(): void {
    // Release a detached copy so it does not retain destroyed actors.
    this.actorIterations[--this.actorIterationDepth]!.list = this.actors;
  }

  private detachActorIterations(): void {
    for (let depth = 0; depth < this.actorIterationDepth; depth++) {
      const iteration = this.actorIterations[depth]!;
      if (iteration.list === this.actors) {
        iteration.list = this.actors.slice(0, iteration.length);
      }
    }
  }

  private phaseContext(tickIndex: number): TickContext {
    return {
      dt: this.clock.dt,
      tickIndex,
      world: this,
      ...(this.inputProvider ?? {}),
    };
  }

  private runPhase(phase: TickPhase, tickIndex: number): void {
    if (phase !== "gameInstance" && !this.canTickScene()) return;
    this.onPhase?.(phase, this.clock.dt, tickIndex);
    const ctx = this.phaseContext(tickIndex);

    this.ticking = true;
    try {
      switch (phase) {
        case "gameInstance":
          this.gameInstance?.callOnTick(ctx);
          for (const subsystem of this.liveGameSubsystems()) {
            subsystem.callOnTick(ctx);
          }
          break;
        case "sceneSubsystems":
          for (const subsystem of this.liveSceneSubsystems()) {
            if (!this.canTickScene()) break;
            if (!subsystem.ended && this.canTickSceneSubsystem(subsystem)) {
              subsystem.callOnTick(ctx);
            }
          }
          break;
        case "actors":
          this.tickActors(ctx);
          break;
        case "components":
          this.tickComponents(ctx);
          break;
        case "physics":
          this.onPhysics?.(ctx);
          break;
        // postPhysics has no built-in work; onPhase marks its boundary.
      }
    } finally {
      this.ticking = false;
    }

    this.flushDeferred();
  }

  private tickActors(ctx: TickContext): void {
    const iteration = this.beginActorIteration();
    try {
      for (let i = 0; i < iteration.length; i++) {
        if (!this.canTickScene()) break;
        const actor = iteration.list[i]!;
        if (actor.tickEnabled && !actor.destroyed && this.canTickActor(actor)) actor.callOnTick(ctx);
      }
    } finally {
      this.endActorIteration();
    }
  }

  /** Each actor's component list is captured into reused scratch before its first callback. */
  private tickComponents(ctx: TickContext): void {
    const iteration = this.beginActorIteration();
    const scratch = (this.componentScratch[this.actorIterationDepth - 1] ??= []);
    try {
      for (let i = 0; i < iteration.length; i++) {
        if (!this.canTickScene()) break;
        const actor = iteration.list[i]!;
        if (actor.destroyed || !this.canTickActor(actor)) continue;
        const count = actor.components.length;
        for (let c = 0; c < count; c++) scratch[c] = actor.components[c];
        for (let c = 0; c < count; c++) {
          if (!this.canTickScene() || !this.canTickActor(actor)) break;
          const component = scratch[c]!;
          if (!component.destroyed) component.callOnTick(ctx);
        }
      }
    } finally {
      scratch.fill(undefined);
      this.endActorIteration();
    }
  }

  tick(): number {
    if (!this.started) this.start();
    this.flushDeferred();
    const tickIndex = this.clock.advance();
    for (const phase of TICK_PHASES) {
      this.runPhase(phase, tickIndex);
    }
    return tickIndex;
  }

  /** Apply queued spawn/destroy immediately (scene swaps outside a tick). */
  flushPending(): void {
    this.flushDeferred();
  }

  createActor(options: {
    classId: string;
    guid?: Guid;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks<Actor>;
    implementedInterfaces?: string[];
    transform?: ConstructorParameters<typeof Actor>[0]["transform"];
    sceneLayerId?: Guid | null;
    suppressedComponentSourceIds?: readonly string[];
  }): Actor {
    const defaults = this.classDefaults(options.classId, options);
    const ActorClass = this.classRegistry.isA(options.classId, "SceneStreamingActor")
      ? SceneStreamingActor
      : this.classRegistry.isA(options.classId, "SceneLayerActorSwitcher")
        ? SceneLayerActorSwitcher
        : Actor;
    return new ActorClass({
      ...options,
      variables: defaults.variables,
      implementedInterfaces: defaults.implementedInterfaces,
      guidFactory: this.guidFactory,
    });
  }

  createComponent(options: {
    classId: string;
    guid?: Guid;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks<ActorComponent>;
    implementedInterfaces?: string[];
    assetGuid?: Guid | null;
    sourceId?: string | null;
    transform?: ConstructorParameters<typeof ActorComponent>[0]["transform"];
    parentId?: string | null;
    materialInstance?: ConstructorParameters<typeof ActorComponent>[0]["materialInstance"];
  }): ActorComponent {
    const defaults = this.classDefaults(options.classId, options);
    return new ActorComponent({
      ...options,
      hooks: options.hooks ?? this.componentHooksFor?.(options.classId),
      variables: defaults.variables,
      implementedInterfaces: defaults.implementedInterfaces,
      guidFactory: this.guidFactory,
    });
  }

  createGameInstance(options: {
    classId: string;
    guid?: Guid;
    variables?: Record<string, unknown>;
    hooks?: GameInstanceHooks;
    implementedInterfaces?: string[];
  }): GameInstance {
    const defaults = this.classDefaults(options.classId, options);
    return new GameInstance({
      ...options,
      variables: defaults.variables,
      implementedInterfaces: defaults.implementedInterfaces,
      guidFactory: this.guidFactory,
    });
  }

  /**
   * Build (not install) a GameSubsystem with class defaults applied. The guid
   * defaults to `subsystem:<classId>` and never comes from the guid factory.
   */
  createGameSubsystem(options: {
    classId: string;
    guid?: Guid;
    variables?: Record<string, unknown>;
    hooks?: GameSubsystemHooks;
    implementedInterfaces?: string[];
  }): GameSubsystem {
    const defaults = this.classDefaults(options.classId, options);
    return new GameSubsystem({
      ...options,
      guid: options.guid ?? gameSubsystemGuid(options.classId),
      variables: defaults.variables,
      implementedInterfaces: defaults.implementedInterfaces,
    });
  }

  private classDefaults(
    classId: string,
    options: {
      variables?: Record<string, unknown>;
      implementedInterfaces?: string[];
    },
  ): {
    variables: Record<string, unknown>;
    implementedInterfaces: string[];
  } {
    const variables: Record<string, unknown> = {};
    for (const variable of this.classRegistry.inheritedVariables(classId)) {
      const value = hydrateClassVariableValue(variable);
      if (value !== undefined) {
        variables[variable.name] = value;
      }
    }
    Object.assign(variables, options.variables ?? {});
    const implementedInterfaces =
      options.implementedInterfaces ??
      this.classRegistry.inheritedInterfaces(classId);
    return { variables, implementedInterfaces };
  }
}
