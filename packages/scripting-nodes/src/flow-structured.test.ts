import { describe, expect, it } from "vitest";
import {
  EXEC,
  INT,
  compileGraph,
  compiledNodeIds,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

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

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { run };`)() as Record<string, unknown>;
}

function stubCtx(extra: Record<string, unknown> = {}) {
  const flow = new Map<string, Record<string, unknown>>();
  return {
    formatValue: (v: unknown) => String(v),
    log: (_s: string, _c: string, message: string) => {
      (extra.logs as string[] | undefined)?.push(message);
    },
    checkInfiniteLoop: () => {
      (extra.checks as number[] | undefined)?.push(1);
    },
    flowState: (nodeId: string) => {
      let row = flow.get(nodeId);
      if (!row) {
        row = {};
        flow.set(nodeId, row);
      }
      return row;
    },
    ...extra,
  };
}

describe("structured flow catalog", () => {
  it("registers For Loop / For Each / map / break / stateful flow nodes", () => {
    const registry = createDefaultNodeRegistry();
    for (const id of [
      "flow.forLoop",
      "flow.forLoopWithBreak",
      "flow.forEach",
      "flow.forEachWithBreak",
      "flow.forEachMap",
      "flow.forEachMapWithBreak",
      "flow.whileLoop",
      "flow.break",
      "flow.doOnce",
      "flow.doN",
      "flow.flipFlop",
      "flow.gate",
    ]) {
      expect(registry.get(id), id).toBeDefined();
    }
  });

  it("titles structured flow nodes in Title Case", () => {
    const registry = createDefaultNodeRegistry();
    expect(registry.get("flow.forLoop")?.title).toBe("For Loop");
    expect(registry.get("flow.forLoopWithBreak")?.title).toBe(
      "For Loop With Break",
    );
    expect(registry.get("flow.forEach")?.title).toBe("For Each");
    expect(registry.get("flow.forEachWithBreak")?.title).toBe(
      "For Each With Break",
    );
    expect(registry.get("flow.forEachMap")?.title).toBe("For Each Map");
    expect(registry.get("flow.forEachMapWithBreak")?.title).toBe(
      "For Each Map With Break",
    );
    expect(registry.get("flow.whileLoop")?.title).toBe("While Loop");
    expect(registry.get("flow.break")?.title).toBe("Break");
    expect(registry.get("flow.doOnce")?.title).toBe("Do Once");
    expect(registry.get("flow.doN")?.title).toBe("Do N");
    expect(registry.get("flow.flipFlop")?.title).toBe("Flip Flop");
    expect(registry.get("flow.gate")?.title).toBe("Gate");
  });

  it("tags loop and stateful nodes with structuredFlow metadata", () => {
    const registry = createDefaultNodeRegistry();
    expect(registry.get("flow.forLoop")?.structuredFlow?.kind).toBe("forLoop");
    expect(registry.get("flow.forLoopWithBreak")?.structuredFlow?.kind).toBe(
      "forLoopWithBreak",
    );
    expect(registry.get("flow.forEach")?.structuredFlow?.kind).toBe("forEach");
    expect(registry.get("flow.forEachMap")?.structuredFlow?.kind).toBe(
      "forEachMap",
    );
    expect(registry.get("flow.whileLoop")?.structuredFlow?.kind).toBe(
      "whileLoop",
    );
    expect(registry.get("flow.break")?.structuredFlow?.kind).toBe("break");
    expect(registry.get("flow.doOnce")?.structuredFlow?.kind).toBe("doOnce");
    expect(registry.get("flow.doN")?.structuredFlow?.kind).toBe("doN");
    expect(registry.get("flow.flipFlop")?.structuredFlow?.kind).toBe("flipFlop");
    expect(registry.get("flow.gate")?.structuredFlow?.kind).toBe("gate");
  });

  it("exposes For Loop pins: first/last index, loop body, index, completed", () => {
    const def = createDefaultNodeRegistry().get("flow.forLoop")!;
    const pins = def.pins({});
    expect(
      pins.map((p) => ({ id: p.id, direction: p.direction, type: p.type })),
    ).toEqual(
      expect.arrayContaining([
        { id: "execIn", direction: "in", type: EXEC },
        { id: "firstIndex", direction: "in", type: INT },
        { id: "lastIndex", direction: "in", type: INT },
        { id: "loopBody", direction: "out", type: EXEC },
        { id: "index", direction: "out", type: INT },
        { id: "completed", direction: "out", type: EXEC },
      ]),
    );
  });
});

describe("structured flow compile + runtime", () => {
  it("compiles For Loop with index slots in the body and Completed after", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "loop", "flow.forLoop", {
          firstIndex: 0,
          lastIndex: 2,
        }),
        node(registry, "log", "debug.log"),
        node(registry, "done", "debug.log", { message: "done" }),
      ],
      edges: [
        edge("e1", "entry", "execOut", "loop", "execIn"),
        edge("e2", "loop", "loopBody", "log", "execIn"),
        edge("e3", "loop", "index", "log", "message"),
        edge("e4", "loop", "completed", "done", "execIn"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(/for\s*\(/);
    const ids = compiledNodeIds(graph);
    expect(ids.has("loop")).toBe(true);
    expect(ids.has("log")).toBe(true);
    expect(ids.has("done")).toBe(true);

    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)(stubCtx({ logs }));
    expect(logs).toEqual(["0", "1", "2", "done"]);
  });

  it("snapshots For Each array iteration and runs Completed after break", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "loop", "flow.forEachWithBreak", {
          array: ["a", "b", "c"],
        }),
        node(registry, "gt", "math.greater", { b: 0 }),
        node(registry, "branch", "flow.branch"),
        node(registry, "brk", "flow.break"),
        node(registry, "log", "debug.log"),
        node(registry, "done", "debug.log", { message: "done" }),
      ],
      edges: [
        edge("e1", "entry", "execOut", "loop", "execIn"),
        edge("e2", "loop", "loopBody", "branch", "execIn"),
        edge("e3", "loop", "index", "gt", "a"),
        edge("e4", "gt", "out", "branch", "condition"),
        edge("e5", "branch", "true", "brk", "execIn"),
        edge("e6", "branch", "false", "log", "execIn"),
        edge("e7", "loop", "element", "log", "message"),
        edge("e8", "loop", "completed", "done", "execIn"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(/\.slice\s*\(/);
    expect(compiled.source).toContain("break;");

    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)(stubCtx({ logs }));
    expect(logs).toEqual(["a", "done"]);
  });

  it("iterates For Each Map from a snapshot of entries", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "loop", "flow.forEachMap", {
          map: [
            ["k1", 1],
            ["k2", 2],
          ],
        }),
        node(registry, "log", "debug.log"),
        node(registry, "done", "debug.log", { message: "done" }),
      ],
      edges: [
        edge("e1", "entry", "execOut", "loop", "execIn"),
        edge("e2", "loop", "loopBody", "log", "execIn"),
        edge("e3", "loop", "key", "log", "message"),
        edge("e4", "loop", "completed", "done", "execIn"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(/\.entries\s*\(/);

    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)(stubCtx({ logs }));
    expect(logs).toEqual(["k1", "k2", "done"]);
  });

  it("instruments each For Loop iteration only when instrumentInfiniteLoops is set", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "loop", "flow.forLoop", {
          firstIndex: 0,
          lastIndex: 1,
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "loop", "execIn"),
        edge("e2", "loop", "loopBody", "log", "execIn"),
      ],
    };
    const plain = compileGraph(graph, { assetGuid: "a", registry });
    expect(plain.source).not.toContain("checkInfiniteLoop");

    const instrumented = compileGraph(graph, {
      assetGuid: "a",
      registry,
      instrumentInfiniteLoops: true,
    });
    expect(instrumented.source).toContain("checkInfiniteLoop");
    const checks: number[] = [];
    const mod = loadModule(instrumented.source);
    (mod.run as (ctx: unknown) => void)(stubCtx({ checks, logs: [] }));
    expect(checks.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves Branch / Sequence source patterns", () => {
    const registry = createDefaultNodeRegistry();
    const branchGraph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "branch", "flow.branch", { condition: true }),
        node(registry, "log", "debug.log", { message: "t" }),
      ],
      edges: [
        edge("e1", "entry", "execOut", "branch", "execIn"),
        edge("e2", "branch", "true", "log", "execIn"),
      ],
    };
    const src = compileGraph(branchGraph, { assetGuid: "a", registry }).source;
    expect(src).toMatch(/if\s*\(/);
    expect(src).toMatch(/else\s*\{/);

    const seqGraph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "seq", "flow.sequence", { count: 2 }),
        node(registry, "a", "debug.log", { message: "a" }),
        node(registry, "b", "debug.log", { message: "b" }),
      ],
      edges: [
        edge("e1", "entry", "execOut", "seq", "execIn"),
        edge("e2", "seq", "then0", "a", "execIn"),
        edge("e3", "seq", "then1", "b", "execIn"),
      ],
    };
    const seqSrc = compileGraph(seqGraph, { assetGuid: "a", registry }).source;
    expect(seqSrc.indexOf("ctx.log")).toBeLessThan(seqSrc.lastIndexOf("ctx.log"));
  });

  it("anchors For Loop body lines to the loop node id", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "loop", "flow.forLoop", {
          firstIndex: 0,
          lastIndex: 0,
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "loop", "execIn"),
        edge("e2", "loop", "loopBody", "log", "execIn"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.anchors.some((a) => a.nodeId === "loop")).toBe(true);
  });

  it("runs nested breakable loops with lexical Break targeting the inner loop", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "outer", "flow.forLoopWithBreak", {
          firstIndex: 0,
          lastIndex: 1,
        }),
        node(registry, "inner", "flow.forLoopWithBreak", {
          firstIndex: 0,
          lastIndex: 5,
        }),
        node(registry, "gt", "math.greater", { b: 1 }),
        node(registry, "branch", "flow.branch"),
        node(registry, "brk", "flow.break"),
        node(registry, "log", "debug.log"),
        node(registry, "outerDone", "debug.log", { message: "outerDone" }),
      ],
      edges: [
        edge("e1", "entry", "execOut", "outer", "execIn"),
        edge("e2", "outer", "loopBody", "inner", "execIn"),
        edge("e3", "inner", "loopBody", "branch", "execIn"),
        edge("e4", "inner", "index", "gt", "a"),
        edge("e5", "gt", "out", "branch", "condition"),
        edge("e6", "branch", "true", "brk", "execIn"),
        edge("e7", "branch", "false", "log", "execIn"),
        edge("e8", "inner", "index", "log", "message"),
        edge("e9", "outer", "completed", "outerDone", "execIn"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const logs: string[] = [];
    const mod = loadModule(compiled.source);
    (mod.run as (ctx: unknown) => void)(stubCtx({ logs }));
    expect(logs).toEqual(["0", "1", "0", "1", "outerDone"]);
  });

  it("Do Once / Do N / Flip Flop / Gate use ctx.flowState rather than module globals", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "once", "flow.doOnce"),
        node(registry, "log", "debug.log", { message: "once" }),
      ],
      edges: [
        edge("e1", "entry", "execOut", "once", "execIn"),
        edge("e2", "once", "then", "log", "execIn"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("flowState");
    expect(compiled.source).not.toMatch(/^(?:const|let|var)\s+\w*once/m);

    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    const ctx = stubCtx({ logs });
    (mod.run as (c: unknown) => void)(ctx);
    (mod.run as (c: unknown) => void)(ctx);
    expect(logs).toEqual(["once"]);
  });
});

describe("structured flow validation", () => {
  it("diagnoses Break outside a breakable loop", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "brk", "flow.break"),
      ],
      edges: [edge("e1", "entry", "execOut", "brk", "execIn")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" }, { registry });
    const hit = diags.find((d) => d.code === "flow.break_outside_loop");
    expect(hit?.nodeId).toBe("brk");
  });
});
