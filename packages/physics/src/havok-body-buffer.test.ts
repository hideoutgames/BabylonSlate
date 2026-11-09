import { describe, expect, it, vi } from "vitest";
import type { HavokPhysicsWithBindings, HP_BodyId } from "@babylonjs/havok";
import { HavokPhysicsBackend } from "./havok-backend";
import type { PhysicsTransform } from "./types";

type MotionType = "static" | "dynamic" | "kinematic";

/** A tilted pose, so no axis of the body lines up with a world axis. */
const tilted = (x: number, y: number, z = 0): PhysicsTransform => ({
  position: { x, y, z }, rotation: { x: 0.1, y: 0.2, z: 0.3, w: Math.sqrt(1 - 0.14) },
});

function spawn(backend: HavokPhysicsBackend, id: string, transform: PhysicsTransform, motionType: MotionType = "dynamic"): void {
  backend.createBody({ id, actorId: id, motionType, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 1, transform });
  backend.createCollider({ id: `collider:${id}`, bodyId: id, shape: { kind: "box", halfExtents: { x: 0.5, y: 0.3, z: 0.4 } },
    friction: 0.5, restitution: 0.2, isTrigger: false, layer: 1, mask: 0xffffffff });
}

const havokOf = (backend: HavokPhysicsBackend) => backend.plugin._hknp as HavokPhysicsWithBindings;
const nativeBody = (backend: HavokPhysicsBackend, id: string) =>
  (backend.scene.getTransformNodeByName(id)!.physicsBody!._pluginData as { hpBodyId: HP_BodyId }).hpBodyId;

/**
 * What Havok itself reports for the body, beside what the backend read for it. Rotations compare as orientations:
 * a quaternion and its negation turn a body the same way, so the dot product of two equal ones is 1 or -1.
 */
function poses(backend: HavokPhysicsBackend, id: string) {
  const [, [position, rotation]] = havokOf(backend).HP_Body_GetQTransform(nativeBody(backend, id));
  const read = backend.getBodyTransform(id)!;
  const dot = read.rotation.x * rotation[0] + read.rotation.y * rotation[1] + read.rotation.z * rotation[2] + read.rotation.w * rotation[3];
  return {
    native: { x: position[0], y: position[1], z: position[2] },
    read: read.position,
    sameOrientation: Math.abs(dot),
    length: Math.hypot(read.rotation.x, read.rotation.y, read.rotation.z, read.rotation.w),
    nativeW: rotation[3],
  };
}

function expectHavokPoses(backend: HavokPhysicsBackend, ids: readonly string[]): void {
  for (const id of ids) {
    const pose = poses(backend, id);
    expect(pose.read, id).toEqual(pose.native);
    expect(pose.sameOrientation, id).toBeCloseTo(1, 6);
    expect(pose.length, id).toBeCloseTo(1, 12);
  }
}

describe("Havok body poses read from the world's body buffer", () => {
  it("gives every stepped body the pose Havok reports, through bodies leaving, joining and teleporting", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    try {
      spawn(backend, "floor", { position: { x: 0, y: -1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, "static");
      const falling = Array.from({ length: 10 }, (_, index) => `falling ${index}`);
      falling.forEach((id, index) => spawn(backend, id, tilted(index * 0.7 - 3, 2 + index * 0.9, Math.sin(index))));
      // Spun past half a turn, so Havok holds some of these with a negative w.
      falling.forEach((id, index) => backend.setBodyAngularVelocity(id, { x: 3 + index, y: -2, z: index - 4 }));
      spawn(backend, "carried", tilted(6, 1), "kinematic");
      for (let step = 0; step < 90; step++) {
        backend.setBodyTargetTransform("carried", tilted(6 + step * 0.01, 1 + step * 0.02));
        backend.step(1 / 60);
      }
      expect(falling.some((id) => poses(backend, id).nativeW < 0)).toBe(true);
      expectHavokPoses(backend, [...falling, "carried"]);

      backend.destroyBody("falling 2");
      backend.destroyBody("falling 6");
      backend.step(1 / 60);
      const remaining = falling.filter((id) => id !== "falling 2" && id !== "falling 6");
      expectHavokPoses(backend, remaining);

      spawn(backend, "late 1", tilted(0.2, 6));
      spawn(backend, "late 2", tilted(-0.4, 8));
      for (let step = 0; step < 20; step++) backend.step(1 / 60);
      expectHavokPoses(backend, [...remaining, "late 1", "late 2", "carried"]);

      backend.teleportBody("falling 4", tilted(4, 3, 1));
      backend.step(1 / 60);
      expectHavokPoses(backend, [...remaining, "late 1", "late 2"]);
      // The teleported body moved one step from where it was put, not from where it had been.
      expect(backend.getBodyTransform("falling 4")!.position.x).toBeCloseTo(4, 1);
    } finally { backend.dispose(); }
  });

  it("steps without asking Havok for one body's transform at a time", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    try {
      for (let index = 0; index < 8; index++) spawn(backend, `body ${index}`, tilted(index * 2, 4));
      backend.step(1 / 60);
      const havok = havokOf(backend);
      const perBody = vi.spyOn(havok, "HP_Body_GetQTransform");
      const offsets = vi.spyOn(havok, "HP_Body_GetWorldTransformOffset");
      const buffer = vi.spyOn(havok, "HP_World_GetBodyBuffer");
      for (let step = 0; step < 5; step++) backend.step(1 / 60);
      // One buffer address per step for the world; each body's offset was learnt in its first step.
      expect(perBody).not.toHaveBeenCalled();
      expect(offsets).not.toHaveBeenCalled();
      expect(buffer).toHaveBeenCalledTimes(5);
      expect(backend.getBodyTransform("body 3")!.position.y).toBeLessThan(4);
    } finally { backend.dispose(); }
  });
});
