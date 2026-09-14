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
  Scene,
  SceneLayer,
  type GameInstanceHooks,
  type LifecycleHooks,
  type TickContext,
} from "./objects";
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
  /** Optional post-physics fixup callback. */
  onPostPhysics?: (ctx: TickContext) => void;
  /** Resolved input for this world; filled by the runtime driver each tick. */
  input?: WorldInputProvider;
  /** Rechecked after Game Instance and between scene objects during loading. */
  canTickScene?: () => boolean;
  /** Owner readiness, independent for world actors and each SceneLayer. */
  canTickActor?: (actor: Actor) => boolean;
  /** Script lifecycle binding shared by authored and dynamically added components. */
  componentHooksFor?: (classId: string) => LifecycleHooks<ActorComponent> | undefined;
}

export class World {
  readonly classRegistry: ClassRegistry;
  readonly interfaceRegistry: InterfaceRegistry;
  readonly clock: TickClock;
  readonly rng: Rng;
  private readonly guidFactory?: GuidFactory;
  private readonly onPhase?: PhaseHook;
  private readonly onPhysics?: (ctx: TickContext) => void;
  private readonly onPostPhysics?: (ctx: TickContext) => void;
  private inputProvider: WorldInputProvider | null;
  private readonly canTickScene: () => boolean;
  private readonly canTickActor: (actor: Actor) => boolean;
  private readonly componentHooksFor?: WorldOptions["componentHooksFor"];

  gameInstance: GameInstance | null = null;
  currentScene: Scene | null = null;
  /** Actors in spawn order — never iterate a Map for tick/snapshot. */
  private readonly actors: Actor[] = [];
  private readonly sceneLayers: SceneLayer[] = [];
  private readonly pendingSpawn: Actor[] = [];
  private readonly pendingDestroy: Array<Guid | Actor> = [];
  private started = false;
  /** True while a tick phase is executing (before deferred flush). */
  private ticking = false;
  private firstSceneLoaded = false;
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
    this.onPostPhysics = options.onPostPhysics;
    this.inputProvider = options.input ?? null;
    this.canTickScene = options.canTickScene ?? (() => true);
    this.canTickActor = options.canTickActor ?? (() => true);
    this.componentHooksFor = options.componentHooksFor;
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

  start(): void {
    if (this.started) return;
    this.started = true;
    this.gameInstance?.callOnCreation();
    this.gameInstance?.callOnGameStart();
  }

  end(): void {
    this.exitActiveScene();
    this.gameInstance?.callOnGameEnd();
  }

  loadScene(sceneName: string): void {
    this.exitActiveScene();
    this.beginSceneLoad(sceneName);
    this.finishSceneLoad(sceneName);
  }

  beginSceneLoad(sceneName: string): void {
    this.loadingSceneName = sceneName;
    this.gameInstance?.callOnSceneStartLoading(sceneName);
  }

  finishSceneLoad(sceneName: string): void {
    this.activeSceneName = sceneName;
    this.loadingSceneName = null;
    this.gameInstance?.callOnSceneFinishLoading(sceneName);
    if (!this.firstSceneLoaded) {
      this.firstSceneLoaded = true;
      this.gameInstance?.callOnFirstSceneLoaded(sceneName);
    }
  }

  exitActiveScene(): void {
    const name = this.activeSceneName ?? this.loadingSceneName;
    this.activeSceneName = null;
    this.loadingSceneName = null;
    this.clearCurrentScene();
    if (!name) return;
    this.gameInstance?.callOnSceneExit(name);
  }

  /** Queue actor for spawn; applied after the current phase / at end of tick. */
  spawnActor(actor: Actor): Actor {
    this.pendingSpawn.push(actor);
    return actor;
  }

  /** Immediately spawn if not mid-tick; otherwise queues like `spawnActor`. */
  spawnActorNow(actor: Actor): Actor {
    if (this.ticking) {
      this.pendingSpawn.push(actor);
      return actor;
    }
    this.commitSpawn(actor);
    return actor;
  }

  destroyActor(guid: Guid): void {
    this.pendingDestroy.push(guid);
  }

  /** Cancel owned preparation without deleting a later Actor with the same guid. */
  destroyActorInstance(actor: Actor): void {
    if (actor.world === this) {
      this.pendingDestroy.push(actor);
      return;
    }
    if (actor.world || actor.destroyed) return;
    const pending = this.pendingSpawn.indexOf(actor);
    if (pending >= 0) this.pendingSpawn.splice(pending, 1);
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
    return layer;
  }

  destroySceneLayer(guid: Guid): void {
    const index = this.sceneLayers.findIndex((layer) => layer.guid === guid);
    if (index < 0) return;
    const layer = this.sceneLayers[index]!;
    this.sceneLayers.splice(index, 1);
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
    this.clearCurrentScene();
    const scene = new Scene({
      ...options,
      guidFactory: this.guidFactory,
    });
    this.currentScene = scene;
    scene.callOnCreation();
    return scene;
  }

  private clearCurrentScene(): void {
    const scene = this.currentScene;
    if (!scene) return;
    this.currentScene = null;
    if (scene.destroyed) return;
    scene.destroyed = true;
    scene.callOnDestroyed();
  }

  findActor(guid: Guid): Actor | undefined {
    return this.actors.find((a) => a.guid === guid);
  }

  private commitSpawn(actor: Actor): void {
    if (actor.destroyed) return;
    actor.world = this;
    actor.spawnIndex = this.actors.length;
    this.actors.push(actor);
    actor.callOnCreation();
    for (const component of actor.components) component.callOnCreation();
  }

  private flushDeferred(): void {
    while (this.pendingSpawn.length > 0 || this.pendingDestroy.length > 0) {
      while (this.pendingSpawn.length > 0) {
        const actor = this.pendingSpawn.shift()!;
        this.commitSpawn(actor);
      }
      while (this.pendingDestroy.length > 0) {
        const guid = this.pendingDestroy.shift()!;
        this.commitDestroy(guid);
      }
    }
  }

  private commitDestroy(target: Guid | Actor): void {
    const index = typeof target === "string"
      ? this.actors.findIndex((actor) => actor.guid === target)
      : this.actors.indexOf(target);
    if (index < 0) return;
    const actor = this.actors[index]!;
    this.actors.splice(index, 1);
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
    for (let i = 0; i < this.actors.length; i++) {
      this.actors[i]!.spawnIndex = i;
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
          break;
        case "actors":
          for (const actor of [...this.actors]) {
            if (!this.canTickScene()) break;
            if (!actor.destroyed && this.canTickActor(actor)) actor.callOnTick(ctx);
          }
          break;
        case "components":
          for (const actor of [...this.actors]) {
            if (!this.canTickScene()) break;
            if (actor.destroyed || !this.canTickActor(actor)) continue;
            for (const component of [...actor.components]) {
              if (!this.canTickScene() || !this.canTickActor(actor)) break;
              if (!component.destroyed) component.callOnTick(ctx);
            }
          }
          break;
        case "physics":
          this.onPhysics?.(ctx);
          break;
        case "postPhysics":
          this.onPostPhysics?.(ctx);
          break;
      }
    } finally {
      this.ticking = false;
    }

    this.flushDeferred();
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
  }): Actor {
    const defaults = this.classDefaults(options.classId, options);
    return new Actor({
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
