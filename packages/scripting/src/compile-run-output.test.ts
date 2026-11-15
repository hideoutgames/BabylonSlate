import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC, FLOAT } from "./types";
import type { GraphNode, LogicGraph } from "./ir";

/** A latent node whose outputs run at different times: Early after the first wait, Late after the second. */
function registry(): NodeRegistry {
  const nodes = new NodeRegistry();
  nodes.registerAll([
    { id: "flow.event.beginPlay", title: "Begin", category: "flow", pins: () => [pin("execOut", "then", "out", EXEC)], codegen: () => {} },
    {
      id: "twoStage", title: "Two Stage", category: "test", latent: true,
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("early", "Early", "out", EXEC), pin("late", "Late", "out", EXEC)],
      codegen: (ctx) => {
        ctx.emit(`ctx.start();`);
        ctx.runOutputIf?.(`(yield ctx.wait("early"))`, "early");
        ctx.runOutputIf?.(`(yield ctx.wait("late"))`, "late");
      },
    },
    { id: "log", title: "Log", category: "test",
      pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), pin("value", "Value", "in", FLOAT)],
      codegen: (ctx) => ctx.emit(`ctx.log(${ctx.input("value")});`) },
  ]);
  return nodes;
}

const nodes = registry();
const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
  ({ id, typeId, position: { x: 0, y: 0 }, properties, pins: nodes.get(typeId)!.pins(properties) });
const wire = (from: string, fromPin: string, to: string, toPin: string) =>
  ({ id: `${from}.${fromPin}->${to}.${toPin}`, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: toPin });

function beginPlayOf(source: string): (ctx: unknown) => PromiseLike<unknown> {
  return new Function(`${source.replace(/export\s+(async\s+)?function /g, "$1function ")}\nreturn onBeginPlay;`)() as (ctx: unknown) => PromiseLike<unknown>;
}

describe("outputs a latent node runs between its statements", () => {
  const graph: LogicGraph = {
    id: "g", kind: "event",
    nodes: [
      node("begin", "flow.event.beginPlay"), node("stage", "twoStage"),
      node("early", "log", { "default:value": 1 }), node("late", "log", { "default:value": 2 }),
    ],
    edges: [wire("begin", "execOut", "stage", "execIn"), wire("stage", "early", "early", "execIn"), wire("stage", "late", "late", "execIn")],
  };
  const source = compileGraph(graph, { assetGuid: "a", registry: nodes, className: "Hero" }).source;

  it("runs each output once, where the node reaches it", async () => {
    const calls: unknown[][] = [];
    await beginPlayOf(source)({ start: () => calls.push(["start"]), wait: (stage: string) => { calls.push(["wait", stage]); return true; }, log: (value: number) => calls.push(["log", value]) });
    expect(calls).toEqual([["start"], ["wait", "early"], ["log", 1], ["wait", "late"], ["log", 2]]);
  });

  it("skips an output whose wait answers false, and still reaches the next", async () => {
    const calls: unknown[][] = [];
    await beginPlayOf(source)({ start: () => calls.push(["start"]), wait: (stage: string) => stage === "late", log: (value: number) => calls.push(["log", value]) });
    expect(calls).toEqual([["start"], ["log", 2]]);
  });
});
