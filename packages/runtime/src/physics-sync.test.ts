import { describe, expect, it } from "vitest";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

describe("PhysicsWorldSync collider translation", () => {
  it("passes the collider component local position into the backend", () => {
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    const actor = world.createActor({
      classId: "Actor",
      guid: "hero",
      transform: identityTransform(),
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: "rb",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    const collider = world.createComponent({
      classId: "ColliderComponent",
      guid: "col",
      variables: {
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      },
      transform: {
        position: { x: 3, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    actor.attachComponent(collider);
    world.spawnActorNow(actor);

    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    sync.syncFromWorld(world);

    expect(backend.sphereOverlap({ x: 3, y: 0, z: 0 }, 0.2).actorIds).toContain(
      "hero",
    );
    expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.2).actorIds).toEqual([]);
    sync.dispose();
  });
});
