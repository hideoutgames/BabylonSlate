import { emptyWaterSample } from "@babylonslate/core";
import { Actor, ActorComponent, SceneLayer, type BObject, type World } from "@babylonslate/object-model";
import type { MovementWorldSync } from "./movement";
import type { PhysicsWorldSync } from "./physics-sync";
import type { RagdollWorldSync } from "./ragdoll-sync";
import type { ScriptHostServices } from "./script-host";

type CursorProjection = ReturnType<NonNullable<ScriptHostServices["projectCursorToScene"]>>;

interface PhysicsHostDeps {
  world(): World;
  /** Main-Scene physics; replaced when the native backend loads. */
  physics(): PhysicsWorldSync;
  /** A Scene Layer instance's world; null when that layer has no physics or is gone. */
  layerPhysics(layerGuid: string): PhysicsWorldSync | null;
  /** The world that simulates an actor (its Scene Layer's own, or main); null for a layer without physics. */
  physicsFor(actor: Actor): PhysicsWorldSync | null;
  ragdolls: Pick<RagdollWorldSync, "addImpulse" | "retireActor">;
  /** Takes the impulse of an actor whose Movement is moved by its character controller. */
  movement: Pick<MovementWorldSync, "addImpulse">;
  /** Simulated water time including the current tick (`WaterClock.time`). */
  waterTime(): number;
  /** Project the cursor through the main Play camera, or through Scene Layer `sceneLayerId`'s camera. */
  projectCursorToScene(
    channel: string | undefined,
    options: { drawDebug?: boolean; duration?: number } | undefined,
    sceneLayerId: string | null,
  ): CursorProjection;
  /** `projectCursorToScene` from a finger that is down this tick; any other finger misses. */
  projectTouchToScene(
    finger: number,
    channel: string | undefined,
    options: { drawDebug?: boolean; duration?: number } | undefined,
    sceneLayerId: string | null,
  ): CursorProjection;
}

const miss = () => ({ hit: false, location: null, normal: null, distance: 0, actorId: null, bodyId: null });

/**
 * The Scene Layer instance whose world a script's queries use: the calling
 * actor's (or its component's owner's) layer, or the calling Scene Layer
 * itself. Null for main-Scene callers and callers outside any actor.
 */
export function callerSceneLayerId(caller: BObject | null | undefined): string | null {
  if (caller instanceof Actor) return caller.sceneLayerId;
  if (caller instanceof ActorComponent) return caller.owner?.sceneLayerId ?? null;
  if (caller instanceof SceneLayer) return caller.guid;
  return null;
}

/**
 * Script physics calls: water samples, traces, overlaps, impulses and character
 * moves. Queries answer from the calling script's world: a Scene Layer actor's
 * queries see only its layer's bodies (none when that layer has no physics),
 * main-Scene scripts see only the main world.
 */
export function createPhysicsHostBindings(deps: PhysicsHostDeps): Pick<ScriptHostServices,
  "sampleWater" | "lineTrace" | "projectCursorToScene" | "projectTouchToScene" | "sphereOverlap" | "shapeSweep" |
  "addImpulse" | "moveCharacter" | "teleportActor"> {
  const queryWorld = (caller: BObject | null | undefined): PhysicsWorldSync | null => {
    const layerId = callerSceneLayerId(caller);
    return layerId ? deps.layerPhysics(layerId) : deps.physics();
  };
  return {
    sampleWater: (position, actorId, caller) => {
      // Water is world-only: Scene Layer worlds hold none, so layer callers sample no water.
      if (callerSceneLayerId(caller)) return { ...emptyWaterSample(), actorId: null };
      // Current at call time in its own state (reused within the tick while nothing it read changed), at the
      // dilated simulated water time; the step keeps its own evaluation and clock.
      return deps.physics().water.query(deps.world().getActors(), deps.waterTime(), position, actorId);
    },
    lineTrace: (start, end, options, caller) =>
      queryWorld(caller)?.lineTrace(start, end, options) ?? miss(),
    projectCursorToScene: (channel, options, caller) =>
      deps.projectCursorToScene(channel, options, callerSceneLayerId(caller)),
    projectTouchToScene: (finger, channel, options, caller) =>
      deps.projectTouchToScene(finger, channel, options, callerSceneLayerId(caller)),
    sphereOverlap: (center, radius, channel, caller) =>
      queryWorld(caller)?.sphereOverlap(center, radius, { channel }) ?? { actorIds: [], bodyIds: [] },
    shapeSweep: (shape, start, end, channel, caller) =>
      queryWorld(caller)?.shapeSweep(shape, start, end, { channel }) ?? miss(),
    addImpulse: (actor, impulse, strength) => {
      const target = actor;
      if (!target) return;
      if (deps.ragdolls.addImpulse(target, impulse, strength)) return;
      if (deps.movement.addImpulse(target, impulse, strength)) return;
      deps.physicsFor(target)?.addImpulse(
        target.guid,
        impulse,
        strength,
      );
    },
    moveCharacter: (actor, translation, dt, offset) => {
      const target = actor;
      if (!target) return;
      deps.physicsFor(target)?.moveCharacter(target, translation, dt, offset);
    },
    teleportActor: (actor, options) => {
      deps.ragdolls.retireActor(actor);
      deps.physicsFor(actor)?.teleportActor(actor, deps.world(), options);
    },
  };
}
