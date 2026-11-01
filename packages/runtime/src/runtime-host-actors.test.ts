import { describe, expect, it, vi } from "vitest";
import { Actor, ClassRegistry, World } from "@haptic/object-model";
import { createActorHostBindings } from "./runtime-host-actors";

function bindings(world: World) {
  const stopAudio = vi.fn();
  return {
    stopAudio,
    host: createActorHostBindings({
      world: () => world,
      stopped: () => false,
      scripts: () => ({ bindInterfaceHandlers: () => {} }),
      audioParticles: { stopAudio, stopParticles: () => {} },
      tweens: { cancelInvalid: () => {} },
      classAssetGuids: new Map(),
      demandAssetCatalog: false,
      assetPreloads: { acquire: vi.fn(), release: vi.fn(), transferOwner: vi.fn(), getState: vi.fn() },
      spawn: () => null,
      prepareSpawn: () => null,
      finishSpawn: () => null,
      continueSimulation: () => undefined,
      slot: () => undefined,
      emit: () => {},
    }),
  };
}

describe("Destroy Actor", () => {
  it("acts on the referenced actor, never on a successor that reuses its guid", () => {
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const { host, stopAudio } = bindings(world);
    const original = world.spawnActorNow(new Actor({ classId: "Door", guid: "door" }));
    host.destroyActor!(original);
    world.flushPending();
    expect(original.destroyed).toBe(true);

    // Same-scene reloads and Save Game ids reuse guids.
    const successor = world.spawnActorNow(new Actor({ classId: "Door", guid: "door" }));
    host.destroyActor!(original);
    world.flushPending();
    expect(successor.destroyed).toBe(false);
    expect(world.findActor("door")).toBe(successor);
    expect(stopAudio).toHaveBeenCalledTimes(1);
  });
});
