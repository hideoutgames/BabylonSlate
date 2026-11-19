import {
  pin,
  diagnostic,
  listValidationRules,
  pinDefaultPropertyKey,
  registerValidationRule,
  FLOAT,
  INT,
  VEC2,
  VEC3,
  VEC4,
  type CodegenContext,
  type Diagnostic,
  type GraphPin,
  type LogicGraph,
  type NodeDefinition,
  type PinType,
  type TypeContext,
} from "@haptic/scripting";
import { ARITHMETIC_SEARCH_ALIASES } from "./arithmetic-search-aliases";
import { hoistedCall } from "./hoisted-helper";

/**
 * Add, Subtract, Multiply, Divide, Modulo and Negate: one node per operation whose operand pins
 * each take Integer, Float or a Vector. Each operand's type is a node property (`aType`, `bType`,
 * `inType`; missing reads as Float), so an unwired operand keeps its inline value editor. The
 * editor retypes an operand to the type wired into it (`retypeNumericOperands`); `accepts` on each
 * operand pin lists the types such a wire may bring while the node stays valid.
 */
export type NumericOperandType = "int" | "float" | "vec2" | "vec3" | "vec4";

export const NUMERIC_OPERAND_TYPES: readonly NumericOperandType[] = ["int", "float", "vec2", "vec3", "vec4"];

const OPERAND_PIN_TYPES: Readonly<Record<NumericOperandType, PinType>> = {
  int: INT, float: FLOAT, vec2: VEC2, vec3: VEC3, vec4: VEC4,
};

const AXES: Readonly<Record<"vec2" | "vec3" | "vec4", readonly string[]>> = {
  vec2: ["x", "y"],
  vec3: ["x", "y", "z"],
  vec4: ["x", "y", "z", "w"],
};

type BinaryOperator = "+" | "-" | "*" | "/" | "%";

const BINARY_OPERATORS: Readonly<Record<string, BinaryOperator>> = {
  "math.add": "+",
  "math.sub": "-",
  "math.mul": "*",
  "math.div": "/",
  "math.mod": "%",
};

export const NUMERIC_NEGATE_NODE_ID = "math.negate";

/** The Script nodes whose operand pins follow the type wired into them. */
export const NUMERIC_OPERATOR_NODE_IDS: ReadonlySet<string> = new Set([...Object.keys(BINARY_OPERATORS), NUMERIC_NEGATE_NODE_ID]);

export function isNumericOperatorNode(typeId: string): boolean {
  return NUMERIC_OPERATOR_NODE_IDS.has(typeId);
}

/** An operand pin and the node property that holds its type. */
export type NumericOperand = { pinId: string; property: string };

const BINARY_OPERANDS: readonly NumericOperand[] = [
  { pinId: "a", property: "aType" },
  { pinId: "b", property: "bType" },
];
const NEGATE_OPERANDS: readonly NumericOperand[] = [{ pinId: "in", property: "inType" }];

/** The operand pins of a numeric operator node, in pin order; empty for any other node. */
export function numericOperands(typeId: string): readonly NumericOperand[] {
  if (typeId === NUMERIC_NEGATE_NODE_ID) return NEGATE_OPERANDS;
  return BINARY_OPERATORS[typeId] ? BINARY_OPERANDS : [];
}

export function isNumericOperandType(value: unknown): value is NumericOperandType {
  return typeof value === "string" && (NUMERIC_OPERAND_TYPES as readonly string[]).includes(value);
}

/** The type stored in `property`; a missing or unknown value reads as Float. */
export function numericOperandType(properties: Record<string, unknown>, property: string): NumericOperandType {
  const value = properties[property];
  return isNumericOperandType(value) ? value : "float";
}

/** The operand type a pin type stands for, or undefined for any other type. */
export function numericOperandTypeOf(type: { kind: string } | undefined): NumericOperandType | undefined {
  return type && isNumericOperandType(type.kind) ? type.kind : undefined;
}

