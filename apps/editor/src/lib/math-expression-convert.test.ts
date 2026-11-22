import { describe, expect, it, vi } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import { compileGraph, MATH_EXPRESSION_NODE_ID, MATH_FUNCTIONS } from "@haptic/scripting";
import { MATH_EXPRESSION_NODE_TABLE, mathExpressionConstructs } from "@haptic/scripting-nodes";
import { defaultNodeRegistry, hydrateSerializedGraphForEditor, materializeLogicGraph } from "../services/graph-validation";
import {
  canConvertToMathExpression,
  convertMathExpressionToNodes,
  convertToMathExpression,
  mathNodesConversionRefusal,
} from "./math-expression-convert";
import { mathExpressionMenuItems } from "./math-expression-menu";

const registry = defaultNodeRegistry();
type Node = SerializedGraph["nodes"][number];
type Value = number | Record<string, number>;

const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0, y = 0): Node =>
  ({ id, type, position: { x, y }, data });
const wire = (from: string, to: string) => {
  const [source, sourceHandle] = from.split(".") as [string, string];
  const [target, targetHandle] = to.split(".") as [string, string];
  return { id: `${from}->${to}`, source, sourceHandle, target, targetHandle };
};
const get = (name: string, typeId = "float") => node(`get_${name}`, "variables.get", { variableName: name, typeId, implicitSelf: true });
const set = (name: string, typeId = "float") => node(`set_${name}`, "variables.set", { variableName: name, typeId, implicitSelf: true });

/** Sets each named output in turn from the entry. */
function sinks(outputs: Array<[name: string, from: string, typeId?: string]>): { nodes: Node[]; edges: SerializedGraph["edges"] } {
  const nodes = [node("entry", "flow.entry"), ...outputs.map(([name, , typeId]) => set(name, typeId))];
  const edges = outputs.flatMap(([name, from], index) => [
    wire(`${index === 0 ? "entry" : `set_${outputs[index - 1]![0]}`}.execOut`, `set_${name}.execIn`),
    wire(from, `set_${name}.value`),
  ]);
  return { nodes, edges };
}

const EDGES = [NaN, 0, -0, Infinity, -Infinity, 1, -1, 0.5, 2, -2.5, 3, 1e-9, 1e300, 90];

/** Compiles the graph and runs it once per input sample; the outputs, by name. */
function run(graph: SerializedGraph, inputs: Record<string, "float" | "vec3">, outputs: readonly string[]): unknown[][] {
  const hydrated = hydrateSerializedGraphForEditor(graph, registry);
  const logic = materializeLogicGraph(hydrated, "g");
  const source = compileGraph(logic, { assetGuid: "a", registry, stripDevelopmentOnly: true, instrumentInfiniteLoops: false }).source;
  const fn = new Function(`${source.replace(/export\s+function\s+/g, "function ")}\nreturn run;`)() as (ctx: unknown) => void;
  const results: unknown[][] = [];
  for (let seed = 0; seed < EDGES.length * 3; seed++) {
    const vars = new Map<string, Value>();
    Object.entries(inputs).forEach(([name, type], index) => {
      const pick = (k: number) => EDGES[(seed * 5 + index * 7 + k * 3) % EDGES.length]!;
      vars.set(name, type === "float" ? pick(0) : { x: pick(1), y: seed % 4 === 0 ? 0 : pick(2), z: seed % 4 === 0 ? 0 : pick(3) });
    });
    fn({ self: {}, debugTrace: null, breakpoints: null, getVariable: (name: string) => vars.get(name), setVariable: (name: string, value: Value) => vars.set(name, value), checkInfiniteLoop() {} });
    results.push(outputs.map((name) => vars.get(name)));
  }
  return results;
}

function expectSameResults(a: unknown[][], b: unknown[][]): void {
  const flat = (rows: unknown[][]) => rows.flatMap((row) => row.flatMap((value) => value && typeof value === "object" ? Object.values(value) : [value]));
  const left = flat(a);
  const right = flat(b);
  expect(right).toHaveLength(left.length);
  left.forEach((value, index) => {
    if (!Object.is(value, right[index])) throw new Error(`value ${index}: ${String(value)} vs ${String(right[index])}`);
  });
}

