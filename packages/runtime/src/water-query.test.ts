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
});