const isVector = (type: NumericOperandType): type is "vec2" | "vec3" | "vec4" => type !== "int" && type !== "float";

/**
 * The result of a binary operation: Integer for two Integers, Float for any other two numbers, the
 * vector for a vector with the same vector or with a number (either order). Two different vector
 * sizes have none.
 */
export function numericResultType(a: NumericOperandType, b: NumericOperandType): NumericOperandType | undefined {
  if (isVector(a) && isVector(b)) return a === b ? a : undefined;
  if (isVector(a)) return a;
  if (isVector(b)) return b;
  return a === "int" && b === "int" ? "int" : "float";
}

const SCALAR_CHOICES: readonly NumericOperandType[] = ["int", "float"];
const VECTOR_CHOICES: Readonly<Record<"vec2" | "vec3" | "vec4", readonly NumericOperandType[]>> = {
  vec2: ["int", "float", "vec2"],
  vec3: ["int", "float", "vec3"],
  vec4: ["int", "float", "vec4"],
};

/**
 * The types an operand of `typeId` may take while the node stays valid, given the other operand's
 * type (`undefined` for Negate): any number type against a number, numbers or that same vector
 * against a vector. Modulo takes numbers only.
 */
export function numericOperandChoices(typeId: string, other: NumericOperandType | undefined): readonly NumericOperandType[] {
  if (typeId === "math.mod") return SCALAR_CHOICES;
  if (other && isVector(other)) return VECTOR_CHOICES[other];
  return NUMERIC_OPERAND_TYPES;
}

/** Whether the operand types stored on a node give a valid operation. */
export function numericOperandsValid(typeId: string, properties: Record<string, unknown>): boolean {
  const operands = numericOperands(typeId);
  if (operands.length !== 2) return true;
  const a = numericOperandType(properties, "aType");
  const b = numericOperandType(properties, "bType");
  return numericOperandChoices(typeId, b).includes(a) && numericResultType(a, b) !== undefined;
}

// One frozen `accepts` list per choice set, so building pins allocates no lists.
const ACCEPTS = new Map<readonly NumericOperandType[], readonly PinType[]>();
function acceptsFor(choices: readonly NumericOperandType[]): PinType[] {
  let accepts = ACCEPTS.get(choices);
  if (!accepts) {
    accepts = Object.freeze(choices.map((choice) => OPERAND_PIN_TYPES[choice]));
    ACCEPTS.set(choices, accepts);
  }
  return accepts as PinType[];
}

function operandPin(id: string, name: string, type: NumericOperandType, choices: readonly NumericOperandType[]): GraphPin {
  return { ...pin(id, name, "in", OPERAND_PIN_TYPES[type]), accepts: acceptsFor(choices) };
}

/**
 * What choosing `type` for an operand writes (the Inspector's type row and the pin menu's Convert
 * Pin): its type property, and no stored value, which was of the old type.
 */
export function numericOperandTypePatch(operand: NumericOperand, type: NumericOperandType): Record<string, unknown> {
  return { [operand.property]: type, [pinDefaultPropertyKey(operand.pinId)]: undefined };
}

/**
 * The operand types after the wires into the node. An operand's type property is unset until a
 * wire, a follow or an Inspector pick chooses it; once set, it is what every later refresh reads.
 * - A wire the node accepts (anything else is left for validation to report) sets an unset
 *   operand to its type, and changes a set one only when its type is not assignable to the set
 *   type: an Integer into a Float operand stays Float.
 * - When a wire sets or changes one operand, the other follows when its type is unset, it is
 *   unwired and it has no stored value, so a fresh node dropped on a Vector3 wire works on two
 *   Vector3s. A follow writes the property, so it happens once.
 * - An operand whose type changes loses its stored value, which was of the old type.
 * Returns `properties` itself when nothing changes.
 */
