import { afterEach, describe, expect, it } from "vitest";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { createPhysicsBackend, createSoftwarePhysicsBackend, type PhysicsBackend } from "@babylonslate/physics";
import { MovementWorldSync } from "./movement";
import { PhysicsWorldSync } from "./physics-sync";

const dt = 1 / 60;
const KINDS = ["software3d", "havok", "software2d", "rapier"] as const;
type Kind = (typeof KINDS)[number];
const NATIVE = ["havok", "rapier"] as const;

async function backendFor(kind: Kind): Promise<PhysicsBackend> {
  const gravity = { x: 0, y: -9.81, z: 0 };
  if (kind === "software3d") return createSoftwarePhysicsBackend("3d", gravity);
  if (kind === "software2d") return createSoftwarePhysicsBackend("2d", gravity);
  return createPhysicsBackend({ kind: kind === "havok" ? "3d" : "2d", gravity, allowSoftwareFallback: false });
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** Movement and physics sharing one World, stepped as the runtime does: Movement is the step's `beforeStep` hook. */
async function scene(kind: Kind) {
  const is3d = kind === "software3d" || kind === "havok";
  const world = new World({ seed: 1, dt, classRegistry: new ClassRegistry(),
    componentHooksFor: () => ({ onCreation: (component) => movement.initialize(component) }),
  });
  const physics = new PhysicsWorldSync(await backendFor(kind));
  const events: string[] = [];
  let warnings = 0;
  const movement = new MovementWorldSync({ world, physics: () => physics, gravity: () => 9.81, eligible: () => true,
    event: (_component, name) => { events.push(name); }, warn: () => { warnings++; } });
  cleanups.push(() => { movement.dispose(); physics.dispose(); });
  const box = (x: number, y: number, z: number) => is3d ? { kind: "box", halfExtents: { x, y, z } } : { kind: "box2d", halfExtents: { x, y } };
  const spawn = (guid: string, position: { x: number; y: number; z?: number }, components: Array<[string, Record<string, unknown>]>): Actor => {
    const actor = world.createActor({ classId: "Actor", guid, transform: identityTransform() });
    Object.assign(actor.transform.position, { z: 0, ...position });
    for (const [classId, variables] of components) actor.attachComponent(world.createComponent({ classId, guid: `${guid}:${classId}`, variables }));
    world.spawnActorNow(actor);
    return actor;
  };
  const solid = (guid: string, position: { x: number; y: number }, half: { x: number; y: number }) =>
    spawn(guid, position, [["RigidBodyComponent", { motionType: "static" }], ["ColliderComponent", { shape: box(half.x, half.y, 50) }]]);
  solid("floor", { x: 0, y: -0.5 }, { x: 50, y: 0.5 });
  const hero = (guid: string, x: number, y: number, body: Record<string, unknown> | null, settings: Record<string, unknown> = {}, more: Array<[string, Record<string, unknown>]> = []) => {
    const actor = spawn(guid, { x, y }, [...(body ? [["RigidBodyComponent", body] as [string, Record<string, unknown>]] : []),
      ["MovementComponent", settings], ...more]);
    const motor = actor.components.find((component) => component.classId === "MovementComponent")!;
    const send = (name: string, args: Record<string, unknown> = {}) => movement.invoke(motor, name, args);
    const push = (x: number) => send("setMovementInput", { direction: { x, y: 0, z: 0 } });
    return { actor, motor, send, push, speed: () => motor.getVariable("speed") as number,
      grounded: () => motor.getVariable("isGrounded") as boolean };
  };
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) physics.step(dt, world, 0, 9.81, () => movement.step(dt, physics));
  };
  return { world, physics, movement, events, warnings: () => warnings, spawn, solid, hero, tick, is3d, backend: physics.getBackend() };
}

