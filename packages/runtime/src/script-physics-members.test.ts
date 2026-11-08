import { describe, expect, it } from "vitest";
import { identityTransform } from "@haptic/core";
import { ClassRegistry, World, type Actor } from "@haptic/object-model";
import { createPhysicsBackend, createSoftwarePhysicsBackend, type PhysicsBackend } from "@haptic/physics";
import { PhysicsWorldSync } from "./physics-sync";
import { createPhysicsHostBindings } from "./runtime-host-physics";
import { ScriptHost } from "./script-host";
import { torqueCouple } from "./script-physics-members";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const at = (x: number, y = 0) => ({ position: { x, y, z: 0 }, rotation: IDENTITY });
const box = (half: number) => ({ kind: "box", halfExtents: { x: half, y: half, z: half } });

async function backendFor(kind: "software" | "rapier" | "havok", gravity = 0): Promise<PhysicsBackend> {
  const dimension = kind === "rapier" ? "2d" : "3d";
  return kind === "software" ? createSoftwarePhysicsBackend(dimension, { x: 0, y: -gravity, z: 0 })
    : createPhysicsBackend({ kind: dimension, gravity: { x: 0, y: -gravity, z: 0 } });
}

/** A script context whose physics services are the runtime's real bindings over one world. */
function physicsContext(world: World, sync: PhysicsWorldSync) {
  const bindings = createPhysicsHostBindings({
    world: () => world,
    physics: () => sync,
    layerPhysics: () => null,
    physicsFor: () => sync,
    ragdolls: { addImpulse: () => false, retireActor: () => {} },
    movement: { addImpulse: () => false },
    waterTime: () => 0,
    projectCursorToScene: () => { throw new Error("unused"); },
    projectTouchToScene: () => { throw new Error("unused"); },
  });
  return new ScriptHost({
    log: () => {}, print: () => {}, destroyActor: () => {}, reportError: () => {}, delay: async () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    findActor: (id) => world.findActor(id),
    refreshComponent: (component) => sync.applyComponent(component),
    ...bindings,
  }).createContext(null, 0, 0);
}

function spawnBody(world: World, guid: string, x: number, motionType: string, shape: unknown = box(0.5)): Actor {
  const actor = world.createActor({ classId: "Actor", guid, transform: { ...identityTransform(), position: { x, y: 0, z: 0 } } });
  actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType, gravityScale: 0, mass: 1, linearDamping: 0, angularDamping: 0 } }));
  actor.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape } }));
  world.spawnActorNow(actor);
  return actor;
}