export function retypeNumericOperands(
  typeId: string,
  properties: Record<string, unknown>,
  wired: (pinId: string) => { wired: boolean; type?: NumericOperandType },
): Record<string, unknown> {
  const operands = numericOperands(typeId);
  if (operands.length === 0) return properties;
  const allowed = typeId === "math.mod" ? SCALAR_CHOICES : NUMERIC_OPERAND_TYPES;
  const chosen = operands.map((operand) => isNumericOperandType(properties[operand.property]));
  const before = operands.map((operand) => numericOperandType(properties, operand.property));
  const links = operands.map((operand) => wired(operand.pinId));
  // The type each operand's property is set to here; undefined leaves it as it is.
  const writes: Array<NumericOperandType | undefined> = links.map((link, index) => {
    const type = link.type;
    if (!type || !allowed.includes(type)) return undefined;
    if (!chosen[index]) return type;
    // Among these types only Integer widens to Float.
    const assignable = type === before[index] || (type === "int" && before[index] === "float");
    return assignable ? undefined : type;
  });
  if (operands.length === 2) {
    for (const [source, other] of [[0, 1], [1, 0]] as const) {
      const type = writes[source];
      if (!type || chosen[other] || writes[other] || links[other]!.wired) continue;
      if (properties[pinDefaultPropertyKey(operands[other]!.pinId)] !== undefined) continue;
      writes[other] = type;
    }
  }
  if (writes.every((type) => type === undefined)) return properties;
  const next = { ...properties };
  operands.forEach((operand, index) => {
    const type = writes[index];
    if (!type) return;
    next[operand.property] = type;
    if (type !== before[index]) delete next[pinDefaultPropertyKey(operand.pinId)];
  });
  return next;
}

/**
 * Integer Divide truncates toward zero and Integer Modulo keeps the dividend's sign. A zero divisor
 * yields 0, so an Integer pin never carries Infinity or NaN.
 */
function intDivisionExpr(ctx: CodegenContext, a: string, b: string, op: "/" | "%"): string {
  const result = op === "/" ? "Math.trunc(a / b)" : "a % b";
  return hoistedCall(ctx, op === "/" ? "__math_divInt" : "__math_modInt", "a, b", `(b === 0 ? 0 : ${result})`, [a, b]);
}

/**
 * Float Divide and Modulo. A zero divisor yields 0, as on Integers: no math node hands NaN or
 * Infinity to the nodes after it for an input outside its domain.
 */
function floatDivisionExpr(ctx: CodegenContext, a: string, b: string, op: "/" | "%"): string {
  return hoistedCall(ctx, op === "/" ? "__math_div" : "__math_mod", "a, b", `(b === 0 ? 0 : a ${op} b)`, [a, b]);
}

const OP_NAMES = { "+": "add", "-": "sub", "*": "mul", "/": "div" } as const;
type VectorOperator = keyof typeof OP_NAMES;

/**
 * Each vector helper binds its inputs once (`a`, `b`, `v`, `s`), so an impure input such as Random
 * Float is sampled once and every component sees it. The helper is a module-scope function named
 * for its operation, axes and, with a number, which side the number is on (`__vec_add_xyz`,
 * `__vec_divScalar_xyz`, `__vec_scalarDiv_xyz`), so a node evaluates with one call. A zero
 * component of a divisor yields 0 for that component, as Divide does on Floats.
 */
function componentWise(ctx: CodegenContext, a: string, b: string, op: VectorOperator, axes: readonly string[]): string {
  return hoistedCall(
    ctx,
    `__vec_${OP_NAMES[op]}_${axes.join("")}`,
    "a, b",
    `({ ${axes.map((axis) => op === "/" ? `${axis}: b.${axis} === 0 ? 0 : a.${axis} / b.${axis}` : `${axis}: a.${axis} ${op} b.${axis}`).join(", ")} })`,
    [a, b],
  );
}

