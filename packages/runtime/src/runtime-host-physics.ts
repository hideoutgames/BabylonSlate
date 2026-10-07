import type { World } from "@babylonslate/object-model";
import type { PhysicsWorldSync } from "./physics-sync";
import type { RagdollWorldSync } from "./ragdoll-sync";
import type { ScriptHostServices } from "./script-host";

interface PhysicsHostDeps {
  world(): World;
  /** Main-Scene physics; replaced when the native backend loads. */
  physics(): PhysicsWorldSync;
  /** Scene Layer (2D overlay) physics; replaced when the native backend loads. */
  overlayPhysics(): PhysicsWorldSync;
  ragdolls: Pick<RagdollWorldSync, "addImpulse" | "retireActor">;
  /** Fixed simulation step, for water time. */
  dt: number;
  projectCursorToScene: NonNullable<ScriptHostServices["projectCursorToScene"]>;
}

/** Script physics calls: water samples, traces, overlaps, impulses and character moves. */
export function createPhysicsHostBindings(deps: PhysicsHostDeps): Pick<ScriptHostServices,
  "sampleWater" | "lineTrace" | "projectCursorToScene" | "sphereOverlap" | "shapeSweep" |
  "addImpulse" | "moveCharacter" | "teleportActor"> {
  return {
    sampleWater: (position, actorId) =>
      // Current at call time in its own state (reused within the tick while nothing it read changed); the step
      // keeps its own evaluation and clock.
      deps.physics().water.query(deps.world().getActors(), deps.world().clock.tickIndex * deps.dt, position, actorId),
    lineTrace: (start, end, options) =>
      deps.physics().lineTrace(start, end, options),
    projectCursorToScene: deps.projectCursorToScene,
    sphereOverlap: (center, radius, channel) =>
      deps.physics().sphereOverlap(center, radius, { channel }),
    shapeSweep: (shape, start, end, channel) =>
      deps.physics().shapeSweep(shape, start, end, { channel }),
    addImpulse: (actor, impulse, strength) => {
      const target = actor;
      if (!target) return;
      if (deps.ragdolls.addImpulse(target, impulse, strength)) return;
      deps.physics().addImpulse(
        target.guid,
        impulse,
        strength,
      );
    },
    moveCharacter: (actor, translation, dt, offset) => {
      const target = actor;
      if (!target) return;
      const sync = target.sceneLayerId ? deps.overlayPhysics() : deps.physics();
      sync.moveCharacter(target, translation, dt, offset);
    },
    teleportActor: (actor, options) => {
      deps.ragdolls.retireActor(actor);
      const sync = actor.sceneLayerId ? deps.overlayPhysics() : deps.physics();
      sync.teleportActor(actor, deps.world(), options);
    },
  };
}
