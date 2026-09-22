import { afterEach, describe, expect, it, vi } from "vitest";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ classId: "Actor", guid: "compound", transform: identityTransform() });
  actor.attachComponent(world.createComponent({
    classId: "RigidBodyComponent", guid: "body-component",
    variables: { motionType: "dynamic", mass: 1, gravityScale: 0, linearDamping: 0, angularDamping: 0 },
  }));
  world.spawnActorNow(actor);
  const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
  const sync = new PhysicsWorldSync(backend);
  return { world, actor, backend, sync };
}

function collider(world: World, actor: Actor, guid: string, x: number) {
  const component = world.createComponent({
    classId: "ColliderComponent", guid,
    transform: { ...identityTransform(), position: { x, y: 0, z: 0 } },
    variables: { shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } },
  });
  actor.attachComponent(component);
  return component;
}

describe("atomic runtime collider publication", () => {
  it("coalesces ordinary and mesh edits, retries a failed batch, and removes only current membership", () => {
    const { world, actor, backend, sync } = fixture();
    const first = collider(world, actor, "first", -4);
    const middle = collider(world, actor, "middle", 0);
    const mesh = world.createComponent({
      classId: "MeshComponent", guid: "mesh",
      transform: { ...identityTransform(), position: { x: 4, y: 0, z: 0 } },
      variables: { meshKind: "box", collisionMode: "simple" },
    });
    actor.attachComponent(mesh);
    const commit = vi.spyOn(backend, "applyColliderChanges");
    try {
      sync.syncFromWorld(world);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0]![1].upsert).toHaveLength(3);
      expect(backend.listDebugColliders()).toHaveLength(3);
      commit.mockClear();
      sync.syncFromWorld(world);
      expect(commit).not.toHaveBeenCalled();

      first.transform.position.x = -8;
      middle.destroyed = true;
      mesh.transform.position.x = 8;
      commit.mockImplementationOnce(() => { throw new Error("injected attachment failure"); });
      expect(() => sync.syncFromWorld(world)).toThrow("injected attachment failure");
      expect(backend.sphereOverlap({ x: -4, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);
      expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);
      expect(backend.sphereOverlap({ x: 4, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);
      expect(backend.sphereOverlap({ x: 8, y: 0, z: 0 }, 0.1).actorIds).toEqual([]);

      commit.mockClear();
      sync.syncFromWorld(world);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0]![1].upsert).toHaveLength(2);
      expect(commit.mock.calls[0]![1].remove).toHaveLength(1);
      expect(backend.listDebugColliders()).toHaveLength(2);
      expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.1).actorIds).toEqual([]);
      expect(backend.sphereOverlap({ x: -8, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);
      expect(backend.sphereOverlap({ x: 8, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);

      first.destroyed = true;
      mesh.setVariable("collisionMode", "none");
      sync.syncFromWorld(world);
      expect(backend.listDebugColliders()).toHaveLength(0);
      expect(backend.getBodyTransform("body:compound")).not.toBeNull();
      first.destroyed = false;
      sync.syncFromWorld(world);
      expect(backend.listDebugColliders()).toHaveLength(1);
      expect(backend.sphereOverlap({ x: -8, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);
    } finally { sync.dispose(); }
  });

  it("retires old source collider IDs when installing a changed model generation", () => {
    const { world, actor, backend, sync } = fixture();
    actor.attachComponent(world.createComponent({
      classId: "MeshComponent", guid: "model-component",
      variables: { assetGuid: "model", collisionMode: "simple" },
    }));
    const install = (id: string, x: number) => sync.setModelContent({ models: {
      model: { materialSlots: [], clipNames: [], skeletonGuid: null, importScale: 1, simpleColliders: [{
        id, name: id, kind: "box", position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
      }] },
    } });
    try {
      install("old", -3);
      sync.syncFromWorld(world);
      install("new", 3);
      sync.syncFromWorld(world);
      expect(backend.listDebugColliders()).toHaveLength(1);
      expect(backend.sphereOverlap({ x: -3, y: 0, z: 0 }, 0.1).actorIds).toEqual([]);
      expect(backend.sphereOverlap({ x: 3, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);
    } finally { sync.dispose(); }
  });

  it("disposes a provisional body after initial collider preparation fails and can retry", () => {
    const { world, actor, backend, sync } = fixture();
    collider(world, actor, "collider", 0);
    vi.spyOn(backend, "applyColliderChanges").mockImplementationOnce(() => { throw new Error("cannot prepare"); });
    try {
      expect(() => sync.syncFromWorld(world)).toThrow("cannot prepare");
      expect(backend.getBodyTransform("body:compound")).toBeNull();
      sync.syncFromWorld(world);
      expect(backend.listDebugColliders()).toHaveLength(1);
      expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.1).actorIds).toEqual([actor.guid]);
    } finally { sync.dispose(); }
  });

  it("uses kinematic targets without teleporting solver writeback and makes explicit world-pose teleports immediate", () => {
    const { world, actor, backend, sync } = fixture();
    collider(world, actor, "collider", 0);
    const parent = world.createActor({ classId: "Actor", guid: "parent", transform: {
      ...identityTransform(), position: { x: 10, y: 0, z: 0 },
    } });
    world.spawnActorNow(parent);
    actor.setVariable("parentId", parent.guid);
    const teleport = vi.spyOn(backend, "teleportBody");
    const target = vi.spyOn(backend, "setBodyTargetTransform");
    try {
      sync.syncFromWorld(world);
      sync.addImpulse(actor.guid, { x: 6, y: 0, z: 0 });
      sync.step(1 / 60, world);
      expect(teleport).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
      actor.transform.position.x = 4;
      parent.transform.position.x = 20;
      sync.teleportActor(actor, world);
      expect(backend.lineTrace({ x: 24, y: 2, z: 0 }, { x: 24, y: -2, z: 0 }).actorId).toBe(actor.guid);
      sync.step(1 / 60, world);
      expect(actor.transform.position.x).toBeCloseTo(4.1);
      sync.teleportActor(actor, world, { velocity: "reset" });
      const stoppedX = actor.transform.position.x;
      sync.step(1 / 60, world);
      expect(actor.transform.position.x).toBeCloseTo(stoppedX);

      const rigid = actor.components.find((component) => component.classId === "RigidBodyComponent")!;
      rigid.setVariable("motionType", "kinematic");
      sync.applyComponent(rigid);
      teleport.mockClear();
      actor.transform.position.x = 6;
      sync.step(1 / 60, world);
      expect(target).toHaveBeenCalledTimes(1);
      expect(teleport).not.toHaveBeenCalled();
      expect(actor.transform.position.x).toBeCloseTo(6);
    } finally { sync.dispose(); }
  });
});
