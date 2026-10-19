import { describe, expect, it, vi } from "vitest";
import * as physics from "@babylonslate/physics";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { PhysicsWorldSync } from "./physics-sync";

const box = { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
// Layer 1 does not collide with itself; every other pair collides.
const MATRIX = [0xffffffff, 0xfffffffd];

function maskOf(variables: Record<string, unknown>, collisionMatrix?: readonly number[]) {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ classId: "Actor", guid: "actor", transform: identityTransform() });
  actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "static", mass: 0 } }));
  actor.attachComponent(world.createComponent({ classId: "ColliderComponent", guid: "collider", variables: { shape: box, ...variables } }));
  world.spawnActorNow(actor);
  const backend = physics.createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
  const commit = vi.spyOn(backend, "applyColliderChanges");
  const sync = new PhysicsWorldSync(backend, { collisionMatrix });
  try {
    sync.syncFromWorld(world);
    return commit.mock.calls.flatMap(([, changes]) => changes.upsert).at(-1)?.mask;
  } finally {
    sync.dispose();
  }
}

describe("Collision Matrix", () => {
  it("gives a Project Matrix collider the row of its layer", () => {
    expect(maskOf({ layer: 2, mask: 0xffffffff, maskSource: "project" }, MATRIX)).toBe(0xfffffffd);
  });

  it("keeps a Custom collider's own mask, and a missing source is Custom", () => {
    expect(maskOf({ layer: 2, mask: 4, maskSource: "custom" }, MATRIX)).toBe(4);
    expect(maskOf({ layer: 2, mask: 4 }, MATRIX)).toBe(4);
  });

  it("keeps the authored mask when the world has no matrix", () => {
    expect(maskOf({ layer: 2, mask: 4, maskSource: "project" })).toBe(4);
  });
});
