import { describe, expect, it } from "vitest";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { HavokPhysicsBackend, createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

function worldFixture() {
  return new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
}

function body(world: World, id: string, x: number, dynamic = false): Actor {
  const actor = world.createActor({ classId: "Actor", guid: id, transform: identityTransform() });
  actor.transform.position.x = x;
  actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: {
    motionType: dynamic ? "dynamic" : "static", mass: dynamic ? 1 : 0,
    linearDamping: 0, angularDamping: 0, gravityScale: 1,
  } }));
  actor.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: {
    shape: { kind: "sphere", radius: 0.1 },
  } }));
  world.spawnActorNow(actor);
  return actor;
}

function constrain(world: World, actor: Actor, target: string, variables: Record<string, unknown> = {}) {
  const component = world.createComponent({ classId: "PhysicsConstraintComponent", guid: "shared-joint", variables: {
    kind: "fixed", targetActorId: target, ...variables,
  } });
  actor.attachComponent(component);
  return component;
}

function advance(sync: PhysicsWorldSync, world: World, ticks = 60): void {
  for (let tick = 0; tick < ticks; tick++) sync.step(1 / 60, world);
}

describe("authored physics constraints", () => {
  it("connects late targets and same-ID replacements without leaking joints across duplicate component IDs", async () => {
    const world = worldFixture();
    const first = body(world, "first", 0, true);
    const firstJoint = constrain(world, first, "first-anchor");
    const second = body(world, "second", 8, true);
    constrain(world, second, "second-anchor");
    body(world, "second-anchor", 8);
    const sync = new PhysicsWorldSync(await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } }));
    try {
      sync.syncFromWorld(world);
      sync.addImpulse(first.guid, { x: 2, y: 0, z: 0 });
      advance(sync, world, 30);
      expect(first.transform.position.x).toBeGreaterThan(0.5);
      const anchor = body(world, "first-anchor", 0);
      advance(sync, world);
      expect(first.transform.position.x).toBeCloseTo(0, 2);
      expect(second.transform.position.x).toBeCloseTo(8, 2);

      world.destroyActorInstance(anchor);
      world.tick();
      sync.syncFromWorld(world);
      sync.addImpulse(first.guid, { x: 2, y: 0, z: 0 });
      advance(sync, world, 30);
      expect(first.transform.position.x).toBeGreaterThan(0.5);
      body(world, "first-anchor", 4);
      advance(sync, world);
      expect(first.transform.position.x).toBeCloseTo(4, 2);

      first.components.splice(first.components.indexOf(firstJoint), 1);
      // Removed membership is authoritative even if an old owner pointer remains.
      sync.syncFromWorld(world);
      sync.addImpulse(first.guid, { x: 2, y: 0, z: 0 });
      advance(sync, world, 30);
      expect(first.transform.position.x).toBeGreaterThan(4.5);
      expect(second.transform.position.x).toBeCloseTo(8, 2);
    } finally { sync.dispose(); }
  });

  it("scales authored anchors and immediately releases disabled constraints", async () => {
    const world = worldFixture();
    const bob = body(world, "bob", 0, true);
    bob.transform.position.y = 2;
    bob.transform.scale.y = 2;
    const joint = constrain(world, bob, "anchor", { anchorA: { x: 0, y: 1, z: 0 } });
    const anchor = body(world, "anchor", 0);
    anchor.transform.position.y = 4;
    const sync = new PhysicsWorldSync(await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } }));
    try {
      advance(sync, world);
      expect(bob.transform.position.y).toBeCloseTo(2, 2);
      joint.setVariable("enabled", false);
      sync.applyComponent(joint);
      advance(sync, world, 30);
      expect(bob.transform.position.y).toBeLessThan(1);
      joint.setVariable("enabled", true);
      sync.applyComponent(joint);
      advance(sync, world);
      expect(bob.transform.position.y).toBeCloseTo(2, 2);
    } finally { sync.dispose(); }
  });

  it("preserves a usable joint after an invalid edit and reports its authored owner", async () => {
    const world = worldFixture();
    const actor = body(world, "joint-owner", 0, true);
    const component = constrain(world, actor, "anchor");
    body(world, "anchor", 0);
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    const sync = new PhysicsWorldSync(backend);
    try {
      sync.syncFromWorld(world);
      component.setVariable("kind", "hinge");
      component.setVariable("axisA", { x: 0, y: 0, z: 0 });
      expect(() => sync.applyComponent(component)).toThrow(/shared-joint on actor joint-owner/);
      for (let tick = 0; tick < 60; tick++) backend.step(1 / 60);
      expect(backend.getBodyTransform("body:joint-owner")!.position.y).toBeCloseTo(0, 2);
      component.setVariable("axisA", { x: Number.NaN, y: 0, z: 0 });
      component.setVariable("enabled", false);
      expect(() => sync.applyComponent(component)).not.toThrow();
      for (let tick = 0; tick < 30; tick++) backend.step(1 / 60);
      expect(backend.getBodyTransform("body:joint-owner")!.position.y).toBeLessThan(-0.5);
      component.setVariable("kind", "fixed");
      component.setVariable("axisA", { x: 0, y: 1, z: 0 });
      component.setVariable("enabled", true);
      expect(() => sync.syncFromWorld(world)).not.toThrow();
    } finally { sync.dispose(); }
  });

  it("defers temporary boot software but rejects configured constraints in explicit software sessions", () => {
    const world = worldFixture();
    const owner = body(world, "owner", 0, true);
    constrain(world, owner, "anchor");
    body(world, "anchor", 0);
    const deferred = new PhysicsWorldSync(createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 }), { deferUnsupportedConstraints: true });
    const explicit = new PhysicsWorldSync(createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 }));
    try {
      expect(() => deferred.syncFromWorld(world)).not.toThrow();
      expect(() => explicit.syncFromWorld(world)).toThrow(/native physics backend/);
    } finally { deferred.dispose(); explicit.dispose(); }
  });
});
