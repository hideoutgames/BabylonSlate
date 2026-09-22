import { afterEach, expect, it, vi } from "vitest";
import * as physics from "@babylonslate/physics";
import * as assets from "@babylonslate/assets";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identityTransform,
} from "@babylonslate/core";
import {
  readActorSlot,
  readSnapshotHeader,
  snapshotFloatCount,
} from "@babylonslate/bridge";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { PhysicsWorldSync } from "./physics-sync";
import { createInProcessRuntime } from "./driver";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const world = new World({
    seed: 1,
    dt: 1 / 60,
    classRegistry: new ClassRegistry(),
  });
  const actor = world.createActor({
    classId: "Actor",
    guid: "actor",
    transform: identityTransform(),
  });
  actor.attachComponent(
    world.createComponent({
      classId: "RigidBodyComponent",
      variables: { motionType: "static", mass: 0 },
    }),
  );
  const shape = { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
  const collider = world.createComponent({
    classId: "ColliderComponent",
    guid: "collider",
    variables: { shape },
  });
  actor.attachComponent(collider);
  world.spawnActorNow(actor);
  const backend = physics.createSoftwarePhysicsBackend("3d", {
    x: 0,
    y: 0,
    z: 0,
  });
  const sync = new PhysicsWorldSync(backend);
  const trace = (x: number) =>
    backend.lineTrace({ x, y: 4, z: 0 }, { x, y: -4, z: 0 }).hit;
  return { world, actor, collider, shape, backend, sync, trace };
}

it("separates ordinary collider pose, tuning, scale and owned source replacements", () => {
  const { world, actor, collider, shape, backend, sync, trace } = fixture();
  const scale = vi.spyOn(physics, "scaleColliderShape");
  const commit = vi.spyOn(backend, "applyColliderChanges");
  try {
    sync.syncFromWorld(world);
    shape.halfExtents.x = 30;
    scale.mockClear();
    commit.mockClear();
    sync.syncFromWorld(world);
    expect(trace(3)).toBe(false); // The assigned shape owns its input snapshot.
    expect(scale).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    collider.transform.position.x = 3;
    sync.syncFromWorld(world);
    expect(trace(3)).toBe(true);
    expect(trace(0)).toBe(false);
    expect(scale).not.toHaveBeenCalled();
    collider.variables.set("mask", 2);
    collider.setVariable("friction", 0.8);
    sync.applyComponent(collider);
    expect(scale).not.toHaveBeenCalled();

    actor.transform.scale.x = 2;
    sync.syncFromWorld(world);
    expect(scale).toHaveBeenCalledTimes(1);
    expect(trace(6.9)).toBe(true);
    expect(trace(7.1)).toBe(false);
    scale.mockClear();
    collider.variables.set("shape", {
      kind: "box",
      halfExtents: { x: 2, y: 0.5, z: 0.5 },
    });
    sync.syncFromWorld(world);
    expect(scale).toHaveBeenCalledTimes(1);
    expect(trace(9)).toBe(true);
    collider.destroyed = true;
    sync.syncFromWorld(world);
    expect(trace(6)).toBe(false);
  } finally {
    sync.dispose();
  }
});

it("invalidates dependent scale through a nonphysics parent and rejects shear transactionally", () => {
  const { world, actor, collider, sync, trace } = fixture();
  const parent = world.createActor({
    classId: "Actor",
    guid: "parent",
    transform: identityTransform(),
  });
  world.spawnActorNow(parent);
  actor.setVariable("parentId", parent.guid);
  const scale = vi.spyOn(physics, "scaleColliderShape");
  try {
    sync.syncFromWorld(world);
    scale.mockClear();
    parent.transform.position.x = 3;
    parent.transform.rotation = {
      x: 0,
      y: 0,
      z: Math.SQRT1_2,
      w: Math.SQRT1_2,
    };
    sync.syncFromWorld(world);
    expect(scale).not.toHaveBeenCalled();
    parent.transform.rotation = { x: 0, y: 0, z: 0, w: 1 };
    parent.transform.scale.x = 4;
    sync.syncFromWorld(world);
    expect(trace(4.9)).toBe(true);
    expect(trace(5.1)).toBe(false);
    actor.transform.rotation = {
      x: 0,
      y: 0,
      z: Math.sin(Math.PI / 8),
      w: Math.cos(Math.PI / 8),
    };
    expect(() => sync.syncFromWorld(world)).toThrow("shear");
    expect(trace(4.9)).toBe(true);
    actor.transform.rotation = { x: 0, y: 0, z: 0, w: 1 };
    collider.transform.scale.x = 0;
    expect(() => sync.syncFromWorld(world)).toThrow("nonzero");
    expect(trace(4.9)).toBe(true);
  } finally {
    sync.dispose();
  }
});

