import { describe, expect, it } from "vitest";
import {
  compileGraph,
  actorRef,
  BOOL,
  classRef,
  objectRef,
  wildcardConverterNodeId,
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

describe("wildcard conversions", () => {
  const registry = createDefaultNodeRegistry();
  const TO_INT = "wildcard.to_int";
  const TO_FLOAT = "wildcard.to_float";

  type Probe = {
    fallback?: unknown;
    isTag?: string;
    blackboard?: Record<string, unknown>;
    actorClassIds?: readonly string[];
  };

  /**
   * Wire `source.out` into a converter, Wildcard Type Of and Wildcard Is,
   * compile the graph, run Begin Play, and return what Set Blackboard saw.
   */
  function convert(source: GraphNode, converter: string, probe: Probe = {}) {
    const set = (id: string, key: string) =>
      node(registry, id, "bt.blackboard.set", { "default:key": key });
    const wire = (id: string, from: string, fromPin: string, to: string, toPin: string) => ({
      id,
      sourceNodeId: from,
      sourcePinId: fromPin,
      targetNodeId: to,
      targetPinId: toPin,
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        source,
        node(
          registry,
          "to",
          converter,
          probe.fallback === undefined ? {} : { "default:fallback": probe.fallback },
        ),
        node(registry, "typeOf", "wildcard.typeOf"),
        node(registry, "is", "wildcard.is", { "default:tag": probe.isTag ?? "" }),
        set("setSuccess", "success"),
        set("setValue", "value"),
        set("setTypeOf", "typeOf"),
        set("setIs", "is"),
      ],
      edges: [
        wire("x1", "begin", "execOut", "to", "execIn"),
        wire("x2", "to", "execOut", "setSuccess", "execIn"),
        wire("x3", "setSuccess", "execOut", "setValue", "execIn"),
        wire("x4", "setValue", "execOut", "setTypeOf", "execIn"),
        wire("x5", "setTypeOf", "execOut", "setIs", "execIn"),
        wire("d1", source.id, "out", "to", "in"),
        wire("d2", source.id, "out", "typeOf", "in"),
        wire("d3", source.id, "out", "is", "in"),
        wire("d4", "to", "success", "setSuccess", "value"),
        wire("d5", "to", "value", "setValue", "value"),
        wire("d6", "typeOf", "out", "setTypeOf", "value"),
        wire("d7", "is", "out", "setIs", "value"),
      ],
    };
    const writes: Record<string, unknown> = {};
    loadBeginPlay(compileGraph(graph, { assetGuid: "a", registry }).source)({
      getBlackboard: (key: string) => probe.blackboard?.[key],
      setBlackboard: (key: string, value: unknown) => {
        writes[key] = value;
      },
      isA: (instance: unknown, classId: string) =>
        classId === "Actor" &&
        (probe.actorClassIds ?? []).includes(
          (instance as { classId?: string }).classId ?? "",
        ),
      formatValue: String,
    });
    return writes;
  }

  const literal = (typeId: string, value: unknown) =>
    node(registry, "src", typeId, { "default:in": value });
  const blackboard = () => node(registry, "src", "bt.blackboard.get", { "default:key": "slot" });

  it("converts a typed source whose tag matches, including Int into Float", () => {
    expect(convert(literal("literal.makeInt", 5), TO_INT)).toMatchObject({
      success: true,
      value: 5,
    });
    expect(convert(literal("literal.makeInt", 5), TO_FLOAT)).toMatchObject({
      success: true,
      value: 5,
    });
  });

  it("returns the fallback when a typed source has another tag", () => {
    expect(convert(literal("literal.makeFloat", 2.5), TO_INT, { fallback: -1 })).toMatchObject({
      success: false,
      value: -1,
    });
  });

  it("reports a typed source's static tag from Type Of and Is", () => {
    // A whole Float stays `float`: the static type wins over the runtime value.
    expect(
      convert(literal("literal.makeFloat", 2), TO_INT, { fallback: -1, isTag: "float" }),
    ).toMatchObject({ success: false, value: -1, typeOf: "float", is: true });
  });

  it("tags an untyped runtime value by shape and unwraps a tagged box", () => {
    expect(
      convert(blackboard(), TO_INT, { blackboard: { slot: 7 }, isTag: "int" }),
    ).toEqual({ success: true, value: 7, typeOf: "int", is: true });
    expect(
      convert(blackboard(), TO_INT, { blackboard: { slot: 2.5 }, fallback: -1, isTag: "int" }),
    ).toEqual({ success: false, value: -1, typeOf: "float", is: false });
    expect(
      convert(blackboard(), TO_FLOAT, { blackboard: { slot: { tag: "float", value: 3 } } }),
    ).toMatchObject({ success: true, value: 3, typeOf: "float" });
    const hero = { classId: "Hero" };
    expect(
      convert(blackboard(), wildcardConverterNodeId(actorRef("Actor")), {
        blackboard: { slot: hero },
        actorClassIds: ["Hero"],
      }),
    ).toMatchObject({ success: true, value: hero, typeOf: "actorRef:Hero" });
  });
});
