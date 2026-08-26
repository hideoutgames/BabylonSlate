import {
  createSeededRng,
  type Guid,
  type GuidFactory,
  type Rng,
} from "@babylonslate/core";
import { ClassRegistry, hydrateClassVariableValue } from "./class-registry";
import { InterfaceRegistry } from "./interfaces";
import {
  Actor,
  ActorComponent,
  GameInstance,
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
  | "getAxis"
  | "getAxis2D"
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

  gameInstance: GameInstance | null = null;
  /** Actors in spawn order — never iterate a Map for tick/snapshot. */
  private readonly actors: Actor[] = [];
  private readonly sceneLayers: SceneLayer[] = [];
  private readonly pendingSpawn: Actor[] = [];
  private readonly pendingDestroy: Guid[] = [];
  private started = false;
  /** True while a tick phase is executing (before deferred flush). */
  private ticking = false;

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
    this.gameInstance?.callOnGameEnd();
  }

  loadScene(sceneName: string): void {
    this.gameInstance?.callOnSceneLoaded(sceneName);
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
    postProcessStack?: Array<{ materialGuid: string; enabled: boolean }>;
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
    for (const actor of [...this.actors]) {
      if (actor.sceneLayerId === guid) {
        this.commitDestroy(actor.guid);
      }
    }
    layer.destroyed = true;
    layer.callOnDestroyed();
    this.sceneLayers.splice(index, 1);
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

  private commitDestroy(guid: Guid): void {
    const index = this.actors.findIndex((a) => a.guid === guid);
    if (index < 0) return;
    const actor = this.actors[index]!;
    for (const component of [...actor.components].reverse()) {
      component.destroyed = true;
      component.callOnDestroyed();
      component.owner = null;
    }
    actor.components.length = 0;
    actor.destroyed = true;
    actor.callOnDestroyed();
    actor.world = null;
    this.actors.splice(index, 1);
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
            if (!actor.destroyed) actor.callOnTick(ctx);
          }
          break;
        case "components":
          for (const actor of [...this.actors]) {
            if (actor.destroyed) continue;
            for (const component of [...actor.components]) {
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
    transform?: ConstructorParameters<typeof ActorComponent>[0]["transform"];
    parentId?: string | null;
  }): ActorComponent {
    const defaults = this.classDefaults(options.classId, options);
    return new ActorComponent({
      ...options,
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