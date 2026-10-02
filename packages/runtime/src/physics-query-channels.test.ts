import { describe, expect, it } from "vitest";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createPhysicsBackend, createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";
import { ScriptHost } from "./script-host";

describe("script physics query channels", () => {
  it.each(["software", "rapier", "havok"] as const)("%s filters candidates before selecting hits", async (kind) => {
    const dimension = kind === "rapier" ? "2d" : "3d";
    const backend = kind === "software" ? createSoftwarePhysicsBackend(dimension, { x: 0, y: 0, z: 0 })
      : await createPhysicsBackend({ kind: dimension, gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
    const sync = new PhysicsWorldSync(backend);
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    try {
      for (const [guid, x, y] of [["static", 2, 0], ["dynamic", 4, 0], ["pawn", 6, 0], ["trigger", 1, 3]] as const) {
        const actor = world.createActor({ classId: "Actor", guid, transform: { ...identityTransform(), position: { x, y, z: 0 } } });
        if (guid === "pawn") actor.attachComponent(world.createComponent({ classId: "MovementComponent" }));
        else {
          actor.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: guid === "dynamic" ? "dynamic" : "static", gravityScale: 0 } }));
          actor.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { isTrigger: guid === "trigger",
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
      for (const [channel, first, actors] of [
        ["All", "static", ["dynamic", "pawn", "static", "trigger"]],
        ["WorldStatic", "static", ["static", "trigger"]],
        ["WorldDynamic", "dynamic", ["dynamic", "pawn"]],
        ["Pawn", "pawn", ["pawn"]],
        ["Visibility", "static", ["dynamic", "pawn", "static"]],
      ] as const) {
        expect(ctx.lineTrace(start.position, end.position, channel, { drawDebug: false }).actor?.guid).toBe(first);
        expect(ctx.shapeSweep(shape, start, end, channel).actor?.guid).toBe(first);
        expect(ctx.sphereOverlap({ x: 4, y: 0, z: 0 }, 10, channel).actors.map((actor) => actor.guid).sort()).toEqual(actors);
      }
    } finally { sync.dispose(); }
  });
});
