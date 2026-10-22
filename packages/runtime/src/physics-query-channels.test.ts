import { describe, expect, it, vi } from "vitest";
import { identityTransform } from "@haptic/core";
import { ClassRegistry, World } from "@haptic/object-model";
import { createPhysicsBackend, createSoftwarePhysicsBackend } from "@haptic/physics";
import type { CommandMessage } from "@haptic/bridge";
import { PhysicsWorldSync } from "./physics-sync";
import { RagdollWorldSync } from "./ragdoll-sync";
import { ScriptHost } from "./script-host";

describe("script physics query channels", () => {
  it("answers a name that is no channel as All and reports each such name once", () => {
    const sync = new PhysicsWorldSync(createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 }));
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wall = world.createActor({ classId: "Actor", guid: "wall", transform: { ...identityTransform(), position: { x: 3, y: 0, z: 0 } } });
      wall.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "dynamic", gravityScale: 0 } }));
      wall.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } }));
      world.spawnActorNow(wall);
      sync.syncFromWorld(world);
      const from = { x: 0, y: 0, z: 0 }, to = { x: 10, y: 0, z: 0 };
      // Known channels filter, and say nothing.
      expect(sync.lineTrace(from, to, { channel: "Static" }).actorId).toBeNull();
      expect(sync.lineTrace(from, to, { channel: "Dynamic" }).actorId).toBe("wall");
      expect(sync.lineTrace(from, to, { channel: "" }).actorId).toBe("wall");
      expect(sync.lineTrace(from, to).actorId).toBe("wall");
      expect(warn).not.toHaveBeenCalled();
      // Names from before the rename no longer filter: every query type sees the wall.
      expect(sync.lineTrace(from, to, { channel: "WorldStatic" }).actorId).toBe("wall");
      expect(sync.lineTrace(from, to, { channel: "WorldStatic" }).actorId).toBe("wall");
      expect(sync.sphereOverlap({ x: 3, y: 0, z: 0 }, 1, { channel: "Pawn" }).actorIds).toEqual(["wall"]);
      expect(sync.shapeSweep({ kind: "sphere", radius: 0.1 },
        { position: from, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { position: to, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { channel: "Pawn" }).actorId).toBe("wall");
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        expect.stringContaining('"WorldStatic"'),
        expect.stringContaining('"Pawn"'),
      ]);
      expect(warn.mock.calls[0]![0]).toContain("All, Static, Dynamic, Character, Solid, Triggers");
    } finally {
      warn.mockRestore();
      sync.dispose();
    }
  });

  it.each(["software", "rapier", "havok"] as const)("%s filters candidates before selecting hits", async (kind) => {
    const dimension = kind === "rapier" ? "2d" : "3d";
    const backend = kind === "software" ? createSoftwarePhysicsBackend(dimension, { x: 0, y: 0, z: 0 })
      : await createPhysicsBackend({ kind: dimension, gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
    const sync = new PhysicsWorldSync(backend);
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    try {
      for (const [guid, x, y] of [["static", 2, 0], ["dynamic", 4, 0], ["character", 6, 0], ["trigger", 1, 0], ["trigger-far", 8, 0]] as const) {
        const actor = world.createActor({ classId: "Actor", guid, transform: { ...identityTransform(), position: { x, y, z: 0 } } });
        if (guid === "character") actor.attachComponent(world.createComponent({ classId: "MovementComponent" }));
        else {
          actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: guid === "dynamic" ? "dynamic" : "static", gravityScale: 0 } }));
          actor.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { isTrigger: guid.startsWith("trigger"),
            shape: dimension === "2d" ? { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } } : { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } }));
        }
        world.spawnActorNow(actor);
      }
      sync.syncFromWorld(world);
      backend.step(1 / 60);
      const ctx = new ScriptHost({ log: () => {}, print: () => {}, destroyActor: () => {},
        executeConsoleCommand: () => ({ success: true, output: "" }), delay: async () => {}, reportError: () => {},
        findActor: (id) => world.findActor(id),
        lineTrace: (start, end, options) => sync.lineTrace(start, end, options),
        sphereOverlap: (center, radius, channel) => sync.sphereOverlap(center, radius, { channel }),
        shapeSweep: (shape, start, end, channel) => sync.shapeSweep(shape, start, end, { channel }),
      }).createContext(null, 0, 0);
      const start = identityTransform(), end = { ...identityTransform(), position: { x: 10, y: 0, z: 0 } };
      const shape = dimension === "2d" ? { kind: "circle" as const, radius: 0.1 } : { kind: "sphere" as const, radius: 0.1 };
      // Every backend's traces and sweeps hit the trigger in front unless the channel excludes it.
      for (const [channel, first, actors] of [
        ["All", "trigger", ["character", "dynamic", "static", "trigger", "trigger-far"]],
        ["Static", "trigger", ["static", "trigger", "trigger-far"]],
        ["Dynamic", "dynamic", ["character", "dynamic"]],
        ["Character", "character", ["character"]],
        ["Solid", "static", ["character", "dynamic", "static"]],
        ["Triggers", "trigger", ["trigger", "trigger-far"]],
      ] as const) {
        expect(ctx.lineTrace(start.position, end.position, channel, { drawDebug: false }).actor?.guid).toBe(first);
        expect(ctx.shapeSweep(shape, start, end, channel).actor?.guid).toBe(first);
        expect(ctx.sphereOverlap({ x: 4, y: 0, z: 0 }, 10, channel).actors.map((actor) => actor.guid).sort()).toEqual(actors);
      }
      // Triggers passes the solids in front of a trigger, whichever shape is hit first, and leaves no shape masked.
      const triggersBehind = { channel: "Triggers", ignoreActorIds: ["trigger"] };
      expect(sync.lineTrace(start.position, end.position, triggersBehind).actorId).toBe("trigger-far");
      expect(sync.shapeSweep(shape, start, end, triggersBehind).actorId).toBe("trigger-far");
      expect(sync.sphereOverlap({ x: 4, y: 0, z: 0 }, 10, triggersBehind).actorIds).toEqual(["trigger-far"]);
      expect(sync.lineTrace(start.position, end.position, { channel: "Triggers", ignoreActorIds: ["trigger", "trigger-far"] }).hit).toBe(false);
      expect(sync.lineTrace(start.position, end.position, { channel: "Solid" }).actorId).toBe("static");
      expect(sync.lineTrace(start.position, end.position).actorId).toBe("trigger");
    } finally { sync.dispose(); }
  });

  it("classifies the bones of an active ragdoll as dynamic, never static or character", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
    const sync = new PhysicsWorldSync(backend);
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const commands: CommandMessage[] = [];
    const ragdolls = new RagdollWorldSync({ world, physics: () => sync, slot: () => 1, eligible: (actor) => !actor.destroyed,
      deferNative: false, emit: (command) => commands.push(command), error: (error) => { throw error; } });
    try {
      const box = { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
      for (const [guid, x] of [["ragdoll", 3], ["static", 6], ["character", 9]] as const) {
        const actor = world.createActor({ classId: "Actor", guid, transform: { ...identityTransform(), position: { x, y: 0.5, z: 0 } } });
        if (guid === "character") actor.attachComponent(world.createComponent({ classId: "MovementComponent" }));
        else {
          const motionType = guid === "static" ? "static" : "dynamic";
          actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType, gravityScale: 0 } }));
          actor.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape: box } }));
        }
        if (guid === "ragdoll") actor.attachComponent(world.createComponent({ classId: "RagdollComponent", variables: { enabled: true } }));
        world.spawnActorNow(actor);
      }
      sync.syncFromWorld(world);
      ragdolls.sync();
      const request = commands.find((command) => command.type === "captureRagdollPose")!;
      ragdolls.accept({ type: "ragdollPoseCaptured", slotId: request.slotId, requestId: request.requestId, bones: [
        { name: "hips", parentName: null, position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { name: "head", parentName: "hips", position: { x: 3, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      ] });
      // The ordinary body is gone: the bones are the only thing left to answer for the ragdoll actor.
      expect(backend.getBodyTransform("body:ragdoll")).toBeNull();
      sync.syncFromWorld(world);
      backend.step(1 / 60);
      const ctx = new ScriptHost({ log: () => {}, print: () => {}, destroyActor: () => {},
        executeConsoleCommand: () => ({ success: true, output: "" }), delay: async () => {}, reportError: () => {},
        findActor: (id) => world.findActor(id),
        lineTrace: (start, end, options) => sync.lineTrace(start, end, options),
        sphereOverlap: (center, radius, channel) => sync.sphereOverlap(center, radius, { channel }),
        shapeSweep: (shape, start, end, channel) => sync.shapeSweep(shape, start, end, { channel }),
      }).createContext(null, 0, 0);
      const start = { ...identityTransform(), position: { x: 0, y: 0.5, z: 0 } };
      const end = { ...identityTransform(), position: { x: 12, y: 0.5, z: 0 } };
      const shape = { kind: "sphere" as const, radius: 0.02 };
      for (const [channel, first, actors] of [
        ["All", "ragdoll", ["character", "ragdoll", "static"]],
        ["Static", "static", ["static"]],
        ["Dynamic", "ragdoll", ["character", "ragdoll"]],
        ["Character", "character", ["character"]],
      ] as const) {
        expect(ctx.lineTrace(start.position, end.position, channel, { drawDebug: false }).actor?.guid, `${channel} trace`).toBe(first);
        expect(ctx.shapeSweep(shape, start, end, channel).actor?.guid, `${channel} sweep`).toBe(first);
        expect(ctx.sphereOverlap({ x: 4.5, y: 0.5, z: 0 }, 10, channel).actors.map((actor) => actor.guid).sort(), `${channel} overlap`).toEqual(actors);
      }
    } finally {
      ragdolls.dispose();
      sync.dispose();
    }
  });
});

