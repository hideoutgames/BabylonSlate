import { describe, expect, it } from "vitest";
import { HavokPhysicsBackend } from "./havok-backend";

function addWall(backend: HavokPhysicsBackend, id: string, x = 0, angle = 0, trigger = false): void {
  backend.createBody({
    id, actorId: `${id}-actor`, motionType: "static", mass: 0,
    linearDamping: 0, angularDamping: 0, gravityScale: 0,
    transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) } },
  });
  backend.createCollider({
    id: `${id}-collider`, bodyId: id,
    shape: { kind: "box", halfExtents: { x: 0.025, y: 2, z: 2 } },
    friction: 0, restitution: 0, isTrigger: trigger, layer: 1, mask: 0xffffffff,
  });
}

describe("reusable Havok sphere sweeps", () => {
  it("stops at radius clearance across a thin wall, ignores triggers, and resets a borrowed hit on misses", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    try {
      addWall(backend, "wall");
      addWall(backend, "trigger", -1, 0, true);
      const query = backend.createSphereSweep(0.25);
      const result = query.sweep(-2, 0, 0, 2, 0, 0);
      expect(result.hit).toBe(true);
      expect(result.bodyId).toBe("wall");
      expect(result.actorId).toBe("wall-actor");
      expect(result.distance).toBeCloseTo(1.725, 2);
      expect(result.location!.x).toBeCloseTo(-0.025, 2);
      expect(result.normal!.x).toBeCloseTo(-1, 3);
      const location = result.location;
      const normal = result.normal;
      for (let repeat = 0; repeat < 20; repeat++) {
        expect(query.sweep(-2, 0, 0, 2, 0, 0)).toBe(result);
        expect(result.location).toBe(location);
        expect(result.normal).toBe(normal);
        expect(result.distance).toBeCloseTo(1.725, 2);
      }
      expect(query.sweep(-2, 5, 0, 2, 5, 0)).toBe(result);
      expect(result).toEqual({ hit: false, location: null, normal: null, distance: 0, bodyId: null, actorId: null });
      expect(query.sweep(-2, 0, 0, 2, 0, 0).hit).toBe(true);
      const wide = backend.createSphereSweep(0.5);
      expect(wide.sweep(-2, 0, 0, 2, 0, 0).distance).toBeCloseTo(1.475, 2);
      expect(query.sweep(NaN, 0, 0, 2, 0, 0).hit).toBe(false);
    } finally { backend.dispose(); }
  });

  it("uses rotated collider surfaces and detects a stationary sphere already overlapping", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    try {
      addWall(backend, "wall", 0, Math.PI / 4);
      const query = backend.createSphereSweep(0.25);
      const axis = Math.SQRT1_2;
      const hit = query.sweep(-2 * axis, -2 * axis, 0, 2 * axis, 2 * axis, 0);
      expect(hit.hit).toBe(true);
      expect(hit.distance).toBeCloseTo(1.725, 2);
      expect(hit.normal!.x).toBeCloseTo(-axis, 2);
      expect(hit.normal!.y).toBeCloseTo(-axis, 2);
      expect(hit.location!.x * axis + hit.location!.y * axis).toBeCloseTo(-0.025, 2);
      const overlap = query.sweep(-0.1 * axis, -0.1 * axis, 0, -0.1 * axis, -0.1 * axis, 0);
      expect(overlap.hit).toBe(true);
      expect(overlap.distance).toBe(0);
      expect(overlap.normal!.x).toBeCloseTo(-axis, 2);
      expect(overlap.normal!.y).toBeCloseTo(-axis, 2);
      // The surface and normal identify a center that clears the wall by the radius.
      const resolvedX = overlap.location!.x + overlap.normal!.x * 0.251;
      const resolvedY = overlap.location!.y + overlap.normal!.y * 0.251;
      expect(query.sweep(resolvedX, resolvedY, 0, resolvedX, resolvedY, 0).hit).toBe(false);
    } finally { backend.dispose(); }
  });

  it("owns one native shape per query and retires it on explicit or backend disposal", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    const shapes = (backend.plugin as unknown as { _shapes: Map<bigint, unknown> })._shapes;
    try {
      const baseline = shapes.size;
      for (const radius of [0, -1, NaN, Infinity]) expect(() => backend.createSphereSweep(radius)).toThrow();
      expect(shapes.size).toBe(baseline);
      const query = backend.createSphereSweep(0.1);
      expect(shapes.size).toBe(baseline + 1);
      for (let repeat = 0; repeat < 20; repeat++) query.sweep(-1, 0, 0, 1, 0, 0);
      expect(shapes.size).toBe(baseline + 1);
      query.dispose();
      query.dispose();
      expect(shapes.size).toBe(baseline);
      expect(query.sweep(-1, 0, 0, 1, 0, 0).hit).toBe(false);
      const owned = backend.createSphereSweep(0.2);
      backend.dispose();
      expect(shapes.size).toBe(0);
      expect(owned.sweep(-1, 0, 0, 1, 0, 0).hit).toBe(false);
      owned.dispose();
      expect(() => backend.createSphereSweep(0.2)).toThrow();
    } finally { backend.dispose(); }
  });
});

