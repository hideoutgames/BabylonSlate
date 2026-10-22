import { expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { ClassRegistry, World } from "@haptic/object-model";
import { SoftwarePhysicsBackend, type PhysicsTransform, type SphereSweepQuery } from "@haptic/physics";
import { CableWorldSync } from "./cable-sync";

class QueryPhysicsBackend extends SoftwarePhysicsBackend {
  queryDisposals = 0;

  createSphereSweep(radius: number): SphereSweepQuery {
    const start: PhysicsTransform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const end: PhysicsTransform = { position: { x: 0, y: 0, z: 0 }, rotation: start.rotation };
    const shape = { kind: "sphere" as const, radius };
    return {
      sweep: (sx, sy, sz, ex, ey, ez) => {
        start.position.x = sx; start.position.y = sy; start.position.z = sz;
        end.position.x = ex; end.position.y = ey; end.position.z = ez;
        return this.shapeSweep(shape, start, end);
      },
      dispose: () => { this.queryDisposals++; },
    };
  }
}

it("retires a destroyed actor's cable query before another simulation step", () => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const backend = new QueryPhysicsBackend("3d", { x: 0, y: -9.81, z: 0 });
  const commands: CommandMessage[] = [];
  const cables = new CableWorldSync({ world, physics: () => backend, eligible: () => true, slot: () => 0, emit: (command) => commands.push(command) });
  const actor = world.createActor({ classId: "Actor", guid: "owner" });
  const component = world.createComponent({ classId: "CableComponent", variables: { enableCollision: true } });
  actor.attachComponent(component);
  world.spawnActorNow(actor);
  try {
    cables.assign(component);
    cables.step(1 / 60, [0, -9.81, 0], 1);
    expect(commands).toHaveLength(1);
    world.destroyActor(actor.guid);
    world.flushPending();
    expect(component.owner).toBeNull();
    cables.retireActor(actor);
    expect(backend.queryDisposals).toBe(1);
    cables.retireActor(actor);
    expect(backend.queryDisposals).toBe(1);
    commands.length = 0;
    cables.step(1 / 60, [0, -9.81, 0], 2);
    expect(commands).toEqual([]);
  } finally {
    cables.dispose();
    backend.dispose();
  }
});

it("lets a colliding cable fall through a trigger when the backend has no sphere sweep", () => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const backend = new SoftwarePhysicsBackend("3d", { x: 0, y: -9.81, z: 0 });
  // A trigger slab just under the cable's pins: a solid one would hold the sag above y = -0.25.
  backend.createBody({ id: "slab", actorId: "slab", motionType: "static", mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0,
    transform: { position: { x: 1, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
  backend.createCollider({ id: "slab", bodyId: "slab", shape: { kind: "box", halfExtents: { x: 3, y: 0.25, z: 1 } },
    friction: 0.5, restitution: 0, isTrigger: true, layer: 1, mask: 0xffffffff });
  const commands: CommandMessage[] = [];
  const cables = new CableWorldSync({ world, physics: () => backend, eligible: () => true, slot: () => 0, emit: (command) => commands.push(command) });
  const actor = world.createActor({ classId: "Actor", guid: "owner" });
  const component = world.createComponent({ classId: "CableComponent", variables: {
    enableCollision: true, attachEnd: false, endPosition: [2, 0, 0], cableLength: 4, numSegments: 8,
  } });
  actor.attachComponent(component);
  world.spawnActorNow(actor);
  try {
    cables.assign(component);
    for (let frame = 1; frame <= 120; frame++) cables.step(1 / 60, [0, -9.81, 0], frame);
    const last = commands.filter((command) => command.type === "cableFrame").at(-1);
    if (last?.type !== "cableFrame") throw new Error("No cable frame");
    // Record: id, count, start slot, end slot, two local anchors, then particle xyz.
    const count = last.data[1]!;
    let lowest = Infinity;
    for (let particle = 0; particle < count; particle++) lowest = Math.min(lowest, last.data[10 + particle * 3 + 1]!);
    expect(lowest).toBeLessThan(-0.75);
  } finally {
    cables.dispose();
    backend.dispose();
  }
});
