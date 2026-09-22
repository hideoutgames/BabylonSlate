import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DistanceConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { PhysicsShapeContainer } from "@babylonjs/core/Physics/v2/physicsShape";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { HavokPhysicsWithBindings } from "@babylonjs/havok";
import { PhysicsPrestepType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPhysicsBackend } from "./havok-backend";
import { bakeColliderLocal } from "./collider-bake";
import type { ColliderDesc, PhysicsTransform } from "./types";

afterEach(() => vi.restoreAllMocks());
beforeEach(({ task }) => console.info("native fixture started", task.name));
const pose = (x = 0, y = 0, z = 0): PhysicsTransform => ({
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});
const create = (gravity = 0) =>
  HavokPhysicsBackend.create({
    kind: "3d",
    gravity: { x: 0, y: gravity, z: 0 },
  });
function body(
  backend: HavokPhysicsBackend,
  id = "body",
  motionType: "static" | "dynamic" | "kinematic" = "static",
  transform = pose(),
) {
  backend.createBody({
    id,
    actorId: id,
    motionType,
    mass: 2,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    transform,
  });
}
function box(id = "collider", x = 0): ColliderDesc {
  return {
    id,
    bodyId: "body",
    shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    translation: { x, y: 0, z: 0 },
    friction: 0.5,
    restitution: 0,
    isTrigger: false,
    layer: 1,
    mask: 0xffffffff,
  };
}
const trace = (backend: HavokPhysicsBackend, x = 0, z = 0) =>
  backend.lineTrace({ x, y: 3, z }, { x, y: -3, z });
const native = (backend: HavokPhysicsBackend, id = "body") =>
  backend.scene.getTransformNodeByName(id)!.physicsBody!;
const liveShapes = (backend: HavokPhysicsBackend) =>
  (
    backend.plugin as unknown as { _hknp: HavokPhysicsWithBindings }
  )._hknp.HP_GetStatistics()[1][1];
const tetrahedron = [
  { x: 0, y: 0, z: 0 },
  { x: 2, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 0.5 },
];