/** Sub, two Multiplies (one reading Sub twice), Sin, Add and Clamp; Sub also feeds a Set outside. */
function scalarGraph(): { graph: SerializedGraph; selection: string[] } {
  const out = sinks([["Out", "clamp.out"], ["Diff", "sub.out"]]);
  return {
    graph: {
      nodes: [
        get("a"), get("b"), get("k"), get("t"), ...out.nodes,
        node("sub", "math.sub", {}, 0, 0), node("mul", "math.mul", {}, 200, 0), node("sq", "math.mul", {}, 200, 200),
        node("sin", "math.sinDegrees", {}, 0, 200), node("add", "math.add", {}, 400, 0),
        node("clamp", "math.clamp", { "default:min": -1, "default:max": 1e3 }, 600, 0),
        node("log", "math.logarithm", {}, 400, 200),
      ],
      edges: [
        ...out.edges,
        wire("get_a.value", "sub.a"), wire("get_b.value", "sub.b"),
        wire("sub.out", "mul.a"), wire("get_k.value", "mul.b"),
        wire("sub.out", "sq.a"), wire("sub.out", "sq.b"),
        wire("get_t.value", "sin.in"), wire("get_t.value", "log.value"),
        wire("mul.out", "add.a"), wire("sin.out", "add.b"),
        wire("add.out", "clamp.value"), wire("sq.out", "log.base"),
      ],
    },
    selection: ["sub", "mul", "sq", "sin", "add", "clamp", "log"],
  };
}

function vectorGraph(): { graph: SerializedGraph; selection: string[] } {
  const out = sinks([["Pos", "add.out", "vec3"], ["Side", "brk.x"], ["Up", "brk.y"]]);
  return {
    graph: {
      nodes: [
        get("p", "vec3"), get("q", "vec3"), get("s"), ...out.nodes,
        node("sub", "math.sub", { aType: "vec3", bType: "vec3" }), node("norm", "vector.normalize3"),
        node("scale", "math.mul", { aType: "vec3", bType: "float" }), node("add", "math.add", { aType: "vec3", bType: "vec3" }),
        node("brk", "vector.break3"),
      ],
      edges: [
        ...out.edges,
        wire("get_q.value", "sub.a"), wire("get_p.value", "sub.b"), wire("sub.out", "norm.v"),
        wire("norm.out", "scale.a"), wire("get_s.value", "scale.b"),
        wire("get_p.value", "add.a"), wire("scale.out", "add.b"), wire("norm.out", "brk.in"),
      ],
    },
    selection: ["sub", "norm", "scale", "add", "brk"],
  };
}

const formulaOf = (graph: SerializedGraph) => graph.nodes.find((entry) => entry.type === MATH_EXPRESSION_NODE_ID)!.data.formula;

