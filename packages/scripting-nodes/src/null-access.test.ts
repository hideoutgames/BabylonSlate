import { describe, expect, it } from "vitest";
import {
  compileGraph,
  validateGraphs,
  type GraphEdge,
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

function edge(source: string, sourcePin: string, target: string, targetPin: string): GraphEdge {
  return {
    id: `${source}.${sourcePin}->${target}.${targetPin}`,
    sourceNodeId: source,
    sourcePinId: sourcePin,
    targetNodeId: target,
    targetPinId: targetPin,
  };
}

type Subject = {
  typeId: string;
  properties: Record<string, unknown>;
  /** The Target input and the context method the node calls with it. */
  pin: string;
  method: string;
  /** A pure node's value is printed; a statement is reached from Begin Play. */
  pure: boolean;
};

/** One run of Begin Play with the subject's Target input unwired, wired to `value`, or wired to null. */
function run(registry: NodeRegistry, subject: Subject, wiring: { wired: false } | { wired: true; value: unknown }) {
  const nodes = [node(registry, "begin", "flow.event.beginPlay"), node(registry, "subject", subject.typeId, subject.properties)];
  const edges: GraphEdge[] = [];
  if (subject.pure) {
    nodes.push(node(registry, "print", "debug.print"));
    edges.push(edge("begin", "execOut", "print", "execIn"), edge("subject", "out", "print", "value"));
  } else {
    edges.push(edge("begin", "execOut", "subject", "execIn"));
  }
  if (wiring.wired) {
    nodes.push(node(registry, "source", "actor.getOfClass"));
    edges.push(edge("source", "out", "subject", subject.pin));
  }
  const graph: LogicGraph = { id: "g", kind: "event", nodes, edges };
  const compiled = compileGraph(graph, { assetGuid: "a", registry, className: "Hero" });
  const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const onBeginPlay = new Function(`${body}\nreturn { onBeginPlay };`)().onBeginPlay as (ctx: unknown) => void;
  const self = { who: "self" };
  const calls: unknown[][] = [];
  const logged: string[] = [];
  const printed: unknown[] = [];
  const spy = (...args: unknown[]) => {
    calls.push(args);
    return {};
  };
  onBeginPlay({
    self,
    getActorOfClass: () => (wiring.wired ? wiring.value : null),
    nullAccess: (message: string) => logged.push(message),
    formatValue: (value: unknown) => value,
    print: (value: unknown) => printed.push(value),
    invokeFunction: spy,
    invokeCustomEvent: spy,
    callInterface: spy,
    getComponent: spy,
  });
  const diagnostics = validateGraphs([graph], { assetGuid: "a" }, { registry });
  return {
    calls,
    logged,
    printed,
    self,
    missing: diagnostics.filter((entry) => entry.code === "pin.missing_input" && entry.nodeId === "subject" && entry.pinId === subject.pin),
  };
}

/** Member calls and Get Component Ref: bound to the graph's own class (`implicitSelf`) or another's. */
function members(implicitSelf: boolean): Array<Subject & { title: string }> {
  const common = { implicitSelf, classId: "Hero" };
  return [
    { title: "Call Jump", typeId: "functions.call", properties: { ...common, functionName: "Jump", pins: [], title: "Call Jump" }, pin: "target", method: "invokeFunction", pure: false },
    { title: "Call Alert", typeId: "flow.event.call", properties: { ...common, name: "Alert", pins: [], title: "Call Alert" }, pin: "target", method: "invokeCustomEvent", pure: false },
    { title: "Call Interface Hit", typeId: "interface.call", properties: { ...common, interfaceGuid: "iface", method: "Hit", pins: [], title: "Call Interface Hit" }, pin: "target", method: "callInterface", pure: false },
    { title: "Get Component Ref", typeId: "component.getNamed", properties: { ...common, componentClassId: "MeshComponent", title: "Get Component Ref" }, pin: "actor", method: "getComponent", pure: true },
  ];
}

describe("calls on the graph's own class", () => {
  const registry = createDefaultNodeRegistry();

  it.each(members(true))("$typeId shows a Target pin that reads Self while unwired", (subject) => {
    const target = registry.get(subject.typeId)!.pins(subject.properties).find((entry) => entry.id === subject.pin);
    expect(target).toMatchObject({ name: expect.stringMatching(/^[Tt]arget$/), optional: true, selfWhenUnwired: true, subject: true });
    const result = run(registry, subject, { wired: false });
    expect(result.calls.map((call) => call[0])).toEqual([result.self]);
    expect(result.logged).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it.each(members(true))("$typeId calls another instance when one is wired in", (subject) => {
    const other = { who: "other" };
    const result = run(registry, subject, { wired: true, value: other });
    expect(result.calls.map((call) => call[0])).toEqual([other]);
    expect(result.logged).toEqual([]);
  });

  it.each(members(true))("$typeId does nothing and logs when the wired Target is null", (subject) => {
    const result = run(registry, subject, { wired: true, value: null });
    expect(result.calls).toEqual([]);
    expect(result.logged).toEqual([`Hero: ${subject.title} (Target) tried to access null.`]);
  });

  it("keeps variables of the graph's own class without a Target pin", () => {
    for (const typeId of ["variables.get", "variables.set", "variables.getValidated"]) {
      const pins = registry.get(typeId)!.pins({ variableName: "Health", typeId: "float", classId: "Hero", implicitSelf: true });
      expect(pins.map((entry) => entry.id)).not.toContain("target");
    }
  });

  it("gives a Function Library call no Target at all", () => {
    const pins = registry.get("functions.call")!.pins({ functionName: "Mix", classId: "Lib", implicitSelf: true, static: true, pins: [] });
    expect(pins.map((entry) => entry.id)).not.toContain("target");
  });
});

describe("members of another class", () => {
  const registry = createDefaultNodeRegistry();

  it.each(members(false))("$typeId needs its Target wired", (subject) => {
    const target = registry.get(subject.typeId)!.pins(subject.properties).find((entry) => entry.id === subject.pin);
    expect(target).toMatchObject({ subject: true });
    expect(target?.optional).toBeFalsy();
    expect(target?.selfWhenUnwired).toBeUndefined();
    const result = run(registry, subject, { wired: false });
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({ severity: "error", message: 'Required input "Target" is not connected' });
    // Self is not that class: the call is skipped, not made on the running object.
    expect(result.calls).toEqual([]);
    expect(result.logged).toEqual([`Hero: ${subject.title} (Target) tried to access null.`]);
  });

  it.each(members(false))("$typeId does nothing and logs when the wired Target is null", (subject) => {
    const result = run(registry, subject, { wired: true, value: null });
    expect(result.calls).toEqual([]);
    expect(result.logged).toEqual([`Hero: ${subject.title} (Target) tried to access null.`]);
  });

  it.each(members(false))("$typeId calls the wired object", (subject) => {
    const other = { who: "other" };
    expect(run(registry, subject, { wired: true, value: other }).calls.map((call) => call[0])).toEqual([other]);
  });

  it.each(["variables.get", "variables.set", "variables.getValidated"])("%s on another class has a required Target pin", (typeId) => {
    const target = registry.get(typeId)!.pins({ variableName: "Health", typeId: "float", classId: "Boss", implicitSelf: false }).find((entry) => entry.id === "target");
    expect(target).toMatchObject({ subject: true });
    expect(target?.optional).toBeFalsy();
  });
});

describe("inputs where null is a legitimate value", () => {
  const registry = createDefaultNodeRegistry();

  function runGraph(nodes: GraphNode[], edges: GraphEdge[], extras: Record<string, unknown> = {}) {
    const compiled = compileGraph({ id: "g", kind: "event", nodes, edges }, { assetGuid: "a", registry, className: "Hero" });
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`${body}\nreturn { onBeginPlay };`)().onBeginPlay as (ctx: unknown) => void;
    const logged: string[] = [];
    const calls: unknown[][] = [];
    onBeginPlay({
      self: { who: "self" },
      getActorOfClass: () => ({ who: "other" }),
      nullAccess: (message: string) => logged.push(message),
      formatValue: String,
      print: () => {},
      setOwner: (...args: unknown[]) => calls.push(["setOwner", ...args]),
      attachActor: (...args: unknown[]) => calls.push(["attachActor", ...args]),
      attachToBone: (...args: unknown[]) => calls.push(["attachToBone", ...args]),
      setVariable: (...args: unknown[]) => calls.push(["setVariable", ...args]),
      ...extras,
    });
    return { logged, calls };
  }

  it("Set Owner clears the owner and Attach Actor detaches without an error", () => {
    const { logged, calls } = runGraph(
      [node(registry, "begin", "flow.event.beginPlay"), node(registry, "source", "actor.getOfClass"), node(registry, "owner", "actor.setOwner"), node(registry, "attach", "actor.attach")],
      [edge("begin", "execOut", "owner", "execIn"), edge("owner", "execOut", "attach", "execIn"),
        edge("source", "out", "owner", "target"), edge("source", "out", "attach", "target")],
    );
    // Owner and Parent are left empty on purpose.
    expect(calls).toEqual([["setOwner", { who: "other" }, null], ["attachActor", { who: "other" }, null]]);
    expect(logged).toEqual([]);
  });

  it("Is Valid answers false for an empty reference without an error", () => {
    const printed: unknown[] = [];
    const { logged } = runGraph(
      [node(registry, "begin", "flow.event.beginPlay"), node(registry, "valid", "actor.isValid"), node(registry, "print", "debug.print")],
      [edge("begin", "execOut", "print", "execIn"), edge("valid", "out", "print", "value")],
      { formatValue: (value: unknown) => { printed.push(value); return String(value); } },
    );
    expect(printed).toEqual([false]);
    expect(logged).toEqual([]);
  });

  it("Set Variable stores an empty value without an error", () => {
    const { logged, calls } = runGraph(
      [node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "set", "variables.set", { variableName: "Rival", typeId: "actor", classId: "Hero", implicitSelf: true })],
      [edge("begin", "execOut", "set", "execIn")],
    );
    expect(calls).toEqual([["setVariable", "Rival", null]]);
    expect(logged).toEqual([]);
  });
});
