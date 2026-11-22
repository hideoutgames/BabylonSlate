import { describe, expect, it } from "vitest";
import {
  analyzeMathExpression,
  compileGraph,
  compileTransitionRuleGraph,
  emitMathExpression,
  MATH_EXPRESSION_NODE_ID,
  MATH_FUNCTIONS,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type MathType,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import { mathExpressionConstructs, mathExpressionNodePlan, mathNodeEntryFor, MATH_EXPRESSION_NODE_TABLE } from "./math-expression-nodes";

const registry = createDefaultNodeRegistry();

type Vec = { x: number; y: number; z?: number; w?: number };
type Value = number | Vec;

const MODES = {
  release: { stripDevelopmentOnly: true, instrumentInfiniteLoops: false },
  traced: { instrumentExecutionTrace: true, instrumentInfiniteLoops: true },
} as const;

/** Edge values: NaN, both zeros, both infinities, the trig and log domain edges and ordinary values. */
const EDGES = [NaN, 0, -0, Infinity, -Infinity, 1, -1, 0.5, -0.5, 2, -2.5, 3, 1e-9, 1e300, -1e-300, 10, 360, 90];

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties) };
}

const typeOf = (types: Record<string, MathType>, name: string) => Object.hasOwn(types, name) ? types[name] : undefined;

type Built = { graph: LogicGraph; outputs: Array<{ name: string; type: MathType }> };

/**
 * One graph that reads each input from a variable, computes the outputs either with one Math
 * Expression node or with the ordinary nodes `mathExpressionNodePlan` gives, and sets one variable
 * per output.
 */
function build(formula: string, types: Record<string, MathType>, form: "expression" | "nodes"): Built {
  const analyzed = analyzeMathExpression(formula, (name) => typeOf(types, name));
  if (!analyzed.ok || analyzed.analysis.typeError) throw new Error(`bad formula ${formula}`);
  const { analysis } = analyzed;
  const nodes: GraphNode[] = [node("entry", "flow.entry")];
  const edges: LogicGraph["edges"] = [];
  const wire = (source: string, sourcePin: string, target: string, targetPin: string) =>
    edges.push({ id: `e${edges.length}`, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin });
  analysis.signature.inputs.forEach((input, index) =>
    nodes.push(node(`get${index}`, "variables.get", { variableName: input.name, typeId: analysis.inputTypes[index], implicitSelf: true })));
  let outputSource: (index: number) => { node: string; pin: string };
  if (form === "expression") {
    nodes.push(node("mx", MATH_EXPRESSION_NODE_ID, { formula, wiredInputTypes: types }));
    analysis.signature.inputs.forEach((input, index) => wire(`get${index}`, "value", "mx", `in_${input.name}`));
    outputSource = (index) => ({ node: "mx", pin: `out_${analysis.signature.outputs[index]!.name}` });
  } else {
    const plan = mathExpressionNodePlan(analysis);
    plan.nodes.forEach((planned, index) => {
      nodes.push(node(`n${index}`, planned.typeId, planned.properties));
      for (const [pinId, source] of Object.entries(planned.inputs)) {
        if (source.kind === "node") wire(`n${source.node}`, source.pin, `n${index}`, pinId);
        else if (source.kind === "input") wire(`get${source.index}`, "value", `n${index}`, pinId);
      }
    });
    outputSource = (index) => {
      const source = plan.outputs[index]!;
      if (source.kind !== "node") throw new Error("output not a node");
      return { node: `n${source.node}`, pin: source.pin };
    };
  }
  let previous = "entry";
  analysis.signature.outputs.forEach((output, index) => {
    const id = `set${index}`;
    nodes.push(node(id, "variables.set", { variableName: `out_${output.name}`, typeId: analysis.outputTypes[index], implicitSelf: true }));
    wire(previous, previous === "entry" ? "execOut" : "execOut", id, "execIn");
    const source = outputSource(index);
    wire(source.node, source.pin, id, "value");
    previous = id;
  });
  return {
    graph: { id: "g", kind: "event", nodes, edges },
    outputs: analysis.signature.outputs.map((output, index) => ({ name: output.name, type: analysis.outputTypes[index]! })),
  };
}

