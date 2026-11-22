import { describe, expect, it, vi } from "vitest";
import {
  ClassRegistry,
  World,
  createWorldSnapshot,
  stringifyWorldSnapshot,
  type Actor,
} from "@haptic/object-model";
import { createSoftwarePhysicsBackend } from "@haptic/physics";
import { HavokPhysicsBackend } from "@haptic/physics/havok-backend";
import { Rapier2DPhysicsBackend } from "@haptic/physics/rapier-backend";
import { PhysicsWorldSync } from "./physics-sync";
import { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";

function createTestWorld(): World {
  const registry = new ClassRegistry();
  registry.register({ id: "Actor", kind: "actor", parentClassId: null, variables: [], implementedInterfaces: [] });
  registry.register({ id: "RigidBodyComponent", kind: "component", parentClassId: null, variables: [], implementedInterfaces: [] });
  registry.register({ id: "ColliderComponent", kind: "component", parentClassId: null, variables: [], implementedInterfaces: [] });
  registry.register({ id: "MeshComponent", kind: "component", parentClassId: null, variables: [], implementedInterfaces: [] });
  registry.register({ id: "DynamicRuntimeMeshComponent", kind: "component", parentClassId: null, variables: [], implementedInterfaces: [] });
  let seq = 0;
  return new World({ seed: 42, dt: 1 / 60, classRegistry: registry, guidFactory: () => `g-${++seq}` });
}

function spawnBox(
  world: World,
  options: {
    guid: string;
    motionType: "static" | "dynamic" | "kinematic";
    x?: number;
    y?: number;
    z?: number;
    half?: number;
    halfY?: number;
    parentId?: string | null;
    sceneLayerId?: string | null;
    planar?: boolean;
  },
): Actor {
  const half = options.half ?? 0.5;
  const halfY = options.halfY ?? half;
  const actor = world.createActor({
    classId: "Actor",
    guid: options.guid,
    sceneLayerId: options.sceneLayerId ?? null,
    variables: options.parentId ? { parentId: options.parentId } : {},
    transform: {
      position: { x: options.x ?? 0, y: options.y ?? 0, z: options.z ?? 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
  });
  actor.attachComponent(
    world.createComponent({
      classId: "RigidBodyComponent",
      variables: {
        motionType: options.motionType,
        mass: options.motionType === "static" ? 0 : 1,
        linearDamping: 0.4,
        angularDamping: 0.4,
      },
    }),
  );
  actor.attachComponent(
    world.createComponent({
      classId: "ColliderComponent",
      variables: {
        shape: options.planar
          ? { kind: "box2d", halfExtents: { x: half, y: halfY } }
          : { kind: "box", halfExtents: { x: half, y: halfY, z: half } },
      },
    }),
  );
  return world.spawnActorNow(actor);
}

describe("event-driven dirty-tracked PhysicsWorldSync", () => {
  it("does O(0) backend mutations on 1,000 untouched static colliders and reads back only awake simulated bodies", async () => {
    const world = createTestWorld();
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    const sync = new PhysicsWorldSync(backend);
    try {
      for (let i = 0; i < 1000; i++) {
        spawnBox(world, { guid: `static-${i}`, motionType: "static", x: i * 4, y: -0.5, z: 0 });
      }
      const ball = spawnBox(world, { guid: "ball", motionType: "dynamic", x: 0, y: 5, z: 0 });
      sync.step(1 / 60, world);

      const createBody = vi.spyOn(backend, "createBody");
      const updateBody = vi.spyOn(backend, "updateBody");
      const teleportBody = vi.spyOn(backend, "teleportBody");
      const applyColliders = vi.spyOn(backend, "applyColliderChanges");
      const readBody = vi.spyOn(backend, "readBodyTransform");

      for (let tick = 0; tick < 5; tick++) {
        sync.step(1 / 60, world);
      }

      expect(createBody).not.toHaveBeenCalled();
      expect(updateBody).not.toHaveBeenCalled();
      expect(teleportBody).not.toHaveBeenCalled();
      expect(applyColliders).not.toHaveBeenCalled();
      // Only the 1 falling dynamic body is read back across the 5 ticks — never the 1,000 statics.
      expect(readBody).toHaveBeenCalledTimes(5);
      expect(ball.transform.position.y).toBeLessThan(5);

      // Moving one static actor updates only that single static body.
      const static42 = world.findActor("static-42")!;
      static42.transform.position.y = 3;
      sync.step(1 / 60, world);
      expect(teleportBody).toHaveBeenCalledTimes(1);
      expect(teleportBody.mock.calls[0]?.[0]).toBe("body:static-42");
    } finally {
      sync.dispose();
    }
  });

  it("isolates dirty sets across multiple PhysicsWorldSync instances sharing one World", () => {
    const world = createTestWorld();
    const mainBackend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const layerBackend = createSoftwarePhysicsBackend("2d", { x: 0, y: 0, z: 0 });
    const mainSync = new PhysicsWorldSync(mainBackend, {
      actorFilter: (a) => a.sceneLayerId == null,
      sceneLayerId: null,
      eligibilityRevision: () => 0,
    });
    const layerSync = new PhysicsWorldSync(layerBackend, {
      actorFilter: (a) => a.sceneLayerId === "hud",
      sceneLayerId: "hud",
      eligibilityRevision: () => 0,
    });
    try {
      const mainActor = spawnBox(world, { guid: "main-a", motionType: "static", x: 1, planar: true });
      const layerActor = spawnBox(world, { guid: "layer-a", motionType: "static", x: 2, sceneLayerId: "hud", planar: true });

      mainSync.syncFromWorld(world);
      layerSync.syncFromWorld(world);

      const mainTeleport = vi.spyOn(mainBackend, "teleportBody");
      const layerTeleport = vi.spyOn(layerBackend, "teleportBody");

      // Mutating both before either drains must deliver each change to its own world independently.
      mainActor.transform.position.x = 10;
      layerActor.transform.position.x = 20;

      mainSync.syncFromWorld(world);
      expect(mainTeleport).toHaveBeenCalledTimes(1);
      expect(mainTeleport.mock.calls[0]?.[0]).toBe("body:main-a");
      expect(layerTeleport).not.toHaveBeenCalled();

      layerSync.syncFromWorld(world);
      expect(layerTeleport).toHaveBeenCalledTimes(1);
      expect(layerTeleport.mock.calls[0]?.[0]).toBe("body:layer-a");
      expect(mainTeleport).toHaveBeenCalledTimes(1);

      // Moving an actor across layers retires it from the old world and creates it in the new world.
      layerActor.sceneLayerId = null;
      mainSync.syncFromWorld(world);
      layerSync.syncFromWorld(world);
      expect(mainBackend.getBodyTransform("body:layer-a")?.position.x).toBe(20);
      expect(layerBackend.getBodyTransform("body:layer-a")).toBeNull();
    } finally {
      mainSync.dispose();
      layerSync.dispose();
    }
  });

  it("handles hidden invalidation sources: eligibilityRevision, DynamicRuntimeMesh collisionRevision, and host ragdoll suppression", () => {
    const world = createTestWorld();
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    let ready = false;
    let rev = 0;
    const sync = new PhysicsWorldSync(backend, {
      actorFilter: () => ready,
      eligibilityRevision: () => rev,
    });
    const dynMeshes = new DynamicRuntimeMeshSync({
      slot: () => 0,
      eligible: () => true,
      emit: () => {},
    });
    try {
      const host = spawnBox(world, { guid: "host", motionType: "dynamic", x: 0, y: 2 });
      const child = spawnBox(world, { guid: "child", motionType: "static", x: 1, y: 0, parentId: host.guid });
      const dynActor = world.createActor({ classId: "Actor", guid: "dyn-mesh" });
      const dynComp = world.createComponent({
        classId: "DynamicRuntimeMeshComponent",
        variables: { enableCollision: true },
      });
      dynActor.attachComponent(dynComp);
      world.spawnActorNow(dynActor);

      // Initially ineligible: no bodies created.
      sync.syncFromWorld(world);
      expect(backend.getBodyTransform("body:host")).toBeNull();

      // Flip eligibilityRevision: host gets a body hosting child's solid shape.
      ready = true;
      rev++;
      sync.syncFromWorld(world);
      expect(backend.getBodyTransform("body:host")).not.toBeNull();
      expect(backend.getBodyTransform("body:child")).toBeNull();

      // Suppressing the host (ragdoll) releases child back to its own static body.
      sync.suppressActorBody(host, true);
      sync.syncFromWorld(world);
      expect(backend.getBodyTransform("body:host")).toBeNull();
      expect(backend.getBodyTransform("body:child")).not.toBeNull();
      expect(child.transform.position.x).toBe(1);

      // Unsuppressing re-hosts child onto host.
      sync.suppressActorBody(host, false);
      sync.syncFromWorld(world);
      expect(backend.getBodyTransform("body:host")).not.toBeNull();
      expect(backend.getBodyTransform("body:child")).toBeNull();

      // Updating DynamicRuntimeMeshComponent geometry bumps collisionRevision and creates its implicit body.
      expect(backend.getBodyTransform("body:dyn-mesh")).toBeNull();
      expect(
        dynMeshes.invoke(dynComp, "setDynamicMeshGeometry", {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
        }).success,
      ).toBe(true);
      sync.syncFromWorld(world);
      expect(backend.getBodyTransform("body:dyn-mesh")).not.toBeNull();
    } finally {
      dynMeshes.dispose();
      sync.dispose();
    }
  });

  it("skips readback on unparented and static-parented sleeping dynamic bodies while updating sleeping dynamic children under a moving parent", async () => {
    const world = createTestWorld();
    const backend = await Rapier2DPhysicsBackend.create({ kind: "2d", gravity: { x: 0, y: -9.81, z: 0 } });
    const sync = new PhysicsWorldSync(backend);
    try {
      spawnBox(world, { guid: "floor", motionType: "static", x: 0, y: -0.5, half: 20, halfY: 0.5, planar: true });
      const sleeper = spawnBox(world, { guid: "sleeper", motionType: "dynamic", x: -5, y: 0.6, planar: true });
      const staticParent = spawnBox(world, { guid: "static-parent", motionType: "static", x: 0, y: 5, planar: true });
      const staticChild = spawnBox(world, { guid: "static-child", motionType: "dynamic", x: 0, y: -4.4, parentId: staticParent.guid, planar: true });
      const parent = spawnBox(world, { guid: "carrier", motionType: "kinematic", x: 5, y: 5, planar: true });
      const child = spawnBox(world, { guid: "child", motionType: "dynamic", x: 0, y: -4.4, parentId: parent.guid, planar: true });

      // Step until all dynamic bodies are resting/asleep on the floor.
      for (let i = 0; i < 300; i++) {
        sync.step(1 / 60, world);
        if (
          !backend.didBodyMoveLastStep("body:sleeper") &&
          !backend.didBodyMoveLastStep("body:static-child") &&
          !backend.didBodyMoveLastStep("body:child")
        ) break;
      }
      expect(backend.didBodyMoveLastStep("body:sleeper")).toBe(false);
      expect(backend.didBodyMoveLastStep("body:static-child")).toBe(false);
      expect(backend.didBodyMoveLastStep("body:child")).toBe(false);

      // Unparented and static-parented sleeping dynamic bodies skip readBodyTransform completely.
      const readSpy = vi.spyOn(backend, "readBodyTransform");
      const childWorldBefore = parent.transform.position.x + child.transform.position.x;
      parent.transform.position.x = 8;
      sync.step(1 / 60, world);
      expect(readSpy.mock.calls.map(([id]) => id)).toContain("body:child");
      expect(readSpy.mock.calls.map(([id]) => id)).not.toContain("body:sleeper");
      expect(readSpy.mock.calls.map(([id]) => id)).not.toContain("body:static-child");
      // Child's local transform compensated for the kinematic parent's motion so its world pose stayed fixed.
      expect(parent.transform.position.x + child.transform.position.x).toBeCloseTo(childWorldBefore, 3);
      expect(sleeper.transform.position.x).toBeCloseTo(-5, 3);
      expect(staticParent.transform.position.x + staticChild.transform.position.x).toBeCloseTo(0, 3);
    } finally {
      sync.dispose();
    }
  });

  it("throws on parent cycles and oblique shear before any native mutation and keeps dirty state on retry", () => {
    const world = createTestWorld();
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    try {
      const a = spawnBox(world, { guid: "a", motionType: "static", x: 0 });
      const b = spawnBox(world, { guid: "b", motionType: "static", x: 2, parentId: a.guid });
      sync.syncFromWorld(world);

      const teleport = vi.spyOn(backend, "teleportBody");
      // Form a parent cycle and move a simultaneously.
      a.transform.position.x = 10;
      a.setVariable("parentId", b.guid);

      expect(() => sync.syncFromWorld(world)).toThrow(/parent cycle/i);
      expect(teleport).not.toHaveBeenCalled();

      // Retrying without fixing the cycle still throws (dirty sets were not cleared on failure).
      expect(() => sync.syncFromWorld(world)).toThrow(/parent cycle/i);
      expect(teleport).not.toHaveBeenCalled();

      // Breaking the cycle lets the deferred move commit cleanly.
      a.setVariable("parentId", null);
      sync.syncFromWorld(world);
      expect(backend.getBodyTransform("body:a")?.position.x).toBe(10);
      expect(backend.getBodyTransform("body:b")?.position.x).toBe(12);
    } finally {
      sync.dispose();
    }
  });

  it.each(["3d", "2d"] as const)("matches a fresh full-sync world bit-for-bit across spawns, reparenting, hosting, and impulses (%s)", async (kind) => {
    const runScenario = async (forceFullEachTick: boolean): Promise<string> => {
      const world = createTestWorld();
      const backend =
        kind === "3d"
          ? await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } })
          : await Rapier2DPhysicsBackend.create({ kind: "2d", gravity: { x: 0, y: -9.81, z: 0 } });
      let fullSyncTick = 0;
      const sync = new PhysicsWorldSync(
        backend,
        forceFullEachTick ? { eligibilityRevision: () => ++fullSyncTick } : undefined,
      );
      try {
        const planar = kind === "2d";
        spawnBox(world, { guid: "floor", motionType: "static", x: 0, y: -0.5, half: 10, planar });
        const carrier = spawnBox(world, { guid: "carrier", motionType: "dynamic", x: 0, y: 3, planar });
        const foot = spawnBox(world, { guid: "foot", motionType: "static", x: 0, y: -1, half: 0.25, parentId: carrier.guid, planar });
        const mover = spawnBox(world, { guid: "mover", motionType: "kinematic", x: -4, y: 1, planar });
        const prop = spawnBox(world, { guid: "prop", motionType: "static", x: 5, y: 0.5, planar });

        for (let tick = 0; tick < 25; tick++) {
          if (tick === 5) {
            mover.transform.position.x = -3.5;
            sync.addImpulse(carrier.guid, { x: 1.5, y: 0, z: 0 });
          }
          if (tick === 10) {
            prop.transform.position.y = 2;
            spawnBox(world, { guid: "late", motionType: "dynamic", x: 2, y: 4, planar });
          }
          if (tick === 15) {
            foot.setVariable("parentId", null);
            world.destroyActor(prop.guid);
            world.flushPending();
          }
          if (tick === 20) {
            mover.transform.position.x = -3;
          }
          sync.step(1 / 60, world);
        }
        return stringifyWorldSnapshot(createWorldSnapshot(world));
      } finally {
        sync.dispose();
      }
    };

    const [incremental, full] = await Promise.all([runScenario(false), runScenario(true)]);
    expect(incremental).toBe(full);
  });
});
