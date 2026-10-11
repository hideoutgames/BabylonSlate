import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import type { LogicGraph } from "./ir";
import { NodeRegistry, pin, type NodeDefinition } from "./node-registry";
import { EXEC, INT, BOOL, STRING, arrayOf } from "./types";
import { flowSwitchCasePinId } from "./flow-switch-pins";
import { validateGraphs } from "./validate";

function registryWith(
  id: string,
  title: string,
  pins: ReturnType<typeof pin>[],
  structuredFlow: NonNullable<NodeDefinition["structuredFlow"]>,
): NodeRegistry {
  const nodes = new NodeRegistry();
  nodes.register({
    id: "flow.entry",
    title: "Entry",
    category: "flow",
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {},
  });
  nodes.register({
    id: "debug.log",
    title: "Log",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("message", "message", "in", INT, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.log("log", "T", String(${ctx.input("message")}));`);
    },
  });
  nodes.register({
    id,
    title,
    category: "flow",
    pins: () => pins,
    codegen: () => {},
    structuredFlow,
  });
  return nodes;
}

describe("compile structured flow metadata", () => {
  it("emits a for-loop from structuredFlow forLoop without hard-coding only type ids in the loop path", () => {
    const registry = registryWith(
      "flow.forLoop",
      "For Loop",
      [
        pin("execIn", "exec", "in", EXEC),
        pin("firstIndex", "firstIndex", "in", INT),
        pin("lastIndex", "lastIndex", "in", INT),
        pin("loopBody", "loopBody", "out", EXEC),
        pin("index", "index", "out", INT),
        pin("completed", "completed", "out", EXEC),
      ],
      {
        kind: "forLoop",
        firstIndexPin: "firstIndex",
        lastIndexPin: "lastIndex",
        loopBodyPin: "loopBody",
        completedPin: "completed",
        indexPin: "index",
      },
    );
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "loop",
          typeId: "flow.forLoop",
          position: { x: 40, y: 0 },
          pins: registry.get("flow.forLoop")!.pins({}),
          properties: { "default:firstIndex": 1, "default:lastIndex": 2 },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 80, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "loop",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "loop",
          sourcePinId: "loopBody",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "loop",
          sourcePinId: "index",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(/for\s*\(/);
    expect(compiled.source).toContain("_n_loop_index");
  });

  it("still emits classic if/else for Branch by typeId", () => {
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
        pin("execIn", "exec", "in", EXEC),
        pin("condition", "condition", "in", BOOL),
        pin("true", "true", "out", EXEC),
        pin("false", "false", "out", EXEC),
      ],
      codegen: () => {},
    });
    nodes.register({
      id: "debug.log",
      title: "Log",
      category: "debug",
      pins: () => [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
      ],
      codegen: (ctx) => {
        ctx.emit(`ctx.log("log", "T", "x");`);
      },
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "branch",
          typeId: "flow.branch",
          position: { x: 40, y: 0 },
          pins: nodes.get("flow.branch")!.pins({}),
          properties: { "default:condition": true },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 80, y: 0 },
          pins: nodes.get("debug.log")!.pins({}),
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "branch",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "branch",
          sourcePinId: "true",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const src = compileGraph(graph, { assetGuid: "a", registry: nodes }).source;
    expect(src).toMatch(/if\s*\(/);
    expect(src).toMatch(/\}\s*else\s*\{/);
  });

  it("emits a while-loop from structuredFlow whileLoop", () => {
    const registry = registryWith(
      "flow.whileLoop",
      "While Loop",
      [
        pin("execIn", "exec", "in", EXEC),
        pin("condition", "Condition", "in", BOOL),
        pin("loopBody", "Loop Body", "out", EXEC),
        pin("completed", "Completed", "out", EXEC),
      ],
      {
        kind: "whileLoop",
        conditionPin: "condition",
        loopBodyPin: "loopBody",
        completedPin: "completed",
      },
    );
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "loop",
          typeId: "flow.whileLoop",
          position: { x: 40, y: 0 },
          pins: registry.get("flow.whileLoop")!.pins({}),
          properties: { "default:condition": true },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 80, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "loop",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "loop",
          sourcePinId: "loopBody",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(/while\s*\(/);
  });
});

function flowRegistry(): NodeRegistry {
  const nodes = new NodeRegistry();
  nodes.registerAll([
    { id: "flow.entry", title: "Entry", category: "flow", pins: () => [pin("execOut", "then", "out", EXEC)], codegen: () => {} },
    { id: "log", title: "Log", category: "debug",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), pin("message", "message", "in", STRING, "data", true)],
      codegen: (ctx) => ctx.emit(`ctx.log(${ctx.input("message")});`) },
    { id: "local", title: "Declare Local", category: "debug",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)],
      codegen: (ctx) => { ctx.emit(`const __local = ctx.next();`); ctx.emit(`ctx.log(__local);`); } },
    { id: "items", title: "Items", category: "debug", pure: true,
      pins: () => [pin("out", "out", "out", arrayOf(STRING))], codegen: () => ({ out: "ctx.items()" }) },
    { id: "num", title: "Number", category: "debug", pure: true,
      pins: () => [pin("out", "out", "out", INT)], codegen: () => ({ out: "ctx.num()" }) },
    { id: "flow.sequence", title: "Sequence", category: "flow",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("then0", "then_0", "out", EXEC), pin("then1", "then_1", "out", EXEC)],
      codegen: () => {} },
    { id: "flow.whileLoop", title: "While Loop", category: "flow",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("condition", "Condition", "in", BOOL),
        pin("loopBody", "Loop Body", "out", EXEC), pin("completed", "Completed", "out", EXEC)],
      codegen: () => {}, structuredFlow: { kind: "whileLoop", conditionPin: "condition", loopBodyPin: "loopBody", completedPin: "completed" } },
    { id: "flow.break", title: "Break", category: "flow", pins: () => [pin("execIn", "exec", "in", EXEC)],
      codegen: () => {}, structuredFlow: { kind: "break" } },
    { id: "flow.forLoop", title: "For Loop", category: "flow",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("firstIndex", "firstIndex", "in", INT), pin("lastIndex", "lastIndex", "in", INT),
        pin("loopBody", "loopBody", "out", EXEC), pin("index", "index", "out", INT), pin("completed", "completed", "out", EXEC)],
      codegen: () => {}, structuredFlow: { kind: "forLoop", firstIndexPin: "firstIndex", lastIndexPin: "lastIndex", loopBodyPin: "loopBody", completedPin: "completed", indexPin: "index" } },
    { id: "flow.forEach", title: "For Each", category: "flow",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("array", "array", "in", arrayOf(STRING)), pin("loopBody", "loopBody", "out", EXEC),
        pin("element", "element", "out", STRING), pin("index", "index", "out", INT), pin("completed", "completed", "out", EXEC)],
      codegen: () => {}, structuredFlow: { kind: "forEach", arrayPin: "array", loopBodyPin: "loopBody", completedPin: "completed", elementPin: "element", indexPin: "index" } },
    { id: "flow.switchString", title: "Switch on String", category: "flow",
      pins: (properties) => [pin("execIn", "exec", "in", EXEC), pin("value", "value", "in", STRING),
        ...(properties.cases as string[]).map((value) => pin(flowSwitchCasePinId(value), value, "out", EXEC)),
        pin("default", "Default", "out", EXEC)],
      codegen: () => {}, structuredFlow: { kind: "switchOnString", valuePin: "value", defaultPin: "default" } },
  ]);
  return nodes;
}

function flowGraph(registry: NodeRegistry, nodes: Array<[string, string, Record<string, unknown>?]>, wires: string[]): LogicGraph {
  return {
    id: "g",
    kind: "event",
    nodes: nodes.map(([id, typeId, properties = {}]) => ({
      id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties),
    })),
    edges: wires.map((wire, index) => {
      const [from, to] = wire.split("->") as [string, string];
      const [sourceNodeId, sourcePinId] = from.split(".") as [string, string];
      const [targetNodeId, targetPinId] = to.split(".") as [string, string];
      return { id: `e${index}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
    }),
  };
}

