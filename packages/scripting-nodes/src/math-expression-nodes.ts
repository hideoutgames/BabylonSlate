import {
  MATH_CONSTANTS,
  MATH_FUNCTIONS,
  MATH_TYPE_AXES,
  mathBinaryResultType,
  type MathAnalysis,
  type MathExpr,
  type MathType,
} from "@haptic/scripting";

/**
 * The ordinary node each Math Expression construct stands for, in one table: a function by name,
 * an operator (`+ - * / % ^`, `neg` for unary minus), a component read (`member`) or a number
 * (`literal`). Convert to Math Nodes reads it forwards and Convert to Math Expression backwards,
 * so the two stay in step; the parity tests compile both sides with the real compiler.
 */
export type MathNodeEntry = {
  /** A function name from `MATH_FUNCTIONS`, an operator, `neg`, `member` or `literal`. */
  construct: string;
  typeId: string;
  /** Input pin ids in argument order. */
  args: readonly string[];
  /** The output pin id; `member` reads the pin named for the axis. */
  out: string;
  /** The vector type of the vector variants (`vector.lerp3` is `vec3`); absent for the Float form. */
  vector?: MathType;
};

const scalar = (construct: string, typeId: string, args: readonly string[] = ["in"], out = "out"): MathNodeEntry =>
  ({ construct, typeId, args, out });
const vectors = (construct: string, base: string, args: readonly string[], out = "out"): MathNodeEntry[] =>
  (["vec2", "vec3", "vec4"] as const).map((vector) => ({ construct, typeId: `${base}${vector.slice(3)}`, args, out, vector }));

const VALUE = ["value"];

export const MATH_EXPRESSION_NODE_TABLE: readonly MathNodeEntry[] = [
  // Operators; their operand types are the nodes' `aType`, `bType` and `inType`.
  scalar("+", "math.add", ["a", "b"]),
  scalar("-", "math.sub", ["a", "b"]),
  scalar("*", "math.mul", ["a", "b"]),
  scalar("/", "math.div", ["a", "b"]),
  scalar("%", "math.mod", ["a", "b"]),
  scalar("^", "math.power", ["base", "exp"]),
  scalar("neg", "math.negate"),
  // Functions.
  scalar("sin", "math.sin"), scalar("cos", "math.cos"), scalar("tan", "math.tan"),
  scalar("asin", "math.asin"), scalar("acos", "math.acos"), scalar("atan", "math.atan"),
  scalar("atan2", "math.atan2", ["y", "x"]),
  scalar("sind", "math.sinDegrees"), scalar("cosd", "math.cosDegrees"), scalar("tand", "math.tanDegrees"),
  scalar("asind", "math.asinDegrees"), scalar("acosd", "math.acosDegrees"), scalar("atand", "math.atanDegrees"),
  scalar("atan2d", "math.atan2Degrees", ["y", "x"]),
  scalar("sqrt", "math.sqrt"), scalar("abs", "math.abs"),
  scalar("min", "math.min", ["a", "b"]), scalar("max", "math.max", ["a", "b"]),
  scalar("clamp", "math.clamp", ["value", "min", "max"]),
  scalar("lerp", "math.lerp", ["a", "b", "alpha"]),
  ...vectors("lerp", "vector.lerp", ["a", "b", "alpha"]),
  scalar("floor", "math.floor"), scalar("ceil", "math.ceil"), scalar("round", "math.round"), scalar("sign", "math.sign"),
  scalar("pow", "math.power", ["base", "exp"]),
  scalar("exp", "math.exp", VALUE), scalar("ln", "math.ln", VALUE),
  scalar("log", "math.logarithm", ["value", "base"]),
  scalar("frac", "math.fraction", VALUE),
  scalar("wrap", "math.wrap", ["value", "min", "max"]),
  { construct: "vec2", typeId: "vector.make2", args: ["x", "y"], out: "out", vector: "vec2" },
  { construct: "vec3", typeId: "vector.make3", args: ["x", "y", "z"], out: "out", vector: "vec3" },
  { construct: "vec4", typeId: "vector.make4", args: ["x", "y", "z", "w"], out: "out", vector: "vec4" },
  ...vectors("dot", "vector.dot", ["a", "b"]),
  { construct: "cross", typeId: "vector.cross3", args: ["a", "b"], out: "out", vector: "vec3" },
  ...vectors("length", "vector.length", ["v"]),
  ...vectors("distance", "vector.distance", ["a", "b"]),
  ...vectors("normalize", "vector.normalize", ["v"]),
  ...vectors("member", "vector.break", ["in"], ""),
  scalar("literal", "literal.makeFloat"),
];

