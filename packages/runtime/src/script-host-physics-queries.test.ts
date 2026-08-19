import { describe, expect, it } from "vitest";
import { Actor } from "@babylonslate/object-model";
import { ScriptHost, type ScriptHostServices } from "./script-host";

function stubServices(
  extras: Partial<ScriptHostServices> = {},
): ScriptHostServices {
  return {
    log: () => {},
    print: () => {},
    destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {},
    reportError: () => {},
    ...extras,
  };
}

describe("ScriptHost physics query resolution", () => {
  it("resolves lineTrace actorId through injected world lookup to a live Actor", () => {
    const ground = new Actor({ classId: "Actor", guid: "ground" });
    const host = new ScriptHost(
      stubServices({
        findActor: (id) => (id === "ground" ? ground : undefined),
        lineTrace: () => ({
          hit: true,
          location: { x: 0, y: 0.5, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          distance: 9.5,
          actorId: "ground",
          bodyId: "body-ground",
        }),
      }),
    );
    const ctx = host.createContext(null, 0, 0);
    const hit = ctx.lineTrace(
      { x: 0, y: 10, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(hit.hit).toBe(true);
    expect(hit.location).toEqual({ x: 0, y: 0.5, z: 0 });
    expect(hit.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(hit.distance).toBe(9.5);
    expect(hit.actor).toBe(ground);
    expect(typeof hit.actor).not.toBe("string");
  });

  it("returns miss defaults for lineTrace without a hit", () => {
    const host = new ScriptHost(
      stubServices({
        findActor: () => undefined,
        lineTrace: () => ({
          hit: false,
          location: null,
          normal: null,
          distance: 0,
          actorId: null,
          bodyId: null,
        }),
      }),
    );
    const ctx = host.createContext(null, 0, 0);
    const hit = ctx.lineTrace(
      { x: 0, y: 10, z: 0 },
      { x: 0, y: 20, z: 0 },
    );
    expect(hit).toEqual({
      hit: false,
      location: null,
      normal: null,
      distance: 0,
      actor: null,
    });
  });

  it("sphereOverlap returns de-duplicated live Actors and filters destroyed/missing", () => {
    const a = new Actor({ classId: "Actor", guid: "a" });
    const b = new Actor({ classId: "Actor", guid: "b" });
    const dead = new Actor({ classId: "Actor", guid: "dead" });
    dead.destroyed = true;
    const host = new ScriptHost(
      stubServices({
        findActor: (id) => {
          if (id === "a") return a;
          if (id === "b") return b;
          if (id === "dead") return dead;
          return undefined;
        },
        sphereOverlap: () => ({
          actorIds: ["a", "dead", "a", "missing", "b"],
          bodyIds: ["body-a1", "body-dead", "body-a2", "body-x", "body-b"],
        }),
      }),
    );
    const ctx = host.createContext(null, 0, 0);
    const overlap = ctx.sphereOverlap({ x: 0, y: 0, z: 0 }, 1);
    expect(overlap.actors).toEqual([a, b]);
    expect(overlap.actorIds).toEqual(["a", "dead", "a", "missing", "b"]);
    expect(overlap.actors.map((actor) => actor.guid)).toEqual(["a", "b"]);
  });

  it("shapeSweep resolves actorId and uses miss defaults", () => {
    const wall = new Actor({ classId: "Actor", guid: "wall" });
    const host = new ScriptHost(
      stubServices({
        findActor: (id) => (id === "wall" ? wall : undefined),
        shapeSweep: () => ({
          hit: true,
          location: { x: 1, y: 0, z: 0 },
          normal: { x: -1, y: 0, z: 0 },
          distance: 2,
          actorId: "wall",
          bodyId: "body-wall",
        }),
      }),
    );
    const ctx = host.createContext(null, 0, 0);
    const hit = ctx.shapeSweep(
      { kind: "sphere", radius: 0.5 },
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      {
        position: { x: 3, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    );
    expect(hit.actor).toBe(wall);
    expect(hit.distance).toBe(2);
    expect(hit.normal).toEqual({ x: -1, y: 0, z: 0 });

    const missHost = new ScriptHost(stubServices({ findActor: () => undefined }));
    const miss = missHost
      .createContext(null, 0, 0)
      .shapeSweep(
        { kind: "sphere", radius: 0.5 },
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
        {
          position: { x: 1, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      );
    expect(miss).toEqual({
      hit: false,
      location: null,
      normal: null,
      distance: 0,
      actor: null,
    });
  });
});
