import { expect, it } from "vitest";
import { identityTransform, parseMovementProperties } from "@babylonslate/core";
import { createDefaultSpriteAnimationPayload } from "@babylonslate/assets";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createPhysicsBackend, createSoftwarePhysicsBackend } from "@babylonslate/physics";
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

it("Havok preserves authored facing and one overlap lifetime while Movement turns inside a trigger", async () => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ classId: "Actor", guid: "moving", transform: identityTransform() });
  actor.attachComponent(world.createComponent({ classId: "MovementComponent" }));
  world.spawnActorNow(actor);
  const trigger = world.createActor({ classId: "Actor", guid: "trigger", transform: identityTransform() });
  trigger.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "static" } }));
  trigger.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: {
    isTrigger: true, shape: { kind: "box", halfExtents: { x: 1, y: 2, z: 2 } },
  } }));
  world.spawnActorNow(trigger);
  const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
  const sync = new PhysicsWorldSync(backend);
  const events: string[] = [];
  const step = (x: number) => {
    sync.step(1 / 60, world, 0, 0, () => sync.moveMovement(actor, { x, y: 0, z: 0 }, 1 / 60, parseMovementProperties()));
    events.push(...backend.pollContacts().filter((event) => event.kind !== "hit").map((event) => event.kind));
  };
  try {
    step(0);
    for (let i = 1; i <= 12; i++) {
      const halfAngle = i * Math.PI / 12;
      actor.transform.rotation = { x: 0, y: Math.sin(halfAngle), z: 0, w: Math.cos(halfAngle) };
      step(0);
      const actual = actor.transform.rotation;
      const dot = Math.abs(actual.y * Math.sin(halfAngle) + actual.w * Math.cos(halfAngle)) /
        Math.hypot(actual.x, actual.y, actual.z, actual.w);
      // Havok integrates a kinematic angular target rather than teleporting to
      // an exact quaternion. A lost facing update would be a full 30 degrees off.
      expect(2 * Math.acos(Math.min(1, dot))).toBeLessThan(Math.PI / 180);
    }
    expect(events).toEqual(["overlapBegin"]);
    for (let i = 0; i < 25; i++) step(0.1);
    expect(events).toEqual(["overlapBegin", "overlapEnd"]);
  } finally {
    sync.dispose();
  }
});

it("Rapier preserves the Movement capsule's overlap while sprite frames and visual transforms change", async () => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ classId: "Actor", guid: "moving", transform: identityTransform() });
  const movement = world.createComponent({ classId: "MovementComponent" });
  const sprite = world.createComponent({ classId: "SpriteComponent" });
  actor.attachComponent(movement);
  actor.attachComponent(sprite);
  world.spawnActorNow(actor);
  const trigger = world.createActor({ classId: "Actor", guid: "trigger", transform: identityTransform() });
  trigger.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "static" } }));
  trigger.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: {
    isTrigger: true, shape: { kind: "box2d", halfExtents: { x: 1, y: 2 } },
  } }));
  world.spawnActorNow(trigger);
  const animation = createDefaultSpriteAnimationPayload();
  animation.frames = [
    { textureGuid: "texture", durationMs: 100, pivot: { x: 0.5, y: 0.5 }, collision: { x: 0, y: 0, width: 1, height: 1 }, width: 100, height: 100 },
    { textureGuid: "texture", durationMs: 100, pivot: { x: 0.25, y: 0.5 }, collision: { x: 0, y: 0, width: 0.5, height: 1 }, width: 200, height: 100 },
  ];
  const backend = await createPhysicsBackend({ kind: "2d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
  const sync = new PhysicsWorldSync(backend);
  sync.setSpriteContent({ sprites: new Map(), spriteAnimations: new Map([["walk", animation]]) });
  const events: string[] = [];
  const step = (x = 0) => {
    sync.step(1 / 60, world, 0, 0, () => sync.moveMovement(actor, { x, y: 0, z: 0 }, 1 / 60, parseMovementProperties()));
    events.push(...backend.pollContacts().filter((event) => event.kind !== "hit").map((event) => event.kind));
  };
  try {
    sync.setActorSpriteClip(actor, { assetGuid: "walk", clipName: "", normalisedTime: 0 });
    step();
    sync.setActorSpriteClip(actor, { assetGuid: "walk", clipName: "", normalisedTime: 0.75 });
    step();
    actor.transform.scale.x = 3;
    sprite.transform.position.x = 10;
    movement.transform.position.y = 5;
    step();
    expect(events).toEqual(["overlapBegin"]);
    expect(backend.lineTrace({ x: 0.6, y: 4, z: 0 }, { x: 0.6, y: -4, z: 0 }, { ignoreActorIds: ["trigger"] }).hit).toBe(false);
    for (let i = 0; i < 25; i++) step(0.1);
    expect(events).toEqual(["overlapBegin", "overlapEnd"]);
  } finally {
    sync.dispose();
  }
});

it.each(["3d", "2d"] as const)("native %s Movement follows parent translation without adding motor velocity", async (kind) => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const parent = world.createActor({ classId: "Actor", guid: "parent", transform: identityTransform() });
  parent.transform.position.x = 10;
  world.spawnActorNow(parent);
  const actor = world.createActor({ classId: "Actor", guid: "moving", variables: { parentId: "parent" }, transform: identityTransform() });
  actor.transform.position.x = 2;
  actor.attachComponent(world.createComponent({ classId: "MovementComponent" }));
  world.spawnActorNow(actor);
  const backend = await createPhysicsBackend({ kind, gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
  const sync = new PhysicsWorldSync(backend);
  const step = () => sync.step(1 / 60, world, 0, 0, () => {
    const moved = sync.moveMovement(actor, { x: 0, y: 0, z: 0 }, 1 / 60, parseMovementProperties());
    expect(moved?.velocity.x).toBeCloseTo(0);
  });
  try {
    step();
    parent.transform.position.x += 5;
    sync.teleportActor(parent, world);
    step();
    expect(actor.transform.position.x).toBeCloseTo(2);
    expect(backend.getBodyTransform("body:moving")?.position.x).toBeCloseTo(17);
    step();
    expect(actor.transform.position.x).toBeCloseTo(2);
  } finally {
    sync.dispose();
  }
});