const OPERAND_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "math.add": ["aType", "bType"],
  "math.sub": ["aType", "bType"],
  "math.mul": ["aType", "bType"],
  "math.div": ["aType", "bType"],
  "math.mod": ["aType", "bType"],
  "math.negate": ["inType"],
};

/** The operand type properties of an operator node (`aType`, `bType`; `inType` for Negate). */
export function mathNodeOperandProperties(typeId: string): readonly string[] {
  return OPERAND_PROPERTIES[typeId] ?? [];
}

/** The table entry for `construct` on these argument types (the vector size picks a vector variant). */
export function mathNodeEntryFor(construct: string, argTypes: readonly MathType[]): MathNodeEntry | undefined {
  const vector = construct === "vec2" || construct === "vec3" || construct === "vec4"
    ? construct
    : argTypes.find((type) => type !== "float");
  const candidates = MATH_EXPRESSION_NODE_TABLE.filter((entry) => entry.construct === construct);
  if (candidates.length === 1 && !candidates[0]!.vector) return candidates[0];
  return candidates.find((entry) => entry.vector === vector) ?? candidates.find((entry) => !entry.vector && !vector);
}

/** Every construct the language has, as `mathNodeEntryFor` names them, for the table's completeness test. */
export function mathExpressionConstructs(): string[] {
  return [...Object.keys(MATH_FUNCTIONS), "+", "-", "*", "/", "%", "^", "neg", "member", "literal"];
}

/** Where a planned node input or a formula output reads from. */
export type MathPlanSource =
  | { kind: "node"; node: number; pin: string }
  | { kind: "input"; index: number }
  | { kind: "literal"; value: number };

/** One ordinary node of a converted formula: inputs not listed read their default. */
export type MathPlanNode = {
  typeId: string;
  properties: Record<string, unknown>;
  inputs: Record<string, MathPlanSource>;
};

/** A formula as ordinary nodes: one per operation, a shared value as one node feeding several. */
export type MathNodePlan = {
  nodes: MathPlanNode[];
  /** Each output's source, in signature order: always a node output. */
  outputs: MathPlanSource[];
};

type PlanValue = { type: MathType; source: MathPlanSource };

/**
 * The ordinary nodes `analysis` (with no type error) compiles to the same results as. Numbers are
 * inline defaults of the pins they feed; an output that is a number or an input passes through
 * Make Float, or Break and Make Vector.
 */
