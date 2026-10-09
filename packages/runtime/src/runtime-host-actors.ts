import type { CommandMessage } from "@babylonslate/bridge";
import { isSceneLayerDeniedComponent, type Transform } from "@babylonslate/core";
import {
  isLockedEngineClassId,
  isSceneLayerExclusiveComponent,
  type Actor,
  type BObject,
  type World,
} from "@babylonslate/object-model";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import { sceneRealizationCancelled } from "./scene-realization-work";
import type { ScriptHost, ScriptHostServices } from "./script-host";
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
  spawn(options: { classId: string; transform?: Transform; streamOwner?: BObject | null }): Actor | null;
  /** Pending while a session boundary holds the owner's continuation. */
  continueSimulation(owner: BObject | null): Promise<void> | undefined;
  slot(actor: Actor): number | undefined;
  emit(command: CommandMessage): void;
}

/** Script actor calls: spawning, destruction, added components and bone attachment. */
export function createActorHostBindings(deps: ActorHostDeps): Pick<ScriptHostServices,
  "destroyActor" | "addComponent" | "spawnActor" | "spawnActorAsync" | "getActors" | "attachToBone" | "findActor"> {
  return {
    destroyActor: (actor) => {
      if (!actor) return;
      deps.audioParticles.stopAudio(actor);
      deps.audioParticles.stopParticles(actor);
      deps.world().destroyActor(actor.guid);
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
        throw new Error(`Class ${id} (${guid}) is not prepared; use Spawn Actor (ctx.spawnActorAsync), or load the Class first with Async Load Class or Load Class Blocking`);
      }
      return deps.spawn({
        classId: id,
        transform: coerceTransform(transform),
        streamOwner: owner,
      });
    },
    spawnActorAsync: async (classId, transform, owner) => {
      const id = String(classId ?? "").trim();
      if (!id || deps.stopped() || owner?.destroyed) return null;
      const guid = deps.classAssetGuids.get(id);
      if (deps.demandAssetCatalog && !guid && !isLockedEngineClassId(id)) throw new Error(`Class ${id} is missing from the asset catalog`);
      const preload = deps.demandAssetCatalog && guid
        ? await deps.assetPreloads.acquire([guid], owner?.guid ?? deps.world().currentScene?.guid ?? "session") : null;
      if (deps.stopped() || owner?.destroyed) {
        if (preload) deps.assetPreloads.release(preload.preloadId);
        throw sceneRealizationCancelled();
      }
      try {
        { const pending = deps.continueSimulation(owner ?? null); if (pending) await pending; }
        if (preload && !preload.success) throw new Error(`Cannot spawn ${id} requested by ${owner?.guid ?? "session"}: ${preload.errorMessage}`);
        const actor = deps.spawn({ classId: id, transform: coerceTransform(transform), streamOwner: owner });
        if (preload) {
          if (actor && !actor.destroyed) deps.assetPreloads.transferOwner(preload.preloadId, actor.guid);
          else deps.assetPreloads.release(preload.preloadId);
        }
        return actor;
      } catch (error) {
        if (preload) deps.assetPreloads.release(preload.preloadId);
        throw error;
      }
    },
    getActors: () => deps.world().getActors(),
    attachToBone: (actor, target, boneName) => {
      const slotId = deps.slot(actor);
      const targetSlotId = target ? deps.slot(target) : null;
      if (slotId === undefined || targetSlotId === undefined) return;
      deps.emit({ type: "attachToBone", slotId, targetSlotId, boneName });
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
