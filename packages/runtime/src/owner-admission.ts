import { isInfiniteLoopError } from "@babylonslate/debugger";
import {
  Actor,
  ActorComponent,
  GameInstance,
  GameSubsystem,
  MaterialObject,
  PostProcessMaterialObject,
  Scene,
  SceneLayer,
  SceneSubsystem,
  type BObject,
  type World,
} from "@babylonslate/object-model";
import type { SceneLayers } from "./scene-layers";
import type { SceneStreams } from "./scene-streams";
import type { SimulationBlocks } from "./simulation-blocks";

interface OwnerAdmissionHost {
  world(): World;
  stopped(): boolean;
  paused(): boolean;
  /** A Save Game boundary is capturing or applying a checkpoint. */
  saveBoundaryActive(): boolean;
  /** The main Scene is still preparing (its load or Play boot loading). */
  sceneLoading(): boolean;
  streams(): Pick<SceneStreams, "actorReady" | "sceneReady">;
  blocks(): Pick<SimulationBlocks, "active">;
  layers(): Pick<SceneLayers, "get" | "anyReady">;
  releaseAssets(ownerGuid: string): void;
  reportError(error: unknown): void;
}

/**
 * Owner-action admission: the tick and run gates for the main Scene, actors,
 * Scene Layers and subsystems, the per-owner queues of script work that waits
 * for its owner (creation, notifications, deferred playback), their flushes,
 * creation/destruction bookkeeping and the script error guard.
 */
export class OwnerAdmission {
  private readonly pending = new Map<BObject, Array<() => void>>();
  /** Nonzero while `flush` runs queued owner work. */
  private flushing = 0;
  private readonly created = new WeakSet<BObject>();
  private readonly host: OwnerAdmissionHost;

  constructor(host: OwnerAdmissionHost) { this.host = host; }

  canTickScene(): boolean {
    return !this.host.paused() && !this.host.saveBoundaryActive() && !this.host.sceneLoading() && !this.host.stopped() &&
      !this.host.blocks().active;
  }

  hasReadyLayers(): boolean {
    if (this.host.stopped() || this.host.blocks().active) return false;
    return this.host.layers().anyReady();
  }

  canTickActor(actor: Actor, ignorePause = false): boolean {
    const streams = this.host.streams();
    if ((!ignorePause && this.host.paused()) || this.host.stopped() || actor.destroyed || this.host.blocks().active || !streams.actorReady(actor)) return false;
    if (!actor.sceneLayerId) return this.canTickScene();
    return this.host.layers().get(actor.sceneLayerId)?.ready === true;
  }

  canRun(owner: BObject): boolean {
    const stopped = this.host.stopped();
    if (this.host.paused() && !stopped) return false;
    if (this.host.saveBoundaryActive()) return false;
    if (owner instanceof GameSubsystem) return this.canRunGameSubsystem(owner);
    const world = this.host.world();
    const streams = this.host.streams();
    const blocked = this.host.blocks().active;
    // Callable from creation until its On End returns, even while its Scene
    // prepares or Play stops (a sibling's On End may still call it); its own
    // lifecycle waits for the Scene (canRunSceneSubsystem).
    if (owner instanceof SceneSubsystem) {
      return !owner.destroyed && owner.scene === world.currentScene &&
        (stopped || !blocked);
    }
    if (stopped || owner.destroyed || blocked) return false;
    if (owner instanceof PostProcessMaterialObject)
      return owner.isCurrent() && this.canRun(owner.owner);
    if (owner === world.gameInstance) return true;
    const actor = owner instanceof Actor ? owner : owner instanceof ActorComponent ? owner.owner
      : owner instanceof MaterialObject ? owner.component.owner : null;
    if (actor) return actor.world === world && this.canTickActor(actor);
    if (owner instanceof SceneLayer) {
      const load = this.host.layers().get(owner.guid);
      return load?.layer === owner && load.ready === true;
    }
    if (owner instanceof Scene) {
      return (owner === world.currentScene || (!this.host.paused() && streams.sceneReady(owner))) && this.canTickScene();
    }
    // Detached components and superseded GameInstances have no active owner.
    return !(owner instanceof ActorComponent || owner instanceof MaterialObject || owner instanceof GameInstance);
  }

  /** A SceneSubsystem's On Init, Tick and notifications: its Scene may run. */
  canRunSceneSubsystem(subsystem: SceneSubsystem): boolean {
    return !subsystem.ended && subsystem.scene === this.host.world().currentScene && this.canTickScene();
  }