export function mathExpressionNodePlan(analysis: MathAnalysis): MathNodePlan {
  if (analysis.typeError) throw new Error(analysis.typeError.message);
  const nodes: MathPlanNode[] = [];
  const memo = new Map<string, number>();
  const sourceKey = (source: MathPlanSource) =>
    source.kind === "node" ? `n${source.node}.${source.pin}` : source.kind === "input" ? `i${source.index}` : `l${Object.is(source.value, -0) ? "-0" : source.value}`;
  const add = (entry: MathNodeEntry, properties: Record<string, unknown>, args: readonly MathPlanSource[]): number => {
    const key = `${entry.typeId}|${JSON.stringify(properties)}|${args.map(sourceKey).join(",")}`;
    const existing = memo.get(key);
    if (existing !== undefined) return existing;
    const inputs: Record<string, MathPlanSource> = {};
    const props: Record<string, unknown> = { ...properties };
    entry.args.forEach((pinId, index) => {
      const source = args[index];
      if (!source) return;
      if (source.kind === "literal") props[`default:${pinId}`] = source.value;
      else inputs[pinId] = source;
    });
    nodes.push({ typeId: entry.typeId, properties: props, inputs });
    memo.set(key, nodes.length - 1);
    return nodes.length - 1;
  };
  const entryOf = (construct: string, types: readonly MathType[]) => {
    const entry = mathNodeEntryFor(construct, types);
    if (!entry) throw new Error(`No node for ${construct}`);
    return entry;
  };
  const operandProps = (typeId: string, types: readonly MathType[]) =>
    Object.fromEntries(mathNodeOperandProperties(typeId).map((property, index) => [property, types[index]]));
  const env = new Map<string, PlanValue>();
  analysis.signature.inputs.forEach((input, index) => env.set(input.name, { type: analysis.inputTypes[index]!, source: { kind: "input", index } }));

  const value = (expr: MathExpr): PlanValue => {
    switch (expr.kind) {
      case "number":
        return { type: "float", source: { kind: "literal", value: expr.value } };
      case "name": {
        if (Object.hasOwn(MATH_CONSTANTS, expr.name)) {
          const constant = expr.name === "pi" ? Math.PI : expr.name === "tau" ? 2 * Math.PI : Math.E;
          return { type: "float", source: { kind: "literal", value: constant } };
        }
        return env.get(expr.name)!;
      }
      case "negate": {
        const arg = value(expr.arg);
        const entry = entryOf("neg", [arg.type]);
        return { type: arg.type, source: { kind: "node", node: add(entry, operandProps(entry.typeId, [arg.type]), [arg.source]), pin: entry.out } };
      }
      case "member": {
        const object = value(expr.object);
        const entry = entryOf("member", [object.type]);
        return { type: "float", source: { kind: "node", node: add(entry, {}, [object.source]), pin: expr.axis } };
      }
      case "binary": {
        const left = value(expr.left);
        const right = value(expr.right);
        const entry = entryOf(expr.op, [left.type, right.type]);
        const type = mathBinaryResultType(expr.op, left.type, right.type) as MathType;
        return { type, source: { kind: "node", node: add(entry, operandProps(entry.typeId, [left.type, right.type]), [left.source, right.source]), pin: entry.out } };
      }
      case "call": {
        const args = expr.args.map(value);
        const types = args.map((arg) => arg.type);
        const entry = entryOf(expr.name, types);
        const type = MATH_FUNCTIONS[expr.name]!.result(types) as MathType;
        // `log(v)` is Logarithm with its default Base of 10.
        return { type, source: { kind: "node", node: add(entry, {}, args.map((arg) => arg.source)), pin: entry.out } };
      }
    }
  };

  const outputs: MathPlanSource[] = [];
  const passThrough = (planned: PlanValue): MathPlanSource => {
    if (planned.source.kind === "node") return planned.source;
    if (planned.type === "float") {
      return { kind: "node", node: add(entryOf("literal", ["float"]), {}, [planned.source]), pin: "out" };
    }
    // A vector input as an output: its components into a Make Vector.
    const broken = add(entryOf("member", [planned.type]), {}, [planned.source]);
    const axes = MATH_TYPE_AXES[planned.type];
    const make = entryOf(planned.type, axes.map(() => "float"));
    return { kind: "node", node: add(make, {}, axes.map((axis) => ({ kind: "node", node: broken, pin: axis }))), pin: "out" };
  };
  for (const statement of analysis.program.statements) {
    const planned = value(statement.expr);
    if (statement.kind === "assign") {
      env.set(statement.name, planned);
      if (!statement.local) outputs.push(passThrough(planned));
    } else {
      outputs.push(passThrough(planned));
    }
  }
  return { nodes, outputs };
}
