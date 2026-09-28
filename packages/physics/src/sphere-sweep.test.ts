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