function load(source: string): (ctx: unknown) => void {
  return new Function(`${source.replace(/export\s+function\s+/g, "function ")}\nreturn run;`)() as (ctx: unknown) => void;
}

function context(vars: Map<string, Value>, traced: boolean) {
  const recorded: unknown[] = [];
  const recorder = { exec() {}, edge() {}, read: (_n: string, _p: string, v: unknown) => v, write: (_n: string, _p: string, v: unknown) => { recorded.push(v); } };
  return {
    self: {},
    debugTrace: traced ? { graph: () => recorder } : null,
    breakpoints: null,
    getVariable: (name: string) => vars.get(name),
    setVariable: (name: string, value: Value) => { vars.set(name, value); },
    checkInfiniteLoop() {},
    nullAccess() {},
  };
}

const AXES = ["x", "y", "z", "w"] as const;
function sample(type: MathType, seed: number): Value {
  const pick = (k: number) => EDGES[Math.abs(seed * 7 + k * 13 + (seed >> 2) * 5) % EDGES.length]!;
  if (type === "float") return pick(0);
  const size = Number(type.slice(3));
  const v: Record<string, number> = {};
  // Every fifth vector is zero, for Normalize and the divisions.
  for (let i = 0; i < size; i++) v[AXES[i]!] = seed % 5 === 0 ? 0 : pick(i + 1);
  return v as Vec;
}

function components(value: unknown): unknown[] {
  return value !== null && typeof value === "object" ? AXES.filter((axis) => axis in value).map((axis) => (value as Record<string, unknown>)[axis]) : [value];
}

/** Runs both graphs over the edge inputs in each mode and expects `Object.is`-identical outputs. */
function expectParity(formula: string, types: Record<string, MathType> = {}): void {
  const expression = build(formula, types, "expression");
  const nodes = build(formula, types, "nodes");
  const analysis = analyzeMathExpression(formula, (name) => typeOf(types, name));
  if (!analysis.ok) throw new Error(formula);
  for (const [mode, options] of Object.entries(MODES)) {
    const runs = [expression, nodes].map((built) => {
      expect(validateGraphs([built.graph], { assetGuid: "a" }).filter((d) => d.severity === "error"), `${formula} (${mode})`).toEqual([]);
      return load(compileGraph(built.graph, { assetGuid: "a", registry, ...options }).source);
    });
    const cases = EDGES.length * 3;
    for (let seed = 0; seed < cases; seed++) {
      const results = runs.map((run) => {
        const vars = new Map<string, Value>();
        analysis.analysis.signature.inputs.forEach((input, index) =>
          vars.set(input.name, sample(analysis.analysis.inputTypes[index]!, seed + index * 11)));
        run(context(vars, mode === "traced"));
        return expression.outputs.map((output) => components(vars.get(`out_${output.name}`)));
      });
      results[0]!.forEach((parts, index) => parts.forEach((part, axis) => {
        const other = results[1]![index]![axis];
        if (!Object.is(part, other)) {
          throw new Error(`${formula} (${mode}) output ${expression.outputs[index]!.name}[${axis}] seed ${seed}: expression ${String(part)} nodes ${String(other)}`);
        }
      }));
    }
  }
}

