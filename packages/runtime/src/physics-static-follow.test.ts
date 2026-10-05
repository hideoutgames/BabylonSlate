import { afterEach, describe, expect, it, vi } from "vitest";
import { identityTransform, type Transform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  type PhysicsBackend,
} from "@babylonslate/physics";
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
const box = (
  kind: "2d" | "3d",
  half: number,
  options: Record<string, unknown> = {},
): Components[number] => [
  "ColliderComponent",
  {
    shape: kind === "3d"
      ? { kind: "box", halfExtents: { x: half, y: half, z: half } }
      : { kind: "box2d", halfExtents: { x: half, y: half } },
    ...options,
  },
];
const nativeBackend = (kind: "2d" | "3d", gravity = 0) =>
  createPhysicsBackend({ kind, gravity: { x: 0, y: gravity, z: 0 }, allowSoftwareFallback: false });

describe("static bodies follow their actor", () => {
  it("keeps a 2D static body's authored depth and tilt across Rapier steps", async () => {
    const { world, spawn } = createWorld();
    // A 120 degree turn about (1, 1, 1): Rapier itself keeps only planar rotation.
    const wall = spawn("wall", {
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0.5, y: 0.5, z: 0.5, w: 0.5 },
    }, [staticBody, box("2d", 0.5)]);
    const sync = new PhysicsWorldSync(await nativeBackend("2d", -9.81));
    try {
      for (let tick = 0; tick < 5; tick++) sync.step(1 / 60, world);
      expect(wall.transform.position).toEqual({ x: 1, y: 2, z: 3 });
      expect(wall.transform.rotation).toEqual({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
      expect(sync.getBackend().getBodyTransform("body:wall")?.position).toEqual({ x: 1, y: 2, z: 0 });
    } finally {
      sync.dispose();
    }
  });

  it("keeps an authored non-normalized static quaternion as written", async () => {
    const { world, spawn } = createWorld();
    // A quarter turn about Z with length sqrt(2); the native body uses its unit form.
    const pillar = spawn("pillar", { rotation: { x: 0, y: 0, z: 1, w: 1 } }, [
      staticBody,
      ["ColliderComponent", { shape: { kind: "box", halfExtents: { x: 2, y: 0.25, z: 0.25 } } }],
    ]);
    const sync = new PhysicsWorldSync(await nativeBackend("3d", -9.81));
    try {
      for (let tick = 0; tick < 5; tick++) sync.step(1 / 60, world);
      expect(pillar.transform.rotation).toEqual({ x: 0, y: 0, z: 1, w: 1 });
      // The turned box spans the Y axis, not X.
      expect(sync.lineTrace({ x: -3, y: 1.5, z: 0 }, { x: 3, y: 1.5, z: 0 }).actorId).toBe("pillar");
      expect(sync.lineTrace({ x: 1.5, y: 3, z: 0 }, { x: 1.5, y: -3, z: 0 }).hit).toBe(false);
    } finally {
      sync.dispose();
    }
  });

  it("keeps a shape-less static child, such as a joint anchor, attached to its falling parent", () => {
    const { world, spawn } = createWorld();
    const crate = spawn("crate", { position: { x: 0, y: 10, z: 0 } }, [
      ["RigidBodyComponent", { motionType: "dynamic", mass: 1, gravityScale: 1, linearDamping: 0 }],
      box("3d", 0.5),
    ]);
    // Without collidable shapes it is not hosted by the crate and keeps its own body.
    const handle = spawn("handle", { position: { x: 2, y: 0, z: 0 } }, [staticBody], crate.guid);
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: -9.81, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    try {
      for (let tick = 0; tick < 30; tick++) sync.step(1 / 60, world);
      expect(crate.transform.position.y).toBeLessThan(9);
      expect(handle.transform.position).toEqual({ x: 2, y: 0, z: 0 });
      // The next tick publishes the handle under the crate's post-step pose.
      sync.syncFromWorld(world);
      const body = backend.getBodyTransform("body:handle")!;
      expect(body.position.x).toBeCloseTo(2, 9);
      expect(body.position.y).toBeCloseTo(crate.transform.position.y, 9);
    } finally {
      sync.dispose();
    }
  });

  it("performs no static teleports while a static scene stays put", async () => {
    const { world, spawn } = createWorld();
    const half = (degrees: number) => (degrees * Math.PI) / 360;
    spawn("floor", { position: { x: 0, y: -1, z: 0 } }, [
      staticBody,
      ["ColliderComponent", { shape: { kind: "box", halfExtents: { x: 10, y: 0.5, z: 10 } } }],
    ]);
    // Statics under a turned, scaled nonphysics parent: implicit Mesh collision
    // and an explicit static body with its own tilt.
    const pivot = spawn("pivot", {
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: Math.sin(half(30)), z: 0, w: Math.cos(half(30)) },
      scale: { x: 1.5, y: 1.5, z: 1.5 },
    });
    spawn("shelf", {
      position: { x: 2, y: 0.5, z: -1 },
      rotation: { x: Math.sin(half(20)), y: 0, z: 0, w: Math.cos(half(20)) },
    }, [staticBody, box("3d", 0.25)], pivot.guid);
    spawn("statue", { position: { x: -1, y: 0, z: 0 } }, [
      ["MeshComponent", { meshKind: "box", collisionMode: "simple" }],
    ], pivot.guid);
    spawn("wall", {
      position: { x: -4, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: Math.sin(half(45)), w: Math.cos(half(45)) },
      scale: { x: 2, y: 4, z: 1 },
    }, [["BlockingVolumeComponent", {}]]);
    const ball = spawn("ball", { position: { x: 5, y: 2, z: 5 } }, [
      ["RigidBodyComponent", { motionType: "dynamic", mass: 1, gravityScale: 1 }],
      box("3d", 0.25),
    ]);
    const backend = await nativeBackend("3d", -9.81);
    const sync = new PhysicsWorldSync(backend);
    const teleports = vi.spyOn(backend, "teleportBody");
    try {
      const perTick: number[] = [];
      for (let tick = 0; tick < 30; tick++) {
        teleports.mockClear();
        sync.step(1 / 60, world);
        perTick.push(teleports.mock.calls.length);
      }
      expect(ball.transform.position.y).toBeLessThan(2);
      expect(perTick).toEqual(Array(30).fill(0));
    } finally {
      sync.dispose();
    }
  });

  it.each([
    { backend: "Havok", kind: "3d" as const },
    { backend: "Rapier", kind: "2d" as const },
    { backend: "software", kind: "3d" as const },
  ])("$backend keeps one overlap while a static trigger rides a moving parent", async ({ backend: name, kind }) => {
    const { world, spawn } = createWorld();
    // The carrier's own collider is filtered away from both the rider and the trigger.
    const carrier = spawn("carrier", {}, [coastingBody, box(kind, 0.25, { layer: 2, mask: 2 })]);
    const sensor = spawn("sensor", { position: { x: 2, y: 0, z: 0 } }, [
      staticBody,
      box(kind, 1, { isTrigger: true }),
    ], carrier.guid);
    spawn("rider", { position: { x: 2, y: 0, z: 0 } }, [coastingBody, box(kind, 0.25)]);
    const backend: PhysicsBackend = name === "software"
      ? createSoftwarePhysicsBackend(kind, { x: 0, y: 0, z: 0 })
      : await nativeBackend(kind);
    const sync = new PhysicsWorldSync(backend);
    const teleports = vi.spyOn(backend, "teleportBody");
    const sensorTeleports: number[] = [];
    const events: string[] = [];
    try {
      sync.syncFromWorld(world);
      // Equal bodies receive equal impulses, so the rider stays inside the trigger.
      sync.addImpulse("carrier", { x: 3, y: 0, z: 0 });
      sync.addImpulse("rider", { x: 3, y: 0, z: 0 });
      for (let tick = 0; tick < 30; tick++) {
        teleports.mockClear();
        sync.step(1 / 60, world);
        sensorTeleports.push(teleports.mock.calls.filter(([bodyId]) => bodyId === "body:sensor").length);
        events.push(...backend.pollContacts().filter((event) => event.kind !== "hit").map((event) => event.kind));
      }
      expect(carrier.transform.position.x).toBeGreaterThan(1);
      expect(sensor.transform.position).toEqual({ x: 2, y: 0, z: 0 });
      // The parent first moves during the first step; each later tick follows it once.
      expect(sensorTeleports).toEqual([0, ...Array(29).fill(1)]);
      expect(events).toEqual(["overlapBegin"]);
    } finally {
      sync.dispose();
    }
  });
});
