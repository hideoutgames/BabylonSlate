import { describe, expect, it } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { createDefaultWaterDefinition } from "@babylonslate/core";
import { compileGraph, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { ScriptHost } from "./script-host";
import { WaterWorld } from "./water-world";

describe("Water graph queries", () => {
  it("executes a compiled surface query against live bounded water and resolves the Actor", () => {
    const lake = new Actor({ guid: "lake", classId: "Actor" });
    lake.transform.position.y = 4;
    lake.attachComponent(new ActorComponent({ classId: "WaterLakeComponent", variables: { assetGuid: "water", width: 10, length: 10 } }));
    const water = new WaterWorld();
    water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    water.update([lake], 0);
    const logs: string[] = [];
    const ctx = new ScriptHost({
      log: (_severity, _category, message) => logs.push(message), print: () => {}, destroyActor: () => {},
      executeConsoleCommand: () => ({ success: true, output: "" }), delay: async () => {}, reportError: (error) => { throw error; },
      sampleWater: (point, actorId) => water.sample(point, actorId), findActor: (id) => id === lake.guid ? lake : undefined,
    }).createContext(null, 0, 0);
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "water-query", kind: "event",
      nodes: [
        ["begin", "flow.event.beginPlay", {}],
        ["sample", "water.sampleSurface", { "default:position": { x: 0, y: 1, z: 0 } }],
        ["log", "debug.log", {}],
      ].map(([id, typeId, properties]) => ({ id: id as string, typeId: typeId as string, properties: properties as Record<string, unknown>, position: { x: 0, y: 0 }, pins: registry.get(typeId as string)!.pins(properties as Record<string, unknown>) })),
      edges: [
        { id: "begin", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "sample", targetPinId: "execIn" },
        { id: "then", sourceNodeId: "sample", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "depth", sourceNodeId: "sample", sourcePinId: "depth", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "logic", registry });
    const run = new Function(`${compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ")}\nreturn onBeginPlay;`)();
    run(ctx);
    expect(logs).toEqual(["3"]);
    expect(ctx.sampleWater({ x: 0, y: 1, z: 0 }).actor).toBe(lake);
    expect(ctx.sampleWater({ x: 30, y: 1, z: 0 })).toMatchObject({ found: false, actor: null });
    expect(ctx.sampleWater({ x: 0, y: 1, z: 0 }, new Actor({ guid: "other", classId: "Actor" })).found).toBe(false);
    water.update([], 1);
    expect(ctx.sampleWater({ x: 0, y: 1, z: 0 }).found).toBe(false);
  });
  it("removes water inside live removal volumes and under terrain that rises above Global Water Volume", () => {
    const ocean = new Actor({ guid: "ocean", classId: "Actor" });
    ocean.attachComponent(new ActorComponent({ classId: "GlobalWaterVolumeComponent", variables: {} }));
    const island = new Actor({ guid: "island", classId: "Actor" });
    island.transform.position.x = 40;
    island.attachComponent(new ActorComponent({ classId: "LandscapeComponent", variables: {
      width: 20, depth: 20, subdivisions: 4, heights: Array.from({ length: 25 }, (_, i) => i === 12 ? 5 : -3),
    } }));
    const boat = new Actor({ guid: "boat", classId: "Actor" });
    boat.transform.position.x = -20;
    const hull = new ActorComponent({ classId: "WaterRemovalVolumeComponent", variables: { shape: "box", width: 2, height: 2, length: 6 } });
    boat.attachComponent(hull);
    const water = new WaterWorld();
    water.setContent({ calm: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    ocean.components[0]!.setVariable("assetGuid", "calm");
    water.update([ocean, island, boat], 0);
    expect(water.sample({ x: 0, y: -1, z: 0 }).found).toBe(true);
    expect(water.sample({ x: 40, y: -1, z: 0 }).found).toBe(false);
    expect(water.sample({ x: 48, y: -1, z: 0 }).found).toBe(true);
    expect(water.sample({ x: -20, y: -0.5, z: 2.5 }).found).toBe(false);
    // Moving the boat carries its hole with it.
    boat.transform.position.x = -60;
    water.update([ocean, island, boat], 0);
    expect(water.sample({ x: -20, y: -0.5, z: 2.5 }).found).toBe(true);
    hull.setVariable("enabled", false);
    water.update([ocean, island, boat], 0);
    expect(water.sample({ x: -60, y: -0.5, z: 0 }).found).toBe(true);
  });
});