it("replaces same-GUID actor and component incarnations and eligibility without retaining old physics", () => {
  const { world, actor, collider, backend, trace } = fixture();
  let eligible = true;
  const sync = new PhysicsWorldSync(backend, { actorFilter: () => eligible });
  try {
    sync.syncFromWorld(world);
    const replacement = world.createComponent({
      classId: "ColliderComponent",
      guid: collider.guid,
      variables: { shape: { kind: "sphere", radius: 2 } },
    });
    actor.components.splice(actor.components.indexOf(collider), 1);
    collider.owner = null;
    actor.attachComponent(replacement);
    sync.syncFromWorld(world);
    expect(trace(1.5)).toBe(true);
    eligible = false;
    sync.syncFromWorld(world);
    expect(trace(0)).toBe(false);
    eligible = true;
    sync.syncFromWorld(world);
    expect(trace(1.5)).toBe(true);
    world.destroyActorInstance(actor);
    world.tick();
    const successor = world.createActor({
      classId: "Actor",
      guid: actor.guid,
      transform: identityTransform(),
    });
    successor.transform.position.x = 10;
    successor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "static" },
      }),
    );
    successor.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        guid: collider.guid,
      }),
    );
    world.spawnActorNow(successor);
    sync.syncFromWorld(world);
    expect(trace(0)).toBe(false);
    expect(trace(10)).toBe(true);
    expect(backend.listDebugColliders()).toHaveLength(1);
  } finally {
    sync.dispose();
  }
});

it("reuses unchanged installed collision content and resolves only its changed source generation", () => {
  const { world, actor, collider, sync, trace } = fixture();
  collider.destroyed = true;
  const model = {
    materialSlots: [],
    clipNames: [],
    skeletonGuid: null,
    importScale: 1,
    simpleColliders: [
      assets.createDefaultSimpleCollider("box", {
        id: "source",
        name: "Source",
      }),
    ],
  };
  actor.attachComponent(
    world.createComponent({
      classId: "MeshComponent",
      variables: { assetGuid: "model", collisionMode: "simple" },
    }),
  );
  const resolve = vi.spyOn(assets, "resolveMeshCollisions");
  const scale = vi.spyOn(physics, "scaleColliderShape");
  try {
    sync.setModelContent({ models: { model } });
    sync.syncFromWorld(world);
    resolve.mockClear();
    scale.mockClear();
    sync.setModelContent({ models: { model: structuredClone(model) } });
    sync.syncFromWorld(world);
    expect(resolve).not.toHaveBeenCalled();
    expect(scale).not.toHaveBeenCalled();
    model.simpleColliders[0]!.position[0] = 5;
    sync.syncFromWorld(world);
    expect(trace(5)).toBe(false);
    sync.setModelContent({ models: { model } });
    sync.syncFromWorld(world);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(trace(5)).toBe(true);
    expect(trace(0)).toBe(false);
  } finally {
    sync.dispose();
  }
});

it("uses current parent physics poses during indexed child readback", () => {
  const { world, actor, sync } = fixture();
  const parent = world.createActor({
    classId: "Actor",
    guid: "parent",
    transform: identityTransform(),
  });
  parent.attachComponent(
    world.createComponent({
      classId: "RigidBodyComponent",
      variables: {
        motionType: "dynamic",
        mass: 1,
        gravityScale: 0,
        linearDamping: 0,
      },
    }),
  );
  world.spawnActorNow(parent);
  actor.setVariable("parentId", parent.guid);
  actor.transform.position.x = 2;
  try {
    sync.syncFromWorld(world);
    sync.addImpulse(parent.guid, { x: 6, y: 0, z: 0 });
    sync.step(1 / 60, world);
    expect(parent.transform.position.x).toBeCloseTo(0.1);
    expect(actor.transform.position.x).toBeCloseTo(1.9);
    const rigid = parent.components[0]!;
    rigid.variables.set("mass", 2);
    sync.syncFromWorld(world);
    sync.teleportActor(parent, world, { velocity: "reset" });
    sync.addImpulse(parent.guid, { x: 6, y: 0, z: 0 });
    sync.step(1 / 60, world);
    expect(parent.transform.position.x).toBeCloseTo(0.15);
  } finally {
    sync.dispose();
  }
});

