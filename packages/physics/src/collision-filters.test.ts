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

  const create = (kind: "rapier" | "software" | "havok") => kind === "rapier"
    ? createPhysicsBackend({ kind: "2d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false })
    : kind === "havok"
      ? createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false })
      : Promise.resolve(createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 }));
  const pair = async (kind: "rapier" | "software" | "havok", b: Partial<ColliderDesc>) => {
    const backend = await create(kind);
    for (const id of ["a", "b"]) backend.createBody({ id, actorId: id, motionType: id === "a" ? "dynamic" : "static",
      mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0,
      transform: { position: { x: id === "a" ? 0.5 : 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    const a: ColliderDesc = { id: "shape-a", bodyId: "a",
      shape: kind === "havok" ? { kind: "box", halfExtents: { x: 1, y: 1, z: 1 } } : { kind: "box2d", halfExtents: { x: 1, y: 1 } },
      layer: 1, mask: 0xffffffff, friction: 0, restitution: 0, isTrigger: false };
    const other: ColliderDesc = { ...a, id: "shape-b", bodyId: "b", ...b };
    backend.createCollider(a); backend.createCollider(other);
    for (let i = 0; i < 5; i++) backend.step(1 / 60);
    return { backend, other, events: backend.pollContacts() };
  };

  it.each(["rapier", "software", "havok"] as const)("%s reports an Overlap response as an overlap without blocking", async (kind) => {
    // a blocks b's layer; b only overlaps a's: the pair overlaps.
    const { backend, other, events } = await pair(kind, { layer: 2, mask: 0, overlapMask: 1 });
    try {
      expect(events).toContainEqual(expect.objectContaining({ kind: "overlapBegin", actorAId: "a", actorBId: "b" }));
      expect(events.some((event) => event.kind === "hit")).toBe(false);
      expect(backend.getBodyTransform("a")?.position.x).toBeCloseTo(0.5, 5);
      backend.applyColliderChanges("b", { upsert: [{ ...other, overlapMask: 0 }], remove: [] });
      for (let i = 0; i < 2; i++) backend.step(1 / 60);
      expect(backend.pollContacts()).toContainEqual(expect.objectContaining({ kind: "overlapEnd", actorAId: "a", actorBId: "b" }));
    } finally { backend.dispose(); }
  });

  it.each(["rapier", "software", "havok"] as const)("%s keeps a Block pair blocking when one side overlaps another layer", async (kind) => {
    const { backend, events } = await pair(kind, { layer: 2, mask: 1, overlapMask: 4 });
    try {
      expect(events.some((event) => event.kind === "hit")).toBe(true);
      expect(events.some((event) => event.kind === "overlapBegin")).toBe(false);
    } finally { backend.dispose(); }
  });
});
