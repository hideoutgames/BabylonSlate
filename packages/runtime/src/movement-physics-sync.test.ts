import { expect, it } from "vitest";
import { identityTransform, parseMovementProperties } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

it.each(["3d", "2d"] as const)("%s Movement alone creates a capsule, updates dimensions and retires on removal", (kind) => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ classId: "Actor", guid: "moving", transform: identityTransform() });
  actor.transform.position.y = 3;
  actor.transform.scale.x = 5;
  const movement = world.createComponent({ classId: "MovementComponent", guid: "movement" });
  actor.attachComponent(movement);
  world.spawnActorNow(actor);
  const backend = createSoftwarePhysicsBackend(kind, { x: 0, y: -9.81, z: 0 });
  const sync = new PhysicsWorldSync(backend);
  try {
    sync.step(1 / 60, world, 0, 9.81, () => {
      const result = sync.moveMovement(actor, { x: 1, y: -0.5, z: 0 }, 1 / 60, parseMovementProperties());
      expect(result?.position).toEqual({ x: 1, y: 2.5, z: 0 });
      expect(result?.grounded).toBe(false);
    });
    expect(actor.transform.position).toEqual({ x: 1, y: 2.5, z: 0 });
    expect(backend.lineTrace({ x: 1, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }).actorId).toBe("moving");
    expect(backend.lineTrace({ x: 2, y: 5, z: 0 }, { x: 2, y: 0, z: 0 }).hit).toBe(false);
    movement.setVariable("radius", 1.2);
    sync.syncFromWorld(world);
    expect(backend.lineTrace({ x: 2, y: 5, z: 0 }, { x: 2, y: 0, z: 0 }).actorId).toBe("moving");
    movement.destroyed = true;
    sync.syncFromWorld(world);
    expect(backend.lineTrace({ x: 1, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }).hit).toBe(false);
    expect(sync.moveMovement(actor, { x: 1, y: 0, z: 0 }, 1 / 60, parseMovementProperties())).toBeNull();
  } finally {
    sync.dispose();
  }
});

it("Movement preserves a parented actor's local pose and refuses another motion owner", () => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const parent = world.createActor({ classId: "Actor", guid: "parent", transform: identityTransform() });
  parent.transform.position.x = 10;
  parent.transform.scale.x = 2;
  world.spawnActorNow(parent);
  const actor = world.createActor({ classId: "Actor", guid: "moving", variables: { parentId: "parent" }, transform: identityTransform() });
  actor.attachComponent(world.createComponent({ classId: "MovementComponent" }));
  world.spawnActorNow(actor);
  const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
  const sync = new PhysicsWorldSync(backend);
  try {
    sync.step(1 / 60, world, 0, 9.81, () => {
      expect(sync.moveMovement(actor, { x: 2, y: 0, z: 0 }, 1 / 60, parseMovementProperties())?.position.x).toBe(12);
    });
    expect(actor.transform.position.x).toBe(1);
    actor.attachComponent(world.createComponent({ classId: "NavAgentComponent" }));
    sync.syncFromWorld(world);
    expect(sync.moveMovement(actor, { x: 2, y: 0, z: 0 }, 1 / 60, parseMovementProperties())).toBeNull();
    expect(backend.getBodyTransform("body:moving")).toBeNull();
  } finally {
    sync.dispose();
  }
});
