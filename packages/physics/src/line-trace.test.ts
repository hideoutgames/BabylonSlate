import { describe, expect, it } from "vitest";
import { createPhysicsBackend } from "./create-backend";
import type { ColliderDesc, LineTraceOptions } from "./types";

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

describe("Line Trace exclusions after collider changes", () => {
  it.each([
    { label: "software 3D", preferSoftware: true },
    { label: "Havok 3D", preferSoftware: false },
  ])("$label masks hosted, retyped and recreated shapes added after earlier queries", async (options) => {
    const backend = await createPhysicsBackend({
      ...options, kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false,
    });
    const body = (id: string, y: number) => backend.createBody({ id, actorId: `${id}-actor`, motionType: "static", mass: 0,
      linearDamping: 0, angularDamping: 0, gravityScale: 0,
      transform: { position: { x: 0, y, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    const box = (id: string, bodyId: string, extra: Partial<ColliderDesc> = {}) => backend.createCollider({
      id, bodyId, shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      friction: 0.5, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff, ...extra });
    const trace = (query?: LineTraceOptions) => {
      backend.step(1 / 60);
      return backend.lineTrace({ x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }, query);
    };
    const ignoreTop = { ignoreActorIds: ["top-actor"] };
    try {
      body("top", 6);
      box("top-box", "top");
      body("low", 2);
      box("low-box", "low");
      expect(trace(ignoreTop).actorId).toBe("low-actor");
      // A shape hosted on the low body for the ignored actor is excluded with the actor's own.
      box("hosted", "low", { actorId: "top-actor", translation: { x: 0, y: 2, z: 0 } });
      expect(trace().actorId).toBe("top-actor");
      expect(trace(ignoreTop)).toMatchObject({ actorId: "low-actor", distance: expect.closeTo(7.5, 3) });
      // The same shape turned into a trigger leaves solid-only queries and returns to them.
      box("low-box", "low", { isTrigger: true });
      expect(trace({ ...ignoreTop, includeTriggers: false }).hit).toBe(false);
      expect(trace(ignoreTop).actorId).toBe("low-actor");
      box("low-box", "low");
      expect(trace({ ...ignoreTop, includeTriggers: false }).actorId).toBe("low-actor");
      // A recreated body takes the same exclusions, and nothing stays masked afterwards.
      backend.destroyBody("low");
      expect(trace(ignoreTop).hit).toBe(false);
      body("low", 2);
      box("low-box", "low", { isTrigger: true });
      expect(trace({ ...ignoreTop, includeTriggers: false }).hit).toBe(false);
      expect(trace(ignoreTop).actorId).toBe("low-actor");
      expect(trace().actorId).toBe("top-actor");
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

describe("Sphere Overlap", () => {
  it.each([
    { label: "software 3D", kind: "3d" as const, preferSoftware: true },
    { label: "Havok 3D", kind: "3d" as const, preferSoftware: false },
    { label: "Rapier 2D", kind: "2d" as const, preferSoftware: false },
  ])("$label lists each body and shape owner once and skips triggers on request", async (options) => {
    const backend = await createPhysicsBackend({
      ...options, gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false,
    });
    const body = (id: string, x: number) => backend.createBody({ id, actorId: id, motionType: "static", mass: 0,
      linearDamping: 0, angularDamping: 0, gravityScale: 0,
      transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    const box = (id: string, bodyId: string, y: number, isTrigger = false, actorId?: string) => backend.createCollider({
      id, bodyId, ...(actorId ? { actorId } : {}),
      shape: options.kind === "2d" ? { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } }
        : { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      translation: { x: 0, y, z: 0 }, friction: 0.5, restitution: 0, isTrigger, layer: 1, mask: 0xffffffff });
    try {
      body("pair", 0);
      box("pair-a", "pair", 0);
      box("pair-b", "pair", 0.2);
      // Shapes hosted for another actor list that owner once, on the host's body.
      box("held-a", "pair", 0.1, false, "held");
      box("held-b", "pair", -0.1, false, "held");
      // A solid shape out of range and a trigger at the query point.
      body("mixed", 10);
      box("mixed-solid", "mixed", 5);
      box("mixed-trigger", "mixed", 0, true);
      backend.step(1 / 60);
      // Owners on one body come in backend order.
      const owners = ({ actorIds, bodyIds }: { actorIds: string[]; bodyIds: string[] }) =>
        actorIds.map((actorId, index) => `${actorId}@${bodyIds[index]}`).sort();
      expect(owners(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.1))).toEqual(["held@pair", "pair@pair"]);
      expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.1, { ignoreActorIds: ["pair"] }))
        .toEqual({ actorIds: ["held"], bodyIds: ["pair"] });
      expect(backend.sphereOverlap({ x: 10, y: 0, z: 0 }, 0.1).actorIds).toEqual(["mixed"]);
      expect(backend.sphereOverlap({ x: 10, y: 0, z: 0 }, 0.1, { includeTriggers: false }).actorIds).toEqual([]);
    } finally { backend.dispose(); }
  });

  it.each([
    { label: "Havok 3D", kind: "3d" as const },
    { label: "Rapier 2D", kind: "2d" as const },
  ])("$label tests collider shapes, not their bounds", async (options) => {
    const backend = await createPhysicsBackend({
      ...options, gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false,
    });
    const angle = Math.PI / 4;
    try {
      backend.createBody({ id: "diamond", actorId: "diamond", motionType: "static", mass: 0,
        linearDamping: 0, angularDamping: 0, gravityScale: 0,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) } } });
      backend.createCollider({ id: "diamond-col", bodyId: "diamond",
        shape: options.kind === "2d" ? { kind: "box2d", halfExtents: { x: 1, y: 1 } }
          : { kind: "box", halfExtents: { x: 1, y: 1, z: 1 } },
        friction: 0.5, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
      backend.step(1 / 60);
      // Inside the rotated box's bounds (±√2), outside the box itself (|x| + |y| > √2).
      expect(backend.sphereOverlap({ x: 1.2, y: 1.2, z: 0 }, 0.05).actorIds).toEqual([]);
      expect(backend.sphereOverlap({ x: 1.2, y: 0, z: 0 }, 0.05).actorIds).toEqual(["diamond"]);
      // Reaching the face from outside within the radius.
      expect(backend.sphereOverlap({ x: 1.6, y: 0, z: 0 }, 0.2).actorIds).toEqual(["diamond"]);
    } finally { backend.dispose(); }
  });
});