it.each([
  { x: -1, y: 1, z: 1 },
  { x: 1, y: -1, z: 1 },
  { x: -2, y: 3, z: 1 },
  { x: 2, y: 3, z: 1 },
])(
  "keeps collision aligned with the published visual transform under parent scale %j",
  (parentScale) => {
    const mesh = createMeshComponent("offset-box", "box");
    mesh.transform!.position = [2, 0, 0];
    let childSlot: number | undefined;
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        ...createDefaultScene(),
        actors: [
          createActor("parent", "Parent", {
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [parentScale.x, parentScale.y, parentScale.z],
            },
          }),
          createActor("child", "Child", {
            parentId: "parent",
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
              scale: [1, 1, 1],
            },
            components: [mesh],
          }),
        ],
      },
      onCommand: (command) => {
        if (command.type === "spawn" && command.actorGuid === "child")
          childSlot = command.slotId;
      },
    });
    try {
      runtime.realizePlayWorld();
      runtime.start();
      const actor = runtime.getWorld().findActor("child")!;
      const backend = runtime.getPhysicsSync()!.getBackend();
      const snapshot = new Float32Array(
        snapshotFloatCount(runtime.snapshotCapacity),
      );
      for (let tick = 0; tick < 10; tick++) {
        runtime.tick();
        expect(runtime.copySnapshot(snapshot)).toBe(true);
        const slot = Array.from(
          { length: readSnapshotHeader(snapshot).actorCount },
          (_, index) => readActorSlot(snapshot, index),
        ).find((value) => value.slotId === childSlot)!;
        expect(slot).toBeDefined();
        const localX = physics.rotateQuatVec(actor.transform.rotation, {
          x: 1,
          y: 0,
          z: 0,
        });
        expect(localX.x).toBeCloseTo(0);
        expect(localX.y).toBeCloseTo(1);
        // The render mesh receives this actor snapshot TRS and its authored local
        // offset. Query that visual center, rather than a physics-only transform.
        const center = physics.rotateQuatVec(slot.rotation, {
          x: 2 * slot.scale.x,
          y: 0,
          z: 0,
        });
        const y = slot.position.y + center.y;
        expect(y).toBeCloseTo(2 * parentScale.x);
        console.info("alignment", tick, actor.guid, slot, backend.listDebugColliders());
        expect(
          backend.lineTrace({ x: -5, y, z: 0 }, { x: 5, y, z: 0 }).hit,
        ).toBe(true);
        expect(
          backend.lineTrace({ x: -5, y: -y, z: 0 }, { x: 5, y: -y, z: 0 }).hit,
        ).toBe(false);
      }
    } finally {
      runtime.stop();
    }
  },
);

it("rejects stale component and pre-sync successor commands before they mutate another incarnation", () => {
  const { world, actor, backend, sync } = fixture();
  try {
    sync.syncFromWorld(world);
    const update = vi.spyOn(backend, "updateBody");
    const move = vi.spyOn(backend, "moveCharacter");
    const teleport = vi.spyOn(backend, "teleportBody");
    const removed = actor.components[0]!;
    actor.components.splice(0, 1); // The owner reference may outlive membership.
    removed.setVariable("mass", 7);
    sync.applyComponent(removed);
    expect(update).not.toHaveBeenCalled();
    world.destroyActorInstance(actor);
    world.tick();
    const successor = world.createActor({
      classId: "Actor",
      guid: actor.guid,
      transform: identityTransform(),
    });
    const rigid = world.createComponent({
      classId: "RigidBodyComponent",
      variables: { motionType: "dynamic", mass: 3 },
    });
    successor.attachComponent(rigid);
    world.spawnActorNow(successor);
    sync.applyComponent(rigid);
    sync.moveCharacter(successor, { x: 3, y: 0, z: 0 }, 1 / 60);
    sync.teleportActor(actor, world);
    expect(update).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(teleport).not.toHaveBeenCalled();
    sync.syncFromWorld(world);
    rigid.setVariable("mass", 5);
    sync.applyComponent(rigid);
    expect(update).toHaveBeenLastCalledWith(
      `body:${successor.guid}`,
      expect.objectContaining({ mass: 5 }),
    );
  } finally {
    sync.dispose();
  }
});
