import { describe, expect, it } from "vitest";
import {
  compileGraph,
  actorRef,
  BOOL,
  classRef,
  objectRef,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { castingNodes, createDefaultNodeRegistry } from "./index";

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

function loadBeginPlay(source: string): (ctx: unknown) => void {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { onBeginPlay };`)().onBeginPlay as (
    ctx: unknown,
  ) => void;
}

describe("casting nodes", () => {
  it("registers a dynamic Cast node", () => {
    expect(castingNodes.map((entry) => entry.id)).toContain("casting.cast");
  });

  it("keeps Cast To Actor for graphs that still store that type id", () => {
    expect(castingNodes.map((entry) => entry.id)).toContain("casting.castActor");
  });

  it("declares exec, then, object, Class, Success, and Result pins", () => {
    const def = castingNodes.find((entry) => entry.id === "casting.cast");
    const pins = def?.pins({}) ?? [];
    expect(pins.map((pin) => pin.id)).toEqual([
      "execIn",
      "execOut",
      "object",
      "class",
      "success",
      "result",
    ]);
    expect(pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "execIn",
          direction: "in",
          type: { kind: "exec" },
        }),
        expect.objectContaining({
          id: "execOut",
          direction: "out",
          type: { kind: "exec" },
        }),
        expect.objectContaining({
          id: "object",
          direction: "in",
          type: objectRef("BObject"),
        }),
        expect.objectContaining({
          id: "class",
          direction: "in",
          type: classRef("BObject"),
        }),
        expect.objectContaining({
          id: "success",
          direction: "out",
          type: BOOL,
        }),
        expect.objectContaining({
          id: "result",
          direction: "out",
          type: objectRef("BObject"),
        }),
      ]),
    );
    expect(def?.pure).not.toBe(true);
  });

  it("types Result as an actor ref when the default class is Actor", () => {
    const def = castingNodes.find((entry) => entry.id === "casting.cast")!;
    const pins = def.pins({
      defaultClassId: "Actor",
      resultKind: "actorRef",
    });
    expect(pins.find((pin) => pin.id === "result")?.type).toEqual(
      actorRef("Actor"),
    );
  });

  it("types Result as an object ref for non-Actor classes", () => {
    const def = castingNodes.find((entry) => entry.id === "casting.cast")!;
    const pins = def.pins({
      defaultClassId: "GameInstance",
      resultKind: "objectRef",
    });
    expect(pins.find((pin) => pin.id === "result")?.type).toEqual(
      objectRef("GameInstance"),
    );
  });

  it("compiles Cast through ctx.isA and returns the instance or null", () => {
    const registry = createDefaultNodeRegistry();
    const properties = {
      defaultClassId: "Hero",
      "default:class": "Hero",
    };
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "cast", "casting.cast", properties),
        node(registry, "log", "debug.log"),
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
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.isA");
    expect(compiled.source).toContain('"Hero"');

    const checks: Array<{ instance: unknown; classId: unknown }> = [];
    const hero = { classId: "Hero" };
    loadBeginPlay(compiled.source)({
      self: hero,
      formatValue: String,
      isA: (instance: unknown, classId: unknown) => {
        checks.push({ instance, classId });
        return instance === hero && classId === "Hero";
      },
      log: () => {},
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((entry) => entry.instance === hero && entry.classId === "Hero")).toBe(
      true,
    );
  });
});
