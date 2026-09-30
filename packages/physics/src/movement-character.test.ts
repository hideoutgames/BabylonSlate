import { expect, it } from "vitest";
import { createPhysicsBackend, createSoftwarePhysicsBackend, type PhysicsBackend, type Vec3 } from "./index";

function body(backend: PhysicsBackend, id: string, position: Vec3, moving = false) {
  backend.createBody({
    id, actorId: id, motionType: moving ? "kinematic" : "static", mass: 1,
    linearDamping: 0, angularDamping: 0, gravityScale: 0,
    transform: { position, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  });
}

function box(backend: PhysicsBackend, id: string, halfExtents: Vec3, isTrigger = false) {
  backend.createCollider({
    id: `${id}:shape`, bodyId: id,
    shape: backend.kind === "3d" ? { kind: "box", halfExtents } : { kind: "box2d", halfExtents },
    friction: 0, restitution: 0, isTrigger, layer: 1, mask: 0xffffffff,
  });
}

it.each(["havok", "rapier", "software3d", "software2d"] as const)(
  "%s capsule falls, grounds, slides against a wall and jumps without colliding with itself or triggers",
  async (kind) => {
    const worldKind = kind === "rapier" || kind === "software2d" ? "2d" : "3d";
    const gravity = { x: 0, y: -9.81, z: 0 };
    const backend = kind.startsWith("software")
      ? createSoftwarePhysicsBackend(worldKind, gravity)
      : await createPhysicsBackend({ kind: worldKind, gravity, allowSoftwareFallback: false });
    const dt = 1 / 60;
    try {
      body(backend, "floor", { x: 0, y: -0.5, z: 0 });
      box(backend, "floor", { x: 8, y: 0.5, z: 8 });
      body(backend, "wall", { x: 2.5, y: 2, z: 0 });
      box(backend, "wall", { x: 0.5, y: 2, z: 8 });
      body(backend, "trigger", { x: 0.6, y: 1, z: 0 });
      box(backend, "trigger", { x: 0.2, y: 1, z: 8 }, true);
      body(backend, "player", { x: 0, y: 3, z: 0 }, true);
      backend.createCollider({
        id: "player:shape", bodyId: "player",
        shape: { kind: worldKind === "3d" ? "capsule" : "capsule2d", radius: 0.4, halfHeight: 0.5 },
        friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff,
      });
      backend.createCharacterController({ id: "motor", bodyId: "player", offset: 0.01, radius: 0.4, height: 1.8 });
      let result = backend.moveCharacter("motor", { x: 0, y: -0.05, z: 0 }, dt)!;
      for (let i = 0; i < 90; i++) {
        result = backend.moveCharacter("motor", { x: 0, y: -0.05, z: 0 }, dt)!;
        backend.step(dt);
      }
      expect(result.position.y).toBeCloseTo(0.91, 1);
      expect(result.position.x).toBeCloseTo(0, 3);
      expect(result.grounded).toBe(true);
      for (let i = 0; i < 60; i++) {
        result = backend.moveCharacter("motor", { x: 0.08, y: -0.02, z: worldKind === "3d" ? 0.02 : 0 }, dt)!;
        backend.step(dt);
      }
      expect(result.position.x).toBeGreaterThan(1.5);
      expect(result.position.x).toBeLessThan(1.61);
      expect(result.velocity.x).toBeCloseTo(0, 2);
      if (worldKind === "3d") expect(result.position.z).toBeGreaterThan(1);
      const settled = result.position.y;
      const jumped = backend.moveCharacter("motor", { x: 0, y: 0.1, z: 0 }, dt)!;
      backend.step(dt);
      expect(jumped.position.y).toBeGreaterThan(settled + 0.08);
      expect(jumped.grounded).toBe(false);
      // The private Havok CCT body must not steal an actor query or remain as a ghost.
      const hit = backend.lineTrace(
        { x: jumped.position.x, y: 5, z: jumped.position.z },
        { x: jumped.position.x, y: 0, z: jumped.position.z },
      );
      expect(hit.actorId).toBe("player");
      backend.destroyBody("player");
      expect(backend.moveCharacter("motor", { x: 1, y: 0, z: 0 }, dt)).toBeNull();
    } finally {
      backend.dispose();
    }
  },
);

it("Havok uses authored capsule height and radius for collision and releases controller shapes", async () => {
  const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
  try {
    body(backend, "floor", { x: 0, y: -0.5, z: 0 });
    box(backend, "floor", { x: 8, y: 0.5, z: 8 });
    body(backend, "player", { x: 0, y: 4, z: 0 }, true);
    backend.createCharacterController({ id: "motor", bodyId: "player", offset: 0.01, radius: 0.6, height: 3 });
    let result;
    for (let i = 0; i < 90; i++) {
      result = backend.moveCharacter("motor", { x: 0, y: -0.05, z: 0 }, 1 / 60);
      backend.step(1 / 60);
    }
    expect(result!.position.y).toBeCloseTo(1.51, 1);
    expect(result!.grounded).toBe(true);
    backend.destroyCharacterController("motor");
    expect(backend.lineTrace({ x: 0, y: 5, z: 0 }, { x: 0, y: 0.1, z: 0 }).hit).toBe(false);
  } finally {
    backend.dispose();
  }
});
