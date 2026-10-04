import { describe, expect, it } from "vitest";
import { createPhysicsBackend } from "./create-backend";

describe("Line Trace actor exclusions", () => {
  it.each([
    { label: "software 3D", kind: "3d" as const, preferSoftware: true },
    { label: "Havok 3D", kind: "3d" as const, preferSoftware: false },
    { label: "Rapier 2D", kind: "2d" as const, preferSoftware: false },
  ])("$label traces past all ignored actors and restores subsequent queries", async (options) => {
    const backend = await createPhysicsBackend({
      ...options,
      gravity: { x: 0, y: 0, z: 0 },
      allowSoftwareFallback: false,
    });
    try {
      for (const [index, y] of [8, 6, 4].entries()) {
        const id = `body-${index}`;
        backend.createBody({
          id,
          actorId: `actor-${index}`,
          motionType: "static",
          mass: 0,
          linearDamping: 0,
          angularDamping: 0,
          gravityScale: 0,
          transform: {
            position: { x: 0, y, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        });
        for (const suffix of index === 0 ? ["a", "b"] : ["a"]) {
          backend.createCollider({
            id: `${id}-${suffix}`,
            bodyId: id,
            shape: options.kind === "2d"
              ? { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } }
              : { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
            friction: 0.5,
            restitution: 0,
            isTrigger: false,
            layer: 1,
            mask: 0xffffffff,
          });
        }
      }
      backend.step(1 / 60);
      const start = { x: 0, y: 10, z: 0 };
      const end = { x: 0, y: 0, z: 0 };
      expect(backend.lineTrace(start, end).actorId).toBe("actor-0");
      const hit = backend.lineTrace(start, end, {
        ignoreActorIds: ["actor-0", "actor-1"],
      });
      expect(hit.actorId).toBe("actor-2");
      expect(hit.distance).toBeCloseTo(5.5, 2);
      expect(backend.lineTrace(start, end, {
        ignoreActorIds: ["actor-0", "actor-1", "actor-2"],
      }).hit).toBe(false);
      expect(backend.lineTrace(start, end).actorId).toBe("actor-0");
    } finally {
      backend.dispose();
    }
  });
});

describe("Line Trace surface normals", () => {
  it.each([
    { label: "software 3D", kind: "3d" as const, preferSoftware: true },
    { label: "Rapier 2D", kind: "2d" as const, preferSoftware: false },
  ])("$label returns the contacted face normal", async (options) => {
    const backend = await createPhysicsBackend({
      ...options, gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false,
    });
    try {
      backend.createBody({ id: "box", actorId: "box", motionType: "static", mass: 0,
        linearDamping: 0, angularDamping: 0, gravityScale: 0,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
      backend.createCollider({ id: "shape", bodyId: "box",
        shape: options.kind === "2d"
          ? { kind: "box2d", halfExtents: { x: 1, y: 1 } }
          : { kind: "box", halfExtents: { x: 1, y: 1, z: 1 } },
        friction: 0.5, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
      for (const [start, expected] of [
        [{ x: -3, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }],
        [{ x: 3, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
        [{ x: 0, y: -3, z: 0 }, { x: 0, y: -1, z: 0 }],
      ] as const) {
        const hit = backend.lineTrace(start, { x: 0, y: 0, z: 0 });
        expect(hit.hit).toBe(true);
        expect(hit.distance).toBeCloseTo(2, 4);
        expect(hit.normal?.x).toBeCloseTo(expected.x, 4);
        expect(hit.normal?.y).toBeCloseTo(expected.y, 4);
        expect(hit.normal?.z).toBeCloseTo(expected.z, 4);
      }
    } finally { backend.dispose(); }
  });
});