describe("Havok attachment transactions", () => {
  it("keeps native geometry and resource counts bounded through 300 compound edit cycles", async () => {
    const backend = await create();
    try {
      body(backend);
      const originalBody = native(backend);
      const baseline = liveShapes(backend);
      const init = vi.spyOn(backend.plugin, "initShape");
      for (let cycle = 0; cycle < 300; cycle++) {
        const ordered =
          cycle % 2
            ? [box("c", 3), box("b"), box("a", -3)]
            : [box("a", -3), box("b"), box("c", 3)];
        backend.applyColliderChanges("body", { upsert: ordered, remove: [] });
        expect(native(backend)).toBe(originalBody);
        expect(originalBody.shape!.getNumChildren()).toBe(3);
        expect(liveShapes(backend)).toBe(baseline + 4);
        for (const x of [-3, 0, 3]) expect(trace(backend, x).hit).toBe(true);
        init.mockClear();
        backend.applyColliderChanges("body", { upsert: ordered, remove: [] });
        expect(init).not.toHaveBeenCalled();
        // Remove the first, middle and last logical child in a rotating order.
        const ids =
          cycle % 3 === 0
            ? ["a", "b", "c"]
            : cycle % 3 === 1
              ? ["b", "c", "a"]
              : ["c", "a", "b"];
        for (const id of ids) {
          backend.destroyCollider(id);
          expect(trace(backend, id === "a" ? -3 : id === "c" ? 3 : 0).hit).toBe(
            false,
          );
        }
        expect(originalBody.shape).toBeNull();
        expect(liveShapes(backend)).toBe(baseline);
        expect(
          backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 10).actorIds,
        ).toEqual([]);
      }
      expect(backend.scene.meshes).toHaveLength(0);
      expect(backend.scene.geometries).toHaveLength(0);
    } finally {
      backend.dispose();
    }
  });

  it("reuses geometry for attachment poses and filter tuning while recomputing inertia for resized geometry", async () => {
    const backend = await create();
    try {
      body(backend, "body", "dynamic");
      backend.createCollider(box());
      const physicsBody = native(backend);
      const stage = (label: string) =>
        console.info("native mutation stage", label);
      stage("body and box created");
      const oldInertia = physicsBody.getMassProperties().inertia!.clone();
      physicsBody.setLinearVelocity(new Vector3(3, -2, 1));
      const initialShape = physicsBody.shape;
      const init = vi.spyOn(backend.plugin, "initShape");
      backend.updateCollider("collider", {
        layer: 2,
        mask: 4,
        friction: 0.8,
        isTrigger: true,
      });
      stage("trigger and filter updated");
      expect(init).not.toHaveBeenCalled();
      expect(physicsBody.shape).toBe(initialShape);
      expect(physicsBody.shape!.isTrigger).toBe(true);
      expect(physicsBody.shape!.filterMembershipMask).toBe(2);
      backend.applyColliderChanges("body", {
        upsert: [{ ...box(), translation: { x: 2, y: 0, z: 0 } }],
        remove: [],
      });
      stage("local pose committed");
      expect(init).toHaveBeenCalledTimes(1); // A pose container, no new geometry.
      expect(trace(backend, 2).hit).toBe(true);
      stage("local pose queried");
      init.mockClear();
      backend.applyColliderChanges("body", {
        upsert: [
          {
            ...box(),
            shape: { kind: "box", halfExtents: { x: 2, y: 0.5, z: 0.5 } },
          },
        ],
        remove: [],
      });
      stage("resize committed");
      expect(init).toHaveBeenCalledTimes(1);
      expect(physicsBody.getMassProperties().mass).toBeCloseTo(2);
      expect(physicsBody.getMassProperties().inertia!.y).toBeGreaterThan(
        oldInertia.y,
      );
      expect(physicsBody.getLinearVelocity().asArray()).toEqual([3, -2, 1]);
    } finally {
      backend.dispose();
    }
  });

  it.each([
    { compound: false, mirrored: false },
    { compound: true, mirrored: false },
    { compound: false, mirrored: true },
    { compound: true, mirrored: true },
  ])(
    "applies asymmetric scaled hull/triangle local pose once (compound=$compound, mirrored=$mirrored)",
    async ({ compound, mirrored }) => {
      const backend = await create();
      try {
        body(backend);
        const rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
        const scale = { x: mirrored ? -2 : 2, y: 1, z: 1 };
        const local = { ...pose(), scale };
        const hull: ColliderDesc = {
          ...box("hull"),
          shape: bakeColliderLocal(
            { kind: "convex", points: tetrahedron },
            local,
            { x: 1, y: 1, z: 1 },
          ).shape,
          translation: { x: 4, y: 0, z: 0 },
          rotation,
        };
        backend.applyColliderChanges("body", {
          upsert: [hull, ...(compound ? [box("other", -4)] : [])],
          remove: [],
        });
        expect(trace(backend, 4.1, mirrored ? 2.8 : -2.8).hit).toBe(true);
        expect(trace(backend, 4.7, 0.1).hit).toBe(false);
        expect(trace(backend, 0.1, 0.1).hit).toBe(false);
        const triangle: ColliderDesc = {
          ...hull,
          id: "triangle",
          shape: bakeColliderLocal(
            {
              kind: "mesh",
              vertices: [
                { x: 0, y: 0, z: 0 },
                { x: 2, y: 0, z: 0 },
                { x: 0, y: 0, z: 1 },
              ],
              indices: [0, 1, 2],
            },
            local,
            { x: 1, y: 1, z: 1 },
          ).shape,
          translation: { x: 8, y: 0, z: 0 },
        };
        backend.applyColliderChanges("body", {
          upsert: [triangle],
          remove: ["hull"],
        });
        expect(trace(backend, 8.2, mirrored ? 2.8 : -2.8).hit).toBe(true);
        expect(trace(backend, 8.7, mirrored ? -0.2 : 0.2).hit).toBe(false);
        expect(trace(backend, 4.1, -0.7).hit).toBe(false);
        expect(backend.scene.meshes).toHaveLength(0);
        expect(backend.scene.geometries).toHaveLength(0);
      } finally {
        backend.dispose();
      }
    },
  );

  it("preserves current attachments on shape/container/native-attachment failure and releases provisional resources", async () => {
    const backend = await create();
    try {
      body(backend);
      backend.createCollider(box());
      const baseline = liveShapes(backend);
      const old = native(backend).shape;
      const init = vi
        .spyOn(backend.plugin, "initShape")
        .mockImplementationOnce(() => {
          throw new Error("shape constructor failed");
        });
      expect(() =>
        backend.applyColliderChanges("body", {
          upsert: [
            { ...box(), shape: { kind: "convex", points: tetrahedron } },
          ],
          remove: [],
        }),
      ).toThrow("shape constructor failed");
      init.mockRestore();
      expect(trace(backend).hit).toBe(true);
      expect(backend.scene.meshes).toHaveLength(0);
      expect(backend.scene.geometries).toHaveLength(0);
      const child = vi
        .spyOn(PhysicsShapeContainer.prototype, "addChild")
        .mockImplementationOnce(() => {
          throw new Error("compound failed");
        });
      expect(() => backend.createCollider(box("second", 3))).toThrow(
        "compound failed",
      );
      child.mockRestore();
      expect(native(backend).shape).toBe(old);
      expect(liveShapes(backend)).toBe(baseline);
      const attach = vi
        .spyOn(backend.plugin, "setShape")
        .mockImplementationOnce(() => {
          throw new Error("attach failed");
        });
      expect(() => backend.createCollider(box("second", 3))).toThrow(
        "attach failed",
      );
      attach.mockRestore();
      expect(native(backend).shape).toBe(old);
      expect(liveShapes(backend)).toBe(baseline);
      expect(trace(backend).hit).toBe(true);
      expect(trace(backend, 3).hit).toBe(false);
      const havok = backend.plugin._hknp as HavokPhysicsWithBindings;
      const nativeAttach = vi
        .spyOn(havok, "HP_Body_SetShape")
        .mockReturnValueOnce(havok.Result.RESULT_FAIL);
      expect(() => backend.createCollider(box("rejected", 6))).toThrow(
        "native shape attachment failed",
      );
      nativeAttach.mockRestore();
      expect(native(backend).shape).toBe(old);
      expect(liveShapes(backend)).toBe(baseline);
      expect(trace(backend).hit).toBe(true);
      expect(trace(backend, 6).hit).toBe(false);
      const cast = vi
        .spyOn(backend.plugin, "shapeCast")
        .mockImplementationOnce(() => {
          throw new Error("cast failed");
        });
      expect(() =>
        backend.shapeSweep(
          { kind: "convex", points: tetrahedron },
          pose(-5),
          pose(5),
        ),
      ).toThrow("cast failed");
      cast.mockRestore();
      expect(liveShapes(backend)).toBe(baseline);
      expect(backend.scene.meshes).toHaveLength(0);
    } finally {
      backend.dispose();
    }
  });

  it("reports rollback failure without releasing possibly attached native shapes", async () => {
    const backend = await create();
    try {
      body(backend);
      backend.createCollider(box());
      const attach = vi
        .spyOn(backend.plugin, "setShape")
        .mockImplementation(() => {
          throw new Error("native unavailable");
        });
      expect(() => backend.createCollider(box("second", 3))).toThrow(
        "rollback failed",
      );
      attach.mockRestore();
      expect(liveShapes(backend)).toBe(3);
      expect(() => trace(backend)).toThrow("rollback failed");
      backend.destroyBody("body");
      expect(liveShapes(backend)).toBe(0);
    } finally {
      backend.dispose();
    }
  });

  it("detached geometry cannot support a falling body and reattachment restores collision response", async () => {
    const backend = await create(-9.81);
    try {
      body(backend);
      backend.createCollider(box());
      body(backend, "falling", "dynamic", pose(0, 3));
      backend.createCollider({ ...box("falling-shape"), bodyId: "falling" });
      backend.destroyCollider("collider");
      for (let i = 0; i < 90; i++) backend.step(1 / 60);
      expect(backend.getBodyTransform("falling")!.position.y).toBeLessThan(-2);
      backend.createCollider(box());
      backend.teleportBody("falling", pose(0, 3), { velocity: "reset" });
      for (let i = 0; i < 120; i++) backend.step(1 / 60);
      expect(backend.getBodyTransform("falling")!.position.y).toBeCloseTo(1, 1);
    } finally {
      backend.dispose();
    }
  });
});

