import {
  mathExpressionError,
  parseMathExpression,
  type MathExpr,
  type MathExpressionError,
  type MathProgram,
  type MathStatement,
} from "./parse";

/** The types a formula works on: the engine's Float and Vector pin types. */
export type MathType = "float" | "vec2" | "vec3" | "vec4";

export const MATH_TYPES: readonly MathType[] = ["float", "vec2", "vec3", "vec4"];

export function isMathType(value: unknown): value is MathType {
  return typeof value === "string" && (MATH_TYPES as readonly string[]).includes(value);
}

const TYPE_NAMES: Readonly<Record<MathType, string>> = { float: "Float", vec2: "Vector2", vec3: "Vector3", vec4: "Vector4" };

/** The editor name of a formula type. */
export function mathTypeName(type: MathType): string {
  return TYPE_NAMES[type];
}

export const MATH_TYPE_AXES: Readonly<Record<MathType, readonly string[]>> = {
  float: [],
  vec2: ["x", "y"],
  vec3: ["x", "y", "z"],
  vec4: ["x", "y", "z", "w"],
};

const isVector = (type: MathType) => type !== "float";

/** Built-in constants and the JavaScript each reads. */
export const MATH_CONSTANTS: Readonly<Record<string, string>> = {
  pi: "Math.PI",
  tau: "(2 * Math.PI)",
  e: "Math.E",
};

type FunctionTyping = {
  /** Fewest and most arguments. */
  arity: readonly [number, number];
  /** The result type for these argument types, or the reason they are refused. */
  result: (args: readonly MathType[]) => MathType | string;
};

const scalars = (count: number) => (args: readonly MathType[]): MathType | string => {
  const bad = args.findIndex((type) => type !== "float");
  if (bad < 0) return "float";
  return count === 1 ? `takes a Float (got ${mathTypeName(args[bad]!)})` : `takes Floats (argument ${bad + 1} is ${mathTypeName(args[bad]!)})`;
};
const scalar1: FunctionTyping = { arity: [1, 1], result: scalars(1) };
const scalar2: FunctionTyping = { arity: [2, 2], result: scalars(2) };
const scalar3: FunctionTyping = { arity: [3, 3], result: scalars(3) };
const sameVectors = (args: readonly MathType[]): MathType | string => {
  if (!isVector(args[0]!)) return `takes vectors (got ${mathTypeName(args[0]!)})`;
  if (args.some((type) => type !== args[0])) return `takes two vectors of the same size (got ${args.map(mathTypeName).join(" and ")})`;
  return args[0]!;
};

/** `result` when `checked` is a type, else the refusal it is. */
const then = (checked: MathType | string, result: MathType): MathType | string => isMathType(checked) ? result : checked;

/**
 * Every built-in function. Each compiles to exactly what its ordinary node compiles to; the node
 * each one stands for is listed in `@haptic/scripting-nodes` (`MATH_EXPRESSION_NODE_TABLE`).
 */
export const MATH_FUNCTIONS: Readonly<Record<string, FunctionTyping>> = {
  sin: scalar1, cos: scalar1, tan: scalar1, asin: scalar1, acos: scalar1, atan: scalar1, atan2: scalar2,
  sind: scalar1, cosd: scalar1, tand: scalar1, asind: scalar1, acosd: scalar1, atand: scalar1, atan2d: scalar2,
  sqrt: scalar1, abs: scalar1, min: scalar2, max: scalar2, clamp: scalar3,
  lerp: {
    arity: [3, 3],
    result: (args) => {
      if (args[2] !== "float") return `takes a Float alpha (got ${mathTypeName(args[2]!)})`;
      if (args[0] !== args[1]) return `takes A and B of the same type (got ${mathTypeName(args[0]!)} and ${mathTypeName(args[1]!)})`;
      return args[0]!;
    },
  },
  floor: scalar1, ceil: scalar1, round: scalar1, sign: scalar1,
  pow: scalar2, exp: scalar1, ln: scalar1,
  log: { arity: [1, 2], result: scalars(2) },
  frac: scalar1, wrap: scalar3,
  vec2: { arity: [2, 2], result: (args) => then(scalars(2)(args), "vec2") },
  vec3: { arity: [3, 3], result: (args) => then(scalars(3)(args), "vec3") },
  vec4: { arity: [4, 4], result: (args) => then(scalars(4)(args), "vec4") },
  dot: { arity: [2, 2], result: (args) => then(sameVectors(args), "float") },
  cross: { arity: [2, 2], result: (args) => args[0] === "vec3" && args[1] === "vec3" ? "vec3" : "takes two Vector3s" },
  length: { arity: [1, 1], result: (args) => isVector(args[0]!) ? "float" : `takes a vector (got ${mathTypeName(args[0]!)})` },
  distance: { arity: [2, 2], result: (args) => then(sameVectors(args), "float") },
  normalize: { arity: [1, 1], result: (args) => isVector(args[0]!) ? args[0]! : `takes a vector (got ${mathTypeName(args[0]!)})` },
};