describe("channel ignore lists", () => {
  const box = { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } as const;
  type Part = [classId: string, variables: Record<string, unknown>];
  const rigid = (motionType: string): Part => ["RigidBodyComponent", { motionType, gravityScale: 0 }];
  const collider: Part = ["ColliderComponent", { shape: box }];

  function channelWorld() {
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const spawn = (guid: string, x: number, parts: Part[], parentId?: string) => {
      const actor = world.createActor({ classId: "Actor", guid, transform: { ...identityTransform(), position: { x, y: 0, z: 0 } },
        variables: parentId ? { parentId } : {} });
      for (const [classId, variables] of parts) actor.attachComponent(world.createComponent({ classId, variables }));
      world.spawnActorNow(actor);
      return actor;
    };
    // Every actor is in range, so a query lists exactly the actors its channel lets through.
    const found = (channel: string, ignoreActorIds?: string[]) =>
      [...sync.sphereOverlap({ x: 0, y: 0, z: 0 }, 100, { channel, ...(ignoreActorIds ? { ignoreActorIds } : {}) }).actorIds].sort();
    return { backend, sync, world, spawn, found };
  }

  it("is reused until a body, its motion, its hosting or a ragdoll changes", () => {
    const { sync, world, spawn, found } = channelWorld();
    try {
      spawn("rock", 2, [rigid("static"), collider]);
      spawn("pallet", 6, [rigid("dynamic"), collider]);
      spawn("plank", 3, [rigid("static"), collider], "pallet");
      sync.syncFromWorld(world);
      expect(found("Static")).toEqual(["rock"]);
      expect(found("Dynamic")).toEqual(["pallet", "plank"]);
      expect(sync.channelListBuilds).toBe(2);
      // More queries, with and without actors to ignore, and passes that change nothing, rebuild nothing.
      expect(found("Static", ["rock"])).toEqual([]);
      expect(found("Dynamic", ["plank"])).toEqual(["pallet"]);
      sync.syncFromWorld(world);
      sync.syncFromWorld(world);
      expect(found("Static")).toEqual(["rock"]);
      expect(found("Dynamic")).toEqual(["pallet", "plank"]);
      expect(sync.channelListBuilds).toBe(2);
      // A new body is listed by the next query.
      spawn("pebble", 4, [rigid("static"), collider]);
      sync.syncFromWorld(world);
      expect(found("Static")).toEqual(["pebble", "rock"]);
      expect(sync.channelListBuilds).toBe(3);
    } finally { sync.dispose(); }
  });

  it("follows a body's motion type", () => {
    const { sync, world, spawn, found } = channelWorld();
    try {
      spawn("rock", 2, [rigid("static"), collider]);
      const crate = spawn("crate", 4, [rigid("dynamic"), collider]);
      sync.syncFromWorld(world);
      expect([found("Static"), found("Dynamic")]).toEqual([["rock"], ["crate"]]);
      crate.components.find((component) => component.classId === "RigidBodyComponent")!.setVariable("motionType", "static");
      sync.syncFromWorld(world);
      expect([found("Static"), found("Dynamic")]).toEqual([["crate", "rock"], []]);
      crate.components.find((component) => component.classId === "RigidBodyComponent")!.setVariable("motionType", "kinematic");
      sync.syncFromWorld(world);
      expect([found("Static"), found("Dynamic")]).toEqual([["rock"], ["crate"]]);
    } finally { sync.dispose(); }
  });

  it("follows a static child joining or leaving the compound of a moving parent", () => {
    const { sync, world, spawn, found } = channelWorld();
    try {
      spawn("rock", 2, [rigid("static"), collider]);
      spawn("pallet", 6, [rigid("dynamic"), collider]);
      const plank = spawn("plank", 3, [rigid("static"), collider], "pallet");
      sync.syncFromWorld(world);
      expect([found("Static"), found("Dynamic")]).toEqual([["rock"], ["pallet", "plank"]]);
      // A call-time reconcile of the one actor, as a script's reparent or teleport runs it.
      plank.setVariable("parentId", "");
      sync.syncActor(plank, world);
      expect([found("Static"), found("Dynamic")]).toEqual([["plank", "rock"], ["pallet"]]);
      // The per-tick pass hosts it again.
      plank.setVariable("parentId", "pallet");
      sync.syncFromWorld(world);
      expect([found("Static"), found("Dynamic")]).toEqual([["rock"], ["pallet", "plank"]]);
    } finally { sync.dispose(); }
  });

  it("follows a Movement component joining or leaving an actor, and no other structure change", () => {
    const { sync, world, spawn, found } = channelWorld();
    try {
      const volume = spawn("volume", 2, [["BlockingVolumeComponent", {}]]);
      sync.syncFromWorld(world);
      expect([found("Static"), found("Character")]).toEqual([["volume"], []]);
      expect(sync.channelListBuilds).toBe(2);
      const movement = world.createComponent({ classId: "MovementComponent" });
      volume.attachComponent(movement);
      expect(found("Character")).toEqual(["volume"]);
      // An unrelated spawn changes the structure, which only Character looks at.
      spawn("bystander", 4, []);
      expect(found("Static")).toEqual(["volume"]);
      expect(sync.channelListBuilds).toBe(3);
      // Destroying the component, as the World does for each component of a destroyed actor.
      movement.destroyed = true;
      movement.callOnDestroyed();
      expect(found("Character")).toEqual([]);
      expect(sync.channelListBuilds).toBe(4);
    } finally { sync.dispose(); }
  });

  it("follows an active ragdoll, whose bones are bodies of its actor that no body map lists", () => {
    const { backend, sync, world, spawn, found } = channelWorld();
    try {
      const ragdoll = spawn("ragdoll", 3, [rigid("static"), collider]);
      spawn("rock", 6, [rigid("static"), collider]);
      sync.syncFromWorld(world);
      expect([found("Static"), found("Dynamic")]).toEqual([["ragdoll", "rock"], []]);
      // The ordinary body is replaced by a dynamic bone under the actor's id.
      sync.suppressActorBody(ragdoll, true);
      backend.createBody({ id: "bone", actorId: "ragdoll", motionType: "dynamic", mass: 1, linearDamping: 0, angularDamping: 0,
        gravityScale: 0, transform: { position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
      backend.createCollider({ id: "bone-box", bodyId: "bone", shape: box, friction: 0.5, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
      expect([found("Static"), found("Dynamic"), found("Character")]).toEqual([["rock"], ["ragdoll"], []]);
      // The bone is no longer special the moment the ragdoll stops, before any pass recreates the ordinary body.
      sync.suppressActorBody(ragdoll, false);
      expect(found("Static")).toEqual(["ragdoll", "rock"]);
      backend.destroyBody("bone");
      sync.syncFromWorld(world);
      expect([found("Static"), found("Dynamic")]).toEqual([["ragdoll", "rock"], []]);
    } finally { sync.dispose(); }
  });
});
