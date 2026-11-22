import { expect, it } from "vitest";
import { Actor, ClassRegistry, World, type EngineObject } from "@haptic/object-model";
import { OwnerAdmission } from "./owner-admission";

function admission(saveBoundary: { active: boolean }) {
  const order: string[] = [];
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const owners = new OwnerAdmission({
    world: () => world,
    stopped: () => false,
    paused: () => false,
    saveBoundaryActive: () => saveBoundary.active,
    sceneLoading: () => false,
    streams: () => ({ actorReady: () => true, sceneReady: () => true }),
    blocks: () => ({ active: false }),
    layers: () => ({ get: () => undefined, anyReady: () => false }),
    releaseAssets: (guid) => order.push(`assets:${guid}`),
    releaseScriptState: (owner: EngineObject) => order.push(`script state:${owner.guid}`),
    reportError: (error) => { throw error; },
  });
  return { owners, order, world };
}

it("releases a destroyed owner's script state whether or not its On Destroyed ran, after it ran", () => {
  const boundary = { active: false };
  const { owners, order, world } = admission(boundary);
  const [created, early, restored] = ["created", "early", "restored"].map((guid) => new Actor({ classId: "Hero", guid }));
  world.spawnActorNow(created!);
  owners.runCreation(created!, () => {});
  owners.runDestroyed(created!, () => order.push("on destroyed:created"));
  // Destroyed before its Begin Play: no On Destroyed, but bindings others made to it still go.
  owners.runDestroyed(early!, () => order.push("on destroyed:early"));
  boundary.active = true;
  owners.runDestroyed(restored!, () => order.push("on destroyed:restored"));
  expect(order).toEqual([
    "assets:created", "on destroyed:created", "script state:created",
    "assets:early", "script state:early",
    "assets:restored", "script state:restored",
  ]);
});