function scaleExpr(ctx: CodegenContext, v: string, s: string, axes: readonly string[]): string {
  return hoistedCall(ctx, `__vec_scale_${axes.join("")}`, "v, s", `({ ${axes.map((axis) => `${axis}: v.${axis} * s`).join(", ")} })`, [v, s]);
}

/** A vector with a number on its right: `v - s`, `v / s` (a zero `s` gives a zero vector). */
function vectorScalarExpr(ctx: CodegenContext, v: string, s: string, op: "+" | "-" | "/", axes: readonly string[]): string {
  const components = axes.map((axis) => `${axis}: v.${axis} ${op} s`).join(", ");
  const body = op === "/"
    ? `(s === 0 ? { ${axes.map((axis) => `${axis}: 0`).join(", ")} } : { ${components} })`
    : `({ ${components} })`;
  return hoistedCall(ctx, `__vec_${OP_NAMES[op]}Scalar_${axes.join("")}`, "v, s", body, [v, s]);
}

/** A number with a vector on its right: `s - v`, `s / v` (0 where a component of `v` is 0). */
function scalarVectorExpr(ctx: CodegenContext, s: string, v: string, op: "-" | "/", axes: readonly string[]): string {
  const name = op === "-" ? "Sub" : "Div";
  return hoistedCall(
    ctx,
    `__vec_scalar${name}_${axes.join("")}`,
    "s, v",
    `({ ${axes.map((axis) => op === "/" ? `${axis}: v.${axis} === 0 ? 0 : s / v.${axis}` : `${axis}: s - v.${axis}`).join(", ")} })`,
    [s, v],
  );
}

function invalidOperands(ctx: CodegenContext, a: NumericOperandType, b: NumericOperandType): Error {
  return new Error(`${ctx.node.typeId} cannot combine ${a} with ${b}`);
}

function binaryExpr(ctx: CodegenContext, op: BinaryOperator): string {
  const props = ctx.node.properties;
  const aType = numericOperandType(props, "aType");
  const bType = numericOperandType(props, "bType");
  if (!numericOperandsValid(ctx.node.typeId, props)) throw invalidOperands(ctx, aType, bType);
  const a = ctx.input("a");
  const b = ctx.input("b");
  if (!isVector(aType) && !isVector(bType)) {
    if (op === "/" || op === "%") {
      return aType === "int" && bType === "int" ? intDivisionExpr(ctx, a, b, op) : floatDivisionExpr(ctx, a, b, op);
    }
    return `(${a} ${op} ${b})`;
  }
  // Modulo takes numbers only (`numericOperandsValid`).
  const vectorOp = op as VectorOperator;
  if (isVector(aType) && isVector(bType)) return componentWise(ctx, a, b, vectorOp, AXES[aType]);
  if (isVector(aType)) {
    const axes = AXES[aType];
    return vectorOp === "*" ? scaleExpr(ctx, a, b, axes) : vectorScalarExpr(ctx, a, b, vectorOp, axes);
  }
  const axes = AXES[bType as "vec2" | "vec3" | "vec4"];
  if (vectorOp === "*") return scaleExpr(ctx, b, a, axes);
  if (vectorOp === "+") return vectorScalarExpr(ctx, b, a, "+", axes);
  return scalarVectorExpr(ctx, a, b, vectorOp, axes);
}

/** Search words of the per-type nodes the unified ones replace, so "add vector3" or "scale" still finds them. */
const TYPED_SEARCH_WORDS: Readonly<Record<BinaryOperator, readonly string[]>> = {
  "+": ["add int", "add vector", "add vector2", "add vector3", "add vector4"],
  "-": ["subtract int", "subtract vector", "subtract vector2", "subtract vector3", "subtract vector4"],
  "*": ["multiply int", "multiply vector", "multiply vector2", "multiply vector3", "multiply vector4",
    "scale", "scale vector", "scale vector2", "scale vector3", "scale vector4", "v * s"],
  "/": ["divide int", "divide vector", "divide vector2", "divide vector3", "divide vector4"],
  "%": ["modulo int"],
};

