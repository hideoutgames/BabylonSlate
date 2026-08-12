import {
  createSeededRng,
  type Guid,
  type GuidFactory,
  type Rng,
} from "@babylonslate/core";
import type { ClassRegistry } from "./class-registry";
import type { InterfaceRegistry } from "./interfaces";
import { Actor, ActorComponent, GameInstance, type TickContext } from "./objects";
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
  /** Optional post-physics fixup callback. */
  onPostPhysics?: (ctx: TickContext) => void;
  /** Resolved input for this world; filled by the runtime driver each tick. */
  input?: WorldInputProvider;
}

export class World {
  readonly classRegistry: ClassRegistry;
  readonly interfaceRegistry: InterfaceRegistry | null;
  readonly clock: TickClock;
  readonly rng: Rng;
  private readonly guidFactory?: GuidFactory;
  private readonly onPhase?: PhaseHook;
  private readonly onPostPhysics?: (ctx: TickContext) => void;
  private inputProvider: WorldInputProvider | null;

  gameInstance: GameInstance | null = null;
  /** Actors in spawn order — never iterate a Map for tick/snapshot. */
  private readonly actors: Actor[] = [];
  private readonly pendingSpawn: Actor[] = [];
  private readonly pendingDestroy: Guid[] = [];
  private started = false;
  /** True while a tick phase is executing (before deferred flush). */
  private ticking = false;

  constructor(options: WorldOptions) {
    this.classRegistry = options.classRegistry;
    this.interfaceRegistry = options.interfaceRegistry ?? null;
    this.clock = new TickClock(options.dt);
    this.rng = createSeededRng(options.seed);
    this.guidFactory = options.guidFactory;
    this.onPhase = options.onPhase;
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
          // Reserved for P7 — must remain a named no-op slot.
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

  createActor(options: {
    classId: string;
    guid?: Guid;
    variables?: Record<string, unknown>;
    hooks?: import("./objects").LifecycleHooks<Actor>;
    implementedInterfaces?: string[];
    transform?: ConstructorParameters<typeof Actor>[0]["transform"];
  }): Actor {
    return new Actor({
      ...options,
      guidFactory: this.guidFactory,
    });
  }

  createComponent(options: {
    classId: string;
    guid?: Guid;
    variables?: Record<string, unknown>;
    hooks?: import("./objects").LifecycleHooks<ActorComponent>;
    assetGuid?: Guid | null;
  }): ActorComponent {
    return new ActorComponent({
      ...options,
      guidFactory: this.guidFactory,
    });
  }
}