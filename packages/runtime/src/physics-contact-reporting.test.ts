import { afterEach, describe, expect, it, vi } from "vitest";
import { identityTransform, type Transform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createPhysicsBackend, type HavokPhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

afterEach(() => vi.restoreAllMocks());

type Components = Array<[string, Record<string, unknown>]>;

function createWorld() {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const spawn = (guid: string, transform: Partial<Transform>, components: Components, parentId?: string) => {
    const actor = world.createActor({
      classId: "Actor", guid, transform: { ...identityTransform(), ...transform },
      variables: parentId ? { parentId } : {},
    });
    for (const [classId, variables] of components) actor.attachComponent(world.createComponent({ classId, variables }));
    world.spawnActorNow(actor);
    return actor;
  };
  return { world, spawn };
}

const staticBody: Components[number] = ["RigidBodyComponent", { motionType: "static", mass: 0, gravityScale: 0 }];
const fallingBody: Components[number] = [
  "RigidBodyComponent", { motionType: "dynamic", mass: 1, gravityScale: 1, linearDamping: 0, angularDamping: 0 },
];
const heldBody: Components[number] = [
  "RigidBodyComponent", { motionType: "dynamic", mass: 1, gravityScale: 0, linearDamping: 0, angularDamping: 0 },
];
const box = (x: number, y = x, z = x): Components[number] => [
  "ColliderComponent", { shape: { kind: "box", halfExtents: { x, y, z } } },
];
const nativeBackend = async (gravity = 0) =>
  (await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: gravity, z: 0 }, allowSoftwareFallback: false })) as HavokPhysicsBackend;

describe("contact reporting follows the actors that can observe contacts", () => {
  it("asks Havok for contact events only on bodies an observer can reach, including a host of one", async () => {
    const { world, spawn } = createWorld();
    spawn("floor", { position: { x: 0, y: -0.5, z: 0 } }, [staticBody, box(5, 0.5, 5)]);
    spawn("plain", { position: { x: -3, y: 2, z: 0 } }, [fallingBody, box(0.25)]);
    spawn("watcher", { position: { x: 3, y: 2, z: 0 } }, [fallingBody, box(0.25)]);
    const carrier = spawn("carrier", { position: { x: 0, y: 6, z: 0 } }, [fallingBody, box(0.25)]);
    // A solid static child rides on the carrier's body, so the carrier's body raises its contacts.
    spawn("sensorFoot", { position: { x: 0, y: -1, z: 0 } }, [staticBody, box(0.1)], carrier.guid);
    const backend = await nativeBackend(-9.81);
    const createBody = vi.spyOn(backend, "createBody");
    const sync = new PhysicsWorldSync(backend, {
      observesContacts: (actor) => actor.guid === "watcher" || actor.guid === "sensorFoot",
    });
    try {
      sync.step(1 / 60, world);
      expect(Object.fromEntries(createBody.mock.calls.map(([desc]) => [desc.actorId, desc.reportContacts])))
        .toEqual({ floor: false, plain: false, watcher: true, carrier: true });
    } finally {
      sync.dispose();
    }
  });

  it("reports a hosted child's contact through its host's body", async () => {
    const { world, spawn } = createWorld();
    spawn("floor", { position: { x: 0, y: -0.5, z: 0 } }, [staticBody, box(5, 0.5, 5)]);
    const carrier = spawn("carrier", { position: { x: 0, y: 2, z: 0 } }, [fallingBody, box(0.25)]);
    spawn("sensorFoot", { position: { x: 0, y: -1, z: 0 } }, [staticBody, box(0.1)], carrier.guid);
    const backend = await nativeBackend(-9.81);
    const sync = new PhysicsWorldSync(backend, { observesContacts: (actor) => actor.guid === "sensorFoot" });
    const pairs = new Set<string>();
    try {
      for (let tick = 0; tick < 90; tick++) {
        sync.step(1 / 60, world);
        for (const event of backend.pollContacts())
          if (event.kind === "hit") pairs.add([event.actorAId, event.actorBId].sort().join("|"));
      }
      expect(pairs.has("floor|sensorFoot")).toBe(true);
    } finally {
      sync.dispose();
    }
  });

  it("starts and stops reporting when the observers change while a contact stays open", async () => {
    const { world, spawn } = createWorld();
    spawn("floor", { position: { x: 0, y: -0.5, z: 0 } }, [staticBody, box(5, 0.5, 5)]);
    spawn("ball", { position: { x: 0, y: 0.24, z: 0 } }, [heldBody, box(0.25)]);
    const backend = await nativeBackend();
    let observed = false;
    const setReporting = vi.spyOn(backend, "setContactReporting");
    const sync = new PhysicsWorldSync(backend, { observesContacts: () => observed });
    // The ball is pressed into the floor every tick, so the contact stays open and awake.
    const run = (ticks: number) => {
      let hits = 0;
      for (let tick = 0; tick < ticks; tick++) {
        backend.setBodyLinearVelocity("body:ball", { y: -1 });
        sync.step(1 / 60, world);
        hits += backend.pollContacts().filter((event) => event.kind === "hit").length;
      }
      return hits;
    };
    try {
      expect(run(20)).toBe(0);
      expect(setReporting).not.toHaveBeenCalled();
      observed = true;
      expect(run(20)).toBeGreaterThan(0);
      expect(setReporting.mock.calls).toEqual(expect.arrayContaining([["floor", true], ["ball", true]]));
      observed = false;
      run(2);
      expect(setReporting.mock.calls).toEqual(expect.arrayContaining([["floor", false], ["ball", false]]));
      expect(run(20)).toBe(0);
    } finally {
      sync.dispose();
    }
  });
});
