import { describe, expect, it } from "vitest";
import {
  FLOAT,
  STRING,
  compileGraph,
  delegateOf,
  isAssignable,
  objectRef,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

const DAMAGE_SIGNATURE = [
  { name: "Damage", typeId: "float", direction: "in" },
  { name: "Instigator", typeId: "object", typeClassId: "Actor", direction: "in" },
];

function pinType(graphNode: GraphNode, pinId: string) {
  return graphNode.pins.find((entry) => entry.id === pinId)?.type;
}

/** Begin Play → Bind Event to the graph's own On Damaged, its Event wired from `source.sourcePin`. */
function bindGraph(registry: NodeRegistry, source: GraphNode, sourcePin: string): LogicGraph {
  return {
    id: "g",
    kind: "event",
    nodes: [
      node(registry, "begin", "flow.event.beginPlay"),
      node(registry, "bind", "flow.dispatcher.bind", { name: "On Damaged", classId: "Bar", implicitSelf: true, pins: DAMAGE_SIGNATURE }),
      source,
    ],
    edges: [
      { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "bind", targetPinId: "execIn" },
      { id: "e2", sourceNodeId: source.id, sourcePinId: sourcePin, targetNodeId: "bind", targetPinId: "event" },
    ],
  };
}

/** Runs the compiled Begin Play with `ctx` overrides and returns what Bind received. */
function bindCalls(graph: LogicGraph, registry: NodeRegistry, ctx: Record<string, unknown>): unknown[][] {
  const compiled = compileGraph(graph, { assetGuid: "a", registry, className: "Bar" });
  const run = new Function(`${compiled.source.replace(/^export /gm, "")}\nreturn onBeginPlay;`)() as (context: unknown) => void;
  const calls: unknown[][] = [];
  run({
    self: "bar",
    nullAccess: () => {},
    getVariable: () => null,
    eventDelegate: (...args: unknown[]) => ({ delegate: args }),
    bindDispatcher: (...args: unknown[]) => calls.push(args),
    ...ctx,
  });
  return calls;
}

describe("Event Dispatcher nodes", () => {
  it("give Bind's Event the dispatcher's input types and accept a custom event with the same inputs", () => {
    const registry = createDefaultNodeRegistry();
    const bind = node(registry, "bind", "flow.dispatcher.bind", { name: "On Damaged", classId: "Enemy", pins: DAMAGE_SIGNATURE });
    const matching = node(registry, "event", "flow.event.custom", {
      name: "Enemy Damaged",
      pins: [
        { name: "Amount", typeId: "float", direction: "out" },
        { name: "By", typeId: "object", typeClassId: "Actor", direction: "out" },
      ],
    });
    const fewer = node(registry, "fewer", "flow.event.custom", {
      name: "Hit", pins: [{ name: "Amount", typeId: "float", direction: "out" }],
    });

    expect(pinType(bind, "event")).toEqual(delegateOf([FLOAT, objectRef("Actor")]));
    expect(isAssignable(pinType(matching, "OutputDelegate")!, pinType(bind, "event")!)).toBe(true);
    expect(isAssignable(pinType(fewer, "OutputDelegate")!, pinType(bind, "event")!)).toBe(false);
  });

  it("draws a custom event's delegate in the title bar and moves an output named OutputDelegate aside", () => {
    const registry = createDefaultNodeRegistry();
    const event = node(registry, "event", "flow.event.custom", {
      name: "Ping", pins: [{ name: "OutputDelegate", typeId: "string", direction: "out" }],
    });

    expect(event.pins.map((entry) => [entry.id, entry.placement ?? "row"])).toEqual([
      ["execOut", "row"],
      ["OutputDelegate", "header"],
      ["OutputDelegate__arg", "row"],
    ]);
    expect(pinType(event, "OutputDelegate")).toEqual(delegateOf([STRING]));
  });

  it("compiles a custom event's delegate to the event on Self with its parameter names", () => {
    const registry = createDefaultNodeRegistry();
    const event = node(registry, "event", "flow.event.custom", {
      name: "Enemy Damaged",
      pins: [
        { name: "Amount", typeId: "float", direction: "out" },
        { name: "By", typeId: "object", typeClassId: "Actor", direction: "out" },
      ],
    });

    expect(bindCalls(bindGraph(registry, event, "OutputDelegate"), registry, {}))
      .toEqual([["bar", "On_Damaged", { delegate: ["bar", "Enemy_Damaged", "event", ["Amount", "By"]] }]]);
  });

  it("compiles Create Event to the chosen function on its Object, and to no delegate without one", () => {
    const registry = createDefaultNodeRegistry();
    const chosen = node(registry, "create", "flow.delegate.create", {
      classId: "Bar", memberName: "Take Hit", memberKind: "function", pins: DAMAGE_SIGNATURE,
    });
    const empty = node(registry, "create", "flow.delegate.create", { classId: "Bar" });

    expect(pinType(chosen, "event")).toEqual(delegateOf([FLOAT, objectRef("Actor")]));
    expect(bindCalls(bindGraph(registry, chosen, "event"), registry, {}))
      .toEqual([["bar", "On_Damaged", { delegate: ["bar", "Take_Hit", "function", ["Damage", "Instigator"]] }]]);
    // Bind's Event is a subject: with no delegate the node is skipped.
    expect(bindCalls(bindGraph(registry, empty, "event"), registry, {})).toEqual([]);
  });

  it("passes Call's values in signature order", () => {
    const registry = createDefaultNodeRegistry();
    const call = node(registry, "call", "flow.dispatcher.call", {
      name: "On Damaged", classId: "Enemy", implicitSelf: true, pins: DAMAGE_SIGNATURE, "default:Damage": 7,
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [node(registry, "begin", "flow.event.beginPlay"), call],
      edges: [{ id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "call", targetPinId: "execIn" }],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry, className: "Enemy" });
    const run = new Function(`${compiled.source.replace(/^export /gm, "")}\nreturn onBeginPlay;`)() as (context: unknown) => void;
    const calls: unknown[][] = [];
    run({ self: "enemy", callDispatcher: (...args: unknown[]) => calls.push(args) });

    expect(calls).toEqual([["enemy", "On_Damaged", [7, null]]]);
  });
});

describe("Delegate signature rows", () => {
  it("type a Delegate parameter by its signature", () => {
    const registry = createDefaultNodeRegistry();
    const call = node(registry, "call", "functions.call", {
      functionName: "Watch", classId: "Bar", implicitSelf: true,
      pins: [{ name: "Callback", typeId: "delegate", direction: "in", signature: [{ typeId: "float" }, { typeId: "string" }] }],
    });

    expect(pinType(call, "Callback")).toEqual(delegateOf([FLOAT, STRING]));
  });
});