/** Names a formula cannot use for a variable. */
export function isMathReservedName(name: string): boolean {
  return name === "let" || Object.hasOwn(MATH_FUNCTIONS, name) || Object.hasOwn(MATH_CONSTANTS, name);
}

/** A variable of the formula: an input or output pin, or a `let` value. */
export type MathVariable = { name: string; pos: number };

/** The pins a formula declares, in order: inputs by first use, outputs by assignment. */
export type MathSignature = {
  inputs: MathVariable[];
  outputs: MathVariable[];
};

/** The pin name of a formula that is one bare expression. */
export const MATH_EXPRESSION_RESULT_NAME = "Result";

type SignatureResult = { ok: true; signature: MathSignature } | { ok: false; error: MathExpressionError };

function forEachName(expr: MathExpr, visit: (name: string, pos: number) => void): void {
  switch (expr.kind) {
    case "number":
      return;
    case "name":
      visit(expr.name, expr.pos);
      return;
    case "negate":
      forEachName(expr.arg, visit);
      return;
    case "binary":
      forEachName(expr.left, visit);
      forEachName(expr.right, visit);
      return;
    case "call":
      for (const arg of expr.args) forEachName(arg, visit);
      return;
    case "member":
      forEachName(expr.object, visit);
  }
}

/** The variables a parsed formula declares, or the first name error. */
export function mathSignature(source: string, program: MathProgram): SignatureResult {
  const fail = (message: string, pos: number): SignatureResult =>
    ({ ok: false, error: mathExpressionError(source, "mathExpression.name", message, pos) });
  const statements = program.statements;
  const bare = statements.filter((statement) => statement.kind === "expr");
  if (bare.length > 0 && statements.length > 1) {
    return fail(`Assign this expression to a name ('name = …' for an output, 'let name = …' for a value)`, bare[0]!.pos);
  }
  const assigned = new Map<string, MathStatement & { kind: "assign" }>();
  for (const statement of statements) {
    if (statement.kind !== "assign") continue;
    if (isMathReservedName(statement.name)) return fail(`'${statement.name}' is a built-in name`, statement.pos);
    if (assigned.has(statement.name)) return fail(`'${statement.name}' is assigned twice`, statement.pos);
    assigned.set(statement.name, statement);
  }
  const inputs: MathVariable[] = [];
  const seenInputs = new Set<string>();
  const defined = new Set<string>();
  let error: SignatureResult | undefined;
  for (const statement of statements) {
    forEachName(statement.expr, (name, pos) => {
      if (error) return;
      if (Object.hasOwn(MATH_CONSTANTS, name)) return;
      if (Object.hasOwn(MATH_FUNCTIONS, name)) {
        error = fail(`'${name}' is a function: call it as ${name}(…)`, pos);
        return;
      }
      if (assigned.has(name)) {
        if (!defined.has(name)) error = fail(`'${name}' is used before it is assigned`, pos);
        return;
      }
      if (!seenInputs.has(name)) {
        seenInputs.add(name);
        inputs.push({ name, pos });
      }
    });
    if (error) return error;
    if (statement.kind === "assign") defined.add(statement.name);
  }
  const outputs: MathVariable[] = bare.length === 1
    ? [{ name: MATH_EXPRESSION_RESULT_NAME, pos: bare[0]!.pos }]
    : statements.flatMap((statement) => statement.kind === "assign" && !statement.local ? [{ name: statement.name, pos: statement.pos }] : []);
  return { ok: true, signature: { inputs, outputs } };
}

/** A formula that parsed and named its variables, and its types for given input types. */
export type MathAnalysis = {
  source: string;
  program: MathProgram;
  signature: MathSignature;
  /** The type of each input, in signature order. */
  inputTypes: MathType[];
  /** The type of each output, in signature order; Float for one whose expression has a type error. */
  outputTypes: MathType[];
  /** Each expression's type; absent below the first type error in its statement. */
  types: Map<MathExpr, MathType>;
  /** The first type error, if any. */
  typeError?: MathExpressionError;
};