  /**
   * Deferred owner work waits for the owner (a SceneSubsystem's for its
   * Scene). World actors and their components also wait while a current
   * SceneSubsystem has queued work (On Init first), so every subsystem hears
   * Spawned right before the actor's Begin Play.
   */
  canRunActions(owner: BObject): boolean {
    if (owner instanceof SceneSubsystem) return this.canRunSceneSubsystem(owner);
    if (!this.canRun(owner)) return false;
    const actor = owner instanceof Actor ? owner : owner instanceof ActorComponent ? owner.owner : null;
    return !actor || !!actor.sceneLayerId || this.host.world().getSceneSubsystems().every(
      (subsystem) => subsystem.ended || !this.pending.get(subsystem)?.length);
  }

  /** Run now when the owner's actions may run, else queue it behind the owner's earlier work. */
  run(owner: BObject, action: () => void): void {
    if (this.canRunActions(owner)) { action(); return; }
    if (this.host.stopped() || owner.destroyed) return;
    const actions = this.pending.get(owner) ?? [];
    actions.push(action);
    this.pending.set(owner, actions);
  }

  /** As `run`, but behind work already queued for the owner even while that queue drains. */
  runAfterQueued(owner: BObject, action: () => void): void {
    // An empty queue is one being drained (its On Init may be running).
    const queued = this.pending.get(owner);
    if (queued && queued.length > 0) queued.push(action);
    else this.run(owner, action);
  }

  /** An owner's authored creation (Begin Play, On Init), once it may run. */
  runCreation(owner: BObject, create: () => void): void {
    // Restored actors already contain checkpoint values. Begin Play must not
    // overwrite them; On Game Loaded is their post-restoration lifecycle hook.
    if (this.host.saveBoundaryActive()) { this.created.add(owner); return; }
    this.run(owner, () => {
      // Spawned before a SceneSubsystem existed: it hears about it now.
      if (owner instanceof Actor) this.host.world().notifyActorEnteringPlay(owner);
      this.created.add(owner);
      this.guard(create);
    });
  }

  /** An owner's authored destruction: dropped queued work, and On Destroyed only after its creation ran. */
  runDestroyed(owner: BObject, destroy: () => void): void {
    this.host.releaseAssets(owner.guid);
    this.pending.delete(owner);
    if (this.host.saveBoundaryActive()) return;
    if (this.created.has(owner)) this.guard(destroy);
  }

  /** The owner's authored creation has run (or a checkpoint restored it). */
  isCreated(owner: BObject): boolean {
    return this.created.has(owner);
  }

  flush(): void {
    this.flushing++;
    try {
      // SceneSubsystems first: their On Init precedes the Begin Play it releases.
      for (const owner of this.pending.keys()) {
        if (owner instanceof SceneSubsystem) this.drain(owner);
      }
      for (const owner of this.pending.keys()) this.drain(owner);
    } finally {
      this.flushing--;
    }
  }

  /**
   * A newly spawned actor's queued work. Spawned from queued work (an On Init
   * or Begin Play): only this actor's work runs now; other owners wait until
   * that handler returns.
   */
  flushSpawned(actor: Actor): void {
    if (this.flushing > 0) {
      for (const owner of [actor, ...actor.components]) this.drain(owner);
    } else this.flush();
  }

  drop(owner: BObject): void {
    this.pending.delete(owner);
  }

  /** Drop the queued work of an actor and its components. */
  dropActor(actor: Actor): void {
    this.pending.delete(actor);
    for (const component of actor.components) this.pending.delete(component);
  }

  clear(): void {
    this.pending.clear();
  }

  /** Run script code, reporting its error; an infinite loop propagates unless Play has stopped. */
  guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      if (isInfiniteLoopError(error)) {
        // Stop must finish tearing down every owner even if On End loops.
        if (!this.host.stopped()) throw error;
        return;
      }
      this.host.reportError(error);
    }
  }

  private canRunGameSubsystem(subsystem: GameSubsystem): boolean {
    // GameSubsystems wrap the Game Instance: admitted like it while Play runs,
    // and through the whole Stop lifecycle until their own On End has run, so
    // the Game Instance's On End (which runs first) can still call them.
    if (subsystem.destroyed || !this.host.world().getGameSubsystems().includes(subsystem)) return false;
    return this.host.stopped() || !this.host.blocks().active;
  }

  private drain(owner: BObject): void {
    const actions = this.pending.get(owner);
    if (!actions) return;
    if (owner.destroyed) { this.pending.delete(owner); return; }
    while (actions.length && this.canRunActions(owner)) actions.shift()!();
    if (actions.length === 0 && this.pending.get(owner) === actions) this.pending.delete(owner);
  }
}
