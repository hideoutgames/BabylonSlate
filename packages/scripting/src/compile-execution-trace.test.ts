import { describe, expect, it } from "vitest";
import { compileGraph, type CompileOptions } from "./compile";
import type { GraphEdge, GraphNode, LogicGraph } from "./ir";
import { NodeRegistry, pin } from "./node-registry";
import { BOOL, EXEC, INT, STRING } from "./types";

function registry(): NodeRegistry {
  const nodes = new NodeRegistry();
  nodes.register({
    id: "flow.entry",
    title: "Entry",
    category: "flow",
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {},
  });
  nodes.register({
    id: "flow.branch",
    title: "Branch",
    category: "flow",
    pins: () => [
      pin("exec", "exec", "in", EXEC),
      pin("condition", "condition", "in", BOOL),
      pin("true", "true", "out", EXEC),
      pin("false", "false", "out", EXEC),
    ],
    codegen: () => {},
  });
  nodes.register({
    id: "flow.forLoop",
    title: "For Loop",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("firstIndex", "firstIndex", "in", INT),
      pin("lastIndex", "lastIndex", "in", INT),
      pin("loopBody", "loopBody", "out", EXEC),
      pin("index", "index", "out", INT),
      pin("completed", "completed", "out", EXEC),
    ],
    codegen: () => {},
    structuredFlow: {
      kind: "forLoop",
      firstIndexPin: "firstIndex",
      lastIndexPin: "lastIndex",
      loopBodyPin: "loopBody",
      completedPin: "completed",
      indexPin: "index",
    },
  });
  nodes.register({
    id: "input.onAnyKeyPressed",
    title: "On Any Key Pressed",
    category: "input",
    pins: () => [
      pin("Then", "Then", "out", EXEC),
      pin("key", "key", "out", STRING),
    ],
    codegen: () => {},
  });
  nodes.register({
    id: "test.make",
    title: "Make",
    category: "test",
    pins: () => [
      pin("exec", "exec", "in", EXEC),
      pin("then", "then", "out", EXEC),
      pin("value", "value", "out", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("value")} = ctx.make();`);
    },
  });
  nodes.register({
    id: "test.shout",
    title: "Shout",
    category: "test",
    pure: true,
    pins: () => [
      pin("text", "text", "in", STRING),
      pin("result", "result", "out", STRING),
    ],
    codegen: (ctx) => ({ result: `String(${ctx.input("text")}).toUpperCase()` }),
  });
  nodes.register({
    id: "test.log",
    title: "Log",
    category: "test",
    pins: () => [
      pin("exec", "exec", "in", EXEC),
      pin("then", "then", "out", EXEC),
      pin("message", "message", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.log(${ctx.input("message")});`);
    },
  });
  return nodes;
}

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: registry().get(typeId)!.pins(properties),
    properties,
  };
}

function edge(id: string, from: string, fromPin: string, to: string, toPin: string): GraphEdge {
  return { id, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: toPin };
}

/** Entry -> Make -> Log, with Log's message read through the pure Shout from Make's value. */
function makeThenLog(): LogicGraph {
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      node("entry", "flow.entry"),
      node("make", "test.make"),
      node("shout", "test.shout"),
      node("log", "test.log"),
    ],
    edges: [
      edge("e1", "entry", "execOut", "make", "exec"),
      edge("e2", "make", "then", "log", "exec"),
      edge("d1", "make", "value", "shout", "text"),
      edge("d2", "shout", "result", "log", "message"),
    ],
  };
}

const TRACED: Partial<CompileOptions> = { instrumentExecutionTrace: true };

function compile(graph: LogicGraph, options: Partial<CompileOptions> = {}) {
  return compileGraph(graph, { assetGuid: "classes/Door.class", registry: registry(), ...options });
}

