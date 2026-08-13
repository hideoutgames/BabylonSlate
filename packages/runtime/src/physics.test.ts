import { describe, expect, it } from "vitest";
import { createInProcessRuntime } from "./driver";

describe("runtime physics phase", () => {
  it("steps rigid bodies and reports separate physicsMs", () => {
    const runtime = createInProcessRuntime({
      seed: 11,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      seedDemoActors: false,
    });
    const world = runtime.getWorld();
    const actor = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: {
          motionType: "dynamic",
          mass: 1,
          gravityScale: 1,
        },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        },
      }),
    );
    world.spawnActorNow(actor);

    const ground = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    ground.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    ground.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } },
        },
      }),
    );
    world.spawnActorNow(ground);

    runtime.start();
    for (let i = 0; i < 90; i++) runtime.tick();

    expect(actor.transform.position.y).toBeLessThan(5);
    expect(runtime.lastPhysicsMs).toBeGreaterThanOrEqual(0);
    expect(runtime.lastScriptMs).toBeGreaterThanOrEqual(0);

    const hit = runtime.getPhysicsSync()!.lineTrace(
      { x: 0, y: 10, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(hit.hit).toBe(true);
    runtime.stop();
  });

  it("loadPhysics upgrades to Havok and keeps already-spawned bodies", async () => {
    const runtime = createInProcessRuntime({
      seed: 3,
      maxActors: 8,
      physicsWorld: "3d",
      seedDemoActors: false,
    });
    const world = runtime.getWorld();
    const ground = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    ground.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    ground.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } },
        },
      }),
    );
    world.spawnActorNow(ground);

    runtime.start();
    runtime.tick();
    expect(runtime.getPhysicsSync()!.getBackend().constructor.name).toBe(
      "SoftwarePhysicsBackend",
    );

    await runtime.loadPhysics();
    expect(runtime.getPhysicsSync()!.getBackend().constructor.name).toBe(
      "HavokPhysicsBackend",
    );
    const hit = runtime.getPhysicsSync()!.lineTrace(
      { x: 0, y: 10, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(hit.hit).toBe(true);
    runtime.stop();
  });

  it("moveCharacter lazily creates a controller and moves a kinematic actor", () => {
    const runtime = createInProcessRuntime({
      seed: 7,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "2d",
      seedDemoActors: false,
    });
    const world = runtime.getWorld();
    const actor = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "kinematic", mass: 1, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } },
        },
      }),
    );
    world.spawnActorNow(actor);

    runtime.start();
    runtime.tick();
    runtime.getPhysicsSync()!.moveCharacter(
      actor,
      { x: 1, y: 0, z: 0 },
      1 / 60,
    );
    expect(actor.transform.position.x).toBeCloseTo(1, 5);
    expect(actor.transform.position.y).toBeCloseTo(1, 5);
    runtime.stop();
  });

  it("moveCharacter works on software 3d kinematic actors", () => {
    const runtime = createInProcessRuntime({
      seed: 8,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      seedDemoActors: false,
    });
    const world = runtime.getWorld();
    const actor = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "kinematic", mass: 1, gravityScale: 0 },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 0.4, y: 0.4, z: 0.4 } },
        },
      }),
    );
    world.spawnActorNow(actor);

    runtime.start();
    runtime.tick();
    runtime.getPhysicsSync()!.moveCharacter(
      actor,
      { x: 0, y: 0, z: 1 },
      1 / 60,
    );
    expect(actor.transform.position.z).toBeCloseTo(1, 5);
    runtime.stop();
  });
});
