import { describe, expect, it } from "vitest";
import {
  BOOL,
  INT,
  compileGraph,
  flowSwitchCasePinId,
  validateGraphs,
  type CompileOptions,
  type GraphNode,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

const registry = createDefaultNodeRegistry();

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties) };
}

function edge(sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) {
  return { id: `${sourceNodeId}:${sourcePinId}:${targetNodeId}:${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function runnable(graph: LogicGraph, options: Partial<CompileOptions> = {}) {
  const compiled = compileGraph(graph, { assetGuid: "cycles", registry, ...options });
  const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const run = new Function(`${body}\nreturn run;`)() as (ctx: unknown) => void | Promise<void>;
  return { ...compiled, run };
}

function flowContext() {
  const states = new Map<string, Record<string, unknown>>();
  return {
    flowState(id: string) {
      if (!states.has(id)) states.set(id, {});
      return states.get(id)!;
    },
  };
}

describe("execution cycles", () => {
  it("re-evaluates branches and impure output feedback without growing the call stack", () => {
    const graph: LogicGraph = { id: "g", kind: "event", nodes: [
      node("entry", "flow.entry"),
      node("step", "debug.executeJavaScript", {
        inputs: [{ name: "previous", type: INT }],
        outputs: [{ name: "count", type: INT }, { name: "again", type: BOOL }],
        body: "count = previous + 1; again = count < 20000; ctx.count = count;",
      }),
      node("branch", "flow.branch"),
      node("done", "debug.executeJavaScript", { body: "ctx.finished = true;" }),
    ], edges: [
      edge("entry", "execOut", "step", "execIn"),
      edge("step", "out_count", "step", "in_previous"),
      edge("step", "out_again", "branch", "condition"),
      edge("step", "execOut", "branch", "execIn"),
      edge("branch", "true", "step", "execIn"),
      edge("branch", "false", "done", "execIn"),
    ] };
    expect(validateGraphs([graph], { assetGuid: "cycles", registry })).toEqual([]);
    const compiled = runnable(graph);
    const ctx = { count: 0, finished: false };
    compiled.run(ctx);
    expect(compiled.isAsync).toBe(false);
    expect(ctx).toEqual({ count: 20000, finished: true });
  });

  it.each(["delay", "javascript", "function"])("awaits every iteration through a latent %s node", async (kind) => {
    const wait = kind === "delay"
      ? node("wait", "timers.delay", { duration: 0.25 })
      : kind === "javascript"
        ? node("wait", "debug.executeJavaScript", { async: true, body: "await ctx.delay(0.25);" })
        : node("wait", "functions.call", { classId: "Waiter", functionName: "Wait", implicitSelf: true });
    const graph: LogicGraph = { id: "g", kind: "event", nodes: [
      node("entry", "flow.entry"), node("repeat", "flow.doN", { n: 3 }), wait,
      node("record", "debug.executeJavaScript", {
        inputs: [{ name: "counter", type: INT }], body: "ctx.values.push(counter);",
      }),
    ], edges: [
      edge("entry", "execOut", "repeat", "execIn"),
      edge("repeat", "then", "wait", "execIn"),
      edge("wait", "execOut", "record", "execIn"),
      edge("repeat", "counter", "record", "in_counter"),
      edge("record", "execOut", "repeat", "execIn"),
    ] };
    const compiled = runnable(graph, { isLatentFunction: () => true });
    const resumes: Array<() => void> = [];
    const durations: number[] = [];
    const delay = (duration: number) => new Promise<void>((resolve) => {
      durations.push(duration);
      resumes.push(resolve);
    });
    const ctx = { ...flowContext(), values: [] as number[], delay, invokeFunction: () => delay(0.25) };
    const pending = compiled.run(ctx);
    expect(compiled.isAsync).toBe(true);
    expect(ctx.values).toEqual([]);
    for (let index = 0; index < 3; index++) {
      expect(resumes).toHaveLength(1);
      resumes.shift()!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.values).toEqual([0, 1, 2].slice(0, index + 1));
    }
    await pending;
    expect(durations).toEqual([0.25, 0.25, 0.25]);
    expect(resumes).toHaveLength(0);
  });

  it("keeps control inputs distinct when a switch routes back to Gate Close", () => {
    const graph: LogicGraph = { id: "g", kind: "event", nodes: [
      node("entry", "flow.entry"), node("sequence", "flow.sequence", { count: 3 }),
      node("gate", "flow.gate"),
      node("record", "debug.executeJavaScript", { body: "ctx.count++;" }),
      node("switch", "flow.switchInt", { cases: [1], value: 1 }),
    ], edges: [
      edge("entry", "execOut", "sequence", "execIn"),
      edge("sequence", "then0", "gate", "open"),
      edge("sequence", "then1", "gate", "enter"),
      edge("sequence", "then2", "gate", "enter"),
      edge("gate", "exit", "record", "execIn"),
      edge("record", "execOut", "switch", "execIn"),
      edge("switch", flowSwitchCasePinId("1"), "gate", "close"),
    ] };
    const ctx = { ...flowContext(), count: 0 };
    runnable(graph).run(ctx);
    expect(ctx.count).toBe(1);
  });

  it("Break exits its structured loop even when reached inside an execution cycle", () => {
    const graph: LogicGraph = { id: "g", kind: "event", nodes: [
      node("entry", "flow.entry"), node("loop", "flow.forLoopWithBreak", { firstIndex: 0, lastIndex: 9 }),
      node("step", "debug.executeJavaScript", {
        outputs: [{ name: "again", type: BOOL }], body: "ctx.count++; again = ctx.count < 3;",
      }),
      node("branch", "flow.branch"), node("break", "flow.break"),
      node("done", "debug.executeJavaScript", { body: "ctx.completed++;" }),
    ], edges: [
      edge("entry", "execOut", "loop", "execIn"),
      edge("loop", "loopBody", "step", "execIn"),
      edge("step", "execOut", "branch", "execIn"),
      edge("step", "out_again", "branch", "condition"),
      edge("branch", "true", "step", "execIn"),
      edge("branch", "false", "break", "execIn"),
      edge("loop", "completed", "done", "execIn"),
    ] };
    const ctx = { count: 0, completed: 0 };
    runnable(graph).run(ctx);
    expect(ctx).toEqual({ count: 3, completed: 1 });
  });

  it.each([false, true])("checks runaway cycles even without emitted action statements (stripped=%s)", (stripped) => {
    const type = stripped ? "debug.log" : "flow.branch";
    const graph: LogicGraph = { id: "g", kind: "event", nodes: [
      node("entry", "flow.entry"), node("repeat", type, { condition: true, developmentOnly: stripped }),
    ], edges: [
      edge("entry", "execOut", "repeat", "execIn"),
      edge("repeat", stripped ? "execOut" : "true", "repeat", "execIn"),
    ] };
    const compiled = runnable(graph, { instrumentInfiniteLoops: true, stripDevelopmentOnly: stripped });
    let checks = 0;
    expect(() => compiled.run({ checkInfiniteLoop() { if (++checks === 3) throw new Error("Loop Budget"); } })).toThrow("Loop Budget");
    expect(checks).toBe(3);
    expect(compiled.anchors.some((anchor) => anchor.nodeId === "repeat")).toBe(true);
  });
});
