import { describe, expect, it } from "vitest";
import {
  compileGraph,
  compilePoseDataGraph,
  compileTransitionRuleGraph,
  validateGraphs,
  type CompileOptions,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

const registry = createDefaultNodeRegistry();

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties };
}

/** `id` names the wire; `from` and `to` are `node.pin`. */
function wire(id: string, from: string, to: string): GraphEdge {
  const [sourceNodeId, sourcePinId] = from.split(".") as [string, string];
  const [targetNodeId, targetPinId] = to.split(".") as [string, string];
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

const reroute = (id: string) => node(id, "flow.reroute");
const graph = (nodes: GraphNode[], edges: GraphEdge[]): LogicGraph => ({ id: "EventGraph", kind: "event", nodes, edges });
const compile = (value: LogicGraph, options: Partial<CompileOptions> = {}) =>
  compileGraph(value, { assetGuid: "hero", registry, ...options }).source;
const validate = (value: LogicGraph) =>
  validateGraphs([value], { assetGuid: "hero" }, { registry }).map((entry) => `${entry.nodeId}.${entry.pinId}:${entry.code}`);

/** Begin Play prints a Float literal. */
const printNodes = () => [node("begin", "flow.event.beginPlay"), node("number", "literal.makeFloat", { "default:in": 2.5 }), node("print", "debug.print")];
const directPrint = graph(printNodes(), [wire("x", "begin.execOut", "print.execIn"), wire("d", "number.out", "print.value")]);

function runPrinted(source: string): string[] {
  const printed: string[] = [];
  const body = source.replace(/export\s+function\s+/g, "function ");
  const run = new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void;
  run({ print: (text: string) => printed.push(text), formatValue: String, debugTrace: null, checkInfiniteLoop: () => {} });
  return printed;
}

describe("Reroute", () => {
  it("compiles a data wire through one or three Reroutes exactly as the direct wire", () => {
    const one = graph([...printNodes(), reroute("r1")], [
      wire("x", "begin.execOut", "print.execIn"), wire("d1", "number.out", "r1.in"), wire("d2", "r1.out", "print.value"),
    ]);
    const three = graph([reroute("r3"), ...printNodes(), reroute("r1"), reroute("r2")], [
      wire("d3", "r2.out", "r3.in"), wire("x", "begin.execOut", "print.execIn"), wire("d1", "number.out", "r1.in"),
      wire("d4", "r3.out", "print.value"), wire("d2", "r1.out", "r2.in"),
    ]);
    const direct = compile(directPrint);
    expect(compile(one)).toBe(direct);
    expect(compile(three)).toBe(direct);
    expect(runPrinted(compile(three))).toEqual(["2.5"]);
    expect(validate(three)).toEqual([]);
  });

  it("shares a value two wires read through one Reroute as two direct wires do", () => {
    const nodes = () => [
      node("begin", "flow.event.beginPlay"), node("random", "math.random"),
      node("add", "math.add"), node("print", "debug.print"),
    ];
    const direct = graph(nodes(), [
      wire("x", "begin.execOut", "print.execIn"), wire("a", "random.out", "add.a"),
      wire("b", "random.out", "add.b"), wire("p", "add.out", "print.value"),
    ]);
    const rerouted = graph([...nodes(), reroute("r")], [
      wire("x", "begin.execOut", "print.execIn"), wire("in", "random.out", "r.in"), wire("a", "r.out", "add.a"),
      wire("b", "r.out", "add.b"), wire("p", "add.out", "print.value"),
    ]);
    expect(compile(rerouted)).toBe(compile(direct));
    expect(compile(direct)).toContain("__memo_");
  });

  it("traces every segment of an exec wire through a Reroute and otherwise compiles as the direct wire", () => {
    const rerouted = graph([...printNodes(), reroute("r")], [
      wire("x1", "begin.execOut", "r.in"), wire("x2", "r.out", "print.execIn"), wire("d", "number.out", "print.value"),
    ]);
    expect(compile(rerouted)).toBe(compile(directPrint));
    const traced = compile(rerouted, { instrumentExecutionTrace: true });
    expect(traced).toBe(
      compile(directPrint, { instrumentExecutionTrace: true }).replace(
        '  if (__dbg !== null) __dbg.edge("x");',
        '  if (__dbg !== null) __dbg.edge("x1");\n  if (__dbg !== null) __dbg.edge("x2");',
      ),
    );
    expect(traced).not.toContain("x1|x2");
    expect(runPrinted(compile(rerouted))).toEqual(["2.5"]);
  });

  it("runs the target of a diamond of exec Reroutes once, as one direct wire", () => {
    const diamond = graph([...printNodes(), reroute("split"), reroute("left"), reroute("right"), reroute("join")], [
      wire("x1", "begin.execOut", "split.in"),
      wire("x2", "split.out", "left.in"),
      wire("x3", "split.out", "right.in"),
      wire("x4", "left.out", "join.in"),
      wire("x5", "right.out", "join.in"),
      wire("x6", "join.out", "print.execIn"),
      wire("d", "number.out", "print.value"),
    ]);
    expect(compile(diamond)).toBe(compile(directPrint));
    expect(runPrinted(compile(diamond))).toEqual(["2.5"]);
    expect(validate(diamond)).toEqual([]);
  });

  it("merges two exec wires through one Reroute as two direct wires", () => {
    const nodes = () => [...printNodes(), node("tick", "flow.event.tick")];
    const direct = graph(nodes(), [
      wire("x", "begin.execOut", "print.execIn"), wire("y", "tick.execOut", "print.execIn"), wire("d", "number.out", "print.value"),
    ]);
    const rerouted = graph([...nodes(), reroute("r")], [
      wire("x1", "begin.execOut", "r.in"), wire("y1", "tick.execOut", "r.in"),
      wire("r1", "r.out", "print.execIn"), wire("d", "number.out", "print.value"),
    ]);
    expect(compile(rerouted)).toBe(compile(direct));
    const traced = compile(rerouted, { instrumentExecutionTrace: true });
    expect(traced.match(/__dbg\.edge\("[^"]*"\)/g)).toEqual([
      '__dbg.edge("x1")', '__dbg.edge("r1")', '__dbg.edge("y1")', '__dbg.edge("r1")',
    ]);
  });

  it("passes a writable variable through a Reroute to a by-reference input", () => {
    const nodes = () => [
      node("begin", "flow.event.beginPlay"), node("hits", "variables.get", { variableName: "Hits", typeId: "int", implicitSelf: true }),
      node("value", "literal.makeInt"), node("set", "variables.setByRef"),
    ];
    const direct = graph(nodes(), [
      wire("x", "begin.execOut", "set.execIn"), wire("t", "hits.value", "set.target"), wire("v", "value.out", "set.value"),
    ]);
    const rerouted = graph([...nodes(), reroute("r")], [
      wire("x", "begin.execOut", "set.execIn"), wire("t1", "hits.value", "r.in"), wire("t2", "r.out", "set.target"),
      wire("v", "value.out", "set.value"),
    ]);
    expect(validate(rerouted)).toEqual([]);
    expect(compile(rerouted)).toBe(compile(direct));
    expect(compile(rerouted)).toContain("ctx.variableReference(");
  });

  it("resolves For Each's element type from an array wired through Reroutes", () => {
    const nodes = () => [
      node("begin", "flow.event.beginPlay"), node("item", "literal.makeInt"), node("array", "array.make", { count: 1 }),
      node("loop", "flow.forEach"), node("print", "debug.printString"),
    ];
    const direct = graph(nodes(), [
      wire("x", "begin.execOut", "loop.execIn"), wire("i", "item.out", "array.item0"), wire("a", "array.out", "loop.array"),
      wire("b", "loop.loopBody", "print.execIn"), wire("e", "loop.element", "print.inString"),
    ]);
    const rerouted = graph([...nodes(), reroute("r1"), reroute("r2")], [
      wire("x", "begin.execOut", "loop.execIn"), wire("i", "item.out", "array.item0"), wire("a1", "array.out", "r1.in"),
      wire("a2", "r1.out", "loop.array"), wire("b", "loop.loopBody", "print.execIn"),
      wire("e1", "loop.element", "r2.in"), wire("e2", "r2.out", "print.inString"),
    ]);
    // The element is an Int, which a String input does not take: the Reroutes hide nothing.
    expect(validate(rerouted)).toEqual(["print.inString:type.mismatch"]);
    expect(validate(rerouted)).toEqual(validate(direct));
    expect(compile(rerouted)).toBe(compile(direct));
  });

  it("reports an exec wire that a Reroute chain ends on a data input as a type mismatch", () => {
    const mixed = graph([...printNodes(), reroute("r1"), reroute("r2")], [
      wire("x", "begin.execOut", "print.execIn"), wire("m1", "begin.execOut", "r1.in"),
      wire("m2", "r1.out", "r2.in"), wire("m3", "r2.out", "print.value"),
    ]);
    const diagnostics = validateGraphs([mixed], { assetGuid: "hero" }, { registry });
    expect(diagnostics.map((entry) => [entry.code, entry.nodeId, entry.pinId, entry.relatedNodeId, entry.message])).toContainEqual([
      "type.mismatch", "print", "value", "begin", "Cannot connect exec pin to data pin",
    ]);
    expect(diagnostics.some((entry) => entry.nodeId === "r1" || entry.nodeId === "r2")).toBe(false);
  });

  it("adds no diagnostics and no code for Reroutes wired on one side or not at all", () => {
    const dangling = graph([...printNodes(), reroute("r1"), reroute("r2"), reroute("r3")], [
      wire("x", "begin.execOut", "print.execIn"), wire("d", "number.out", "print.value"),
      wire("o1", "r1.out", "print.value"), wire("i2", "begin.execOut", "r2.in"),
    ]);
    expect(validate(dangling)).toEqual([]);
    expect(compile(dangling)).toBe(compile(directPrint));
  });

  it("compiles a transition rule and a pose graph reading a value through a Reroute", () => {
    const rule = (rerouted: boolean): LogicGraph => ({
      id: "rule", kind: "event",
      nodes: [node("elapsed", "anim.state.elapsedSeconds"), node("exit", "anim.rule.exitState"), node("more", "math.greater"),
        ...(rerouted ? [reroute("r")] : [])],
      edges: rerouted
        ? [wire("a1", "elapsed.value", "r.in"), wire("a2", "r.out", "more.a"), wire("b", "more.out", "exit.value")]
        : [wire("a", "elapsed.value", "more.a"), wire("b", "more.out", "exit.value")],
    });
    const options = { assetGuid: "rules", registry };
    expect(compileTransitionRuleGraph(rule(true), options).source).toBe(compileTransitionRuleGraph(rule(false), options).source);
    expect(compileTransitionRuleGraph(rule(true), options).source).toContain("elapsedSeconds");

    const pose = (rerouted: boolean): LogicGraph => ({
      id: "pose", kind: "event",
      nodes: [node("blend", "anim.pose.blend"), node("alpha", "literal.makeFloat", { "default:in": 0.25 }),
        ...(rerouted ? [reroute("r")] : [])],
      edges: rerouted
        ? [wire("a1", "alpha.out", "r.in"), wire("a2", "r.out", "blend.alpha")]
        : [wire("a", "alpha.out", "blend.alpha")],
    });
    const poseSource = compilePoseDataGraph(pose(true), options)?.source;
    expect(poseSource).toBe(compilePoseDataGraph(pose(false), options)?.source);
    expect(poseSource).toContain('"blend": { "alpha": ');
  });
});