/** Runs the compiled entry with a recorder standing in for the runtime's `ctx.debugTrace`. */
function run(source: string, exportName = "run", ctxExtras: Record<string, unknown> = {}) {
  const events: string[] = [];
  const recorder = {
    exec: (nodeId: string) => events.push(`exec ${nodeId}`),
    edge: (edgeId: string) => events.push(`edge ${edgeId}`),
    read: (nodeId: string, pinId: string, value: unknown) => {
      events.push(`read ${nodeId}.${pinId}=${String(value)}`);
      return value;
    },
    write: (nodeId: string, pinId: string, value: unknown) => events.push(`write ${nodeId}.${pinId}=${String(value)}`),
  };
  const graphs: string[] = [];
  const logged: unknown[] = [];
  const ctx = {
    make: () => "door",
    log: (value: unknown) => logged.push(value),
    debugTrace: { graph: (assetGuid: string, graphId: string) => (graphs.push(`${assetGuid}#${graphId}`), recorder) },
    ...ctxExtras,
  };
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const module = new Function(`${body}\nreturn { ${exportName} };`)() as Record<string, (ctx: unknown) => void>;
  module[exportName]!(ctx);
  return { events, graphs, logged };
}

describe("compileGraph instrumentExecutionTrace", () => {
  it("emits no probes unless the option is set", () => {
    const plain = compile(makeThenLog()).source;
    expect(plain).not.toContain("__dbg");
    expect(plain).not.toContain("__dv");
    expect(plain).not.toContain("debugTrace");
  });

  it("is a release export's no-op: stripDevelopmentOnly output equals the plain compile", () => {
    const release = compile(makeThenLog(), { ...TRACED, stripDevelopmentOnly: true });
    const plain = compile(makeThenLog(), { stripDevelopmentOnly: true });
    expect(release.source).toBe(plain.source);
    expect(release.source).not.toContain("__dbg");
    expect(release.anchors).toEqual(plain.anchors);
  });

  it("emits visits, wires taken and the values nodes read and produce", () => {
    expect(compile(makeThenLog(), TRACED).source).toBe(`//# sourceURL=babylonslate:///classes/Door.class.js
var __dv = (t, node, pin, value) => (t === null ? value : t.read(node, pin, value));
export function run(ctx) {
  const __dbg = ctx.debugTrace?.graph("classes/Door.class", "event-graph") ?? null;
  let _n_make_value = "";
  if (__dbg !== null) __dbg.exec("entry");
  if (__dbg !== null) __dbg.edge("e1");
  if (__dbg !== null) __dbg.exec("make");
  _n_make_value = ctx.make();
  if (__dbg !== null) { __dbg.write("make", "value", _n_make_value); }
  if (__dbg !== null) __dbg.edge("e2");
  if (__dbg !== null) __dbg.exec("log");
  ctx.log(__dv(__dbg, "log", "message", (String(_n_make_value).toUpperCase())));
}
`);
  });

  it("reports the same events when run, wrapping each wired read exactly once", () => {
    const { events, graphs, logged } = run(compile(makeThenLog(), TRACED).source);
    expect(events).toEqual([
      "exec entry",
      "edge e1",
      "exec make",
      "write make.value=door",
      "edge e2",
      "exec log",
      "read log.message=DOOR",
    ]);
    expect(graphs).toEqual(["classes/Door.class#event-graph"]);
    // The probes pass the value through: the node still logs what it would have.
    expect(logged).toEqual(["DOOR"]);
  });

  it("behaves identically for an unobserved instance and for a host without a trace", () => {
    const source = compile(makeThenLog(), TRACED).source;
    const baseline = run(compile(makeThenLog()).source).logged;
    for (const debugTrace of [null, undefined]) {
      const { events, logged } = run(source, "run", { debugTrace });
      expect(events).toEqual([]);
      expect(logged).toEqual(baseline);
    }
    // An observed class whose graph isn't traced yet answers null.
    const { events, logged } = run(source, "run", { debugTrace: { graph: () => null } });
    expect(events).toEqual([]);
    expect(logged).toEqual(baseline);
  });

  it("reads an impure input once: the recorder sees the value the node used", () => {
    let samples = 0;
    const graph = makeThenLog();
    const { events, logged } = run(compile(graph, TRACED).source, "run", {
      make: () => `door${++samples}`,
    });
    expect(samples).toBe(1);
    expect(logged).toEqual(["DOOR1"]);
    expect(events).toContain("read log.message=DOOR1");
  });

  it("reports the arm a Branch takes and visits only that arm", () => {
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node("entry", "flow.entry"),
        { ...node("branch", "flow.branch"), properties: { "default:condition": true } },
        node("yes", "test.log"),
        node("no", "test.log"),
        node("make", "test.make"),
      ],
      edges: [
        edge("e0", "entry", "execOut", "make", "exec"),
        edge("e1", "make", "then", "branch", "exec"),
        edge("e2", "branch", "true", "yes", "exec"),
        edge("e3", "branch", "false", "no", "exec"),
        edge("d1", "make", "value", "yes", "message"),
      ],
    };
    const taken = run(compile(graph, TRACED).source).events;
    expect(taken).toEqual([
      "exec entry", "edge e0", "exec make", "write make.value=door",
      "edge e1", "exec branch",
      "edge e2", "exec yes", "read yes.message=door",
    ]);
  });

  it("reports loop iterations through the loop's own output and a wire per arrival", () => {
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node("entry", "flow.entry"),
        { ...node("loop", "flow.forLoop"), properties: { "default:firstIndex": 1, "default:lastIndex": 2 } },
        node("log", "test.log"),
        node("done", "test.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "loop", "execIn"),
        edge("e2", "loop", "loopBody", "log", "exec"),
        edge("e3", "loop", "completed", "done", "exec"),
        edge("d1", "loop", "index", "log", "message"),
      ],
    };
    const { events } = run(compile(graph, TRACED).source);
    expect(events).toEqual([
      "exec entry", "edge e1", "exec loop",
      "write loop.index=1", "edge e2", "exec log", "read log.message=1",
      "write loop.index=2", "edge e2", "exec log", "read log.message=2",
      "edge e3", "exec done",
    ]);
  });

  it("reports a back edge each time it is taken and not the entry wire again", () => {
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [node("entry", "flow.entry"), node("a", "test.log"), node("b", "test.log")],
      edges: [
        edge("e1", "entry", "execOut", "a", "exec"),
        edge("e2", "a", "then", "b", "exec"),
        edge("e3", "b", "then", "a", "exec"),
      ],
    };
    const source = compile(graph, { ...TRACED, instrumentInfiniteLoops: false }).source;
    // The cycle never ends on its own: stop it after a few visits.
    const events: string[] = [];
    let visits = 0;
    const recorder = {
      exec: (nodeId: string) => { events.push(`exec ${nodeId}`); if (++visits > 4) throw new Error("stop"); },
      edge: (edgeId: string) => events.push(`edge ${edgeId}`),
      read: (_n: string, _p: string, value: unknown) => value,
      write: () => {},
    };
    const body = source.replace(/export\s+function\s+/g, "function ");
    const module = new Function(`${body}\nreturn { run };`)() as { run: (ctx: unknown) => void };
    expect(() => module.run({ log: () => {}, debugTrace: { graph: () => recorder } })).toThrow("stop");
    expect(events).toEqual([
      "exec entry", "edge e1", "exec a", "edge e2", "exec b", "edge e3", "exec a", "edge e2", "exec b",
    ]);
  });

  it("reports a gated input event only on ticks where it fires", () => {
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [node("keys", "input.onAnyKeyPressed"), node("log", "test.log")],
      edges: [
        edge("e1", "keys", "Then", "log", "exec"),
        edge("d1", "keys", "key", "log", "message"),
      ],
    };
    const source = compile(graph, TRACED).source;
    const idle = run(source, "onTick", { getPressedKeys: () => [] });
    expect(idle.events).toEqual([]);
    const pressed = run(source, "onTick", { getPressedKeys: () => ["KeyW"] });
    expect(pressed.events).toEqual([
      "exec keys", "write keys.key=KeyW", "edge e1", "exec log", "read log.message=KeyW",
    ]);
  });
});