describe("Havok explicit native motion", () => {
  it("defers contact-callback mutations until stepping completes and cancels queued work on disposal", async () => {
    const backend = await create();
    body(backend);
    backend.createCollider(box());
    body(backend, "moving", "dynamic", pose(0.5));
    backend.createCollider({ ...box("moving-shape"), bodyId: "moving" });
    let requested = false;
    const observer = backend.plugin.onCollisionObservable.add(() => {
      if (requested) return;
      requested = true;
      backend.teleportBody("moving", pose(8), { velocity: "reset" });
      expect(() => trace(backend, 8)).toThrow("native callbacks");
    });
    try {
      backend.step(1 / 60);
      expect(requested).toBe(true);
      expect(trace(backend, 8).actorId).toBe("moving");
      backend.plugin.onCollisionObservable.remove(observer);
      backend.teleportBody("moving", pose(0.5));
      backend.plugin.onCollisionObservable.addOnce(() => {
        backend.dispose();
        backend.teleportBody("moving", pose(20));
      });
      backend.step(1 / 60);
      expect(backend.scene.isDisposed).toBe(true);
      expect(() => backend.step(1 / 60)).toThrow("disposed");
    } finally {
      backend.dispose();
    }
  });

  it("retains controller-owned resources only while their native users are alive", async () => {
    const backend = await create();
    try {
      body(backend, "body", "kinematic");
      const baseline = liveShapes(backend);
      for (let i = 0; i < 50; i++) {
        backend.createCharacterController({
          id: "controller",
          bodyId: "body",
          offset: 0.01,
        });
        backend.teleportBody("body", pose(i + 1));
        expect(
          backend.moveCharacter("controller", { x: 0, y: 0, z: 0 }, 1 / 60)!
            .position.x,
        ).toBeCloseTo(i + 1);
        backend.destroyCharacterController("controller");
        expect(liveShapes(backend)).toBe(baseline);
        expect(backend.plugin.numBodies).toBe(1);
      }
    } finally {
      backend.dispose();
    }
  });

  it("ends retired trigger-pair generations without permanent or duplicate stale overlaps", async () => {
    const backend = await create();
    try {
      const stage = (label: string) =>
        console.info("trigger mutation stage", label);
      const havok = (backend.plugin as unknown as { _hknp: HavokPhysicsWithBindings })._hknp;
      const nativeStep = havok.HP_World_Step.bind(havok);
      vi.spyOn(havok, "HP_World_Step").mockImplementation((...args) => {
        stage("enter native step");
        const result = nativeStep(...args);
        stage("leave native step");
        return result;
      });
      body(backend);
      stage("body created");
      const trigger = (id: string, x: number) => ({
        ...box(id, x),
        isTrigger: true,
      });
      backend.applyColliderChanges("body", {
        upsert: [trigger("left", -0.3), trigger("right", 0.3)],
        remove: [],
      });
      stage("compound created");
      body(backend, "visitor", "dynamic");
      backend.createCollider({ ...box("visitor-shape"), bodyId: "visitor" });
      stage("before step");
      backend.step(1 / 60);
      stage("after step");
      expect(
        backend.pollContacts().filter((event) => event.kind === "overlapBegin"),
      ).toHaveLength(1);
      stage("before left removal");
      backend.destroyCollider("left");
      stage("after left removal");
      expect(
        backend.pollContacts().filter((event) => event.kind === "overlapEnd"),
      ).toHaveLength(1);
      stage("before step");
      backend.step(1 / 60);
      stage("after step");
      expect(
        backend.pollContacts().filter((event) => event.kind === "overlapBegin"),
      ).toHaveLength(1);
      stage("before right removal");
      backend.destroyCollider("right");
      stage("after right removal");
      expect(
        backend.pollContacts().filter((event) => event.kind === "overlapEnd"),
      ).toHaveLength(1);
      for (let i = 0; i < 3; i++) backend.step(1 / 60);
      expect(backend.pollContacts()).toEqual([]);
      backend.createCollider(trigger("replacement", 0));
      stage("before step");
      backend.step(1 / 60);
      stage("after step");
      expect(
        backend.pollContacts().filter((event) => event.kind === "overlapBegin"),
      ).toHaveLength(1);
      backend.teleportBody("visitor", pose(10));
      for (let i = 0; i < 3; i++) backend.step(1 / 60);
      expect(
        backend.pollContacts().filter((event) => event.kind === "overlapEnd"),
      ).toHaveLength(1);
    } finally {
      console.info("trigger mutation stage", "before disposal");
      backend.dispose();
      console.info("trigger mutation stage", "after disposal");
    }
  });

  it("teleports falling and sleeping bodies immediately, restores prestep, and preserves or resets both velocities", async () => {
    const backend = await create(-9.81);
    try {
      body(backend, "body", "dynamic", pose(0, 5));
      backend.createCollider(box());
      const physicsBody = native(backend);
      backend.setBodyLinearVelocity("body", { x: 2 });
      physicsBody.setAngularVelocity(new Vector3(0, 1, 0));
      for (let i = 0; i < 10; i++) backend.step(1 / 60);
      const linear = physicsBody.getLinearVelocity().asArray(),
        angular = physicsBody.getAngularVelocity().asArray();
      backend.teleportBody("body", {
        ...pose(8),
        rotation: { x: 0, y: 0, z: 0, w: 3 },
      });
      const havok = (
        backend.plugin as unknown as { _hknp: HavokPhysicsWithBindings }
      )._hknp;
      const handle = (
        physicsBody as unknown as { _pluginData: { hpBodyId: [bigint] } }
      )._pluginData.hpBodyId;
      expect(havok.HP_Body_GetQTransform(handle)[1][0]).toEqual([8, 0, 0]);
      expect(trace(backend, 8).hit).toBe(true);
      expect(trace(backend).hit).toBe(false);
      expect(physicsBody.getPrestepType()).toBe(PhysicsPrestepType.DISABLED);
      expect(physicsBody.getLinearVelocity().asArray()).toEqual(linear);
      expect(physicsBody.getAngularVelocity().asArray()).toEqual(angular);
      backend.step(1 / 60);
      expect(backend.getBodyTransform("body")!.position.x).toBeGreaterThan(8);
      expect(backend.getBodyTransform("body")!.position.y).toBeLessThan(0);
      havok.HP_Body_SetActivationState(handle, havok.ActivationState.INACTIVE);
      expect(havok.HP_Body_GetActivationState(handle)[1]).toBe(
        havok.ActivationState.INACTIVE,
      );
      backend.teleportBody("body", pose(12), { velocity: "reset" });
      expect(trace(backend, 12).hit).toBe(true);
      expect(physicsBody.getLinearVelocity().asArray()).toEqual([0, 0, 0]);
      expect(physicsBody.getAngularVelocity().asArray()).toEqual([0, 0, 0]);
      backend.step(1 / 60);
      expect(backend.getBodyTransform("body")!.position.x).toBeCloseTo(12);
      expect(backend.getBodyTransform("body")!.position.y).toBeLessThan(0);
      const transform = vi
        .spyOn(backend.plugin, "setPhysicsBodyTransformation")
        .mockImplementationOnce(() => {
          throw new Error("teleport failed");
        });
      expect(() => backend.teleportBody("body", pose(20))).toThrow(
        "teleport failed",
      );
      transform.mockRestore();
      expect(physicsBody.getPrestepType()).toBe(PhysicsPrestepType.DISABLED);
      const failedAdd = vi
        .spyOn(havok, "HP_World_AddBody")
        .mockReturnValueOnce(havok.Result.RESULT_FAIL);
      expect(() => backend.teleportBody("body", pose(30))).toThrow(
        "query membership insertion failed",
      );
      failedAdd.mockRestore();
      expect(trace(backend, 12).hit).toBe(true);
      expect(trace(backend, 30).hit).toBe(false);
      expect(native(backend)).toBe(physicsBody);
      const failedPose = vi
        .spyOn(havok, "HP_Body_SetQTransform")
        .mockReturnValueOnce(havok.Result.RESULT_FAIL);
      expect(() => backend.teleportBody("body", pose(30))).toThrow(
        "native body teleport failed",
      );
      failedPose.mockRestore();
      expect(trace(backend, 12).hit).toBe(true);
      expect(physicsBody.getPrestepType()).toBe(PhysicsPrestepType.DISABLED);
    } finally {
      backend.dispose();
    }
  });

  it("keeps constraints and body policy on the same native handle across immediate teleports", async () => {
    const backend = await create();
    let constraint: DistanceConstraint | undefined;
    try {
      body(backend, "anchor");
      body(backend, "body", "dynamic", pose(2));
      backend.createCollider(box());
      const physicsBody = native(backend);
      backend.updateBody("body", {
        linearDamping: 0.2,
        angularDamping: 0.3,
        gravityScale: 0.4,
        mass: 3,
      });
      const mass = physicsBody.getMassProperties();
      const handle = physicsBody._pluginData.hpBodyId;
      constraint = new DistanceConstraint(2, backend.scene);
      native(backend, "anchor").addConstraint(physicsBody, constraint);
      backend.step(1 / 60);
      backend.teleportBody("body", pose(8));
      expect(trace(backend, 8).actorId).toBe("body");
      expect(physicsBody._pluginData.hpBodyId).toBe(handle);
      expect(physicsBody.getMassProperties()).toEqual(mass);
      expect(physicsBody.getLinearDamping()).toBeCloseTo(0.2);
      expect(physicsBody.getAngularDamping()).toBeCloseTo(0.3);
      expect(physicsBody.getGravityFactor()).toBeCloseTo(0.4);
      expect(constraint.getBodiesUsingConstraint()).toHaveLength(1);
      for (let i = 0; i < 90; i++) backend.step(1 / 60);
      expect(
        Math.abs(backend.getBodyTransform("body")!.position.x),
      ).toBeLessThan(2.1);
    } finally {
      constraint?.dispose();
      backend.dispose();
    }
  });

  it("moves a kinematic pusher by targets without leaving teleport prestep enabled", async () => {
    const backend = await create();
    try {
      body(backend, "body", "kinematic", pose(-2));
      backend.createCollider(box());
      body(backend, "pushed", "dynamic");
      backend.createCollider({ ...box("pushed-shape"), bodyId: "pushed" });
      for (let i = 0; i < 90; i++) {
        backend.setBodyTargetTransform("body", pose(-2 + (i + 1) / 30));
        backend.step(1 / 60);
      }
      expect(backend.getBodyTransform("body")!.position.x).toBeCloseTo(1, 2);
      expect(backend.getBodyTransform("pushed")!.position.x).toBeGreaterThan(
        1.5,
      );
      expect(native(backend).getPrestepType()).toBe(
        PhysicsPrestepType.DISABLED,
      );
    } finally {
      backend.dispose();
    }
  });
});