describe("Convert to Math Expression", () => {
  it("replaces the selection with one node computing identical results, one input per source and an output per value used outside", () => {
    const { graph, selection } = scalarGraph();
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const converted = convertToMathExpression(hydrated, selection, registry, "mx")!;
    // Sub feeds three nodes and a Set outside: an output. Square feeds only Logarithm, which feeds nothing: both go.
    expect(formulaOf(converted)).toBe("subtract = a - b\nclampResult = clamp(subtract * k + sind(t), -1, 1000)");
    const mx = converted.nodes.find((entry) => entry.id === "mx")!;
    expect(mx.position).toEqual({ x: 257, y: 86 });
    expect(converted.nodes.some((entry) => selection.includes(entry.id))).toBe(false);
    // One input per source pin, reconnected; outputs to the same consumers.
    expect(converted.edges.filter((edge) => edge.target === "mx").map((edge) => `${edge.source}->${edge.targetHandle}`))
      .toEqual(["get_a->in_a", "get_b->in_b", "get_k->in_k", "get_t->in_t"]);
    expect(converted.edges.filter((edge) => edge.source === "mx").map((edge) => `${edge.sourceHandle}->${edge.target}`).sort())
      .toEqual(["out_clampResult->set_Out", "out_subtract->set_Diff"]);
    const inputs = { a: "float", b: "float", k: "float", t: "float" } as const;
    expectSameResults(run(graph, inputs, ["Out", "Diff"]), run(converted, inputs, ["Out", "Diff"]));
  });

  it("converts vector nodes, reading several components of one vector from a let", () => {
    const { graph, selection } = vectorGraph();
    const converted = convertToMathExpression(hydrateSerializedGraphForEditor(graph, registry), selection, registry, "mx")!;
    expect(formulaOf(converted)).toBe([
      "let normalizeVector3 = normalize(q - p)",
      "add = p + normalizeVector3 * s",
      "breakVector3X = normalizeVector3.x",
      "breakVector3Y = normalizeVector3.y",
    ].join("\n"));
    const inputs = { p: "vec3", q: "vec3", s: "float" } as const;
    expectSameResults(run(graph, inputs, ["Pos", "Side", "Up"]), run(converted, inputs, ["Pos", "Side", "Up"]));
  });

  it("is offered only when every selected node is a math node a formula expresses exactly", () => {
    const { graph } = scalarGraph();
    const hydrated = hydrateSerializedGraphForEditor({
      ...graph,
      nodes: [...graph.nodes, node("int", "math.add", { aType: "int", bType: "int" }), node("rand", "math.random"), node("mx", MATH_EXPRESSION_NODE_ID, { formula: "a" })],
    }, registry);
    expect(canConvertToMathExpression(hydrated, ["sub", "mul"], registry)).toBe(true);
    expect(canConvertToMathExpression(hydrated, ["sub", "set_Out"], registry)).toBe(false);
    expect(canConvertToMathExpression(hydrated, ["sub", "int"], registry)).toBe(false);
    expect(canConvertToMathExpression(hydrated, ["rand"], registry)).toBe(false);
    expect(canConvertToMathExpression(hydrated, ["get_a"], registry)).toBe(false);
    expect(canConvertToMathExpression(hydrated, ["mx"], registry)).toBe(false);
    expect(canConvertToMathExpression(hydrated, [], registry)).toBe(false);
    const disabled = { ...hydrated, nodes: hydrated.nodes.map((entry) => entry.id === "sub" ? { ...entry, data: { ...entry.data, __disabled: true } } : entry) };
    expect(canConvertToMathExpression(disabled, ["sub"], registry)).toBe(false);
  });
});