describe("Havok shape sweeps", () => {
  it("report a shape that already overlaps at its start and reject a rotating sweep", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const pose = (x: number) => ({ position: { x, y: 0, z: 0 }, rotation: identity });
    const cube = { kind: "box" as const, halfExtents: { x: 0.2, y: 0.2, z: 0.2 } };
    try {
      addWall(backend, "wall");
      const cast = backend.shapeSweep(cube, pose(-2), pose(2));
      expect(cast).toMatchObject({ hit: true, bodyId: "wall" });
      expect(cast.distance).toBeCloseTo(1.775, 2);
      // Starting inside the wall: the cast alone would report nothing.
      const overlapping = backend.shapeSweep(cube, pose(0.1), pose(2));
      expect(overlapping).toMatchObject({ hit: true, bodyId: "wall", distance: 0 });
      expect(overlapping.normal!.x).toBeCloseTo(1, 2);
      // The negated quaternion is the same rotation; a turn is not.
      expect(backend.shapeSweep(cube, pose(-2), { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: -1 } }).hit).toBe(true);
      expect(() => backend.shapeSweep(cube, pose(-2),
        { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } })).toThrow(/rotation/);
    } finally { backend.dispose(); }
  });

  it("keeps a bounded set of native shapes for repeated primitive sweeps and releases them with the backend", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    const shapes = (backend.plugin as unknown as { _shapes: Map<bigint, unknown> })._shapes;
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const pose = (x: number) => ({ position: { x, y: 0, z: 0 }, rotation: identity });
    const sweep = (shape: Parameters<HavokPhysicsBackend["shapeSweep"]>[0]) => backend.shapeSweep(shape, pose(-2), pose(2));
    try {
      addWall(backend, "wall");
      const baseline = shapes.size;
      const sphere = { kind: "sphere" as const, radius: 0.2 };
      const first = sweep(sphere);
      expect(first).toMatchObject({ hit: true, bodyId: "wall" });
      // The same kind and dimensions share one native shape, whatever the pose, and give the same answer.
      for (let repeat = 0; repeat < 10; repeat++) expect(sweep({ ...sphere })).toEqual(first);
      expect(shapes.size).toBe(baseline + 1);
      for (const shape of [
        { kind: "box" as const, halfExtents: { x: 0.2, y: 0.2, z: 0.2 } },
        { kind: "capsule" as const, radius: 0.2, halfHeight: 0.3 },
        { kind: "cylinder" as const, radius: 0.2, height: 0.6 },
      ]) {
        expect(sweep(shape).hit).toBe(true);
        expect(sweep(shape).hit).toBe(true);
      }
      expect(shapes.size).toBe(baseline + 4);
      // Sizes that never repeat cannot grow the set without bound.
      for (let index = 1; index <= 40; index++) sweep({ kind: "sphere", radius: 0.01 * index });
      const grown = shapes.size;
      expect(grown).toBeLessThan(baseline + 40);
      for (let index = 41; index <= 80; index++) sweep({ kind: "sphere", radius: 0.01 * index });
      expect(shapes.size).toBe(grown);
      expect(() => sweep({ kind: "sphere", radius: -1 })).toThrow();
      expect(shapes.size).toBe(grown);
      backend.dispose();
      expect(shapes.size).toBe(0);
    } finally { backend.dispose(); }
  });

  it("never lets a query filter mask the shape it casts", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const pose = (x: number) => ({ position: { x, y: 0, z: 0 }, rotation: identity });
    const sphere = { kind: "sphere" as const, radius: 0.2 };
    try {
      addWall(backend, "wall");
      addWall(backend, "trigger", -1, 0, true);
      // Excluding the wall's actor and the trigger masks their shapes for that query only, and the cast shape stays whole.
      expect(backend.shapeSweep(sphere, pose(-2), pose(2), { ignoreActorIds: ["wall-actor"], includeTriggers: false }).hit).toBe(false);
      expect(backend.shapeSweep(sphere, pose(-2), pose(2), { ignoreActorIds: ["wall-actor"] })).toMatchObject({ hit: true, bodyId: "trigger" });
      expect(backend.shapeSweep(sphere, pose(-2), pose(2), { includeTriggers: false })).toMatchObject({ hit: true, bodyId: "wall" });
      expect(backend.shapeSweep(sphere, pose(-2), pose(2))).toMatchObject({ hit: true, bodyId: "trigger" });
    } finally { backend.dispose(); }
  });
});
