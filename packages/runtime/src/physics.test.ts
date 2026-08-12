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
});
