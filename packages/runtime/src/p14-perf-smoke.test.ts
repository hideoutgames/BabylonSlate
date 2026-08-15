import { describe, expect, it } from "vitest";
import { TICK_BUDGET_MS } from "@babylonslate/debugger";
import { createInProcessRuntime } from "./driver";

describe("P14 perf smoke", () => {
  it("keeps a tiny scene's script and physics tick under 8ms", () => {
    const runtime = createInProcessRuntime({
      seed: 14,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      seedDemoActors: false,
    });
    const world = runtime.getWorld();
    const actor = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "dynamic", mass: 1, gravityScale: 1 },
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
    runtime.start();
    for (let i = 0; i < 30; i++) runtime.tick();
    expect(runtime.lastScriptMs).toBeLessThan(TICK_BUDGET_MS);
    expect(runtime.lastPhysicsMs).toBeLessThan(TICK_BUDGET_MS);
    expect(runtime.lastScriptMs + runtime.lastPhysicsMs).toBeLessThan(
      TICK_BUDGET_MS,
    );
    runtime.stop();
  });
});