function binaryOperatorNode(id: string, title: string): NodeDefinition {
  const op = BINARY_OPERATORS[id]!;
  return {
    id,
    title,
    category: "math",
    searchAliases: [...ARITHMETIC_SEARCH_ALIASES[op]!, ...TYPED_SEARCH_WORDS[op]],
    pure: true,
    referentiallyTransparent: true,
    pins: (properties) => {
      const a = numericOperandType(properties, "aType");
      const b = numericOperandType(properties, "bType");
      // A hand-edited pair of different vector sizes keeps A's type: validation reports it.
      const out = numericResultType(a, b) ?? a;
      return [
        operandPin("a", "A", a, numericOperandChoices(id, b)),
        operandPin("b", "B", b, numericOperandChoices(id, a)),
        pin("out", "Out", "out", OPERAND_PIN_TYPES[out]),
      ];
    },
    codegen: (ctx) => ({ out: binaryExpr(ctx, op) }),
  };
}

export const numericOperatorNodes: NodeDefinition[] = [
  binaryOperatorNode("math.add", "Add"),
  binaryOperatorNode("math.sub", "Subtract"),
  binaryOperatorNode("math.mul", "Multiply"),
  binaryOperatorNode("math.div", "Divide"),
  binaryOperatorNode("math.mod", "Modulo"),
  {
    id: NUMERIC_NEGATE_NODE_ID,
    searchAliases: ["-", "−", "-x", "negation", "invert", "reverse", "opposite", "negate int", "negate vector",
      "negate vector2", "negate vector3", "negate vector4"],
    title: "Negate",
    category: "math",
    pure: true,
    referentiallyTransparent: true,
    pins: (properties) => {
      const type = numericOperandType(properties, "inType");
      return [
        operandPin("in", "In", type, NUMERIC_OPERAND_TYPES),
        pin("out", "Out", "out", OPERAND_PIN_TYPES[type]),
      ];
    },
    codegen: (ctx) => {
      const type = numericOperandType(ctx.node.properties, "inType");
      const value = ctx.input("in");
      if (!isVector(type)) return { out: `(-(${value}))` };
      const axes = AXES[type];
      return {
        out: hoistedCall(ctx, `__util_negate${axes.length}`, "v", `({ ${axes.map((axis) => `${axis}: -v.${axis}`).join(", ")} })`, [value]),
      };
    },
  },
];

const TYPE_NAMES: Readonly<Record<NumericOperandType, string>> = {
  int: "Integer", float: "Float", vec2: "Vector2", vec3: "Vector3", vec4: "Vector4",
};

/** The Inspector and diagnostic name of an operand type. */
export function numericOperandTypeName(type: NumericOperandType): string {
  return TYPE_NAMES[type];
}

/** A hand-edited graph can hold operand types no wire or Inspector pick gives: report them. */
function validateNumericOperands(graphs: readonly LogicGraph[], ctx: TypeContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (numericOperands(node.typeId).length !== 2 || numericOperandsValid(node.typeId, node.properties)) continue;
      const a = numericOperandTypeName(numericOperandType(node.properties, "aType"));
      const b = numericOperandTypeName(numericOperandType(node.properties, "bType"));
      out.push(diagnostic({
        code: "math.operandTypes",
        message: node.typeId === "math.mod"
          ? `Modulo takes Integer or Float operands (got ${a} and ${b})`
          : `Cannot combine ${a} with ${b}: use the same vector size, or a number with a vector`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: node.id,
        pinId: "b",
      }));
    }
  }
  return out;
}

export function registerNumericOperatorValidationRules(): void {
  if (listValidationRules().some((rule) => rule.id === "math.operandTypes")) return;
  registerValidationRule({ id: "math.operandTypes", run: validateNumericOperands });
}
