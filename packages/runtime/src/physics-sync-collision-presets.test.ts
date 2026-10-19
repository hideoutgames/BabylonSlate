import { describe, expect, it, vi } from "vitest";
import * as physics from "@babylonslate/physics";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { PhysicsWorldSync } from "./physics-sync";

const box = { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
const PRESETS = [{ id: "ghost-pass", layer: 2, mask: 0xffffffef, overlapMask: 0 }];

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
    return desc && { layer: desc.layer, mask: desc.mask };
  } finally {
    sync.dispose();
  }
}

describe("Collision Presets", () => {
  it("gives a collider its preset's layer and mask", () => {
    expect(filterOf({ layer: 1, mask: 4, collisionPreset: "ghost-pass" }, PRESETS)).toEqual({ layer: 2, mask: 0xffffffef });
  });

  it("keeps a Custom collider's own layer and mask, and a missing or removed preset is Custom", () => {
    expect(filterOf({ layer: 1, mask: 4, collisionPreset: "custom" }, PRESETS)).toEqual({ layer: 1, mask: 4 });
    expect(filterOf({ layer: 1, mask: 4 }, PRESETS)).toEqual({ layer: 1, mask: 4 });
    expect(filterOf({ layer: 1, mask: 4, collisionPreset: "removed" }, PRESETS)).toEqual({ layer: 1, mask: 4 });
  });
});