/** Evaluate the compiled module; a source that does not parse throws here. */
function runCompiled(graph: LogicGraph, registry: NodeRegistry, ctx: Record<string, unknown>): unknown[] {
  const source = compileGraph(graph, { assetGuid: "a", registry }).source;
  const run = new Function(`${source.replace(/export function /g, "function ")}\nreturn run;`)() as (ctx: unknown) => void;
  const logs: unknown[] = [];
  run({ ...ctx, log: (value: unknown) => logs.push(value) });
  return logs;
}

describe("compiled structured flow behavior", () => {
  it("runs a While Loop body and its Completed chain, and Break leaves the loop", () => {
    const registry = flowRegistry();
    const graph = flowGraph(registry, [
      ["entry", "flow.entry"],
      ["loop", "flow.whileLoop", { "default:condition": true }],
      ["body", "log", { "default:message": "body" }],
      ["break", "flow.break"],
      ["done", "log", { "default:message": "done" }],
    ], ["entry.execOut->loop.execIn", "loop.loopBody->body.execIn", "body.execOut->break.execIn", "loop.completed->done.execIn"]);
    expect(runCompiled(graph, registry, {})).toEqual(["body", "done"]);
    expect(validateGraphs([graph], { assetGuid: "a" }, { registry }).map((d) => d.code)).not.toContain("flow.break_outside_loop");
  });

  it("compiles Break outside a loop to a module that still loads", () => {
    const registry = flowRegistry();
    const graph = flowGraph(registry, [["entry", "flow.entry"], ["log", "log", { "default:message": "before" }], ["break", "flow.break"]],
      ["entry.execOut->log.execIn", "log.execOut->break.execIn"]);
    expect(runCompiled(graph, registry, {})).toEqual(["before"]);
  });

  it("keeps a Switch on String case named Default apart from the Default output", () => {
    const registry = flowRegistry();
    const graph = flowGraph(registry, [
      ["entry", "flow.entry"],
      ["switch", "flow.switchString", { cases: ["Default"] }],
      ["case", "log", { "default:message": "case" }],
      ["fallback", "log", { "default:message": "fallback" }],
    ], ["entry.execOut->switch.execIn", `switch.${flowSwitchCasePinId("Default")}->case.execIn`, "switch.default->fallback.execIn"]);
    graph.nodes[1]!.properties["default:value"] = "Default";
    expect(runCompiled(graph, registry, {})).toEqual(["case"]);
    graph.nodes[1]!.properties["default:value"] = "other";
    expect(runCompiled(graph, registry, {})).toEqual(["fallback"]);
  });

  it("scopes each Sequence output so a node reached twice can declare its locals again", () => {
    const registry = flowRegistry();
    const graph = flowGraph(registry, [["entry", "flow.entry"], ["seq", "flow.sequence"], ["local", "local"]],
      ["entry.execOut->seq.execIn", "seq.then0->local.execIn", "seq.then1->local.execIn"]);
    let count = 0;
    expect(runCompiled(graph, registry, { next: () => ++count })).toEqual([1, 2]);
  });

  it("evaluates the For Each array once", () => {
    const registry = flowRegistry();
    const graph = flowGraph(registry, [["entry", "flow.entry"], ["items", "items"], ["each", "flow.forEach"], ["log", "log"]],
      ["entry.execOut->each.execIn", "items.out->each.array", "each.loopBody->log.execIn", "each.element->log.message"]);
    let reads = 0;
    expect(runCompiled(graph, registry, { items: () => { reads++; return ["a", "b"]; } })).toEqual(["a", "b"]);
    expect(reads).toBe(1);
  });

  it("does not wrap For Loop bounds beyond 32-bit integers", () => {
    const registry = flowRegistry();
    const graph = flowGraph(registry, [
      ["entry", "flow.entry"],
      ["loop", "flow.forLoop", { "default:firstIndex": 2 ** 31 - 1, "default:lastIndex": 2 ** 31 }],
      ["log", "log"],
    ], ["entry.execOut->loop.execIn", "loop.loopBody->log.execIn", "loop.index->log.message"]);
    expect(runCompiled(graph, registry, {})).toEqual([2 ** 31 - 1, 2 ** 31]);
  });

  it("treats a non-finite For Loop bound as 0 instead of looping without end", () => {
    const registry = flowRegistry();
    const graph = flowGraph(registry, [
      ["entry", "flow.entry"],
      ["num", "num"],
      ["loop", "flow.forLoop", { "default:firstIndex": 0 }],
      ["log", "log"],
    ], ["entry.execOut->loop.execIn", "num.out->loop.lastIndex", "loop.loopBody->log.execIn", "loop.index->log.message"]);
    let reads = 0;
    const num = () => {
      if (++reads > 10) throw new Error("unbounded loop");
      return Infinity;
    };
    expect(runCompiled(graph, registry, { num })).toEqual([0]);
  });
});
