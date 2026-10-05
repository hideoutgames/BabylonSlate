import { afterEach, describe, expect, it, vi } from "vitest";
import { identityTransform, type Transform } from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  type PhysicsBackend,
} from "@babylonslate/physics";
import { componentIdFromColliderPhysicsId } from "./physics-collider-id";
import { PhysicsWorldSync } from "./physics-sync";

afterEach(() => vi.restoreAllMocks());

type Components = Array<[string, Record<string, unknown>]>;

function createWorld() {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const spawn = (
    guid: string,
    transform: Partial<Transform>,
    components: Components = [],
    parentId?: string,
  ) => {
    const actor = world.createActor({
      classId: "Actor",
      guid,
      transform: { ...identityTransform(), ...transform },
      variables: parentId ? { parentId } : {},
    });
    for (const [classId, variables] of components)
      actor.attachComponent(world.createComponent({ classId, variables }));
    world.spawnActorNow(actor);
    return actor;
  };
  return { world, spawn };
}

const staticBody: Components[number] = [
  "RigidBodyComponent",
  { motionType: "static", mass: 0, gravityScale: 0 },
];
const coastingBody: Components[number] = [
  "RigidBodyComponent",
  { motionType: "dynamic", mass: 1, gravityScale: 0, linearDamping: 0, angularDamping: 0 },
];
const fallingBody: Components[number] = [
  "RigidBodyComponent",
  { motionType: "dynamic", mass: 1, gravityScale: 1, linearDamping: 0, angularDamping: 0 },
];
const kinematicBody: Components[number] = [
  "RigidBodyComponent",
  { motionType: "kinematic", mass: 1, gravityScale: 0 },
];
const box = (kind: "2d" | "3d", x: number, y = x, z = x, isTrigger = false): Components[number] => [
  "ColliderComponent",
  {
    ...(isTrigger ? { isTrigger } : {}),
    shape: kind === "3d"
      ? { kind: "box", halfExtents: { x, y, z } }
      : { kind: "box2d", halfExtents: { x, y } },
  },
];
const trigger = (kind: "2d" | "3d", x: number) => box(kind, x, x, x, true);
const everyBackend = [
  { backend: "software", kind: "3d" as const },
  { backend: "Rapier", kind: "2d" as const },
  { backend: "Havok", kind: "3d" as const },
];
const nativeBackend = (kind: "2d" | "3d", gravity = 0) =>
  createPhysicsBackend({ kind, gravity: { x: 0, y: gravity, z: 0 }, allowSoftwareFallback: false });
const backendFor = (name: string, kind: "2d" | "3d", gravity: number): Promise<PhysicsBackend> | PhysicsBackend =>
  name === "software"
    ? createSoftwarePhysicsBackend(kind, { x: 0, y: gravity, z: 0 })
    : nativeBackend(kind, gravity);
const colliderGuid = (actor: Actor) =>
  actor.components.find((component) => component.classId === "ColliderComponent")!.guid;

