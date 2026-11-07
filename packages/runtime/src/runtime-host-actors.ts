import type { CommandMessage } from "@haptic/bridge";
import { isSceneLayerDeniedComponent, type Transform } from "@haptic/core";
import {
  isLockedEngineClassId,
  isSceneLayerExclusiveComponent,
  type Actor,
  type EngineObject,
  type World,
} from "@haptic/object-model";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import type { ScriptHost, ScriptHostServices, SpawnActorOptions } from "./script-host";
import type { SimulationBlocks } from "./simulation-blocks";
import type { TweenRuntime } from "./tween-runtime";

interface ActorHostDeps {
  world(): World;
  stopped(): boolean;
  scripts(): Pick<ScriptHost, "bindInterfaceHandlers">;
  audioParticles: Pick<AudioParticleEmitter, "stopAudio" | "stopParticles">;
  tweens: Pick<TweenRuntime, "cancelInvalid">;
  /** Class id to its asset guid, for classes the host prepares on demand. */
  classAssetGuids: ReadonlyMap<string, string>;
  /** The host prepares class assets on demand, so spawns must wait for them. */
  demandAssetCatalog: boolean;
  assetPreloads: Pick<RuntimeAssetPreloads, "acquire" | "release" | "transferOwner" | "getState">;
  /** A blocking spawn holds the simulation while its Class prepares. */
  blocks: Pick<SimulationBlocks, "hold">;
  spawn(options: SpawnOptions): Actor | null;
  /** `spawn` in two steps for Spawn Actor Deferred: the actor outside the World, then its realization. */
  prepareSpawn(options: SpawnOptions): Actor | null;
  finishSpawn(actor: Actor): Actor | null;
  /** Pending while a session boundary holds the owner's continuation. */
  continueSimulation(owner: EngineObject | null): Promise<void> | undefined;
  slot(actor: Actor): number | undefined;
  emit(command: CommandMessage): void;
}

type SpawnOptions = { classId: string; transform?: Transform; streamOwner?: EngineObject | null };