describe.each(KINDS)("Movement steering a dynamic Rigid Body on %s", (kind) => {
  it("falls under the Rigid Body's gravity onto the floor, runs to Max Speed, brakes and reports the landing", async () => {
    const { hero, tick, events } = await scene(kind);
    const walker = hero("hero", 0, 2, { motionType: "dynamic" });
    tick(90);
    expect(walker.actor.transform.position.y).toBeCloseTo(0.9, 1);
    expect(walker.grounded()).toBe(true);
    expect(events).toContain("onMovementLanded");

    walker.push(1);
    tick(60);
    expect(walker.speed()).toBeGreaterThan(4.8);
    expect(walker.speed()).toBeLessThanOrEqual(5.001);
    expect(walker.actor.transform.position.x).toBeGreaterThan(3);
    expect(walker.actor.transform.position.y).toBeCloseTo(0.9, 1);

    walker.push(0);
    tick(20);
    expect(walker.speed()).toBeLessThan(0.05);
  });

  it("jumps once from the ground, ignores a jump in the air, and lands again", async () => {
    const { hero, tick, events } = await scene(kind);
    const walker = hero("hero", 0, 0.95, { motionType: "dynamic" }, { jumpBufferTime: 0 });
    tick(30);
    expect(walker.grounded()).toBe(true);
    events.length = 0;
    walker.send("jumpMovement");
    tick();
    expect(walker.motor.getVariable("isInAir")).toBe(true);
    expect((walker.motor.getVariable("velocity") as { y: number }).y).toBeGreaterThan(5);
    walker.send("jumpMovement");
    tick(8);
    expect(walker.actor.transform.position.y).toBeGreaterThan(1.2);
    tick(100);
    expect(walker.actor.transform.position.y).toBeCloseTo(0.9, 1);
    expect(walker.grounded()).toBe(true);
    expect(events).toEqual(["onMovementJumped", "onMovementLeftGround", "onMovementLanded"]);
  });

  it("caps the fall at Max Fall Speed", async () => {
    const { hero, tick, backend } = await scene(kind);
    hero("hero", 0, 40, { motionType: "dynamic" }, { maxFallSpeed: 2 });
    tick(60);
    const fall = backend.getBodyVelocity("body:hero")!.linear.y;
    // The cap applies before each step, which then adds one step of gravity.
    expect(fall).toBeLessThan(-1.9);
    expect(fall).toBeGreaterThan(-2.2);
  });

  it("leaves gravity to the Rigid Body: its Gravity Scale applies and Movement's own does not", async () => {
    const { hero, tick } = await scene(kind);
    const falls = hero("falls", -5, 3, { motionType: "dynamic" }, { gravityScale: 0 });
    const floats = hero("floats", 5, 3, { motionType: "dynamic", gravityScale: 0 }, { gravityScale: 1 });
    tick(120);
    expect(falls.actor.transform.position.y).toBeCloseTo(0.9, 1);
    expect(floats.actor.transform.position.y).toBeCloseTo(3, 1);
  });

  it("is pushed by Add Impulse divided by the Rigid Body's mass, then brakes", async () => {
    const { hero, tick, physics, movement } = await scene(kind);
    const walker = hero("hero", 0, 0.95, { motionType: "dynamic", mass: 2 });
    tick(30);
    // Add Impulse reaches the body, not Movement's velocity, when Movement steers a dynamic body.
    expect(movement.addImpulse(walker.actor, { x: 10, y: 0, z: 0 })).toBe(false);
    physics.addImpulse("hero", { x: 10, y: 0, z: 0 });
    tick(2);
    expect(walker.speed()).toBeGreaterThan(4);
    tick(30);
    expect(walker.speed()).toBeLessThan(0.05);
    // v = 5 braking at 40: 5 * 5 / (2 * 40) = 0.31 m.
    expect(walker.actor.transform.position.x).toBeGreaterThan(0.2);
    expect(walker.actor.transform.position.x).toBeLessThan(0.5);
  });

  it("uses its own Collider instead of the capsule, and sizes the capsule from Radius and Height otherwise", async () => {
    const { hero, tick, is3d } = await scene(kind);
    const ball = hero("ball", -5, 3, { motionType: "dynamic" }, {}, [
      ["ColliderComponent", { shape: is3d ? { kind: "sphere", radius: 0.5 } : { kind: "circle", radius: 0.5 } }]]);
    const tall = hero("tall", 5, 4, { motionType: "dynamic" }, { height: 3 });
    tick(120);
    expect(ball.actor.transform.position.y).toBeCloseTo(0.5, 1);
    expect(tall.actor.transform.position.y).toBeCloseTo(1.5, 1);
  });
});

describe.each(["havok", "software3d"] as const)("Movement beside a Rigid Body that is not dynamic on %s", (kind) => {
  it("warns once and stays put beside a static Rigid Body", async () => {
    const { hero, tick, warnings } = await scene(kind);
    const walker = hero("hero", 0, 3, { motionType: "static" });
    walker.push(1);
    tick(30);
    expect(warnings()).toBe(1);
    expect(walker.actor.transform.position).toEqual({ x: 0, y: 3, z: 0 });
  });
});