describe("Math Expression parity with the ordinary nodes", () => {
  it.each([
    "a + b", "a - b", "a * b", "a / b", "a % b", "a ^ b", "-a", "-a^2", "a^b^c", "2^-a",
    "sqrt(a)", "abs(a)", "min(a, b)", "max(a, b)", "clamp(a, b, c)", "lerp(a, b, c)",
    "floor(a) + ceil(b) + round(c)", "sign(a)", "pow(a, b)", "exp(a)", "ln(a)", "log(a)", "log(a, b)",
    "frac(a)", "wrap(a, b, c)",
    "sin(a) + cos(b) * tan(c)", "asin(a) - acos(b) + atan(c)", "atan2(a, b)",
    "sind(a) + cosd(b) * tand(c)", "asind(a) - acosd(b) + atand(c)", "atan2d(a, b)",
    "pi * a + tau - e", "2", "a", "(a + b) * (a + b) / (a - b)",
    "let d = b - a\nx = d * d\ny = d / 2 + x",
    "y = clamp((a - b) * k + sin(t * f) * amp, lo, hi)",
  ])("scalar %s", (formula) => {
    expectParity(formula);
  });

  const v3 = { p: "vec3", q: "vec3" } as const;
  it.each([
    "p + q", "p - s", "s - p", "s / p", "p / s", "p / q", "p * s", "s * p", "s + p", "p * q", "-p",
    "dot(p, q)", "cross(p, q)", "length(p)", "distance(p, q)", "normalize(p)", "lerp(p, q, s)",
    "p.x * q.y - p.z", "vec3(s, p.y, 2)", "p", "Pos = p + normalize(q - p) * (s * t)",
    "let n = normalize(q)\nr = n * dot(p, n)\nu = p - r",
  ])("Vector3 %s", (formula) => {
    expectParity(formula, v3);
  });

  it.each([
    ["normalize(u) + v * s", { u: "vec2", v: "vec2" }],
    ["dot(u, v) + length(u - v) + distance(u, v)", { u: "vec2", v: "vec2" }],
    ["lerp(w, w2, s) / s", { w: "vec4", w2: "vec4" }],
    ["vec4(w.x, w.w, s, 1) - normalize(w2)", { w: "vec4", w2: "vec4" }],
    ["vec2(s, t)", {}],
  ] as const)("%s", (formula, types) => {
    expectParity(formula, types);
  });

  it("matches the study's 26-operation formula", () => {
    expectParity([
      "let d = x1 - x0",
      "let e2 = d * k - v * c",
      "let g = sin(t * w) * amp * d",
      "let h = sqrt(abs(d)) * s / (1 + d * d)",
      "let m = lerp(lo, hi, clamp(e2 * 0.1, 0, 1))",
      "Out = clamp(e2 + g + h + m, -lim, lim) * exp(-damp * dt)",
    ].join("\n"));
  });
});

