import { describe, expect, it } from "vitest";
import { Actor, ActorComponent, ClassRegistry } from "@babylonslate/object-model";
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

  it("compiled component queries return usable live references in actor and attachment order", async () => {
    const registry = createDefaultNodeRegistry();
    const classRegistry = new ClassRegistry();
    classRegistry.register({
      id: "Health", parentClassId: "ActorComponent", kind: "component",
      variables: [], implementedInterfaces: [],
    });
    classRegistry.register({
      id: "Shield", parentClassId: "Health", kind: "component",
      variables: [], implementedInterfaces: [],
    });
    const firstActor = new Actor({ classId: "Actor" });
    const secondActor = new Actor({ classId: "Actor" });
    const overlayActor = new Actor({ classId: "SceneLayerActor", sceneLayerId: "overlay" });
    const destroyedActor = new Actor({ classId: "Actor" });
    const first = new ActorComponent({ classId: "Shield" });
    const second = new ActorComponent({ classId: "Health" });
    const third = new ActorComponent({ classId: "Health" });
    const overlay = new ActorComponent({ classId: "Health" });
    const destroyed = new ActorComponent({ classId: "Health" });
    firstActor.attachComponent(new ActorComponent({ classId: "AudioComponent" }));
    firstActor.attachComponent(destroyed);
    firstActor.attachComponent(first);
    firstActor.attachComponent(second);
    secondActor.attachComponent(third);
    overlayActor.attachComponent(overlay);
    destroyedActor.attachComponent(new ActorComponent({ classId: "Health" }));
    destroyed.destroyed = true;
    destroyedActor.destroyed = true;
    let actors = [destroyedActor, firstActor, secondActor, overlayActor];
    const host = new ScriptHost(stubServices({ classRegistry, getActors: () => actors }));
    const graph: LogicGraph = {
      id: "component-queries", kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "first", "component.getFirstOfType", { "default:classId": "Health" }),
        node(registry, "all", "component.getAllOfType", { "default:classId": "Health" }),
        node(registry, "storeFirst", "variables.set", {
          variableName: "First", typeId: "object", typeClassId: "ActorComponent", implicitSelf: true,
        }),
        node(registry, "storeAll", "variables.set", {
          variableName: "All", typeId: "object", typeClassId: "ActorComponent", container: "array", implicitSelf: true,
        }),
        node(registry, "update", "variables.set", { variableName: "Health", typeId: "float" }),
      ],
      edges: [
        { id: "start", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "storeFirst", targetPinId: "execIn" },
        { id: "next", sourceNodeId: "storeFirst", sourcePinId: "execOut", targetNodeId: "storeAll", targetPinId: "execIn" },
        { id: "mutate", sourceNodeId: "storeAll", sourcePinId: "execOut", targetNodeId: "update", targetPinId: "execIn" },
        { id: "firstValue", sourceNodeId: "first", sourcePinId: "out", targetNodeId: "storeFirst", targetPinId: "value" },
        { id: "allValue", sourceNodeId: "all", sourcePinId: "out", targetNodeId: "storeAll", targetPinId: "value" },
        { id: "target", sourceNodeId: "first", sourcePinId: "out", targetNodeId: "update", targetPinId: "target" },
      ],
    };
    const runner = new Actor({ classId: "Runner" });
    await host.load(toScript(graph, registry, "Runner"));
    host.invokeEvent("Runner", "onBeginPlay", runner);
    expect(runner.getVariable("First")).toBe(first);
    const all = runner.getVariable("All") as ActorComponent[];
    expect(all).toHaveLength(4);
    expect(all[0]).toBe(first);
    expect(all[1]).toBe(second);
    expect(all[2]).toBe(third);
    expect(all[3]).toBe(overlay);
    expect(first.getVariable("Health")).toBe(0);
    expect(second.getVariable("Health")).toBeUndefined();

    // Query the current scene each time, rather than retaining earlier results.
    const ctx = host.createContext(runner, 0, 0);
    first.destroyed = true;
    expect(ctx.getFirstComponentOfType("Health")).toBe(second);
    const added = new ActorComponent({ classId: "Shield" });
    secondActor.attachComponent(added);
    expect(ctx.getAllComponentsOfType("Health")).toEqual([second, third, added, overlay]);
    actors = [new Actor({ classId: "Actor" })];
    expect(ctx.getFirstComponentOfType("Health")).toBeNull();
    expect(ctx.getAllComponentsOfType("Health")).toEqual([]);
  });

  it("component queries handle missing types and worlds and match exact classes without a registry", () => {
    const actor = new Actor({ classId: "Actor" });
    const component = new ActorComponent({ classId: "MeshComponent" });
    actor.attachComponent(component);
    const ctx = new ScriptHost(stubServices({ getActors: () => [actor] })).createContext(null, 0, 0);
    expect(ctx.getFirstComponentOfType("MeshComponent")).toBe(component);
    expect(ctx.getAllComponentsOfType("MeshComponent")).toEqual([component]);
    for (const classId of ["", "MissingComponent", "ActorComponent"]) {
      expect(ctx.getFirstComponentOfType(classId)).toBeNull();
      expect(ctx.getAllComponentsOfType(classId)).toEqual([]);
    }
    const empty = new ScriptHost(stubServices()).createContext(null, 0, 0);
    expect(empty.getFirstComponentOfType("ActorComponent")).toBeNull();
    expect(empty.getAllComponentsOfType("ActorComponent")).toEqual([]);
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
