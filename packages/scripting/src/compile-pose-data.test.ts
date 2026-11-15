import { describe, expect, it } from "vitest";
import { compilePoseDataGraph } from "./compile";
import { NodeRegistry, pin } from "./node-registry";
import { FLOAT, POSE, FRAME, BOOL } from "./types";
import type { GraphNode, LogicGraph } from "./ir";

function fixture() {
  const registry = new NodeRegistry();
  const structural = () => ({});
  registry.registerAll([
    { id: "anim.pose.output", title: "Output Pose", category: "animation", pure: true,
      pins: () => [pin("pose", "pose", "in", POSE)], codegen: structural },
    { id: "anim.pose.sequencePlayer", title: "Sequence Player", category: "animation", pure: true,
      pins: () => [pin("playRate", "playRate", "in", FLOAT, "data", true, 1), pin("pose", "pose", "out", POSE)], codegen: structural },
    { id: "anim.pose.blend", title: "Blend", category: "animation", pure: true,
      pins: () => [pin("a", "a", "in", POSE), pin("b", "b", "in", POSE), pin("alpha", "alpha", "in", FLOAT, "data", true, 0.5), pin("pose", "pose", "out", POSE)],
      codegen: structural },
    { id: "anim.frame.flip", title: "Flip Frame", category: "animation", pure: true,
      pins: () => [pin("frame", "frame", "in", FRAME), pin("flipX", "flipX", "in", BOOL, "data", true, false), pin("pose", "frame", "out", FRAME)],
      codegen: structural },
    { id: "speed", title: "Speed", category: "variables", pure: true,
      pins: () => [pin("value", "value", "out", FLOAT)], codegen: () => ({ value: "ctx.getVariable(\"Speed\")" }) },
    { id: "half", title: "Half", category: "math", pure: true, referentiallyTransparent: true,
      pins: () => [pin("a", "a", "in", FLOAT), pin("out", "out", "out", FLOAT)], codegen: (ctx) => ({ out: `(${ctx.input("a")} / 2)` }) },
  ]);
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
    ({ id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties) });
  const graph: LogicGraph = { id: "pose-run", kind: "event", nodes: [], edges: [] };
  const wire = (from: string, output: string, to: string, input: string) =>
    graph.edges.push({ id: `edge-${graph.edges.length}`, sourceNodeId: from, sourcePinId: output, targetNodeId: to, targetPinId: input });
  return { registry, graph, node, wire };
}

function evaluate(source: string): (ctx: unknown) => unknown {
  return new Function(`${source.replace(/export function /g, "function ")}\nreturn evaluate;`)() as (ctx: unknown) => unknown;
}

describe("compilePoseDataGraph", () => {
  it("compiles each pose node's wired data inputs, keyed by node and pin, and leaves pose wires and unwired inputs out", () => {
    const { registry, graph, node, wire } = fixture();
    graph.nodes.push(
      node("output", "anim.pose.output"),
      node("blend", "anim.pose.blend"),
      node("walk", "anim.pose.sequencePlayer"),
      node("run", "anim.pose.sequencePlayer"),
      node("speed", "speed"),
      node("half", "half"),
    );
    wire("walk", "pose", "blend", "a");
    wire("run", "pose", "blend", "b");
    wire("blend", "pose", "output", "pose");
    wire("speed", "value", "half", "a");
    wire("half", "out", "blend", "alpha");
    wire("speed", "value", "run", "playRate");
    const compiled = compilePoseDataGraph(graph, { assetGuid: "Loco", registry });
    expect(compiled).not.toBeNull();
    expect(compiled!.entryPoints.map((point) => point.name)).toContain("evaluate");
    const result = evaluate(compiled!.source)({ getVariable: (name: string) => (name === "Speed" ? 3 : undefined) });
    expect(result).toEqual({ blend: { alpha: 1.5 }, run: { playRate: 3 } });
  });

  it("compiles a frame graph's wired inputs the same way", () => {
    const { registry, graph, node, wire } = fixture();
    registry.register({ id: "facing", title: "Facing", category: "variables", pure: true,
      pins: () => [pin("value", "value", "out", BOOL)], codegen: () => ({ value: "ctx.left" }) });
    graph.nodes.push(node("flip", "anim.frame.flip"), node("facing", "facing"));
    wire("facing", "value", "flip", "flipX");
    const compiled = compilePoseDataGraph(graph, { assetGuid: "Robot", registry });
    expect(evaluate(compiled!.source)({ left: true })).toEqual({ flip: { flipX: true } });
  });

  it("compiles nothing for a graph with no wired data input", () => {
    const { registry, graph, node, wire } = fixture();
    graph.nodes.push(node("output", "anim.pose.output"), node("walk", "anim.pose.sequencePlayer", { "default:playRate": 2 }));
    wire("walk", "pose", "output", "pose");
    expect(compilePoseDataGraph(graph, { assetGuid: "Loco", registry })).toBeNull();
  });
});
