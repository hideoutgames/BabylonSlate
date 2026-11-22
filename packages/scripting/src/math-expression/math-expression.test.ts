import { describe, expect, it } from "vitest";
import {
  analyzeMathExpression,
  editMathExpressionFormula,
  MATH_EXPRESSION_MAX_DEPTH,
  MATH_EXPRESSION_MAX_LENGTH,
  MATH_EXPRESSION_MAX_STATEMENTS,
  MATH_EXPRESSION_NODE_ID,
  mathExpressionFormulaEdit,
  mathExpressionInputTypePatch,
  mathExpressionNodeState,
  mathExpressionPins,
  parseMathExpression,
  retypeMathExpressionInputs,
  type MathExpr,
} from "./index";
import { FLOAT, INT, VEC3, BOOL } from "../types";

/** The parsed expression in fully parenthesized prefix form, for precedence checks. */
function shape(expr: MathExpr): string {
  switch (expr.kind) {
    case "number": return expr.text;
    case "name": return expr.name;
    case "negate": return `(neg ${shape(expr.arg)})`;
    case "binary": return `(${expr.op} ${shape(expr.left)} ${shape(expr.right)})`;
    case "call": return `${expr.name}(${expr.args.map(shape).join(" ")})`;
    case "member": return `${shape(expr.object)}.${expr.axis}`;
  }
}

