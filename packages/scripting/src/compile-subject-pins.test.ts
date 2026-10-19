import { describe, expect, it } from "vitest";
import { compileGraph, compileTransitionRuleGraph } from "./compile";
import { NodeRegistry, pin } from "./node-registry";
import { BOOL, EXEC, FLOAT, actorRef, objectRef } from "./types";
import type { GraphNode, GraphPin, LogicGraph } from "./ir";

const actor = actorRef("Actor");
const subject = (id: string, name: string): GraphPin => ({ ...pin(id, name, "in", actor), subject: true });
const selfSubject = (id: string, name: string): GraphPin => ({
  ...pin(id, name, "in", actor, "data", true),
  subject: true,
  selfWhenUnwired: true,
});

function registry(): NodeRegistry {
  const nodes = new NodeRegistry();
  nodes.registerAll([
    { id: "flow.event.beginPlay", title: "Begin", category: "flow", pins: () => [pin("execOut", "then", "out", EXEC)], codegen: () => {} },
    // A pure source whose value comes from the test.
    { id: "source", title: "Source", category: "test", pure: true, pins: () => [pin("out", "out", "out", actor)],
      codegen: () => ({ out: "ctx.read()" }) },
    // A statement node: acts on its Target, writes an output.
    { id: "act", title: "Act", category: "test",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), subject("target", "Target"),
        pin("amount", "Amount", "in", FLOAT, "data", true, 1), pin("result", "Result", "out", FLOAT)],
      codegen: (ctx) => ctx.emit(`${ctx.output("result")} = ctx.act(${ctx.input("target")}, ${ctx.input("amount")});`) },
    // Target reads Self while unwired.
    { id: "selfAct", title: "Self Act", category: "test",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), selfSubject("actor", "Actor")],
      codegen: (ctx) => ctx.emit(`ctx.selfAct(${ctx.input("actor")});`) },
    // A pure node reading its Target.
    { id: "read", title: "Read", category: "test", pure: true,
      pins: () => [subject("target", "Target"), pin("value", "Value", "out", FLOAT)],
      codegen: (ctx) => ({ value: `${ctx.input("target")}.value` }) },
    { id: "both", title: "Both", category: "test", pure: true,
      pins: () => [subject("first", "First"), subject("second", "Second"), pin("value", "Value", "out", FLOAT)],
      codegen: (ctx) => ({ value: `${ctx.input("first")}.value + ${ctx.input("second")}.value` }) },
    // Null is a legitimate value here: no subject flag.
    { id: "holder", title: "Holder", category: "test",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), pin("owner", "Owner", "in", actor)],
      codegen: (ctx) => ctx.emit(`ctx.hold(${ctx.input("owner")});`) },
    // Its work is the continuation: Completed runs only when the wait finishes.
    { id: "wait", title: "Wait", category: "test", latent: true,
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "Completed", "out", EXEC), subject("target", "Target")],
      codegen: (ctx) => ctx.continueIf?.(`await ctx.wait(${ctx.input("target")})`) },
    { id: "log", title: "Log", category: "test",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), pin("value", "Value", "in", FLOAT)],
      codegen: (ctx) => ctx.emit(`ctx.log(${ctx.input("value")});`) },
    { id: "anim.rule.enterState", title: "Enter", category: "animation", pins: () => [pin("value", "value", "in", BOOL)], codegen: () => {} },
    { id: "positive", title: "Positive", category: "test", pure: true,
      pins: () => [subject("target", "Target"), pin("value", "Value", "out", BOOL)],
      codegen: (ctx) => ({ value: `${ctx.input("target")}.value > 0` }) },
  ]);
  return nodes;
}

function node(nodes: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, properties, pins: nodes.get(typeId)!.pins(properties) };
}

function wire(from: string, fromPin: string, to: string, toPin: string) {
  return { id: `${from}.${fromPin}->${to}.${toPin}`, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: toPin };
}

function beginPlayOf(source: string): (ctx: unknown) => unknown {
  return new Function(`${source.replace(/export\s+(async\s+)?function /g, "$1function ")}\nreturn onBeginPlay;`)() as (ctx: unknown) => unknown;
}