describe("Convert to Math Nodes", () => {
  it("is refused for a formula with errors or no outputs", () => {
    expect(mathNodesConversionRefusal(node("mx", MATH_EXPRESSION_NODE_ID, { formula: "a +" }))).toBe("The formula has errors");
    expect(mathNodesConversionRefusal(node("mx", MATH_EXPRESSION_NODE_ID, { formula: "u + p", inputTypes: { u: "vec2", p: "vec3" } }))).toBe("The formula has errors");
    expect(mathNodesConversionRefusal(node("mx", MATH_EXPRESSION_NODE_ID, { formula: "" }))).toBe("The formula has no outputs");
    expect(mathNodesConversionRefusal(node("mx", MATH_EXPRESSION_NODE_ID, { formula: "a * 2" }))).toBeNull();
  });

  it("has a node for every construct of the language", () => {
    for (const construct of [...Object.keys(MATH_FUNCTIONS), ...mathExpressionConstructs()]) {
      expect(MATH_EXPRESSION_NODE_TABLE.some((entry) => entry.construct === construct), construct).toBe(true);
    }
  });

  it("replaces the node with ordinary nodes, wires and values that compute identical results", () => {
    const out = sinks([["Out", "mx.out_y"], ["Mid", "mx.out_m"]]);
    const graph: SerializedGraph = {
      nodes: [get("a"), get("v", "vec3"), ...out.nodes,
        node("mx", MATH_EXPRESSION_NODE_ID, { formula: "let d = a - b\nm = d * d\ny = length(v * d) + atan2d(d, c) + m", wiredInputTypes: { v: "vec3" }, "default:in_c": 2 }, 100, 100)],
      edges: [...out.edges, wire("get_a.value", "mx.in_a"), wire("get_v.value", "mx.in_v")],
    };
    let counter = 0;
    const converted = convertMathExpressionToNodes(hydrateSerializedGraphForEditor(graph, registry), "mx", () => `n${counter++}`)!;
    expect(converted.nodes.some((entry) => entry.id === "mx")).toBe(false);
    const types = converted.nodes.filter((entry) => entry.id.startsWith("n")).map((entry) => entry.type);
    expect(types.sort()).toEqual(["math.add", "math.add", "math.atan2Degrees", "math.mul", "math.mul", "math.sub", "vector.length3"].sort());
    // Laid out left to right: a node is right of every node it reads.
    const byId = new Map(converted.nodes.map((entry) => [entry.id, entry] as const));
    for (const edge of converted.edges) {
      if (edge.source.startsWith("n") && edge.target.startsWith("n")) expect(byId.get(edge.source)!.position.x).toBeLessThan(byId.get(edge.target)!.position.x);
    }
    const inputs = { a: "float", v: "vec3" } as const;
    expectSameResults(run(graph, inputs, ["Out", "Mid"]), run(converted, inputs, ["Out", "Mid"]));
  });

  it("round-trips nodes to an expression and back with identical results", () => {
    for (const { graph, selection, inputs, outputs } of [
      { ...scalarGraph(), inputs: { a: "float", b: "float", k: "float", t: "float" } as const, outputs: ["Out", "Diff"] },
      { ...vectorGraph(), inputs: { p: "vec3", q: "vec3", s: "float" } as const, outputs: ["Pos", "Side", "Up"] },
    ]) {
      const expression = convertToMathExpression(hydrateSerializedGraphForEditor(graph, registry), selection, registry, "mx")!;
      let counter = 0;
      const back = convertMathExpressionToNodes(hydrateSerializedGraphForEditor(expression, registry), "mx", () => `r${counter++}`)!;
      const original = run(graph, inputs, outputs);
      expectSameResults(original, run(expression, inputs, outputs));
      expectSameResults(original, run(back, inputs, outputs));
    }
  });
});

describe("Math Expression node menu", () => {
  const items = (graph: SerializedGraph, nodeId: string, selection: string[]) =>
    mathExpressionMenuItems(hydrateSerializedGraphForEditor(graph, registry), nodeId, selection, () => {})
      .map((item) => `${"label" in item ? item.label : item.id}${"disabled" in item && item.disabled ? " (disabled)" : ""}`);

  it("offers Convert to Math Expression only for a selection of expressible math nodes, and commits one change", () => {
    const { graph, selection } = scalarGraph();
    expect(items(graph, "sub", selection)).toEqual(["Convert to Math Expression"]);
    expect(items(graph, "sub", [...selection, "set_Out"])).toEqual([]);
    expect(items(graph, "get_a", ["get_a"])).toEqual([]);
    const commit = vi.fn();
    const [item] = mathExpressionMenuItems(hydrateSerializedGraphForEditor(graph, registry), "sub", selection, commit);
    (item as { onSelect: () => void }).onSelect();
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0]![0] as SerializedGraph).nodes.filter((entry) => entry.type === MATH_EXPRESSION_NODE_ID)).toHaveLength(1);
  });

  it("offers Convert to Math Nodes on one Math Expression node, disabled while its formula has errors", () => {
    const graph = (formula: string): SerializedGraph => ({ nodes: [node("mx", MATH_EXPRESSION_NODE_ID, { formula }), node("sub", "math.sub")], edges: [] });
    expect(items(graph("a * 2"), "mx", ["mx"])).toEqual(["Convert to Math Nodes"]);
    expect(items(graph("a *"), "mx", ["mx"])).toEqual(["Convert to Math Nodes (disabled)"]);
    expect(items(graph("a * 2"), "mx", ["mx", "sub"])).toEqual([]);
  });
});