describe.each(KINDS)("Movement moving a kinematic capsule on %s", (kind) => {
  it("keeps the character controller beside a kinematic Rigid Body: its own gravity lands it on the floor", async () => {
    const { hero, tick, warnings } = await scene(kind);
    const walker = hero("hero", 0, 2, { motionType: "kinematic" });
    tick(90);
    expect(warnings()).toBe(0);
    expect(walker.actor.transform.position.y).toBeCloseTo(0.9, 1);
    expect(walker.grounded()).toBe(true);
  });

  it("gains velocity from Add Impulse, scaled by the kinematic Rigid Body's mass, and is still stopped by a wall", async () => {
    const launch = async (body: Record<string, unknown> | null, wall: boolean) => {
      const { hero, tick, solid, movement } = await scene(kind);
      if (wall) solid("wall", { x: 1.5, y: 2 }, { x: 0.5, y: 2 });
      const walker = hero("hero", 0, 0.9, body);
      tick(30);
      expect(movement.addImpulse(walker.actor, { x: 10, y: 0, z: 0 })).toBe(true);
      tick(60);
      return walker.actor.transform.position.x;
    };
    // v = 10 braking at 40 carries 1.25 m; a mass of 4 leaves a quarter of the speed.
    expect(await launch(null, false)).toBeGreaterThan(1.1);
    expect(await launch({ motionType: "kinematic", mass: 4 }, false)).toBeLessThan(0.3);
    expect(await launch({ motionType: "kinematic", mass: 4 }, false)).toBeGreaterThan(0.03);
    // The wall face is at x = 1 and the capsule radius is 0.4.
    expect(await launch(null, true)).toBeLessThan(0.62);
  });

  it("lets a launch pad impulse leave the ground and fall back", async () => {
    const { hero, tick, movement, events } = await scene(kind);
    const walker = hero("hero", 0, 0.9, null);
    tick(30);
    events.length = 0;
    movement.addImpulse(walker.actor, { x: 0, y: 6, z: 0 });
    tick(10);
    expect(walker.actor.transform.position.y).toBeGreaterThan(1.3);
    expect(walker.grounded()).toBe(false);
    tick(100);
    expect(walker.grounded()).toBe(true);
    expect(events).toEqual(["onMovementLeftGround", "onMovementLanded"]);
  });
});

describe.each(NATIVE)("A Rigid Body steered by Movement on %s", (kind) => {
  it("stays upright when hit off-centre", async () => {
    const { hero, spawn, tick, is3d, backend } = await scene(kind);
    const walker = hero("hero", 0, 0.95, { motionType: "dynamic" });
    tick(30);
    spawn("anvil", { x: 0.3, y: 4 }, [["RigidBodyComponent", { motionType: "dynamic", mass: 5 }],
      ["ColliderComponent", { shape: is3d ? { kind: "box", halfExtents: { x: 0.4, y: 0.4, z: 0.4 } } : { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } } }]]);
    for (let i = 0; i < 60; i++) {
      tick();
      backend.addImpulseAtPoint("body:hero", { x: 2, y: 0, z: 0 }, { x: 0, y: 1.6, z: 0 });
    }
    const { x, y, z, w } = walker.actor.transform.rotation;
    expect([x, y, z]).toEqual([expect.closeTo(0, 5), expect.closeTo(0, 5), expect.closeTo(0, 5)]);
    expect(w).toBeCloseTo(1, 5);
  });

  it("frees the body to tumble once Movement is removed", async () => {
    const { hero, physics, world, backend, is3d } = await scene(kind);
    const walker = hero("hero", 0, 3, { motionType: "dynamic" }, {}, [
      ["ColliderComponent", { shape: is3d ? { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } : { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } } }]]);
    const spin = () => {
      backend.addImpulseAtPoint("body:hero", { x: 0, y: 1, z: 0 }, { x: 0.4, y: 3, z: 0 });
      backend.step(dt);
      return Math.abs(backend.getBodyVelocity("body:hero")!.angular.z);
    };
    physics.syncFromWorld(world);
    expect(spin()).toBe(0);
    walker.motor.destroyed = true;
    physics.syncFromWorld(world);
    expect(spin()).toBeGreaterThan(0.1);
  });
});

describe("Ground detection on Havok", () => {
  it.each([[30, true], [70, false]] as const)("treats a %s degree slope as ground only within Max Slope Angle", async (degrees, ground) => {
    const { hero, spawn, tick } = await scene("havok");
    const half = (degrees * Math.PI) / 360;
    // High above the floor, so the body never reaches flat ground.
    const slope = spawn("slope", { x: 20, y: 10 }, [["RigidBodyComponent", { motionType: "static" }],
      ["ColliderComponent", { shape: { kind: "box", halfExtents: { x: 8, y: 0.5, z: 8 } } }]]);
    Object.assign(slope.transform.rotation, { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) });
    const walker = hero("hero", 20, 11.5, { motionType: "dynamic" });
    tick(90);
    expect(walker.grounded()).toBe(ground);
  });
});
