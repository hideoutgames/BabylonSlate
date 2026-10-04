import { describe, expect, it } from "vitest";
import { compileGraph, compileTransitionRuleGraph } from "./compile";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC, FLOAT, BOOL, VEC3 } from "./types";
import type { GraphNode, LogicGraph } from "./ir";

function fixture(depth: number, volatile = false) {
  const registry = new NodeRegistry();
  registry.registerAll([
    { id: "flow.event.beginPlay", title: "Begin", category: "flow", pins: () => [pin("execOut", "then", "out", EXEC)], codegen: () => {} },
    { id: "value", title: "Value", category: "math", pure: true, referentiallyTransparent: !volatile,
      pins: () => [pin("out", "out", "out", FLOAT)], codegen: () => ({ out: volatile ? "ctx.read()" : "1" }) },
    { id: "add", title: "Add", category: "math", pure: true, referentiallyTransparent: true,
      pins: () => [pin("a", "a", "in", FLOAT), pin("b", "b", "in", FLOAT), pin("out", "out", "out", FLOAT)],
      codegen: (ctx) => ({ out: `(${ctx.input("a")} + ${ctx.input("b")})` }) },
    { id: "select", title: "Select", category: "math", pure: true,
      pins: () => [pin("value", "value", "in", FLOAT), pin("out", "out", "out", FLOAT)],
      codegen: (ctx) => ({ out: `ctx.enabled ? ${ctx.input("value")} : 0` }) },
    { id: "positive", title: "Positive", category: "math", pure: true, referentiallyTransparent: true,
      pins: () => [pin("value", "value", "in", FLOAT), pin("out", "out", "out", BOOL)], codegen: (ctx) => ({ out: `${ctx.input("value")} > 0` }) },
    { id: "anim.rule.enterState", title: "Enter", category: "animation", pins: () => [pin("value", "value", "in", BOOL)], codegen: () => {} },
    { id: "log", title: "Log", category: "debug", pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), pin("value", "value", "in", FLOAT)],
      codegen: (ctx) => ctx.emit(`ctx.log(${ctx.input("value")});`) },
  ]);
  const node = (id: string, typeId: string): GraphNode => ({ id, typeId, position: { x: 0, y: 0 }, properties: {}, pins: registry.get(typeId)!.pins({}) });
  const graph: LogicGraph = { id: "dag", kind: "event", nodes: [node("begin", "flow.event.beginPlay"), node("value", "value")], edges: [] };
  const wire = (from: string, to: string, input: string, output = "out") => graph.edges.push({ id: `edge-${graph.edges.length}`, sourceNodeId: from, sourcePinId: output, targetNodeId: to, targetPinId: input });
  let last = "value";
  for (let i = 0; i < depth; i++) {
    const id = `add-${i}`;
    graph.nodes.push(node(id, "add")); wire(last, id, "a"); wire(last, id, "b"); last = id;
  }
  graph.nodes.push(node("select", "select"), node("log1", "log"), node("log2", "log"));
  wire(last, "select", "value"); wire("select", "log1", "value"); wire("select", "log2", "value");
  wire("begin", "log1", "execIn", "execOut"); wire("log1", "log2", "execIn", "execOut");
  return { graph, registry, node, wire, last };
}

function entry(source: string, name: string): (ctx: unknown) => unknown {
  return new Function(`${source.replace(/export function /g, "function ")}\nreturn ${name};`)();
}

describe("shared pure expression compilation", () => {
  it("does not share mutable output allocations between reads", () => {
    const { graph, registry, node, wire } = fixture(0);
    registry.register({ id: "vector", title: "Vector", category: "math", pure: true, referentiallyTransparent: true,
      pins: () => [pin("out", "out", "out", VEC3)], codegen: () => ({ out: `({ x: ${"1 + ".repeat(150)}0, y: 2, z: 3 })` }) });
    registry.register({ id: "compare", title: "Compare", category: "debug",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("a", "a", "in", VEC3), pin("b", "b", "in", VEC3)],
      codegen: (ctx) => ctx.emit(`ctx.log(${ctx.input("a")} === ${ctx.input("b")});`) });
    graph.edges = [];
    graph.nodes.push(node("vector", "vector"), node("compare", "compare"));
    wire("begin", "compare", "execIn", "execOut"); wire("vector", "compare", "a"); wire("vector", "compare", "b");
    const values: unknown[] = [];
    entry(compileGraph(graph, { assetGuid: "mutable", registry }).source, "onBeginPlay")({ log: (value: unknown) => values.push(value) });
    expect(values).toEqual([false]);
  });

  it("keeps deep DAG source bounded in events and transition rules", () => {
    const { graph, registry, node, wire, last } = fixture(16);
    const compiled = compileGraph(graph, { assetGuid: "dag", registry });
    expect(compiled.source.length).toBeLessThan(20_000);
    const values: unknown[] = [];
    entry(compiled.source, "onBeginPlay")({ enabled: true, log: (value: unknown) => values.push(value) });
    expect(values).toEqual([65_536, 65_536]);
    graph.nodes.push(node("positive", "positive"), node("enter", "anim.rule.enterState"));
    wire(last, "positive", "value"); wire("positive", "enter", "value");
    const transition = compileTransitionRuleGraph(graph, { assetGuid: "dag", registry });
    expect(transition.source.length).toBeLessThan(20_000);
    expect(entry(transition.source, "evaluate")({})).toEqual({ enter: true, exit: true });
  });

  it("preserves short-circuit laziness, volatile read counts, and writes between consumers", () => {
    const { graph, registry } = fixture(8, true);
    const run = entry(compileGraph(graph, { assetGuid: "volatile", registry }).source, "onBeginPlay");
    let reads = 0, current = 1;
    const values: unknown[] = [];
    const ctx = { enabled: false, read: () => { reads++; return current; }, log: (value: unknown) => { values.push(value); current++; } };
    run(ctx);
    expect(reads).toBe(0);
    expect(values).toEqual([0, 0]);
    ctx.enabled = true; current = 1; values.length = 0;
    run(ctx);
    expect(reads).toBe(512);
    expect(values).toEqual([256, 512]);
  });
});