function parsed(source: string): string {
  const result = parseMathExpression(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.program.statements.map((statement) =>
    statement.kind === "assign" ? `${statement.local ? "let " : ""}${statement.name} = ${shape(statement.expr)}` : shape(statement.expr)).join("; ");
}

function parseError(source: string) {
  const result = parseMathExpression(source);
  if (result.ok) throw new Error(`parsed: ${source}`);
  return [result.error.code, result.error.line, result.error.column, result.error.message];
}

describe("Math Expression parser", () => {
  it.each([
    ["a + b * c", "(+ a (* b c))"],
    ["a - b - c", "(- (- a b) c)"],
    ["a / b % c * d", "(* (% (/ a b) c) d)"],
    ["a ^ b ^ c", "(^ a (^ b c))"],
    ["-a ^ 2", "(neg (^ a 2))"],
    ["2 ^ -a", "(^ 2 (neg a))"],
    ["-a * b", "(* (neg a) b)"],
    ["(a + b) * c", "(* (+ a b) c)"],
    ["p.x ^ 2", "(^ p.x 2)"],
    ["normalize(p - q).y", "normalize((- p q)).y"],
    ["clamp(a, 0, 1.5e3)", "clamp(a 0 1.5e3)"],
    [".5 + 2.", "(+ .5 2.)"],
  ])("parses %s as %s", (source, expected) => {
    expect(parsed(source)).toBe(expected);
  });

  it("separates statements by line breaks and semicolons, continues lines after an operator or inside parentheses, and skips comments", () => {
    expect(parsed("let d = b - a; x = d *\n  2 // doubled\ny = min(\n  d,\n  x)\n\n")).toBe("let d = (- b a); x = (* d 2); y = min(d x)");
  });

  it.each([
    ["a + ", ["mathExpression.parse", 1, 5, "Expected a number, a name or '(' but found the end of the formula"]],
    ["a $ b", ["mathExpression.parse", 1, 3, "Unexpected character '$'"]],
    ["x = 1\ny = (2", ["mathExpression.parse", 2, 7, "Expected ')' but found the end of the formula"]],
    ["a b", ["mathExpression.parse", 1, 3, "Expected an operator or the end of the statement but found 'b'"]],
    ["p.q", ["mathExpression.parse", 1, 3, "Expected x, y, z or w after '.' but found 'q'"]],
    ["let 2", ["mathExpression.parse", 1, 5, "Expected a name and '=' after 'let'"]],
    ["a == b", ["mathExpression.parse", 1, 4, "Expected a number, a name or '(' but found '='"]],
    ["1e999", ["mathExpression.parse", 1, 1, "The number 1e999 is too large"]],
    ["\u0007", ["mathExpression.parse", 1, 1, "Unexpected character 'U+0007'"]],
  ] as const)("reports %j with its position", (source, expected) => {
    expect(parseError(source)).toEqual(expected);
  });

  it("refuses formulas past the length, nesting and statement limits, and accepts them at the limit", () => {
    expect(parseError("a".repeat(MATH_EXPRESSION_MAX_LENGTH + 1))[0]).toBe("mathExpression.limit");
    expect(parseMathExpression(`${"(".repeat(MATH_EXPRESSION_MAX_DEPTH)}a${")".repeat(MATH_EXPRESSION_MAX_DEPTH)}`).ok).toBe(true);
    expect(parseError(`${"(".repeat(MATH_EXPRESSION_MAX_DEPTH + 1)}a${")".repeat(MATH_EXPRESSION_MAX_DEPTH + 1)}`))
      .toEqual(["mathExpression.limit", 1, MATH_EXPRESSION_MAX_DEPTH + 1, `The formula nests more than ${MATH_EXPRESSION_MAX_DEPTH} levels deep`]);
    expect(parseError("-".repeat(MATH_EXPRESSION_MAX_DEPTH + 1) + "a")[0]).toBe("mathExpression.limit");
    const statements = (count: number) => Array.from({ length: count }, (_, index) => `v${index} = ${index}`).join("\n");
    expect(parseMathExpression(statements(MATH_EXPRESSION_MAX_STATEMENTS)).ok).toBe(true);
    expect(parseError(statements(MATH_EXPRESSION_MAX_STATEMENTS + 1))[0]).toBe("mathExpression.limit");
    expect(parseError(`${"n".repeat(65)} = 1`)[0]).toBe("mathExpression.limit");
  });
});

describe("Math Expression names and types", () => {
  type Analyzed = { error?: unknown[]; inputs?: string[]; outputs?: string[]; typeError?: unknown[] };
  const analyze = (source: string, types: Record<string, "float" | "vec2" | "vec3" | "vec4"> = {}): Analyzed => {
    const result = analyzeMathExpression(source, (name) => Object.hasOwn(types, name) ? types[name] : undefined);
    if (!result.ok) return { error: [result.error.code, result.error.line, result.error.column, result.error.message] };
    const { signature, inputTypes, outputTypes, typeError } = result.analysis;
    return {
      inputs: signature.inputs.map((input, index) => `${input.name}:${inputTypes[index]}`),
      outputs: signature.outputs.map((output, index) => `${output.name}:${outputTypes[index]}`),
      ...(typeError ? { typeError: [typeError.line, typeError.column, typeError.message] } : {}),
    };
  };

  it("makes unassigned names inputs in order of first use, assignments outputs, and keeps let values internal", () => {
    expect(analyze("let d = b - a\nx = d * k\ny = x + b + pi")).toEqual({ inputs: ["b:float", "a:float", "k:float"], outputs: ["x:float", "y:float"] });
  });

  it("names a single bare expression's output Result and gives an empty formula no pins", () => {
    expect(analyze("a * 2")).toEqual({ inputs: ["a:float"], outputs: ["Result:float"] });
    expect(analyze("  // nothing yet\n")).toEqual({ inputs: [], outputs: [] });
  });

  it.each([
    ["x = 1\na + 2", ["mathExpression.name", 2, 1, "Assign this expression to a name ('name = …' for an output, 'let name = …' for a value)"]],
    ["x = 1\nx = 2", ["mathExpression.name", 2, 1, "'x' is assigned twice"]],
    ["y = x\nx = 2", ["mathExpression.name", 1, 5, "'x' is used before it is assigned"]],
    ["sin = 2", ["mathExpression.name", 1, 1, "'sin' is a built-in name"]],
    ["let pi = 3", ["mathExpression.name", 1, 5, "'pi' is a built-in name"]],
    ["sqrt + 1", ["mathExpression.name", 1, 1, "'sqrt' is a function: call it as sqrt(…)"]],
  ] as const)("refuses %j", (source, error) => {
    expect(analyze(source)).toEqual({ error });
  });

  it("types vectors as the operator nodes do and reports mismatches with their position", () => {
    expect(analyze("a = p * s + q\nb = s - p\nc = dot(p, q)\nd = p.x", { p: "vec3", q: "vec3" }).outputs)
      .toEqual(["a:vec3", "b:vec3", "c:float", "d:float"]);
    expect(analyze("u + p", { u: "vec2", p: "vec3" }).typeError)
      .toEqual([1, 3, "Cannot combine Vector2 with Vector3: use the same vector size, or a number with a vector"]);
    expect(analyze("p % 2", { p: "vec3" }).typeError).toEqual([1, 3, "Modulo takes Floats (got Vector3 and Float)"]);
    expect(analyze("abs(p)", { p: "vec3" }).typeError).toEqual([1, 1, "abs takes a Float (got Vector3)"]);
    expect(analyze("u.z", { u: "vec2" }).typeError).toEqual([1, 2, "A Vector2 has no .z"]);
    expect(analyze("clamp(a, b)").typeError).toEqual([1, 1, "clamp takes 3 arguments (got 2)"]);
    expect(analyze("foo(a)").typeError).toEqual([1, 1, "Unknown function 'foo'"]);
  });

  it("keeps the pins of a formula with a type error, typing outputs it cannot type as Float", () => {
    expect(analyze("y = u + p\nz = u", { u: "vec2", p: "vec3" })).toMatchObject({ inputs: ["u:vec2", "p:vec3"], outputs: ["y:float", "z:float"] });
  });
});

describe("Math Expression node pins", () => {
  const pinsOf = (properties: Record<string, unknown>) =>
    mathExpressionPins(properties).map((pin) => `${pin.direction} ${pin.id} ${pin.name} ${pin.type.kind}${pin.accepts ? " follows" : ""}`);

  it("gives a node with no formula no pins", () => {
    expect(mathExpressionPins({})).toEqual([]);
  });

  it("types an input by the Inspector's choice, else its wire's type, else Float", () => {
    expect(pinsOf({ formula: "y = a + b + c", inputTypes: { a: "vec3" }, wiredInputTypes: { a: "vec2", b: "vec3" } })).toEqual([
      "in in_a a vec3", "in in_b b vec3 follows", "in in_c c float follows", "out out_y y vec3",
    ]);
  });

  it("keeps the last formula's pins while the formula does not parse", () => {
    expect(pinsOf({ formula: "y = a +", pinFormula: "y = a + b" })).toEqual(["in in_a a float follows", "in in_b b float follows", "out out_y y float"]);
    expect(mathExpressionNodeState({ formula: "y = a +", pinFormula: "y = a + b" }).error?.code).toBe("mathExpression.parse");
  });

  it("retypes an input to the type wired into it, Integer as Float, and leaves Inspector types alone", () => {
    const properties = { formula: "a + b + c", "default:in_a": 3, inputTypes: { c: "vec2" } };
    const wires: Record<string, { kind: string }> = { in_a: VEC3, in_b: INT, in_c: VEC3 };
    const next = retypeMathExpressionInputs(properties, (pinId) => wires[pinId] as never);
    expect(next).toEqual({ formula: "a + b + c", inputTypes: { c: "vec2" }, wiredInputTypes: { a: "vec3", b: "float" } });
    // The same wires again change nothing; a Bool wire is left for validation.
    expect(retypeMathExpressionInputs(next, (pinId) => wires[pinId] as never)).toBe(next);
    expect(retypeMathExpressionInputs(next, () => BOOL)).toBe(next);
    // Unwired, an input keeps the type its last wire gave it.
    expect(retypeMathExpressionInputs(next, () => undefined)).toBe(next);
  });

  it("drops an input's stored default when an Inspector type changes it", () => {
    const properties = { formula: "a * 2", "default:in_a": 4 };
    expect(mathExpressionInputTypePatch(properties, "a", "vec3")).toEqual({ inputTypes: { a: "vec3" }, "default:in_a": undefined });
    expect(mathExpressionInputTypePatch({ ...properties, inputTypes: { a: "vec3" } }, "a", undefined)).toEqual({ inputTypes: undefined, "default:in_a": undefined });
    expect(mathExpressionInputTypePatch(properties, "a", "float")).toEqual({ inputTypes: { a: "float" } });
  });
});

describe("Math Expression formula edits", () => {
  const typeIdOf = (node: { data: Record<string, unknown> }) => String(node.data.__nodeType);
  const graph = (formula: string, extra: Record<string, unknown> = {}) => ({
    nodes: [
      { id: "mx", data: { __nodeType: MATH_EXPRESSION_NODE_ID, formula, ...extra } },
      { id: "src", data: { __nodeType: "other" } },
    ],
    edges: [
      { id: "e1", source: "src", target: "mx", sourceHandle: "out", targetHandle: "in_a" },
      { id: "e2", source: "src", target: "mx", sourceHandle: "out", targetHandle: "in_b" },
      { id: "e3", source: "mx", target: "src", sourceHandle: "out_y", targetHandle: "in" },
    ],
  });
  const edit = (formula: string, next: string, extra: Record<string, unknown> = {}) => {
    const before = graph(formula, extra);
    const result = editMathExpressionFormula(before.nodes, before.edges, "mx", next, typeIdOf)!;
    return {
      edges: result.edges.map((edge) => `${edge.id} ${edge.sourceHandle}->${edge.targetHandle}`),
      data: Object.fromEntries(Object.entries(result.nodes[0]!.data).filter(([key]) => key !== "__nodeType")),
    };
  };

  it("moves the wire, default and type choices of a variable renamed in place", () => {
    expect(edit("y = a + b", "y = speed + b", { "default:in_a": 2, wiredInputTypes: { a: "float" } })).toEqual({
      edges: ["e1 out->in_speed", "e2 out->in_b", "e3 out_y->in"],
      data: { formula: "y = speed + b", "default:in_speed": 2, wiredInputTypes: { speed: "float" } },
    });
    expect(edit("y = a + b", "total = a + b").edges).toEqual(["e1 out->in_a", "e2 out->in_b", "e3 out_total->in"]);
  });

  it("drops the wires of variables that are gone when the change is not one rename in place", () => {
    // Two names changed: nothing follows.
    expect(edit("y = a + b", "y = c + d").edges).toEqual(["e3 out_y->in"]);
    // The new name is in another position.
    expect(edit("y = a + b", "y = b + c").edges).toEqual(["e2 out->in_b", "e3 out_y->in"]);
    // The renamed input changes type (an Inspector choice for the new name).
    expect(edit("y = a + b", "y = v + b", { inputTypes: { v: "vec3" } }).edges).toEqual(["e2 out->in_b", "e3 out_y->in"]);
    // Removing a variable drops its wire and its stored default.
    expect(edit("y = a + b", "y = b", { "default:in_a": 5 })).toEqual({ edges: ["e2 out->in_b", "e3 out_y->in"], data: { formula: "y = b" } });
  });

  it("keeps every pin and wire while the new formula does not parse", () => {
    expect(edit("y = a + b", "y = a +")).toEqual({
      edges: ["e1 out->in_a", "e2 out->in_b", "e3 out_y->in"],
      data: { formula: "y = a +", pinFormula: "y = a + b" },
    });
    // Fixing it later renames against the pins on show.
    const typo = mathExpressionFormulaEdit({ formula: "y = a +", pinFormula: "y = a + b" }, "y = a + c");
    expect([...typo.renames]).toEqual([["in_b", "in_c"]]);
    expect(typo.properties).toEqual({ formula: "y = a + c" });
  });

  it("returns the hydrated pins with the node's data, and nothing for another node", () => {
    const hydrated = { nodes: [{ id: "mx", data: { __nodeType: MATH_EXPRESSION_NODE_ID, __pins: [] } }], edges: [] };
    const result = editMathExpressionFormula(hydrated.nodes, hydrated.edges, "mx", "v * 2", typeIdOf)!;
    expect((result.nodes[0]!.data.__pins as Array<{ id: string; type: unknown }>).map((pin) => [pin.id, pin.type])).toEqual([["in_v", FLOAT], ["out_Result", FLOAT]]);
    expect(editMathExpressionFormula(hydrated.nodes, hydrated.edges, "other", "v", typeIdOf)).toBeUndefined();
  });
});
