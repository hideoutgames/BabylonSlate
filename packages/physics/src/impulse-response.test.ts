import { expect, it } from "vitest";
import { createPhysicsBackend, createSoftwarePhysicsBackend } from "./index";

it.each(["havok", "software"] as const)("%s predicts off-centre impulse response without changing the body", async (kind) => {
  const gravity = { x: 0, y: 0, z: 0 };
  const backend = kind === "software" ? createSoftwarePhysicsBackend("3d", gravity)
    : await createPhysicsBackend({ kind: "3d", gravity, allowSoftwareFallback: false });
  try {
    backend.createBody({ id: "body", actorId: "actor", motionType: "dynamic", mass: 2.5,
      linearDamping: 0, angularDamping: 0, gravityScale: 0,
      transform: { position: { x: 3, y: 2, z: -1 }, rotation: { x: 0, y: 0, z: Math.sin(0.3), w: Math.cos(0.3) } },
    });
    backend.createCollider({ id: "shape", bodyId: "body",
      shape: { kind: "box", halfExtents: { x: 1, y: 0.2, z: 0.7 } },
      translation: { x: 0.3, y: -0.2, z: 0.1 }, rotation: { x: 0, y: Math.sin(0.4), z: 0, w: Math.cos(0.4) },
      friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff,
    });
    const impulse = { x: 0.4, y: 2, z: -0.7 }, point = { x: 4, y: 2.5, z: -1.2 };
    const before = backend.getBodyVelocity("body")!;
    const response = backend.getBodyImpulseResponse!("body", impulse, point)!;
    expect(backend.getBodyVelocity("body")).toEqual(before);
    backend.addImpulseAtPoint("body", impulse, point);
    const after = backend.getBodyVelocity("body")!;
    // Native velocity storage is quantized (for example 0.16 reads as 0.16015625).
    for (const motion of ["linear", "angular"] as const) for (const axis of ["x", "y", "z"] as const)
      expect(after[motion][axis] - before[motion][axis]).toBeCloseTo(response[motion][axis], 2);
    backend.destroyBody("body");
    expect(backend.getBodyImpulseResponse!("body", impulse, point)).toBeNull();
  } finally { backend.dispose(); }
});