/** Script actor calls: spawning, destruction, added components and bone attachment. */
export function createActorHostBindings(deps: ActorHostDeps): Pick<ScriptHostServices,
  "destroyActor" | "addComponent" | "spawnActor" | "spawnActorAsync" | "beginDeferredSpawnAsync" | "finishDeferredSpawn" |
  "getActors" | "attachToBone" | "findActor"> {
  // Spawn Actor Deferred results awaiting Finish Deferred Spawn Actor, with the Class preload each one owns.
  const deferred = new WeakMap<Actor, string | null>();
  const release = (preloadId: string | null) => {
    if (preloadId) deps.assetPreloads.release(preloadId);
  };
  // The latent half of the Spawn Actor nodes: prepare the Class for `owner`, wait for the owner's simulation, then
  // `create`. A blocking spawn prepares at High priority and holds the simulation meanwhile, like Load Class
  // Blocking, so no game time passes before the actor exists. The preload is the caller's to hand on or release.
  const createPrepared = async (
    classId: string,
    transform: unknown,
    owner: EngineObject | null | undefined,
    create: (options: SpawnOptions) => Actor | null,
    options: SpawnActorOptions | undefined,
  ): Promise<{ actor: Actor | null; preloadId: string | null } | null> => {
    const id = String(classId ?? "").trim();
    if (!id || deps.stopped() || owner?.destroyed) return null;
    const guid = deps.classAssetGuids.get(id);
    if (deps.demandAssetCatalog && !guid && !isLockedEngineClassId(id)) throw new Error(`Class ${id} is missing from the asset catalog`);
    const blocking = options?.blocking === true;
    const acquiring = deps.demandAssetCatalog && guid
      ? deps.assetPreloads.acquire([guid], owner?.guid ?? deps.world().currentScene?.guid ?? "session", blocking ? { priority: "High" } : {})
      : null;
    const preload = acquiring ? await (blocking ? deps.blocks.hold(acquiring) : acquiring) : null;
    try {
      // Ends quietly, like any continuation, when the session stopped or the owner was destroyed meanwhile,
      // including by another continuation that resumed in the same flush.
      for (let pending = deps.continueSimulation(owner ?? null); pending; pending = deps.continueSimulation(owner ?? null)) await pending;
      if (preload && !preload.success) throw new Error(`Cannot spawn ${id} requested by ${owner?.guid ?? "session"}: ${preload.errorMessage}`);
      const actor = create({ classId: id, transform: coerceTransform(transform), streamOwner: owner });
      return { actor, preloadId: preload?.preloadId ?? null };
    } catch (error) {
      release(preload?.preloadId ?? null);
      throw error;
    }
  };
  // A live actor owns its Class preload, so the preload outlives the spawner; otherwise it is released.
  const handOver = (preloadId: string | null, actor: Actor | null): void => {
    if (!preloadId) return;
    if (actor && !actor.destroyed) deps.assetPreloads.transferOwner(preloadId, actor.guid);
    else release(preloadId);
  };
  return {
    destroyActor: (actor) => {
      if (!actor) return;
      if (deferred.has(actor)) {
        // An unfinished Spawn Actor Deferred result never entered play: its preparation is cancelled.
        release(deferred.get(actor) ?? null);
        deferred.delete(actor);
        deps.world().destroyActorInstance(actor);
      } else {
        const world = deps.world();
        // By identity: a stale reference never reaches a successor that reuses
        // the guid. One spawned earlier in this phase commits first, then goes.
        const queued = world.isSpawnQueued(actor);
        if (actor.destroyed || (actor.world !== world && !queued)) return;
        deps.audioParticles.stopAudio(actor);
        deps.audioParticles.stopParticles(actor);
        if (queued) world.destroyActor(actor.guid);
        else world.destroyActorInstance(actor);
      }
      deps.tweens.cancelInvalid();
    },
    addComponent: (actor, classId, transform) => {
      const target = actor;
      if (deps.stopped() || !target || target.destroyed) return null;
      const id = String(classId ?? "").trim();
      if (!id) return null;
      const overlay = Boolean(target.sceneLayerId);
      if (overlay && isSceneLayerDeniedComponent(id)) return null;
      if (!overlay && isSceneLayerExclusiveComponent(id)) return null;
      const pose = coerceTransform(transform);
      const component = deps.world().createComponent({
        classId: id,
        ...(pose ? { transform: pose } : {}),
      });
      deps.scripts().bindInterfaceHandlers(component);
      target.attachComponent(component);
      return component;
    },
    spawnActor: (classId, transform, owner) => {
      const id = String(classId ?? "").trim();
      if (!id) return null;
      const guid = deps.classAssetGuids.get(id);
      if (deps.demandAssetCatalog && guid && deps.assetPreloads.getState(guid) !== "ready") {
        throw new Error(`Class ${id} (${guid}) is not prepared; use Spawn Actor (Async) or Spawn Actor (Blocking), or load the Class first with Async Load Class or Load Class Blocking`);
      }
      return deps.spawn({
        classId: id,
        transform: coerceTransform(transform),
        streamOwner: owner,
      });
    },
    spawnActorAsync: async (classId, transform, owner, options) => {
      const prepared = await createPrepared(classId, transform, owner, deps.spawn, options);
      if (!prepared) return null;
      handOver(prepared.preloadId, prepared.actor);
      return prepared.actor;
    },
    beginDeferredSpawnAsync: async (classId, transform, owner, options) => {
      const prepared = await createPrepared(classId, transform, owner, deps.prepareSpawn, options);
      if (!prepared) return null;
      handOver(prepared.preloadId, prepared.actor);
      if (prepared.actor) deferred.set(prepared.actor, prepared.preloadId);
      return prepared.actor;
    },
    finishDeferredSpawn: (actor) => {
      if (!deferred.has(actor)) {
        if (actor.destroyed) return null;
        throw new Error(`${actor.classId} (${actor.guid}) is not waiting to finish spawning; pass the result of Spawn Actor Deferred (Async) or Spawn Actor Deferred (Blocking) to Finish Deferred Spawn Actor once`);
      }
      const preloadId = deferred.get(actor) ?? null;
      deferred.delete(actor);
      let spawned: Actor | null = null;
      try {
        spawned = deps.finishSpawn(actor);
      } finally {
        if (!spawned) release(preloadId);
      }
      return spawned;
    },
    getActors: () => deps.world().getActors(),
    attachToBone: (actor, target, boneName) => {
      const slotId = deps.slot(actor);
      const targetSlotId = target ? deps.slot(target) : null;
      if (slotId === undefined || targetSlotId === undefined) return false;
      deps.emit({ type: "attachToBone", slotId, targetSlotId, boneName });
      return true;
    },
    findActor: (actorId) => {
      const actor = deps.world().findActor(actorId);
      if (!actor || actor.destroyed) return undefined;
      return actor;
    },
  };
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
