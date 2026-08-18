import { describe, expect, it } from "vitest";
import { createInProcessRuntime } from "./driver";

describe("RuntimeDriver.inspectWorld", () => {
  it("returns a debug inspect snapshot of the live world", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
    });
    runtime.start();
    const actor = runtime.getWorld().createActor({
      guid: "cube",
      classId: "Actor",
      variables: { name: "Cube", ticks: 0 },
    });
    runtime.getWorld().spawnActorNow(actor);
    runtime.tick();
    actor.setVariable("ticks", 1);

    const snapshot = runtime.inspectWorld();
    expect(snapshot.tickIndex).toBeGreaterThan(0);
    const cube = snapshot.nodes.find((node) => node.id === "cube");
    expect(cube?.label).toBe("Cube");
    expect(cube?.kind).toBe("actor");
    expect(cube?.variables.ticks).toBe(1);
    runtime.stop();
  });
});
