import { expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { SoftwarePhysicsBackend, type PhysicsTransform, type SphereSweepQuery } from "@babylonslate/physics";
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
