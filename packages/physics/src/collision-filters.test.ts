import { describe, expect, it } from "vitest";
import { createPhysicsBackend, createSoftwarePhysicsBackend, type ColliderDesc } from "./index";

describe("32-bit collision membership and masks", () => {
  it.each(["rapier", "software"] as const)("%s applies both masks to contacts and trigger pairs, including high bits", async (kind) => {
    for (const isTrigger of [false, true]) {
      const backend = kind === "rapier"
        ? await createPhysicsBackend({ kind: "2d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false })
        : createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
      try {
        for (const id of ["a", "b"]) backend.createBody({ id, actorId: id, motionType: id === "a" ? "dynamic" : "static",
          mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0,
          transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
        const a: ColliderDesc = { id: "shape-a", bodyId: "a", shape: { kind: "box2d", halfExtents: { x: 1, y: 1 } },
          layer: 1 << 20, mask: 1 << 31, friction: 0, restitution: 0, isTrigger };
        const b: ColliderDesc = { ...a, id: "shape-b", bodyId: "b", layer: 1 << 31, mask: 0, isTrigger: false };
        backend.createCollider(a); backend.createCollider(b);
        backend.step(1 / 60);
        expect(backend.pollContacts()).toEqual([]);
        backend.applyColliderChanges("b", { upsert: [{ ...b, mask: 1 << 20 }], remove: [] });
        backend.step(1 / 60);
        expect(backend.pollContacts()).toContainEqual(expect.objectContaining({
          kind: isTrigger ? "overlapBegin" : "hit", actorAId: "a", actorBId: "b",
        }));
      } finally { backend.dispose(); }
    }
  });
});
