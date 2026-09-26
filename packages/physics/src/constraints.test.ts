import { describe, expect, it, vi } from "vitest";
import { HavokPhysicsBackend } from "./havok-backend";
import { Rapier2DPhysicsBackend } from "./rapier-backend";
import { SoftwarePhysicsBackend } from "./software-backend";
import { parseConstraintProperties } from "./component-props";
import type { PhysicsBackend } from "./backend";
import type { ConstraintDesc, PhysicsTransform } from "./types";

const pose = (x = 0, y = 0, angle = 0): PhysicsTransform => ({
  position: { x, y, z: 0 }, rotation: { x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) },
});
const angleOf = (backend: PhysicsBackend, id = "arm") => {
  const q = backend.getBodyTransform(id)!.rotation;
  return 2 * Math.atan2(q.z, q.w);
};
const base = { id: "joint", bodyAId: "anchor", bodyBId: "arm", anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: -1, y: 0, z: 0 } };
function body(backend: PhysicsBackend, id: string, motionType: "static" | "dynamic", transform = pose()) {
  backend.createBody({ id, actorId: id, motionType, transform, mass: 1, linearDamping: 0.1, angularDamping: 0.3, gravityScale: 1 });
  backend.createCollider({ id: `${id}:shape`, bodyId: id,
    // A two-metre rod gives the one-metre hinge lever physically representative inertia.
    shape: id === "arm"
      ? backend.kind === "3d" ? { kind: "capsule", radius: 0.15, halfHeight: 0.85 } : { kind: "capsule2d", radius: 0.15, halfHeight: 0.85 }
      : backend.kind === "3d" ? { kind: "sphere", radius: 0.1 } : { kind: "circle", radius: 0.1 },
    rotation: pose(0, 0, -Math.PI / 2).rotation,
    friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
}
function step(backend: PhysicsBackend, count = 120) { for (let i = 0; i < count; i++) backend.step(1 / 60); }

describe.each([
  { name: "Havok", create: () => HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } }) },
  { name: "Rapier", create: () => Rapier2DPhysicsBackend.create({ kind: "2d", gravity: { x: 0, y: -9.81, z: 0 } }) },
])("$name native constraints", ({ create }) => {
  it("holds a rotated fixed joint, survives edits and teleport, and releases when destroyed", async () => {
    const backend = await create();
    try {
      body(backend, "anchor", "static");
      body(backend, "arm", "dynamic", pose(0, 1, Math.PI / 2));
      backend.createConstraint({ ...base, kind: "fixed", frameA: pose(0, 0, Math.PI / 2).rotation });
      backend.addImpulse("arm", { x: 6, y: 3, z: 0 });
      step(backend);
      expect(backend.getBodyTransform("arm")!.position.x).toBeCloseTo(0, 1);
      expect(backend.getBodyTransform("arm")!.position.y).toBeCloseTo(1, 1);
      expect(angleOf(backend)).toBeCloseTo(Math.PI / 2, 1);
      backend.createCollider({ id: "arm:shape", bodyId: "arm",
        shape: backend.kind === "3d" ? { kind: "sphere", radius: 0.2 } : { kind: "circle", radius: 0.2 },
        friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
      backend.teleportBody("arm", pose(5, 4, Math.PI / 2), { velocity: "reset" });
      step(backend);
      expect(backend.getBodyTransform("arm")!.position.y).toBeCloseTo(1, 1);
      backend.destroyConstraint("joint");
      step(backend, 30);
      // The released replacement sphere can settle on the static anchor at y=0.3.
      expect(backend.getBodyTransform("arm")!.position.y).toBeLessThan(0.5);
    } finally { backend.dispose(); }
  });

  it("limits a loaded hinge while ball/socket permits the same arm to swing down", async () => {
    const backend = await create();
    try {
      body(backend, "anchor", "static");
      body(backend, "arm", "dynamic", pose(1));
      backend.createConstraint({ ...base, kind: "hinge", axisA: { x: 0, y: 0, z: 1 }, axisB: { x: 0, y: 0, z: 1 }, limits: { min: -0.3, max: 0.3 } });
      step(backend);
      expect(Math.abs(angleOf(backend))).toBeLessThan(0.36);
      expect(Math.abs(angleOf(backend))).toBeGreaterThan(0.2);
      backend.createConstraint({ ...base, kind: "ballSocket" });
      step(backend, 45);
      expect(backend.getBodyTransform("arm")!.position.y).toBeLessThan(-0.65);
    } finally { backend.dispose(); }
  });

  it("keeps an existing joint after invalid replacement and retires joints before either body is reused", async () => {
    const backend = await create();
    try {
      body(backend, "anchor", "static");
      body(backend, "arm", "dynamic", pose(1));
      backend.createConstraint({ ...base, kind: "fixed" });
      expect(() => backend.createConstraint({ ...base, kind: "fixed", bodyBId: "missing" })).toThrow();
      expect(() => backend.createConstraint({ ...base, kind: "hinge", axisA: { x: 0, y: 0, z: 0 }, axisB: { x: 0, y: 0, z: 1 } })).toThrow();
      backend.addImpulse("arm", { x: 0, y: 8, z: 0 });
      step(backend);
      expect(backend.getBodyTransform("arm")!.position.y).toBeCloseTo(0, 1);
      backend.destroyBody("anchor");
      body(backend, "anchor", "static", pose(10));
      step(backend, 30);
      expect(backend.getBodyTransform("arm")!.position.y).toBeLessThan(-1);
      backend.destroyConstraint("joint");
    } finally { backend.dispose(); }
  });

  it("applies connected collision policy to real contact events", async () => {
    const backend = await create();
    try {
      backend.setGravity({ x: 0, y: 0, z: 0 });
      body(backend, "anchor", "static");
      body(backend, "arm", "dynamic");
      const desc: ConstraintDesc = { ...base, kind: "ballSocket", anchorB: { x: 0, y: 0, z: 0 } };
      backend.createConstraint(desc);
      step(backend, 3);
      expect(backend.pollContacts()).toHaveLength(0);
      backend.createConstraint({ ...desc, collideConnected: true });
      step(backend, 3);
      expect(backend.pollContacts().some((event) => event.kind === "hit")).toBe(true);
    } finally { backend.dispose(); }
  });
});

it("Havok bounds a ball joint and enforces exact anchor distance after transactional allocation failure", async () => {
  const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
  try {
    body(backend, "anchor", "static");
    body(backend, "arm", "dynamic", pose(1));
    backend.createConstraint({ ...base, kind: "ballSocket", angularLimits: {
      min: { x: -0.25, y: -0.25, z: -0.25 }, max: { x: 0.25, y: 0.25, z: 0.25 },
    } });
    step(backend);
    expect(Math.abs(angleOf(backend))).toBeGreaterThan(0.15);
    expect(Math.abs(angleOf(backend))).toBeLessThan(0.32);
    const original = backend.plugin.initConstraint.bind(backend.plugin);
    const fail = vi.spyOn(backend.plugin, "initConstraint").mockImplementationOnce((...args) => {
      original(...args);
      throw new Error("injected native setup failure");
    });
    expect(() => backend.createConstraint({ ...base, kind: "distance", distance: 3 })).toThrow("injected");
    fail.mockRestore();
    step(backend);
    expect(Math.abs(angleOf(backend))).toBeLessThan(0.32);
    backend.createConstraint({ ...base, kind: "distance", anchorB: { x: 0, y: 0, z: 0 }, distance: 2 });
    backend.teleportBody("arm", pose(6), { velocity: "reset" });
    step(backend);
    const p = backend.getBodyTransform("arm")!.position;
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(2, 1);
  } finally { backend.dispose(); }
});

it("rejects unsupported or nonplanar native constraints instead of approximating their physics", async () => {
  const backend = await Rapier2DPhysicsBackend.create({ kind: "2d", gravity: { x: 0, y: 0, z: 0 } });
  try {
    body(backend, "anchor", "static"); body(backend, "arm", "dynamic", pose(1));
    expect(() => backend.createConstraint({ ...base, kind: "distance", distance: 1 })).toThrow("not supported in 2D");
    expect(() => backend.createConstraint({ ...base, kind: "ballSocket", anchorA: { x: 0, y: 0, z: 1 } })).toThrow("XY plane");
    expect(() => backend.createConstraint({ ...base, kind: "hinge", axisA: { x: 1, y: 0, z: 0 }, axisB: { x: 1, y: 0, z: 0 } })).toThrow("along Z");
  } finally { backend.dispose(); }
  const software: PhysicsBackend = new SoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
  expect(() => software.createConstraint({ ...base, kind: "fixed" })).toThrow("native physics");
});

it("parses authored axes and degree limits without losing explicit zero values or accepting nonfinite input", () => {
  const parsed = parseConstraintProperties({ kind: "hinge", minAngle: 0, maxAngle: 90, enabled: false }, "2d");
  expect(parsed).toMatchObject({ axisA: { x: 0, y: 0, z: 1 }, minAngle: 0, maxAngle: 90, enabled: false });
  expect(() => parseConstraintProperties({ anchorA: { x: NaN } }, "3d")).toThrow("finite");
});
