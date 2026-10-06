import { describe, expect, it } from "vitest";
import type { TagRegistry } from "@babylonslate/core";
import {
  BOXED_WILDCARD,
  EXEC,
  STRING,
  compileGraph,
  compileTransitionRuleGraph,
  pin,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type PinType,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

const tagRegistry: TagRegistry = {
  tags: [
    { id: 1, path: "State", parentId: 0 },
    { id: 2, path: "State.Movement", parentId: 1 },
    { id: 3, path: "State.Movement.Running", parentId: 2 },
    { id: 4, path: "State.Combat", parentId: 1 },
    { id: 5, path: "Ability", parentId: 0 },
    { id: 6, path: "Ability.Jump", parentId: 5 },
  ],
  nextId: 7,
};

function loadEntry(source: string, name: string): (ctx: unknown) => unknown {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn ${name};`)() as (ctx: unknown) => unknown;
}

function fixture() {
  const registry = createDefaultNodeRegistry();
  registry.register({
    id: "test.captureTagResult",
    title: "Capture Result",
    category: "test",
    pins: (properties) => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      pin("value", "Value", "in", (properties.valueType as PinType | undefined) ?? BOXED_WILDCARD),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.capture(${JSON.stringify(ctx.node.properties.label)}, ${ctx.input("value")});`);
    },
  });
  const graph: LogicGraph = { id: "tags", kind: "event", nodes: [], edges: [] };
  function add(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
    const definition = registry.get(typeId);
    if (!definition) throw new Error(`Missing node ${typeId}`);
    const node: GraphNode = {
      id,
      typeId,
      position: { x: 0, y: 0 },
      properties,
      pins: definition.pins(properties),
    };
    graph.nodes.push(node);
    return node;
  }
  function wire(source: GraphNode, sourcePinId: string, target: GraphNode, targetPinId: string) {
    graph.edges.push({
      id: `edge-${graph.edges.length}`,
      sourceNodeId: source.id,
      sourcePinId,
      targetNodeId: target.id,
      targetPinId,
    });
  }
  const begin = add("begin", "flow.event.beginPlay");
  let previous = begin;
  function chain(node: GraphNode) {
    wire(previous, "execOut", node, "execIn");
    previous = node;
  }
  function capture(source: GraphNode, pinId = "out", valueType?: PinType) {
    const sink = add(`capture-${source.id}`, "test.captureTagResult", {
      label: source.id,
      valueType,
    });
    wire(source, pinId, sink, "value");
    chain(sink);
  }
  function run(context: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {};
    const compiled = compileGraph(graph, { assetGuid: "tags", registry, tagRegistry });
    loadEntry(compiled.source, "onBeginPlay")({
      ...context,
      capture: (label: string, value: unknown) => { values[label] = value; },
    });
    return values;
  }
  return { registry, graph, begin, add, wire, chain, capture, run };
}