/** Test context: `read` returns `value` and every call is recorded in order. */
function runContext(value: unknown) {
  const calls: unknown[][] = [];
  const record = (name: string, result?: unknown) => (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  let reads = 0;
  return {
    calls,
    reads: () => reads,
    ctx: {
      self: { who: "self" },
      read: () => { reads += 1; return value; },
      act: record("act", 42),
      selfAct: record("selfAct"),
      hold: record("hold"),
      wait: record("wait", true),
      log: record("log"),
      nullAccess: record("nullAccess"),
    },
  };
}

describe("subject input guard", () => {
  const nodes = registry();
  const compile = (graph: LogicGraph, className = "Hero") => compileGraph(graph, { assetGuid: "a", registry: nodes, className });

  function actGraph(properties: Record<string, unknown> = {}): LogicGraph {
    return {
      id: "g", kind: "event",
      nodes: [node(nodes, "begin", "flow.event.beginPlay"), node(nodes, "source", "source"), node(nodes, "act", "act", properties), node(nodes, "log", "log")],
      edges: [wire("begin", "execOut", "act", "execIn"), wire("source", "out", "act", "target"), wire("act", "execOut", "log", "execIn"), wire("act", "result", "log", "value")],
    };
  }

  it("skips a statement whose subject is null, logs the class, node and pin, and continues with default outputs", () => {
    const run = runContext(null);
    beginPlayOf(compile(actGraph()).source)(run.ctx);
    expect(run.calls).toEqual([
      ["nullAccess", "Hero: Act (Target) tried to access null."],
      ["log", 0],
    ]);
  });

  it("runs the statement when the subject is not null", () => {
    const run = runContext({ who: "other" });
    beginPlayOf(compile(actGraph()).source)(run.ctx);
    expect(run.calls).toEqual([["act", { who: "other" }, 1], ["log", 42]]);
  });

  it("logs on every run and not only the first", () => {
    const run = runContext(null);
    const onBeginPlay = beginPlayOf(compile(actGraph()).source);
    onBeginPlay(run.ctx);
    onBeginPlay(run.ctx);
    expect(run.calls.filter(([name]) => name === "nullAccess")).toHaveLength(2);
  });

  it("names the node by its authored title", () => {
    const graph = actGraph({ title: "Hit The Thing" });
    const run = runContext(null);
    beginPlayOf(compile(graph, "My_Hero").source)(run.ctx);
    expect(run.calls[0]).toEqual(["nullAccess", "My_Hero: Hit The Thing (Target) tried to access null."]);
  });

  it("evaluates the subject input once", () => {
    const run = runContext({ who: "other" });
    beginPlayOf(compile(actGraph()).source)(run.ctx);
    expect(run.reads()).toBe(1);
  });

  it("passes an input that is not a subject through even when it is null", () => {
    const graph: LogicGraph = {
      id: "g", kind: "event",
      nodes: [node(nodes, "begin", "flow.event.beginPlay"), node(nodes, "source", "source"), node(nodes, "hold", "holder")],
      edges: [wire("begin", "execOut", "hold", "execIn"), wire("source", "out", "hold", "owner")],
    };
    const run = runContext(null);
    beginPlayOf(compile(graph).source)(run.ctx);
    expect(run.calls).toEqual([["hold", null]]);
  });

  it("does not complete a continuation node whose subject is null", async () => {
    const graph: LogicGraph = {
      id: "g", kind: "event",
      nodes: [node(nodes, "begin", "flow.event.beginPlay"), node(nodes, "source", "source"), node(nodes, "wait", "wait"), node(nodes, "log", "log")],
      edges: [wire("begin", "execOut", "wait", "execIn"), wire("source", "out", "wait", "target"), wire("wait", "execOut", "log", "execIn")],
    };
    const empty = runContext(null);
    await beginPlayOf(compile(graph).source)(empty.ctx);
    expect(empty.calls).toEqual([["nullAccess", "Hero: Wait (Target) tried to access null."]]);
    const live = runContext({ who: "other" });
    await beginPlayOf(compile(graph).source)(live.ctx);
    expect(live.calls).toEqual([["wait", { who: "other" }], ["log", 0]]);
  });

  describe("pure nodes", () => {
    function readGraph(): LogicGraph {
      return {
        id: "g", kind: "event",
        nodes: [node(nodes, "begin", "flow.event.beginPlay"), node(nodes, "source", "source"), node(nodes, "read", "read"), node(nodes, "log1", "log"), node(nodes, "log2", "log")],
        edges: [wire("begin", "execOut", "log1", "execIn"), wire("log1", "execOut", "log2", "execIn"), wire("source", "out", "read", "target"),
          wire("read", "value", "log1", "value"), wire("read", "value", "log2", "value")],
      };
    }

    it("returns the output default for a null subject and logs each time the value is read", () => {
      const run = runContext(null);
      beginPlayOf(compile(readGraph()).source)(run.ctx);
      expect(run.calls).toEqual([
        ["nullAccess", "Hero: Read (Target) tried to access null."],
        ["log", 0],
        ["nullAccess", "Hero: Read (Target) tried to access null."],
        ["log", 0],
      ]);
    });

    it("reads the value when the subject is not null", () => {
      const run = runContext({ value: 7 });
      beginPlayOf(compile(readGraph()).source)(run.ctx);
      expect(run.calls).toEqual([["log", 7], ["log", 7]]);
    });

    it("logs every null subject, not only the first", () => {
      const graph: LogicGraph = {
        id: "g", kind: "event",
        nodes: [node(nodes, "begin", "flow.event.beginPlay"), node(nodes, "source", "source"), node(nodes, "both", "both"), node(nodes, "log", "log")],
        edges: [wire("begin", "execOut", "log", "execIn"), wire("source", "out", "both", "first"), wire("source", "out", "both", "second"), wire("both", "value", "log", "value")],
      };
      const run = runContext(null);
      beginPlayOf(compile(graph).source)(run.ctx);
      expect(run.calls).toEqual([
        ["nullAccess", "Hero: Both (First) tried to access null."],
        ["nullAccess", "Hero: Both (Second) tried to access null."],
        ["log", 0],
      ]);
    });

    it("guards transition rule graphs the same way", () => {
      const graph: LogicGraph = {
        id: "rule", kind: "event",
        nodes: [node(nodes, "source", "source"), node(nodes, "positive", "positive"), node(nodes, "enter", "anim.rule.enterState")],
        edges: [wire("source", "out", "positive", "target"), wire("positive", "value", "enter", "value")],
      };
      const compiled = compileTransitionRuleGraph(graph, { assetGuid: "a", registry: nodes, className: "Hero" });
      const evaluate = new Function(`${compiled.source.replace(/export function /g, "function ")}\nreturn evaluate;`)() as (ctx: unknown) => unknown;
      const run = runContext(null);
      expect(evaluate(run.ctx)).toMatchObject({ enter: false });
      expect(run.calls).toEqual([["nullAccess", "Hero: Positive (Target) tried to access null."]]);
    });
  });

  describe("pins that read Self while unwired", () => {
    function selfGraph(wired: boolean): LogicGraph {
      return {
        id: "g", kind: "event",
        nodes: [node(nodes, "begin", "flow.event.beginPlay"), node(nodes, "source", "source"), node(nodes, "selfAct", "selfAct")],
        edges: [wire("begin", "execOut", "selfAct", "execIn"), ...(wired ? [wire("source", "out", "selfAct", "actor")] : [])],
      };
    }

    it("passes Self while unwired without logging", () => {
      const run = runContext({ who: "other" });
      beginPlayOf(compile(selfGraph(false)).source)(run.ctx);
      expect(run.calls).toEqual([["selfAct", { who: "self" }]]);
    });

    it("uses a wired reference as is", () => {
      const run = runContext({ who: "other" });
      beginPlayOf(compile(selfGraph(true)).source)(run.ctx);
      expect(run.calls).toEqual([["selfAct", { who: "other" }]]);
    });

    it("never falls back to Self for a wired null: it logs and does nothing", () => {
      const run = runContext(null);
      beginPlayOf(compile(selfGraph(true)).source)(run.ctx);
      expect(run.calls).toEqual([["nullAccess", "Hero: Self Act (Actor) tried to access null."]]);
    });

    it("still logs when Self itself is missing, as in a graph with no owner", () => {
      const run = runContext(null);
      beginPlayOf(compile(selfGraph(false)).source)({ ...run.ctx, self: null });
      expect(run.calls).toEqual([["nullAccess", "Hero: Self Act (Actor) tried to access null."]]);
    });
  });

  it("reads the flag from the catalog, so a graph saved before the flag existed is guarded", () => {
    const graph = actGraph();
    const act = graph.nodes.find((entry) => entry.id === "act")!;
    act.pins = act.pins.map((entry) => (entry.id === "target" ? { ...entry, subject: undefined } : entry));
    const run = runContext(null);
    beginPlayOf(compile(graph).source)(run.ctx);
    expect(run.calls[0]).toEqual(["nullAccess", "Hero: Act (Target) tried to access null."]);
  });

  it("omits the class prefix when the compile has no class name", () => {
    const run = runContext(null);
    beginPlayOf(compileGraph(actGraph(), { assetGuid: "a", registry: nodes }).source)(run.ctx);
    expect(run.calls[0]).toEqual(["nullAccess", "Act (Target) tried to access null."]);
  });
});

describe("object reference type", () => {
  it("applies to object references as well as actors", () => {
    const nodes = new NodeRegistry();
    nodes.registerAll([
      { id: "flow.event.beginPlay", title: "Begin", category: "flow", pins: () => [pin("execOut", "then", "out", EXEC)], codegen: () => {} },
      { id: "poke", title: "Poke", category: "test",
        pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), { ...pin("target", "Target", "in", objectRef("Thing")), subject: true }],
        codegen: (ctx) => ctx.emit(`ctx.poke(${ctx.input("target")});`) },
    ]);
    const graph: LogicGraph = {
      id: "g", kind: "event",
      nodes: [node(nodes, "begin", "flow.event.beginPlay"), node(nodes, "poke", "poke")],
      edges: [wire("begin", "execOut", "poke", "execIn")],
    };
    const calls: unknown[][] = [];
    beginPlayOf(compileGraph(graph, { assetGuid: "a", registry: nodes, className: "Hero" }).source)({
      poke: () => calls.push(["poke"]),
      nullAccess: (message: string) => calls.push(["nullAccess", message]),
    });
    // Unwired and not a Self pin: the missing object is reported, never passed on.
    expect(calls).toEqual([["nullAccess", "Hero: Poke (Target) tried to access null."]]);
  });
});
