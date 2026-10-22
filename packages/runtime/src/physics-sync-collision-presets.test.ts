import { describe, expect, it, vi } from "vitest";
import * as physics from "@haptic/physics";
import { identityTransform } from "@haptic/core";
import { ClassRegistry, World } from "@haptic/object-model";
import { PhysicsWorldSync } from "./physics-sync";

const box = { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
const PRESETS = [{ id: "ghost-pass", layer: 2, mask: 0xffffffef, overlapMask: 0x10 }];

function filterOf(variables: Record<string, unknown>, collisionPresets?: typeof PRESETS) {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ classId: "Actor", guid: "actor", transform: identityTransform() });
  actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "static", mass: 0 } }));
  actor.attachComponent(world.createComponent({ classId: "ColliderComponent", guid: "collider", variables: { shape: box, ...variables } }));
  world.spawnActorNow(actor);
  const backend = physics.createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
  const commit = vi.spyOn(backend, "applyColliderChanges");
  const sync = new PhysicsWorldSync(backend, { collisionPresets });
  try {
    sync.syncFromWorld(world);
    const desc = commit.mock.calls.flatMap(([, changes]) => changes.upsert).at(-1);
    return desc && { layer: desc.layer, mask: desc.mask, overlapMask: desc.overlapMask };
  } finally {
    sync.dispose();
  }
}

describe("Collision Presets", () => {
  it("gives a collider its preset's layer and mask", () => {
    expect(filterOf({ layer: 1, mask: 4, collisionPreset: "ghost-pass" }, PRESETS)).toEqual({ layer: 2, mask: 0xffffffef, overlapMask: 0x10 });
  });

  it("keeps a Custom collider's own layer and responses, as for a removed preset", () => {
    const own = { layer: 1, mask: 4, overlapMask: 8 };
    expect(filterOf({ ...own, collisionPreset: "custom" }, PRESETS)).toEqual(own);
    expect(filterOf({ ...own, collisionPreset: "removed" }, PRESETS)).toEqual(own);
  });
});