describe("compiled Tags", () => {
  it("keeps Tag literals numeric and resolves their display path from the project registry", () => {
    const f = fixture();
    const selected = f.add("selected", "tags.make", { "default:value": 3 });
    const empty = f.add("empty", "tags.make");
    const name = f.add("name", "tags.toString");
    const missing = f.add("missing", "tags.toString", { "default:value": 999 });
    f.wire(selected, "out", name, "value");
    for (const node of [selected, empty, name, missing]) f.capture(node);

    expect(f.run()).toEqual({ selected: 3, empty: 0, name: "State.Movement.Running", missing: "" });
  });

  it("preserves Tag IDs and TagContainer values through ordinary variable assignment and reads", () => {
    const f = fixture();
    const variables = new Map<string, unknown>();
    const tag = f.add("tag", "tags.make", { "default:value": 3 });
    const container = f.add("container", "tags.makeContainer", { "default:value": { Tags: [3, 6] } });
    for (const [id, typeId, typeClassId, source] of [
      ["CurrentTag", "tag", undefined, tag],
      ["CurrentTags", "struct", "engine:TagContainer", container],
    ] as const) {
      const properties = { variableName: id, typeId, typeClassId, implicitSelf: true };
      const set = f.add(`set-${id}`, "variables.set", properties);
      const get = f.add(id, "variables.get", properties);
      f.wire(source, "out", set, "value");
      f.chain(set);
      f.capture(get, "value");
    }

    const values = f.run({
      getVariable: (name: string) => variables.get(name),
      setVariable: (name: string, value: unknown) => { variables.set(name, value); },
    });
    expect(values).toEqual({ CurrentTag: 3, CurrentTags: { Tags: [3, 6] } });
    expect(variables.get("CurrentTag")).toBe(3);
    expect(variables.get("CurrentTags")).toEqual({ Tags: [3, 6] });
  });

  it.each([
    { value: 3, query: 3, exact: true, expected: true },
    { value: 3, query: 2, exact: true, expected: false },
    { value: 3, query: 2, exact: false, expected: true },
    { value: 3, query: 1, exact: false, expected: true },
    { value: 3, query: 4, exact: false, expected: false },
    { value: 2, query: 3, exact: false, expected: false },
    { value: 0, query: 0, exact: false, expected: false },
    { value: 999, query: 999, exact: true, expected: false },
    { value: 3, query: 999, exact: false, expected: false },
    { value: "3", query: 2, exact: false, expected: false },
    { value: 3.5, query: 2, exact: false, expected: false },
    { value: -3, query: 2, exact: false, expected: false },
  ])("matches $value against $query with exact=$exact as $expected", ({ value, query, exact, expected }) => {
    const f = fixture();
    const input = f.add("input", "variables.get", { variableName: "CurrentTag", typeId: "tag", implicitSelf: true });
    const matches = f.add("matches", "tags.matches", { "default:query": query, "default:exact": exact });
    f.wire(input, "value", matches, "value");
    f.capture(matches);

    expect(f.run({ getVariable: () => value })).toEqual({ matches: expected });
  });

  it("assigns Tags through typed writable references and rejects literal targets", () => {
    const f = fixture();
    const stored = new Map<string, unknown>();
    for (const [name, typeId, typeClassId, assignment, value] of [
      ["Current", "tag", undefined, "tags.assign", 3],
      ["CurrentTags", "struct", "engine:TagContainer", "tags.assignContainer", { Tags: [3, 3, 6] }],
    ] as const) {
      const target = f.add(`get-${name}`, "variables.get", { variableName: name, typeId, typeClassId, implicitSelf: true });
      const set = f.add(`assign-${name}`, assignment, { "default:value": value });
      f.wire(target, "value", set, "target");
      f.chain(set);
      f.capture(target, "value");
    }
    expect(f.run({
      getVariable: (name: string) => stored.get(name),
      variableReference: (_owner: unknown, name: string) => ({ set: (value: unknown) => { stored.set(name, value); } }),
    })).toEqual({ "get-Current": 3, "get-CurrentTags": { Tags: [3, 6] } });

    const invalid = fixture();
    const literal = invalid.add("literal", "tags.make", { "default:value": 3 });
    const assign = invalid.add("assign", "tags.assign");
    invalid.chain(assign);
    invalid.wire(literal, "out", assign, "target");
    expect(validateGraphs([invalid.graph], { assetGuid: "tags" }, { registry: invalid.registry }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "pin.invalid_reference", nodeId: "assign" })]));
  });

  it("distinguishes exact equality from hierarchy matching and rejects unknown selections as invalid", () => {
    const f = fixture();
    for (const [id, typeId, properties] of [
      ["same", "tags.equals", { "default:a": 3, "default:b": 3 }],
      ["ancestor", "tags.equals", { "default:a": 3, "default:b": 2 }],
      ["different", "tags.notEquals", { "default:a": 3, "default:b": 4 }],
      ["valid", "tags.isValid", { "default:value": 3 }],
      ["empty", "tags.isValid", { "default:value": 0 }],
      ["unknown", "tags.isValid", { "default:value": 999 }],
    ] as const) f.capture(f.add(id, typeId, properties));

    expect(f.run()).toEqual({ same: true, ancestor: false, different: true, valid: true, empty: false, unknown: false });
  });

  it("normalizes container literals and edits detached containers without changing the source", () => {
    const f = fixture();
    const source = { Tags: [3, 4] };
    const input = f.add("input", "variables.get", {
      variableName: "CurrentTags", typeId: "struct", typeClassId: "engine:TagContainer", implicitSelf: true,
    });
    f.capture(f.add("normalized", "tags.makeContainer", {
      "default:value": { Tags: [3, 3, 0, 4, -1, 1.25, "3"] },
    }));
    for (const [id, typeId, tag] of [
      ["added", "tags.add", 6],
      ["duplicate", "tags.add", 3],
      ["removed", "tags.remove", 3],
      ["parentRemoved", "tags.remove", 1],
      ["cleared", "tags.clear", undefined],
      ["count", "tags.count", undefined],
      ["empty", "tags.isEmpty", undefined],
    ] as const) {
      const operation = f.add(id, typeId, { "default:tag": tag });
      f.wire(input, "value", operation, "container");
      f.capture(operation);
    }
    f.capture(f.add("defaultEmpty", "tags.isEmpty"));
    const values = f.run({ getVariable: () => source });

    expect(values).toEqual({
      normalized: { Tags: [3, 4] },
      added: { Tags: [3, 4, 6] },
      duplicate: { Tags: [3, 4] },
      removed: { Tags: [4] },
      parentRemoved: { Tags: [3, 4] },
      cleared: { Tags: [] },
      count: 2,
      empty: false,
      defaultEmpty: true,
    });
    expect(source).toEqual({ Tags: [3, 4] });
    for (const key of ["added", "duplicate", "removed", "parentRemoved", "cleared"]) {
      expect(values[key]).not.toBe(source);
      expect((values[key] as { Tags: number[] }).Tags).not.toBe(source.Tags);
    }
  });

  it("evaluates exact and hierarchical container queries, including empty query sets", () => {
    const f = fixture();
    const container = { Tags: [3, 4] };
    for (const [id, typeId, properties] of [
      ["hasAncestor", "tags.has", { "default:tag": 2 }],
      ["hasExactAncestor", "tags.has", { "default:tag": 2, "default:exact": true }],
      ["hasUnknown", "tags.has", { "default:tag": 999 }],
      ["any", "tags.hasAny", { "default:queries": { Tags: [6, 2] } }],
      ["all", "tags.hasAll", { "default:queries": { Tags: [1, 4] } }],
      ["missing", "tags.hasAll", { "default:queries": { Tags: [2, 6] } }],
      ["noAny", "tags.hasAny", { "default:queries": { Tags: [] } }],
      ["allEmpty", "tags.hasAll", { "default:queries": { Tags: [] } }],
    ] as const) f.capture(f.add(id, typeId, { "default:container": container, ...properties }));

    expect(f.run()).toEqual({
      hasAncestor: true, hasExactAncestor: false, hasUnknown: false,
      any: true, all: true, missing: false, noAny: false, allEmpty: true,
    });
  });

  it("compares explicit container membership independently of order and duplicate entries", () => {
    const f = fixture();
    f.capture(f.add("same", "tags.containerEquals", {
      "default:a": { Tags: [3, 4] }, "default:b": { Tags: [4, 3, 4] },
    }));
    f.capture(f.add("different", "tags.containerEquals", {
      "default:a": { Tags: [3] }, "default:b": { Tags: [2] },
    }));
    expect(f.run()).toEqual({ same: true, different: false });
  });

  it("combines explicit Tag sets and returns detached arrays for array conversion", () => {
    const f = fixture();
    for (const [id, typeId] of [["union", "tags.union"], ["intersection", "tags.intersection"], ["difference", "tags.difference"]] as const) {
      f.capture(f.add(id, typeId, {
        "default:a": { Tags: [3, 4] }, "default:b": { Tags: [4, 6] },
      }));
    }
    const ids = [3, 3, 0, 4];
    const stored = { Tags: [3, 6] };
    const arrayVariable = f.add("arrayVariable", "variables.get", {
      variableName: "Ids", typeId: "tag", container: "array", implicitSelf: true,
    });
    const containerVariable = f.add("containerVariable", "variables.get", {
      variableName: "Stored", typeId: "struct", typeClassId: "engine:TagContainer", implicitSelf: true,
    });
    const fromArray = f.add("fromArray", "tags.fromArray");
    const toArray = f.add("toArray", "tags.toArray");
    f.wire(arrayVariable, "value", fromArray, "tags");
    f.wire(containerVariable, "value", toArray, "container");
    f.capture(fromArray);
    f.capture(toArray);
    const values = f.run({ getVariable: (name: string) => name === "Ids" ? ids : stored });

    expect(values).toEqual({
      union: { Tags: [3, 4, 6] }, intersection: { Tags: [4] }, difference: { Tags: [3] },
      fromArray: { Tags: [3, 4] }, toArray: [3, 6],
    });
    expect(values.toArray).not.toBe(stored.Tags);
    expect(ids).toEqual([3, 3, 0, 4]);
    expect(stored).toEqual({ Tags: [3, 6] });
  });

  it.each([false, true])("selects typed Tag and TagContainer values with a Boolean index of %s", (index) => {
    const f = fixture();
    f.capture(f.add("tag", "select.tag", { "default:index": index, "default:false": 3, "default:true": 6 }));
    f.capture(f.add("container", "select.tagContainer", {
      "default:index": index, "default:false": { Tags: [3, 4] }, "default:true": { Tags: [6] },
    }));
    expect(f.run()).toEqual(index
      ? { tag: 6, container: { Tags: [6] } }
      : { tag: 3, container: { Tags: [3, 4] } });
  });

  it.each([
    { value: 3, exact: false, expected: "running" },
    { value: 4, exact: false, expected: "state" },
    { value: 6, exact: false, expected: "other" },
    { value: 3, exact: true, expected: "running" },
    { value: 4, exact: undefined, expected: "other" },
    { value: 0, exact: false, expected: "other" },
  ])("selects the most specific case for Tag $value with exact=$exact", ({ value, exact, expected }) => {
    const f = fixture();
    const select = f.add("selected", "tags.select", {
      cases: [1, 2, 3], caseNames: { 1: "State", 2: "State.Movement", 3: "State.Movement.Running" },
      "default:index": value,
      "default:exact": exact,
      "default:option:1": "state",
      "default:option:2": "movement",
      "default:option:3": "running",
      "default:default": "other",
    });
    f.capture(select, "out", STRING);

    expect(f.run()).toEqual({ selected: expected });
  });

  it("uses the resolved type default for an unwired selected option without falling back to an ancestor", () => {
    const f = fixture();
    const selected = f.add("selected", "tags.select", {
      cases: [1, 2, 3],
      "default:index": 3, "default:exact": false,
      "default:option:1": "state", "default:option:2": "movement", "default:default": "other",
    });
    f.capture(selected, "out", STRING);

    expect(f.run()).toEqual({ selected: "" });
  });

  it.each([
    { value: 3, exact: false, unwired: false, expected: ["running"] },
    { value: 4, exact: false, unwired: false, expected: ["state"] },
    { value: 6, exact: false, unwired: false, expected: ["other"] },
    { value: 3, exact: true, unwired: false, expected: ["running"] },
    { value: 4, exact: undefined, unwired: false, expected: ["other"] },
    { value: 3, exact: false, unwired: true, expected: [] },
    { value: 3, exact: true, unwired: true, expected: [] },
  ])("switches Tag $value with exact=$exact and unwired=$unwired", ({ value, exact, unwired, expected }) => {
    const f = fixture();
    const selected = f.add("switch", "tags.switch", {
      cases: [1, 2, 3], caseNames: { 1: "State", 2: "State.Movement", 3: "State.Movement.Running" },
      "default:value": value, "default:exact": exact,
    });
    f.wire(f.begin, "execOut", selected, "execIn");
    for (const [pinId, message] of [["case:1", "state"], ["case:2", "movement"], ["case:3", "running"], ["default", "other"]] as const) {
      if (unwired && pinId === "case:3") continue;
      const log = f.add(message, "debug.log", { "default:message": message });
      f.wire(selected, pinId, log, "execIn");
    }
    const messages: string[] = [];
    f.run({
      formatValue: (input: unknown) => String(input),
      log: (_severity: string, _category: string, message: string) => { messages.push(message); },
    });

    expect(messages).toEqual(expected);
  });

  it("dispatches switch cases by their Tag IDs when display names are missing or duplicated", () => {
    const f = fixture();
    const selected = f.add("switch", "tags.switch", {
      cases: [1, 2, 3], "default:value": 2,
    });
    f.wire(f.begin, "execOut", selected, "execIn");
    for (const tag of [1, 2, 3]) {
      const result = f.add(`result-${tag}`, "test.captureTagResult", {
        label: `case-${tag}`, "default:value": tag,
      });
      f.wire(selected, `case:${tag}`, result, "execIn");
    }
    expect(f.run()).toEqual({ "case-2": 2 });
  });

  it("uses the same project hierarchy when compiling animation transition rules", () => {
    const f = fixture();
    const input = f.add("input", "variables.get", { variableName: "CurrentTag", typeId: "tag", implicitSelf: true });
    const matchesState = f.add("state", "tags.matches", { "default:query": 1 });
    const matchesCombat = f.add("combat", "tags.matches", { "default:query": 4 });
    const enter = f.add("enter", "anim.rule.enterState");
    const exit = f.add("exit", "anim.rule.exitState");
    f.wire(input, "value", matchesState, "value");
    f.wire(input, "value", matchesCombat, "value");
    f.wire(matchesState, "out", enter, "value");
    f.wire(matchesCombat, "out", exit, "value");
    const compiled = compileTransitionRuleGraph(f.graph, { assetGuid: "tag-rule", registry: f.registry, tagRegistry });
    const evaluate = loadEntry(compiled.source, "evaluate");

    expect(evaluate({ getVariable: () => 3 })).toEqual({ enter: true, exit: false });
    expect(evaluate({ getVariable: () => 4 })).toEqual({ enter: true, exit: true });
    expect(evaluate({ getVariable: () => 0 })).toEqual({ enter: false, exit: false });
  });
});