describe("collidable static descendants of simulated bodies", () => {
  it.each(["software", "Havok"])("%s rests a dynamic parent on its overlapping mesh child without climbing", async (name) => {
    const { world, spawn } = createWorld();
    spawn("ground", { position: { x: 0, y: -0.5, z: 0 } }, [staticBody, box("3d", 10, 0.5, 10)]);
    const crate = spawn("crate", { position: { x: 0, y: 3, z: 0 } }, [fallingBody, box("3d", 0.5)]);
    // The default simple box (half extent 0.75) hangs below the crate and overlaps its collider.
    const weight = spawn("weight", { position: { x: 0, y: -1, z: 0 } }, [
      ["MeshComponent", { meshKind: "box", collisionMode: "simple" }],
    ], crate.guid);
    const backend = await backendFor(name, "3d", -9.81);
    const sync = new PhysicsWorldSync(backend);
    const colliderChanges = vi.spyOn(backend, "applyColliderChanges");
    try {
      for (let tick = 0; tick < 120; tick++) sync.step(1 / 60, world);
      // The weight's bottom (crate y - 1.75) touches the ground before the crate's own box.
      expect(crate.transform.position.y).toBeCloseTo(1.75, 1);
      const rested = crate.transform.position.y;
      for (let tick = 0; tick < 60; tick++) sync.step(1 / 60, world);
      expect(Math.abs(crate.transform.position.y - rested)).toBeLessThan(0.01);
      expect(weight.transform.position).toEqual({ x: 0, y: -1, z: 0 });
      expect(backend.getBodyTransform("body:weight")).toBeNull();
      // The compound is built once; a falling and resting host never rebuilds it.
      expect(colliderChanges.mock.calls.filter(([bodyId]) => bodyId === "body:crate")).toHaveLength(1);
    } finally {
      sync.dispose();
    }
  });

  it("carries a kinematic parent's child shape, which pushes a dynamic body", async () => {
    const { world, spawn } = createWorld();
    const pusher = spawn("pusher", {}, [["RigidBodyComponent", { motionType: "kinematic", mass: 1, gravityScale: 0 }]]);
    const paddle = spawn("paddle", { position: { x: 1, y: 0, z: 0 } }, [staticBody, box("3d", 0.5)], pusher.guid);
    const ball = spawn("ball", { position: { x: 2.5, y: 0, z: 0 } }, [coastingBody, box("3d", 0.5)]);
    const sync = new PhysicsWorldSync(await nativeBackend("3d"));
    try {
      for (let tick = 0; tick < 60; tick++) {
        pusher.transform.position.x += 0.05;
        sync.step(1 / 60, world);
      }
      expect(pusher.transform.position.x).toBeCloseTo(3, 5);
      expect(paddle.transform.position).toEqual({ x: 1, y: 0, z: 0 });
      // The paddle's face ends at x = 4.5; the ball it pushed stays in front of it.
      expect(ball.transform.position.x - 0.5).toBeGreaterThan(4.45);
      expect(sync.getBackend().getBodyVelocity("body:ball")!.linear.x).toBeGreaterThan(2.5);
      // Havok queries are per body and name the host; ignoring the hosted
      // child still skips its shape, which collision channels rely on.
      const start = { x: 4, y: 3, z: 0 }, end = { x: 4, y: -3, z: 0 };
      expect(sync.lineTrace(start, end).actorId).toBe("pusher");
      expect(sync.lineTrace(start, end, { ignoreActorIds: ["paddle"] }).hit).toBe(false);
    } finally {
      sync.dispose();
    }
  });

  it("gives a moved or detached child its own static body at its world pose", () => {
    const { world, spawn } = createWorld();
    const crate = spawn("crate", {}, [coastingBody, box("3d", 0.5)]);
    const handle = spawn("handle", { position: { x: 2, y: 0, z: 0 } }, [staticBody, box("3d", 0.25)], crate.guid);
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    const down = (x: number, from = 10, to = -10) =>
      sync.lineTrace({ x, y: from, z: 0 }, { x, y: to, z: 0 });
    try {
      sync.syncFromWorld(world);
      sync.addImpulse(crate.guid, { x: 0, y: 3, z: 0 });
      for (let tick = 0; tick < 30; tick++) sync.step(1 / 60, world);
      const height = crate.transform.position.y;
      expect(height).toBeCloseTo(1.5, 9);
      expect(backend.getBodyTransform("body:handle")).toBeNull();
      expect(down(2).actorId).toBe("handle");
      expect(down(2).location!.y).toBeCloseTo(height + 0.25, 9);

      // A pose write moves the hosted shape before the next step.
      handle.transform.position.x = 3;
      sync.teleportActor(handle, world);
      expect(down(3).actorId).toBe("handle");
      expect(down(2).hit).toBe(false);

      // Detach Actor keeps the world pose, which the child's own body takes over.
      handle.setVariable("parentId", null);
      handle.transform.position.y = height;
      for (let tick = 0; tick < 30; tick++) sync.step(1 / 60, world);
      expect(crate.transform.position.y).toBeCloseTo(3, 9);
      const own = backend.getBodyTransform("body:handle")!;
      expect(own.position.x).toBe(3);
      expect(own.position.y).toBe(height);
      expect(down(3).actorId).toBe("handle");
      // Nothing rides along with the crate any more.
      expect(down(3, 10, height + 0.5).hit).toBe(false);
    } finally {
      sync.dispose();
    }
  });

  it.each([
    { change: "becomes static", apply: (crate: Actor) => crate.components[0]!.setVariable("motionType", "static") },
    { change: "loses its RigidBody", apply: (crate: Actor) => { crate.components[0]!.destroyed = true; } },
  ])("restores the child's own following static body when its parent $change", ({ apply }) => {
    const { world, spawn } = createWorld();
    const crate = spawn("crate", {}, [coastingBody, box("3d", 0.5)]);
    const handle = spawn("handle", { position: { x: 2, y: 0, z: 0 } }, [staticBody, box("3d", 0.25)], crate.guid);
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    try {
      sync.syncFromWorld(world);
      sync.addImpulse(crate.guid, { x: 0, y: 3, z: 0 });
      for (let tick = 0; tick < 30; tick++) sync.step(1 / 60, world);
      expect(backend.getBodyTransform("body:handle")).toBeNull();
      apply(crate);
      crate.transform.position.y = 4;
      sync.step(1 / 60, world);
      expect(backend.getBodyTransform("body:handle")?.position).toEqual({ x: 2, y: 4, z: 0 });
      // Exactly one handle shape remains: on its own body, not also on the crate.
      expect(backend.sphereOverlap({ x: 2, y: 4, z: 0 }, 0.1)).toEqual({
        actorIds: ["handle"],
        bodyIds: ["body:handle"],
      });
      // It follows its actor again.
      crate.transform.position.y = 5;
      sync.step(1 / 60, world);
      expect(backend.getBodyTransform("body:handle")?.position).toEqual({ x: 2, y: 5, z: 0 });
      expect(handle.transform.position).toEqual({ x: 2, y: 0, z: 0 });
    } finally {
      sync.dispose();
    }
  });

  it.each([
    { backend: "software", kind: "3d" as const, named: "handle" },
    { backend: "Rapier", kind: "2d" as const, named: "handle" },
    // Havok reports contacts per body, so they name the body's owner and its own collider.
    { backend: "Havok", kind: "3d" as const, named: "crate" },
  ])("$backend names $named for a hosted shape's ground contact", async ({ backend: name, kind, named }) => {
    const { world, spawn } = createWorld();
    spawn("ground", { position: { x: 0, y: -0.5, z: 0 } }, [staticBody, box(kind, 10, 0.5, 10)]);
    const crate = spawn("crate", { position: { x: 0, y: 2, z: 0 } }, [fallingBody, box(kind, 0.5)]);
    const handle = spawn("handle", { position: { x: 0, y: -1, z: 0 } }, [staticBody, box(kind, 0.25)], crate.guid);
    const backend = await backendFor(name, kind, -9.81);
    const sync = new PhysicsWorldSync(backend);
    const others: Array<{ actor: string; component: string | undefined }> = [];
    try {
      for (let tick = 0; tick < 90; tick++) {
        sync.step(1 / 60, world);
        for (const event of backend.pollContacts()) {
          if (event.kind !== "hit") continue;
          if (event.actorAId === "ground")
            others.push({ actor: event.actorBId, component: componentIdFromColliderPhysicsId(event.colliderBId) });
          else if (event.actorBId === "ground")
            others.push({ actor: event.actorAId, component: componentIdFromColliderPhysicsId(event.colliderAId) });
        }
      }
      // The handle's bottom (crate y - 1.25) reached the ground first.
      expect(crate.transform.position.y).toBeCloseTo(1.25, 1);
      const owner = named === "handle" ? handle : crate;
      expect(others.length).toBeGreaterThan(0);
      expect(new Set(others.map((other) => JSON.stringify(other)))).toEqual(
        new Set([JSON.stringify({ actor: named, component: colliderGuid(owner) })]),
      );
    } finally {
      sync.dispose();
    }
  });

  it.each(everyBackend)("$backend keeps a hosted child's trigger off its own shapes", async ({ backend: name, kind }) => {
    const { world, spawn } = createWorld();
    const carrier = spawn("carrier", {}, [kinematicBody]);
    // A pickup's solid shape rides on the carrier inside the pickup's own trigger.
    spawn("pickup", {}, [staticBody, box(kind, 0.25), trigger(kind, 1)], carrier.guid);
    // The visitor touches the trigger but not the solid shape.
    spawn("visitor", { position: { x: 0.8, y: 0, z: 0 } }, [coastingBody, box(kind, 0.1)]);
    const backend = await backendFor(name, kind, 0);
    const sync = new PhysicsWorldSync(backend);
    const overlaps: string[] = [];
    try {
      for (let tick = 0; tick < 5; tick++) {
        sync.step(1 / 60, world);
        for (const event of backend.pollContacts())
          if (event.kind !== "hit") overlaps.push(`${event.kind} ${event.actorAId} ${event.actorBId}`);
      }
      expect(overlaps).toEqual(["overlapBegin pickup visitor"]);
    } finally {
      sync.dispose();
    }
  });

  it.each(everyBackend)("$backend keeps an overlap open while a hosted child moves on its host", async ({ backend: name, kind }) => {
    const { world, spawn } = createWorld();
    spawn("zone", {}, [staticBody, trigger(kind, 5)]);
    const carrier = spawn("carrier", {}, [kinematicBody]);
    const wheel = spawn("wheel", {}, [staticBody, box(kind, 0.25)], carrier.guid);
    const backend = await backendFor(name, kind, 0);
    const sync = new PhysicsWorldSync(backend);
    const overlaps: string[] = [];
    const step = () => {
      sync.step(1 / 60, world);
      for (const event of backend.pollContacts()) if (event.kind !== "hit") overlaps.push(event.kind);
    };
    try {
      // Each move rebuilds the wheel's shape on the carrier inside the zone.
      for (let tick = 0; tick < 10; tick++) {
        wheel.transform.position.x = (tick % 2) * 0.5;
        step();
      }
      expect(overlaps).toEqual(["overlapBegin"]);
      wheel.transform.position.x = 50;
      for (let tick = 0; tick < 3; tick++) step();
      expect(overlaps).toEqual(["overlapBegin", "overlapEnd"]);
    } finally {
      sync.dispose();
    }
  });

  it("Rapier keeps the host's mass when a shape joins its body", async () => {
    const { world, spawn } = createWorld();
    const plain = spawn("plain", {}, [coastingBody, box("2d", 0.5)]);
    const loaded = spawn("loaded", { position: { x: 20, y: 0, z: 0 } }, [coastingBody, box("2d", 0.5)]);
    spawn("cargo", { position: { x: 0, y: 3, z: 0 } }, [staticBody, box("2d", 2)], loaded.guid);
    const sync = new PhysicsWorldSync(await nativeBackend("2d"));
    const velocity = (actor: Actor) => sync.getBackend().getBodyVelocity(`body:${actor.guid}`)!.linear.x;
    try {
      // Steps first, so the bodies' mass properties include their colliders.
      for (let tick = 0; tick < 2; tick++) sync.step(1 / 60, world);
      for (const actor of [plain, loaded]) sync.addImpulse(actor.guid, { x: 2, y: 0, z: 0 });
      sync.step(1 / 60, world);
      expect(velocity(plain)).toBeGreaterThan(0.5);
      expect(velocity(loaded)).toBeCloseTo(velocity(plain), 6);
    } finally {
      sync.dispose();
    }
  });

  it("attaches a hosted actor's joint to its host's body", async () => {
    const { world, spawn } = createWorld();
    const platform = spawn("platform", {}, [kinematicBody]);
    // The collidable frame has no body of its own; its joint joins the platform's.
    spawn("frame", { position: { x: 2, y: 0, z: 0 } }, [
      staticBody,
      box("3d", 0.25),
      ["PhysicsConstraintComponent", { kind: "ballSocket", targetActorId: "door", anchorA: { x: 0, y: -1, z: 0 } }],
    ], platform.guid);
    const door = spawn("door", { position: { x: 2, y: -1, z: 0 } }, [coastingBody, box("3d", 0.2)]);
    const sync = new PhysicsWorldSync(await nativeBackend("3d"));
    try {
      for (let tick = 0; tick < 60; tick++) {
        platform.transform.position.x += 0.05;
        sync.step(1 / 60, world);
      }
      expect(sync.getBackend().getBodyTransform("body:frame")).toBeNull();
      // The platform carried the joint's anchor from x = 2 to x = 5.
      expect(Math.abs(door.transform.position.x - 5)).toBeLessThan(0.25);
      expect(door.transform.position.y).toBeCloseTo(-1, 1);
    } finally {
      sync.dispose();
    }
  });
});
