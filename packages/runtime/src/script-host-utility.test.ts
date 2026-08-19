import { describe, expect, it } from "vitest";
import { Actor, ClassRegistry } from "@babylonslate/object-model";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import {
  ScriptHost,
  type CompiledScript,
  type ScriptHostServices,
} from "./script-host";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

function toScript(
  graph: LogicGraph,
  registry: NodeRegistry,
  classId: string,
): CompiledScript {
  const compiled = compileGraph(graph, { assetGuid: "utility-asset", registry });
  return {
    assetGuid: "utility-asset",
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

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

describe("ScriptHost utility bindings", () => {
  it("exposes deterministic seeded ctx.random float/int/bool without Math.random", () => {
    const floatsA = (() => {
      const ctx = new ScriptHost(stubServices()).createContext(null, 0, 0);
      return [ctx.random.float(), ctx.random.float(), ctx.random.float()];
    })();
    const floatsB = (() => {
      const ctx = new ScriptHost(stubServices()).createContext(null, 0, 0);
      return [ctx.random.float(), ctx.random.float(), ctx.random.float()];
    })();
    expect(floatsA).toEqual(floatsB);
    expect(floatsA.every((value) => value >= 0 && value < 1)).toBe(true);

    const ctx = new ScriptHost(stubServices()).createContext(null, 0, 0);
    const ints = Array.from({ length: 20 }, () => ctx.random.int(2, 4));
    expect(ints.every((value) => value >= 2 && value <= 4)).toBe(true);
    expect(new Set(ints).size).toBeGreaterThan(1);

    const bools = Array.from({ length: 20 }, () => ctx.random.bool());
    expect(bools.some(Boolean)).toBe(true);
    expect(bools.some((value) => !value)).toBe(true);

    expect(typeof ctx.randomFloat).toBe("function");
    expect(ctx.randomFloat()).toBeTypeOf("number");
  });

  it("Get All / Get Actor Of Class use ClassRegistry ancestry and spawn order", async () => {
    const nodeRegistry = createDefaultNodeRegistry();
    const classRegistry = new ClassRegistry();
    classRegistry.register({
      id: "Hero",
      parentClassId: "Actor",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    classRegistry.register({
      id: "Villain",
      parentClassId: "Actor",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    classRegistry.register({
      id: "SuperHero",
      parentClassId: "Hero",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });

    const actors = [
      new Actor({ classId: "Villain", guid: "v1" }),
      new Actor({ classId: "Hero", guid: "h1" }),
      new Actor({ classId: "SuperHero", guid: "h2" }),
      new Actor({ classId: "Hero", guid: "h3" }),
    ];

    const messages: string[] = [];
    const host = new ScriptHost(
      stubServices({
        classRegistry,
        getActors: () => actors,
        log: (_severity, _category, message) => {
          messages.push(message);
        },
      }),
    );

    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(nodeRegistry, "begin", "flow.event.beginPlay"),
        node(nodeRegistry, "all", "actor.getAllOfClass", {
          "default:classId": "Hero",
        }),
        node(nodeRegistry, "one", "actor.getOfClass", {
          "default:classId": "Hero",
        }),
        node(nodeRegistry, "logAll", "debug.log"),
        node(nodeRegistry, "logOne", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "logAll",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "logAll",
          sourcePinId: "execOut",
          targetNodeId: "logOne",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "all",
          sourcePinId: "out",
          targetNodeId: "logAll",
          targetPinId: "message",
        },
        {
          id: "e4",
          sourceNodeId: "one",
          sourcePinId: "out",
          targetNodeId: "logOne",
          targetPinId: "message",
        },
      ],
    };

    await host.load(toScript(graph, nodeRegistry, "Runner"));
    host.invokeEvent("Runner", "onBeginPlay", new Actor({ classId: "Runner" }));

    expect(messages[0]).toContain("h1");
    expect(messages[0]).toContain("h2");
    expect(messages[0]).toContain("h3");
    expect(messages[0]).not.toContain("v1");
    // spawn / list order: Hero then SuperHero then Hero
    expect(messages[0].indexOf("h1")).toBeLessThan(messages[0].indexOf("h2"));
    expect(messages[0].indexOf("h2")).toBeLessThan(messages[0].indexOf("h3"));
    expect(messages[1]).toContain("h1");
  });

  it("Add World Offset mutates actor location in place", () => {
    const actor = new Actor({ classId: "Actor" });
    actor.transform.position.x = 1;
    actor.transform.position.y = 2;
    actor.transform.position.z = 3;
    const ctx = new ScriptHost(stubServices()).createContext(actor, 0, 0);
    ctx.addActorWorldOffset(actor, { x: 4, y: -1, z: 0.5 });
    expect(actor.transform.position).toEqual({ x: 5, y: 1, z: 3.5 });
  });
});