export type MathAnalyzeResult = { ok: true; analysis: MathAnalysis } | { ok: false; error: MathExpressionError };

class MathTypeError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

function typeOf(expr: MathExpr, env: ReadonlyMap<string, MathType>, types: Map<MathExpr, MathType>): MathType {
  const type = inferType(expr, env, types);
  types.set(expr, type);
  return type;
}

/** The type of a binary operation, as Add, Subtract, Multiply, Divide, Modulo and Power type theirs. */
export function mathBinaryResultType(op: string, left: MathType, right: MathType): MathType | string {
  if (op === "%" || op === "^") {
    if (left === "float" && right === "float") return "float";
    return `${op === "%" ? "Modulo" : "Power"} takes Floats (got ${mathTypeName(left)} and ${mathTypeName(right)})`;
  }
  if (isVector(left) && isVector(right)) {
    return left === right ? left : `Cannot combine ${mathTypeName(left)} with ${mathTypeName(right)}: use the same vector size, or a number with a vector`;
  }
  return isVector(left) ? left : right;
}

function inferType(expr: MathExpr, env: ReadonlyMap<string, MathType>, types: Map<MathExpr, MathType>): MathType {
  switch (expr.kind) {
    case "number":
      return "float";
    case "name":
      return Object.hasOwn(MATH_CONSTANTS, expr.name) ? "float" : env.get(expr.name)!;
    case "negate":
      return typeOf(expr.arg, env, types);
    case "binary": {
      const left = typeOf(expr.left, env, types);
      const right = typeOf(expr.right, env, types);
      const result = mathBinaryResultType(expr.op, left, right);
      if (!isMathType(result)) throw new MathTypeError(result, expr.pos);
      return result;
    }
    case "member": {
      const object = typeOf(expr.object, env, types);
      if (!MATH_TYPE_AXES[object].includes(expr.axis)) {
        throw new MathTypeError(object === "float"
          ? `A Float has no .${expr.axis}`
          : `A ${mathTypeName(object)} has no .${expr.axis}`, expr.pos);
      }
      return "float";
    }
    case "call": {
      const typing = MATH_FUNCTIONS[expr.name];
      if (!typing || !Object.hasOwn(MATH_FUNCTIONS, expr.name)) throw new MathTypeError(`Unknown function '${expr.name}'`, expr.pos);
      const [min, max] = typing.arity;
      if (expr.args.length < min || expr.args.length > max) {
        const count = min === max ? `${min}` : `${min} or ${max}`;
        throw new MathTypeError(`${expr.name} takes ${count} argument${max === 1 ? "" : "s"} (got ${expr.args.length})`, expr.pos);
      }
      const args = expr.args.map((arg) => typeOf(arg, env, types));
      const result = typing.result(args);
      if (!isMathType(result)) throw new MathTypeError(`${expr.name} ${result}`, expr.pos);
      return result;
    }
  }
}

/**
 * Parses `source`, names its variables and types it with `inputType` (by input name; Float when
 * it returns undefined). A parse or name error fails; a type error is reported in `typeError`, so
 * the pins are still known.
 */
export function analyzeMathExpression(
  source: string,
  inputType: (name: string) => MathType | undefined = () => undefined,
): MathAnalyzeResult {
  const parsed = parseMathExpression(source);
  if (!parsed.ok) return parsed;
  const named = mathSignature(source, parsed.program);
  if (!named.ok) return named;
  const { signature } = named;
  const inputTypes = signature.inputs.map((input) => inputType(input.name) ?? "float");
  const env = new Map<string, MathType>(signature.inputs.map((input, index) => [input.name, inputTypes[index]!]));
  const types = new Map<MathExpr, MathType>();
  const outputType = new Map<string, MathType>();
  let typeError: MathExpressionError | undefined;
  for (const statement of parsed.program.statements) {
    try {
      const type = typeOf(statement.expr, env, types);
      if (statement.kind === "assign") {
        env.set(statement.name, type);
        if (!statement.local) outputType.set(statement.name, type);
      } else {
        outputType.set(signature.outputs[0]!.name, type);
      }
    } catch (error) {
      if (!(error instanceof MathTypeError)) throw error;
      typeError = mathExpressionError(source, "mathExpression.type", error.message, error.pos);
      break;
    }
  }
  return {
    ok: true,
    analysis: {
      source,
      program: parsed.program,
      signature,
      inputTypes,
      outputTypes: signature.outputs.map((output) => outputType.get(output.name) ?? "float"),
      types,
      ...(typeError ? { typeError } : {}),
    },
  };
}
