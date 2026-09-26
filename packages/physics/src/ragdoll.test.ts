import { expect, it, vi } from "vitest";
import { parseRagdollProperties, type RagdollBonePose } from "@babylonslate/core";
import { HavokPhysicsBackend } from "./havok-backend";
import { RagdollPhysics } from "./ragdoll";

const bones: RagdollBonePose[] = [
  { name: "hip", parentName: null, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } },
  { name: "knee", parentName: "hip", position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0.3826834323650898, w: 0.9238795325112867 } },
  { name: "foot", parentName: "knee", position: { x: 0.7, y: 1.7, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
];
const properties = () => parseRagdollProperties({ enabled: true, totalMass: 3, radius: 0.1 });

it("builds from the captured pose and keeps limbs connected when a queried bone is struck", async () => {
  const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
  try {
    const ragdoll = new RagdollPhysics(backend, "actor", "ragdoll", bones, properties());
    const initial = ragdoll.readPose();
    expect(initial.map((bone) => bone.position)).toEqual(bones.map((bone) => bone.position));
    expect(initial[0]!.rotation.z).toBeCloseTo(Math.SQRT1_2);
    const hit = backend.lineTrace({ x: -2, y: 0.5, z: 0 }, { x: 2, y: 0.5, z: 0 });
    expect(hit.actorId).toBe("actor");
    expect(hit.bodyId).not.toBeNull();
    backend.addImpulse(hit.bodyId!, { x: -2, y: 1, z: 1 });
    for (let i = 0; i < 90; i++) backend.step(1 / 60);
    const result = ragdoll.readPose();
    const hip = result.find((bone) => bone.name === "hip")!.position;
    const knee = result.find((bone) => bone.name === "knee")!.position;
    const foot = result.find((bone) => bone.name === "foot")!.position;
    expect(Math.hypot(hip.x - knee.x, hip.y - knee.y, hip.z - knee.z)).toBeCloseTo(1, 1);
    expect(Math.hypot(foot.x - knee.x, foot.y - knee.y, foot.z - knee.z)).toBeCloseTo(Math.sqrt(0.98), 1);
    expect(hip.x).toBeLessThan(-0.2);
    ragdoll.dispose();
    ragdoll.dispose();
    expect(backend.readTransforms().size).toBe(0);
    expect(ragdoll.readPose()).toEqual([]);
    expect(backend.lineTrace({ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }).hit).toBe(false);
  } finally { backend.dispose(); }
});

it("validates the skeleton before mutation and rolls back every native resource if joint construction fails", async () => {
  const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
  try {
    expect(() => new RagdollPhysics(backend, "actor", "bad", [bones[0]!, { ...bones[1]!, parentName: "missing" }], properties())).toThrow("parent");
    expect(() => new RagdollPhysics(backend, "actor", "bad", bones, { ...properties(), boneNames: ["hip", "foot"] })).toThrow("connected");
    expect(backend.readTransforms().size).toBe(0);
    const original = backend.createConstraint.bind(backend);
    let allocations = 0;
    const fail = vi.spyOn(backend, "createConstraint").mockImplementation((desc) => {
      if (++allocations === 2) throw new Error("joint setup failed");
      original(desc);
    });
    expect(() => new RagdollPhysics(backend, "actor", "partial", bones, properties())).toThrow("joint setup");
    fail.mockRestore();
    expect(backend.readTransforms().size).toBe(0);
    // Reuse the same namespace after failure: no stale native body/joint may survive.
    const retry = new RagdollPhysics(backend, "actor", "partial", bones, properties());
    for (let i = 0; i < 10; i++) backend.step(1 / 60);
    expect(retry.readPose().every((bone) => Number.isFinite(bone.position.x))).toBe(true);
    retry.dispose();
  } finally { backend.dispose(); }
});
