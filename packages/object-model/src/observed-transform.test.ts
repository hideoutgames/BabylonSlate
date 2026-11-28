import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import { writeObservedPose, writeObservedPosition, writeObservedRotation, writeObservedScale } from "./observed-transform";
import { World, type WorldChangeObserver } from "./world";

function createTestWorld(): World {
  const registry = new ClassRegistry();
  registry.register({ id: "Actor", kind: "actor", parentClassId: null, variables: [], implementedInterfaces: [] });
  registry.register({ id: "RigidBodyComponent", kind: "component", parentClassId: null, variables: [], implementedInterfaces: [] });
  registry.register({ id: "ColliderComponent", kind: "component", parentClassId: null, variables: [], implementedInterfaces: [] });
  return new World({ seed: 1, dt: 1 / 60, classRegistry: registry });
}

describe("observed transforms and WorldChangeObserver", () => {
  it("preserves plain-object semantics across spread, keys, JSON, structuredClone, and toEqual", () => {
    const world = createTestWorld();
    const actor = world.createActor({
      classId: "Actor",
      guid: "a1",
      transform: {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
        scale: { x: 2, y: 2, z: 2 },
      },
    });

    expect(Object.getPrototypeOf(actor.transform)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(actor.transform.position)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(actor.transform.rotation)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(actor.transform.scale)).toBe(Object.prototype);

    expect(Object.keys(actor.transform)).toEqual(["position", "rotation", "scale"]);
    expect(Object.keys(actor.transform.position)).toEqual(["x", "y", "z"]);
    expect(Object.keys(actor.transform.rotation)).toEqual(["x", "y", "z", "w"]);
    expect(Object.keys(actor.transform.scale)).toEqual(["x", "y", "z"]);

    expect({ ...actor.transform.position }).toEqual({ x: 1, y: 2, z: 3 });
    expect(Object.assign({}, actor.transform.rotation)).toEqual({ x: 0, y: 0.5, z: 0, w: 0.866 });
    expect(JSON.parse(JSON.stringify(actor.transform))).toEqual({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
      scale: { x: 2, y: 2, z: 2 },
    });
    expect(structuredClone(actor.transform)).toEqual({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
      scale: { x: 2, y: 2, z: 2 },
    });
    expect(actor.transform).toEqual({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
      scale: { x: 2, y: 2, z: 2 },
    });
  });

  it("tracks transformRevision on coordinate writes, sub-object replacement, full replacement, and physics pose writes while ignoring no-op writes", () => {
    const world = createTestWorld();
    const events: Array<{ guid: string; source: string }> = [];
    world.addChangeObserver({
      onActorTransformChanged: (actor, source) => events.push({ guid: actor.guid, source }),
    });

    const actor = world.spawnActorNow(world.createActor({ classId: "Actor", guid: "mover" }));
    expect(actor.transformRevision).toBe(0);

    // No-op coordinate write does not bump revision or notify.
    actor.transform.position.x = 0;
    expect(actor.transformRevision).toBe(0);
    expect(events).toEqual([]);

    // Coordinate write bumps revision and emits "script".
    actor.transform.position.x = 4;
    expect(actor.transformRevision).toBe(1);
    expect(events).toEqual([{ guid: "mover", source: "script" }]);

    // Sub-object replacement keeps the observed wrapper alive for subsequent coordinate writes.
    actor.transform.position = { x: 4, y: 0, z: 0 };
    expect(actor.transformRevision).toBe(1); // same values: no-op
    actor.transform.position = { x: 5, y: 1, z: 2 };
    expect(actor.transformRevision).toBe(2);
    actor.transform.position.y = 9;
    expect(actor.transformRevision).toBe(3);

    // Full transform replacement emits once and preserves observation.
    actor.transform = {
      position: { x: 5, y: 9, z: 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    };
    expect(actor.transformRevision).toBe(3); // unchanged
    actor.transform = {
      position: { x: 10, y: 20, z: 30 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 2, y: 2, z: 2 },
    };
    expect(actor.transformRevision).toBe(4);
    actor.transform.scale.z = 3;
    expect(actor.transformRevision).toBe(5);

    // Physics pose write emits "physics" and bumps revision only when changed.
    expect(actor.writeTransformPoseFromPhysics({ x: 10, y: 20, z: 30 }, { x: 0, y: 0, z: 0, w: 1 })).toBe(false);
    expect(actor.transformRevision).toBe(5);
    expect(actor.writeTransformPoseFromPhysics({ x: 11, y: 20, z: 30 }, { x: 0, y: 0, z: 0, w: 1 })).toBe(true);
    expect(actor.transformRevision).toBe(6);
    expect(events.at(-1)).toEqual({ guid: "mover", source: "physics" });
  });

  it("maintains the childrenByParentGuid index across out-of-order spawn, reparenting, and destruction", () => {
    const world = createTestWorld();
    const child = world.spawnActorNow(world.createActor({
      classId: "Actor",
      guid: "child",
      variables: { parentId: "parent-a" },
    }));
    // Indexed even before parent-a spawns.
    expect(world.getChildren("parent-a")?.has(child)).toBe(true);

    const parentA = world.spawnActorNow(world.createActor({ classId: "Actor", guid: "parent-a" }));
    const parentB = world.spawnActorNow(world.createActor({ classId: "Actor", guid: "parent-b" }));
    expect(world.getChildren(parentA.guid)?.has(child)).toBe(true);

    child.setVariable("parentId", parentB.guid);
    expect(world.getChildren(parentA.guid)).toBeUndefined();
    expect(world.getChildren(parentB.guid)?.has(child)).toBe(true);

    // Destroying parentB leaves child registered under parentB's guid so observers can dirty orphaned children.
    world.destroyActor(parentB.guid);
    world.flushPending();
    expect(world.getChildren(parentB.guid)?.has(child)).toBe(true);

    // Destroying child removes it cleanly.
    world.destroyActor(child.guid);
    world.flushPending();
    expect(world.getChildren(parentB.guid)).toBeUndefined();
  });

  it("delivers all observer events and stops after unsubscribe", () => {
    const world = createTestWorld();
    const log: string[] = [];
    const observer: WorldChangeObserver = {
      onActorSpawned: (a) => log.push(`spawn:${a.guid}`),
      onActorDestroyed: (a) => log.push(`destroy:${a.guid}`),
      onActorParentChanged: (a, prev, next) => log.push(`parent:${a.guid}:${prev}->${next}`),
      onActorTransformChanged: (a, src) => log.push(`transform:${a.guid}:${src}`),
      onActorVariableChanged: (a, name) => log.push(`var:${a.guid}:${name}`),
      onActorComponentChanged: (a, c, kind) => log.push(`comp:${a.guid}:${c.classId}:${kind}`),
      onActorLayerChanged: (a, prev, next) => log.push(`layer:${a.guid}:${prev}->${next}`),
    };
    const unsubscribe = world.addChangeObserver(observer);

    const actor = world.spawnActorNow(world.createActor({ classId: "Actor", guid: "a" }));
    actor.setVariable("parentId", "p");
    actor.setVariable("visible", false);
    actor.generateHitEvents = false;
    actor.generateOverlapEvents = false;
    actor.sceneLayerId = "layer-1";
    const collider = world.createComponent({ classId: "ColliderComponent" });
    actor.attachComponent(collider);
    collider.setVariable("isTrigger", true);
    collider.transform.position.x = 2;
    collider.assetGuid = "asset-1";
    collider.parentId = "comp-parent";
    collider.destroyed = true;

    expect(log).toEqual([
      "spawn:a",
      "var:a:parentId",
      "parent:a:null->p",
      "var:a:visible",
      "var:a:generateHitEvents",
      "var:a:generateOverlapEvents",
      "layer:a:null->layer-1",
      "comp:a:ColliderComponent:attached",
      "comp:a:ColliderComponent:variable",
      "comp:a:ColliderComponent:transform",
      "comp:a:ColliderComponent:meta",
      "comp:a:ColliderComponent:meta",
      "comp:a:ColliderComponent:destroyed",
    ]);

    log.length = 0;
    unsubscribe();
    actor.transform.position.x = 99;
    world.destroyActor(actor.guid);
    world.flushPending();
    expect(log).toEqual([]);
  });

  it("emits at most one transform notification for batch position, rotation, scale and pose writers", () => {
    const world = createTestWorld();
    let notifications = 0;
    world.addChangeObserver({ onActorTransformChanged: () => { notifications++; } });
    const actor = world.spawnActorNow(world.createActor({ classId: "Actor", guid: "batch" }));

    expect(writeObservedPosition(actor.transform, 1, 2, 3)).toBe(true);
    expect(writeObservedPosition(actor.transform, 1, 2, 3)).toBe(false);
    expect(notifications).toBe(1);

    expect(writeObservedRotation(actor.transform, 0, 0.5, 0, 0.866)).toBe(true);
    expect(writeObservedRotation(actor.transform, 0, 0.5, 0, 0.866)).toBe(false);
    expect(notifications).toBe(2);

    expect(writeObservedScale(actor.transform, 2, 3, 4)).toBe(true);
    expect(writeObservedScale(actor.transform, 2, 3, 4)).toBe(false);
    expect(notifications).toBe(3);

    expect(writeObservedPose(actor.transform, { x: 4, y: 5, z: 6 }, { x: 0, y: 0, z: 0, w: 1 })).toBe(true);
    expect(writeObservedPose(actor.transform, { x: 4, y: 5, z: 6 }, { x: 0, y: 0, z: 0, w: 1 })).toBe(false);
    expect(notifications).toBe(4);
    expect(actor.transform).toEqual({
      position: { x: 4, y: 5, z: 6 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 2, y: 3, z: 4 },
    });
  });

  it("filters actor variable notifications for keyed observers while delivering all writes to wildcard observers", () => {
    const world = createTestWorld();
    const keyedLog: Array<string | null> = [];
    const wildcardLog: Array<string | null> = [];
    const unsubKeyed = world.addChangeObserver({
      variableKeys: new Set(["visible"]),
      onActorVariableChanged: (_actor, name) => keyedLog.push(name),
    });
    const unsubWildcard = world.addChangeObserver({
      onActorVariableChanged: (_actor, name) => wildcardLog.push(name),
    });

    const actor = world.spawnActorNow(world.createActor({ classId: "Actor", guid: "v1" }));
    actor.setVariable("health", 100);
    actor.setVariable("health", 100); // unchanged primitive: no notification
    actor.setVariable("health", 80);
    actor.setVariable("visible", false);
    actor.setVariable("name", "Hero");
    actor.variables.clear();

    expect(keyedLog).toEqual(["visible", null]);
    expect(wildcardLog).toEqual(["health", "health", "visible", "name", null]);

    keyedLog.length = 0;
    wildcardLog.length = 0;
    unsubKeyed();
    unsubWildcard();
    actor.setVariable("visible", true);
    actor.setVariable("health", 50);
    expect(keyedLog).toEqual([]);
    expect(wildcardLog).toEqual([]);
  });
});
