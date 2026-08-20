import { describe, expect, it } from "vitest";
import {
  Actor,
  ActorComponent,
  ClassRegistry,
  GameInstance,
  BObject,
} from "@babylonslate/object-model";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { ScriptHost, type CompiledScript, type ScriptHostServices } from "./script-host";

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
  const compiled = compileGraph(graph, { assetGuid: "cast-asset", registry });
  return {
    assetGuid: "cast-asset",
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

describe("ScriptContext.isA", () => {
  it("uses ClassRegistry.isA for live object kinds", () => {
    const classRegistry = new ClassRegistry();
    classRegistry.register({
      id: "Hero",
      parentClassId: "Actor",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    classRegistry.register({
      id: "HealthComponent",
      parentClassId: "ActorComponent",
      kind: "component",
      variables: [],
      implementedInterfaces: [],
    });
    classRegistry.register({
      id: "Campaign",
      parentClassId: "GameInstance",
      kind: "gameInstance",
      variables: [],
      implementedInterfaces: [],
    });
    classRegistry.register({
      id: "LevelTools",
      parentClassId: "EditorUtilityObject",
      kind: "other",
      variables: [],
      implementedInterfaces: [],
    });

    const ctx = new ScriptHost(
      stubServices({ classRegistry }),
    ).createContext(null, 0, 0);

    const hero = new Actor({ classId: "Hero" });
    const mesh = new ActorComponent({ classId: "HealthComponent" });
    const campaign = new GameInstance({ classId: "Campaign" });
    const tools = new BObject({ classId: "LevelTools" });

    expect(ctx.isA(hero, "Hero")).toBe(true);
    expect(ctx.isA(hero, "Actor")).toBe(true);
    expect(ctx.isA(hero, "BObject")).toBe(true);
    expect(ctx.isA(hero, "GameInstance")).toBe(false);

    expect(ctx.isA(mesh, "HealthComponent")).toBe(true);
    expect(ctx.isA(mesh, "ActorComponent")).toBe(true);
    expect(ctx.isA(mesh, "Actor")).toBe(false);

    expect(ctx.isA(campaign, "Campaign")).toBe(true);
    expect(ctx.isA(campaign, "GameInstance")).toBe(true);
    expect(ctx.isA(campaign, "Actor")).toBe(false);

    expect(ctx.isA(tools, "LevelTools")).toBe(true);
    expect(ctx.isA(tools, "EditorUtilityObject")).toBe(true);
    expect(ctx.isA(tools, "Actor")).toBe(false);

    expect(ctx.isA(null, "Actor")).toBe(false);
    expect(ctx.isA("Hero", "Hero")).toBe(false);
  });

  it("compiled Cast succeeds for Actor ancestry and fails for other kinds", async () => {
    const nodeRegistry = createDefaultNodeRegistry();
    const classRegistry = new ClassRegistry();
    classRegistry.register({
      id: "Hero",
      parentClassId: "Actor",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    const messages: string[] = [];
    const host = new ScriptHost(
      stubServices({
        classRegistry,
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
        node(nodeRegistry, "self", "actor.getSelf"),
        node(nodeRegistry, "cast", "casting.cast", {
          defaultClassId: "Actor",
          "default:class": "Actor",
          resultKind: "actorRef",
        }),
        node(nodeRegistry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "cast",
          targetPinId: "execIn",
        },
        {
          id: "e1b",
          sourceNodeId: "cast",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "cast",
          targetPinId: "object",
        },
        {
          id: "e3",
          sourceNodeId: "cast",
          sourcePinId: "success",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    await host.load(toScript(graph, nodeRegistry, "Hero"));
    host.invokeEvent("Hero", "onBeginPlay", new Actor({ classId: "Hero" }));
    expect(messages.some((message) => message.includes("true"))).toBe(true);

    messages.length = 0;
    await host.load(toScript(graph, nodeRegistry, "GameInstance"));
    host.invokeEvent(
      "GameInstance",
      "onBeginPlay",
      new GameInstance({ classId: "GameInstance" }) as never,
    );
    expect(messages.some((message) => message.includes("false"))).toBe(true);
  });
});
