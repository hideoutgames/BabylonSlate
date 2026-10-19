import { describe, expect, it } from "vitest";
import { createPhysicsBackend } from "./create-backend";

describe.each([
  { name: "Havok", kind: "3d" as const, preferSoftware: false },
  { name: "Rapier", kind: "2d" as const, preferSoftware: false },
  { name: "software", kind: "3d" as const, preferSoftware: true },
])("$name body velocity", ({ kind, preferSoftware }) => {
  it("reports owned velocity values, spins through simulation, and resets angular velocity on teleport", async () => {
    const backend = await createPhysicsBackend({ kind, preferSoftware, allowSoftwareFallback: false, gravity: { x: 0, y: 0, z: 0 } });
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    try {
      backend.createBody({ id: "body", actorId: "actor", motionType: "dynamic", mass: 1,
        linearDamping: 0, angularDamping: 0, gravityScale: 1, transform: pose });
      backend.createCollider({ id: "shape", bodyId: "body", shape: kind === "3d"
        ? { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } : { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
        translation: { x: 0, y: 1, z: 0 }, friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
      backend.step(1 / 60);
      backend.setBodyLinearVelocity("body", { x: 2, y: 0, z: 0 });
      backend.setBodyAngularVelocity("body", { x: 0, y: 0, z: 1 });
      const velocity = backend.getBodyVelocity("body")!;
      // Both native engines place the mass center at the offset collider center.
      expect(velocity.centerOfMass.y).toBeCloseTo(preferSoftware ? 0 : 1);
      velocity.linear.x = 99;
      velocity.angular.z = 99;
      expect(backend.getBodyVelocity("body")!.linear.x).toBeCloseTo(2);
      for (let i = 0; i < 30; i++) backend.step(1 / 60);
      const rotation = backend.getBodyTransform("body")!.rotation;
      expect(2 * Math.atan2(rotation.z, rotation.w)).toBeCloseTo(0.5, 1);
      backend.teleportBody("body", pose, { velocity: "reset" });
      expect(backend.getBodyVelocity("body")!.angular).toEqual({ x: 0, y: 0, z: 0 });
      backend.destroyBody("body");
      expect(backend.getBodyVelocity("body")).toBeNull();
    } finally { backend.dispose(); }
  });

  it("keeps a locked body upright and spins it again once the lock is released", async () => {
    const backend = await createPhysicsBackend({ kind, preferSoftware, allowSoftwareFallback: false, gravity: { x: 0, y: 0, z: 0 } });
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    try {
      backend.createBody({ id: "body", actorId: "actor", motionType: "dynamic", mass: 1,
        linearDamping: 0, angularDamping: 0, gravityScale: 1, lockRotation: true, transform: pose });
      backend.createCollider({ id: "shape", bodyId: "body", shape: kind === "3d"
        ? { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } : { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
        friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
      // Pushing up at the right edge twists the body about Z.
      const push = () => backend.addImpulseAtPoint("body", { x: 0, y: 1, z: 0 }, { x: 0.5, y: 0, z: 0 });
      const spin = () => {
        for (let i = 0; i < 10; i++) backend.step(1 / 60);
        return Math.abs(backend.getBodyVelocity("body")!.angular.z);
      };
      push();
      expect(spin()).toBe(0);
      expect(backend.getBodyTransform("body")!.rotation.z).toBeCloseTo(0);
      expect(backend.getBodyVelocity("body")!.linear.y).toBeGreaterThan(0.5);
      backend.updateBody("body", { lockRotation: false });
      push();
      expect(spin()).toBeGreaterThan(0.1);
      backend.updateBody("body", { lockRotation: true });
      backend.setBodyAngularVelocity("body", { x: 0, y: 0, z: 0 });
      push();
      expect(spin()).toBe(0);
    } finally { backend.dispose(); }
  });
});