describe("script physics members", () => {
  it.each(["software", "rapier", "havok"] as const)("%s: multi traces, box and capsule queries and switched-off collision", async (kind) => {
    const sync = new PhysicsWorldSync(await backendFor(kind));
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    try {
      const near = spawnBody(world, "near", 2, "static");
      spawnBody(world, "middle", 4, "dynamic");
      spawnBody(world, "far", 6, "static");
      sync.syncFromWorld(world);
      const ctx = physicsContext(world, sync);
      const guids = (hits: { Actor: Actor | null }[]) => hits.map((hit) => hit.Actor?.guid);

      // Nearest first, one hit per actor, each Distance to that actor's face.
      const line = ctx.multiTrace(null, at(0), at(10));
      expect(guids(line)).toEqual(["near", "middle", "far"]);
      expect(line.map((hit) => hit.Distance)).toEqual([expect.closeTo(1.5, 3), expect.closeTo(3.5, 3), expect.closeTo(5.5, 3)]);
      expect(line.every((hit) => hit.Hit)).toBe(true);
      const sphere = { kind: "sphere" as const, radius: 0.25 };
      expect(guids(ctx.multiTrace(sphere, at(0), at(10)))).toEqual(["near", "middle", "far"]);
      expect(guids(ctx.multiTrace(sphere, at(0), at(10), "Static", [near]))).toEqual(["far"]);
      expect(ctx.multiTrace(null, at(0, 3), at(10, 3))).toEqual([]);

      const quarter = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
      expect(ctx.shapeSweep({ kind: "box", halfExtents: { x: 0.2, y: 0.2, z: 0.2 } }, at(0), at(10)).distance).toBeCloseTo(1.3, 3);
      expect(ctx.shapeSweep({ kind: "box", halfExtents: { x: 0.2, y: 0.2, z: 0.2 } }, at(0), at(10), "All", [near]).actor?.guid).toBe("middle");
      // A capsule lying along X (its Up axis turned a quarter about Z) reaches 0.8 ahead of its center.
      expect(ctx.shapeSweep({ kind: "capsule", radius: 0.2, halfHeight: 0.6 }, { ...at(0), rotation: quarter },
        { ...at(10), rotation: quarter }).distance).toBeCloseTo(0.7, 2);
      expect(ctx.shapeOverlap({ kind: "box", halfExtents: { x: 1.5, y: 0.25, z: 0.25 } }, at(3)).map((actor) => actor.guid).sort())
        .toEqual(["middle", "near"]);
      expect(ctx.shapeOverlap({ kind: "capsule", radius: 0.3, halfHeight: 0.5 }, at(6)).map((actor) => actor.guid)).toEqual(["far"]);
      expect(ctx.shapeOverlap({ kind: "capsule", radius: 0.3, halfHeight: 0.5 }, at(6, 3))).toEqual([]);

      // Switched off, the near box blocks and overlaps nothing and every channel's queries pass it.
      const published = () => [...sync.publishedColliders(near)!.values()].map(({ mask, overlapMask }) => ({ mask, overlapMask }));
      const authored = published();
      expect(authored.every(({ mask }) => mask !== 0)).toBe(true);
      ctx.setActorCollisionEnabled(near, false);
      expect(ctx.isActorCollisionEnabled(near)).toBe(false);
      expect(published()).toEqual(authored.map(() => ({ mask: 0, overlapMask: 0 })));
      expect(guids(ctx.multiTrace(null, at(0), at(10)))).toEqual(["middle", "far"]);
      expect(guids(ctx.multiTrace(null, at(0), at(10), "Static"))).toEqual(["far"]);
      expect(ctx.lineTrace(at(0).position, at(10).position, "Solid", { drawDebug: false }).actor?.guid).toBe("middle");
      expect(ctx.sphereOverlap({ x: 2, y: 0, z: 0 }, 0.5).actors).toEqual([]);
      ctx.setActorCollisionEnabled(near, true);
      expect(ctx.isActorCollisionEnabled(near)).toBe(true);
      expect(published()).toEqual(authored);
      expect(guids(ctx.multiTrace(null, at(0), at(10), "Static"))).toEqual(["near", "far"]);
    } finally {
      sync.dispose();
    }
  });

  it("reads and writes Rigid Body velocity in degrees, adds force and torque, and sets Motion Type", async () => {
    const backend = await backendFor("havok");
    const sync = new PhysicsWorldSync(backend);
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    try {
      const ball = spawnBody(world, "ball", 0, "dynamic", { kind: "sphere", radius: 0.5 });
      sync.syncFromWorld(world);
      const ctx = physicsContext(world, sync);

      ctx.setPhysicsVelocity(ball, false, { x: 1, y: 2, z: 3 }, false);
      ctx.setPhysicsVelocity(ball, false, { x: 1, y: 0, z: 0 }, true);
      expect(ctx.physicsVelocity(ball, false)).toEqual({ x: expect.closeTo(2, 4), y: expect.closeTo(2, 4), z: expect.closeTo(3, 4) });
      ctx.setPhysicsVelocity(ball, true, { x: 0, y: 90, z: 0 }, false);
      expect(backend.getBodyVelocity("body:ball")!.angular.y).toBeCloseTo(Math.PI / 2, 4);
      expect(ctx.physicsVelocity(ball, true).y).toBeCloseTo(90, 3);

      // Force × Delta Seconds is the impulse; mass 1 turns it into the same change of velocity.
      ctx.setPhysicsVelocity(ball, false, { x: 0, y: 0, z: 0 }, false);
      ctx.setPhysicsVelocity(ball, true, { x: 0, y: 0, z: 0 }, false);
      ctx.addForce(ball, { x: 0, y: 0, z: 60 }, 0.5);
      expect(ctx.physicsVelocity(ball, false).z).toBeCloseTo(30, 3);
      // No time passed, no push.
      ctx.addForce(ball, { x: 0, y: 0, z: 60 }, 0);
      expect(ctx.physicsVelocity(ball, false).z).toBeCloseTo(30, 3);

      // Torque spins the ball about the torque's axis without moving it.
      ctx.setPhysicsVelocity(ball, false, { x: 0, y: 0, z: 0 }, false);
      ctx.addTorque(ball, { x: 0, y: 2, z: 0 }, 0.5);
      const spin = ctx.physicsVelocity(ball, true);
      expect(spin.y).toBeGreaterThan(1);
      expect(Math.abs(spin.x) + Math.abs(spin.z)).toBeLessThan(1e-6 + Math.abs(spin.y) * 1e-6);
      expect(ctx.physicsVelocity(ball, false)).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(0, 6), z: expect.closeTo(0, 6) });

      // Set Motion Type writes the Rigid Body and the body follows: Static now answers the Static channel.
      expect(ctx.lineTrace({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, "Static", { drawDebug: false }).hit).toBe(false);
      ctx.setMotionType(ball, "Static");
      expect(ball.components.find((component) => component.classId === "RigidBodyComponent")!.getVariable("motionType")).toBe("static");
      expect(ctx.lineTrace({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, "Static", { drawDebug: false }).actor?.guid).toBe("ball");
      ctx.setMotionType(ball, "Floating");
      expect(ball.components.find((component) => component.classId === "RigidBodyComponent")!.getVariable("motionType")).toBe("static");
    } finally {
      sync.dispose();
    }
  });

  it("builds a torque couple with no net impulse and the requested angular impulse", () => {
    for (const angular of [{ x: 0, y: 0, z: 3 }, { x: 1, y: -2, z: 0.5 }, { x: 0, y: 4, z: 0 }]) {
      const center = { x: 2, y: -1, z: 5 };
      const couple = torqueCouple(angular, center)!;
      const arm = (point: typeof center) => ({ x: point.x - center.x, y: point.y - center.y, z: point.z - center.z });
      const cross = (a: typeof center, b: typeof center) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
      const a = cross(arm(couple.at), couple.impulse);
      const b = cross(arm(couple.opposite), { x: -couple.impulse.x, y: -couple.impulse.y, z: -couple.impulse.z });
      expect({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }).toEqual({
        x: expect.closeTo(angular.x, 9), y: expect.closeTo(angular.y, 9), z: expect.closeTo(angular.z, 9),
      });
    }
    // A planar torque keeps both points in the plane.
    const planar = torqueCouple({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 })!;
    expect([planar.at.z, planar.opposite.z, planar.impulse.z].map(Math.abs)).toEqual([0, 0, 0]);
    expect(torqueCouple({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