describe("Math Expression generated code", () => {
  const helpers = (formula: string, types: Record<string, MathType> = {}) => {
    const analyzed = analyzeMathExpression(formula, (name) => typeOf(types, name));
    if (!analyzed.ok) throw new Error(formula);
    return emitMathExpression(analyzed.analysis);
  };

  it("creates no closures and one object literal per vector output", () => {
    const outputs = helpers("let n = normalize(q - p)\nA = p + n * s\nB = cross(n, q)\nC = dot(A, B)", { p: "vec3", q: "vec3" });
    for (const helper of outputs) {
      // The helper itself is the only function: nothing inside it allocates a closure.
      expect(helper.declaration.match(/=>/g)).toHaveLength(1);
      expect(helper.declaration).not.toMatch(/\bfunction\b/);
    }
    expect(outputs.map((helper) => (helper.declaration.match(/\{ x:/g) ?? []).length)).toEqual([1, 1, 0]);
  });

  it("gives each output a helper that reads only the inputs it needs", () => {
    const [a, b] = helpers("A = x * 2\nB = y + z");
    expect(a!.inputs).toEqual([0]);
    expect(b!.inputs).toEqual([1, 2]);
    expect(b!.declaration).not.toContain("i0");
  });

  it("names a helper by its source, so equal formulas share one declaration and different ones never do", () => {
    const [first] = helpers("a + b");
    const [second] = helpers("first + second");
    const [third] = helpers("a - b");
    expect(first!.declaration).toBe(second!.declaration);
    expect(third!.name).not.toBe(first!.name);
  });

  it("never copies the formula's names into the code", () => {
    const [helper] = helpers("evilName = constructor * __proto__ + alert");
    expect(helper!.declaration).not.toMatch(/evilName|constructor|__proto__|alert/);
  });

  it("compiles to one hoisted call per wired output in release and traced builds", () => {
    const built = build("A = x * 2\nB = x + 1", {}, "expression");
    const release = compileGraph(built.graph, { assetGuid: "a", registry, ...MODES.release }).source;
    expect(release.match(/var __mx_[0-9a-f]{16} = /g)).toHaveLength(2);
    expect(release.match(/__mx_[0-9a-f]{16}\(/g)).toHaveLength(2);
  });
});

describe("Math Expression node", () => {
  it("has no pins until it has a formula", () => {
    expect(registry.get(MATH_EXPRESSION_NODE_ID)!.pins({})).toEqual([]);
  });

  /** The node feeding a Set Variable, so the graph check compiles it. */
  const checked = (properties: Record<string, unknown>, output: string) => {
    const graph: LogicGraph = {
      id: "g", kind: "event",
      nodes: [node("entry", "flow.entry"), node("mx", MATH_EXPRESSION_NODE_ID, properties), node("set", "variables.set", { variableName: "v", typeId: "float", implicitSelf: true })],
      edges: [
        { id: "e0", sourceNodeId: "entry", sourcePinId: "execOut", targetNodeId: "set", targetPinId: "execIn" },
        { id: "e1", sourceNodeId: "mx", sourcePinId: output, targetNodeId: "set", targetPinId: "value" },
      ],
    };
    return validateGraphs([graph], { assetGuid: "a" }).filter((d) => d.nodeId === "mx").map((d) => [d.code, d.message]);
  };

  it("reports a formula error through the graph check, keeping the last formula's pins", () => {
    expect(checked({ formula: "a +* b", pinFormula: "a + b" }, "out_Result")).toEqual([
      ["mathExpression.parse", "Math Expression: Line 1, column 4: Expected a number, a name or '(' but found '*'"],
    ]);
  });

  it("reports a type error with its position", () => {
    expect(checked({ formula: "y = a.x\nz = cross(a, b)", inputTypes: { a: "vec2", b: "vec2" } }, "out_y")).toEqual([
      ["mathExpression.type", "Math Expression: Line 2, column 5: cross takes two Vector3s"],
    ]);
  });
});

describe("Math Expression in Animation Graph transition rules", () => {
  it("compiles in a rule, which offers every pure node", () => {
    const graph: LogicGraph = {
      id: "rule", kind: "event",
      nodes: [
        node("enter", "anim.rule.enterState"),
        node("speed", "variables.get", { variableName: "speed", typeId: "float", implicitSelf: true }),
        node("mx", MATH_EXPRESSION_NODE_ID, { formula: "speed * 2 - 1" }),
        node("gt", "math.greater", { "default:b": 5 }),
      ],
      edges: [
        { id: "e0", sourceNodeId: "speed", sourcePinId: "value", targetNodeId: "mx", targetPinId: "in_speed" },
        { id: "e1", sourceNodeId: "mx", sourcePinId: "out_Result", targetNodeId: "gt", targetPinId: "a" },
        { id: "e2", sourceNodeId: "gt", sourcePinId: "out", targetNodeId: "enter", targetPinId: "value" },
      ],
    };
    const source = compileTransitionRuleGraph(graph, { assetGuid: "anim", registry }).source;
    const evaluate = new Function(`${source.replace(/export\s+function\s+/g, "function ")}\nreturn evaluate;`)() as
      (ctx: unknown) => { enter: boolean };
    expect(evaluate({ getVariable: () => 3 }).enter).toBe(false);
    expect(evaluate({ getVariable: () => 3.5 }).enter).toBe(true);
  });
});

describe("Math Expression node table", () => {
  it("maps every construct of the language to a catalog node, and each of its vector sizes", () => {
    expect(Object.keys(MATH_FUNCTIONS).every((name) => mathExpressionConstructs().includes(name))).toBe(true);
    for (const construct of mathExpressionConstructs()) {
      expect(MATH_EXPRESSION_NODE_TABLE.some((entry) => entry.construct === construct), construct).toBe(true);
    }
    for (const entry of MATH_EXPRESSION_NODE_TABLE) {
      const def = registry.get(entry.typeId);
      expect(def, entry.typeId).toBeDefined();
      const pins = def!.pins({});
      for (const pinId of entry.args) expect(pins.some((pin) => pin.id === pinId && pin.direction === "in"), `${entry.typeId}.${pinId}`).toBe(true);
    }
    expect(mathNodeEntryFor("normalize", ["vec2"])?.typeId).toBe("vector.normalize2");
    expect(mathNodeEntryFor("lerp", ["float", "float", "float"])?.typeId).toBe("math.lerp");
    expect(mathNodeEntryFor("vec4", ["float", "float", "float", "float"])?.typeId).toBe("vector.make4");
  });
});
