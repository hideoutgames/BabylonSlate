import { MATH_CONSTANTS, MATH_TYPE_AXES, type MathAnalysis, type MathType } from "./analyze";
import type { MathExpr, MathStatement } from "./parse";

/**
 * Re-emits an analysed formula as JavaScript. Every value is scalarized: a vector is its component
 * values, each a `const` local or a generated parameter's property, and only an output builds an
 * object. Every operation is the expression its ordinary node compiles to (`math.ts`, `vector.ts`,
 * `numeric-operators.ts`, `utility-helpers.ts` in `@haptic/scripting-nodes`), in the same order, so
 * results are identical bit for bit. No user text reaches the output: inputs are `i0, i1, …` and
 * values `t0, t1, …`.
 */

/** A value: one atom (a local, a parameter or a literal) per component; one for a Float. */
type Value = { type: MathType; parts: string[] };

type Local = { name: string; expr: string; deps: string[] };

class Emitter {
  readonly locals: Local[] = [];
  private readonly byExpr = new Map<string, string>();
  private readonly params: string[];
  private readonly inputParts = new Map<string, string>();

  constructor(params: string[]) {
    this.params = params;
  }

  /** A `const` holding `expr`, which reads `deps`; an identical expression reuses its local. */
  local(expr: string, deps: string[]): string {
    const existing = this.byExpr.get(expr);
    if (existing) return existing;
    const name = `t${this.locals.length}`;
    this.locals.push({ name, expr, deps: deps.filter(isName) });
    this.byExpr.set(expr, name);
    return name;
  }

  /** Component `axis` of vector parameter `param`, read once. */
  inputPart(param: string, axis: string): string {
    const key = `${param}.${axis}`;
    let name = this.inputParts.get(key);
    if (!name) {
      name = this.local(key, [param]);
      this.inputParts.set(key, name);
    }
    return name;
  }

  isParam(name: string): boolean {
    return this.params.includes(name);
  }
}

const isName = (atom: string) => /^[ti]\d+$/.test(atom);

/** A JavaScript literal for a parsed number: the shortest form that reads back as the same value. */
function numberLiteral(value: number): string {
  return String(value);
}

type Op = (e: Emitter, ...args: string[]) => string;
const op = (template: (...args: string[]) => string): Op => (e, ...args) => e.local(template(...args), args);

// Scalar operations, each the expression its node compiles to (with its inputs bound to names).
const S = {
  add: op((a, b) => `${a} + ${b}`),
  sub: op((a, b) => `${a} - ${b}`),
  mul: op((a, b) => `${a} * ${b}`),
  // Divide and Modulo: 0 for a zero divisor (`__math_div`, `__math_mod`).
  div: op((a, b) => `${b} === 0 ? 0 : ${a} / ${b}`),
  mod: op((a, b) => `${b} === 0 ? 0 : ${a} % ${b}`),
  // Negate: `(-(v))`, and `-v.x` per vector component.
  neg: op((a) => `-${a}`),
  // Power: 0 when the result is not finite (`__math_pow`).
  pow: (e: Emitter, b: string, x: string) => {
    const p = e.local(`Math.pow(${b}, ${x})`, [b, x]);
    return e.local(`Number.isFinite(${p}) ? ${p} : 0`, [p]);
  },
  sqrt: op((v) => `${v} > 0 ? Math.sqrt(${v}) : 0`),
  abs: op((v) => `Math.abs(${v})`),
  min: op((a, b) => `Math.min(${a}, ${b})`),
  max: op((a, b) => `Math.max(${a}, ${b})`),
  clamp: op((v, lo, hi) => `Math.min(${hi}, Math.max(${lo}, ${v}))`),
  lerp: op((a, b, t) => `${a} + (${b} - ${a}) * ${t}`),
  floor: op((v) => `Math.floor(${v})`),
  ceil: op((v) => `Math.ceil(${v})`),
  round: op((v) => `Math.round(${v})`),
  sign: op((v) => `Math.sign(${v})`),
  exp: op((v) => `Math.exp(${v})`),
  ln: op((v) => `${v} > 0 ? Math.log(${v}) : 0`),
  log: op((v, b) => `${v} > 0 && ${b} > 0 && ${b} !== 1 ? Math.log(${v}) / Math.log(${b}) : 0`),
  frac: op((v) => `${v} - Math.floor(${v})`),
  wrap: op((v, lo, hi) => `${hi} > ${lo} ? ${lo} + (((${v} - ${lo}) % (${hi} - ${lo})) + (${hi} - ${lo})) % (${hi} - ${lo}) : ${lo}`),
  sin: op((v) => `Math.sin(${v})`),
  cos: op((v) => `Math.cos(${v})`),
  tan: op((v) => `Math.tan(${v})`),
  // Asin and Acos hold their input to -1..1.
  asin: op((v) => `Math.asin(Math.min(1, Math.max(-1, ${v})))`),
  acos: op((v) => `Math.acos(Math.min(1, Math.max(-1, ${v})))`),
  atan: op((v) => `Math.atan(${v})`),
  atan2: op((y, x) => `Math.atan2(${y}, ${x})`),
  // The (Degrees) nodes: `(v * Math.PI / 180)` in, `(r * 180 / Math.PI)` out.
  sind: op((v) => `Math.sin(${v} * Math.PI / 180)`),
  cosd: op((v) => `Math.cos(${v} * Math.PI / 180)`),
  tand: op((v) => `Math.tan(${v} * Math.PI / 180)`),
  asind: op((v) => `Math.asin(Math.min(1, Math.max(-1, ${v}))) * 180 / Math.PI`),
  acosd: op((v) => `Math.acos(Math.min(1, Math.max(-1, ${v}))) * 180 / Math.PI`),
  atand: op((v) => `Math.atan(${v}) * 180 / Math.PI`),
  atan2d: op((y, x) => `Math.atan2(${y}, ${x}) * 180 / Math.PI`),
} satisfies Record<string, Op>;

type ScalarFunction = keyof typeof S;
const SCALAR_FUNCTIONS: ReadonlySet<string> = new Set([
  "sqrt", "abs", "min", "max", "clamp", "floor", "ceil", "round", "sign", "exp", "ln", "frac", "wrap",
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sind", "cosd", "tand", "asind", "acosd", "atand", "atan2d",
]);

class Compiler {
  readonly e: Emitter;
  private readonly analysis: MathAnalysis;
  private readonly env = new Map<string, Value>();

  constructor(analysis: MathAnalysis) {
    this.analysis = analysis;
    const params = analysis.signature.inputs.map((_, index) => `i${index}`);
    this.e = new Emitter(params);
    analysis.signature.inputs.forEach((input, index) => {
      const type = analysis.inputTypes[index]!;
      const param = params[index]!;
      this.env.set(input.name, type === "float"
        ? { type, parts: [param] }
        : { type, parts: MATH_TYPE_AXES[type].map((axis) => this.e.inputPart(param, axis)) });
    });
  }

  statement(statement: MathStatement): Value {
    const value = this.value(statement.expr);
    if (statement.kind === "assign") this.env.set(statement.name, value);
    return value;
  }

  private typeOf(expr: MathExpr): MathType {
    return this.analysis.types.get(expr) ?? "float";
  }

  value(expr: MathExpr): Value {
    const e = this.e;
    switch (expr.kind) {
      case "number":
        return { type: "float", parts: [numberLiteral(expr.value)] };
      case "name":
        return Object.hasOwn(MATH_CONSTANTS, expr.name)
          ? { type: "float", parts: [MATH_CONSTANTS[expr.name]!] }
          : this.env.get(expr.name)!;
      case "negate": {
        const arg = this.value(expr.arg);
        return { type: arg.type, parts: arg.parts.map((part) => S.neg(e, part)) };
      }
      case "member": {
        const object = this.value(expr.object);
        return { type: "float", parts: [object.parts[MATH_TYPE_AXES[object.type].indexOf(expr.axis)]!] };
      }
      case "binary":
        return this.binary(expr.op, this.value(expr.left), this.value(expr.right));
      case "call":
        return this.call(expr.name, expr.args.map((arg) => this.value(arg)), this.typeOf(expr));
    }
  }

  /** As the operator nodes do: component-wise on two vectors, the number broadcast with one. */
  private binary(operator: string, a: Value, b: Value): Value {
    const e = this.e;
    if (operator === "^") return { type: "float", parts: [S.pow(e, a.parts[0]!, b.parts[0]!)] };
    if (operator === "%") return { type: "float", parts: [S.mod(e, a.parts[0]!, b.parts[0]!)] };
    const fn = operator === "+" ? S.add : operator === "-" ? S.sub : operator === "*" ? S.mul : S.div;
    if (a.type === "float" && b.type === "float") return { type: "float", parts: [fn(e, a.parts[0]!, b.parts[0]!)] };
    if (a.type !== "float" && b.type !== "float") {
      return { type: a.type, parts: a.parts.map((part, index) => fn(e, part, b.parts[index]!)) };
    }
    if (a.type !== "float") {
      // A vector with a number on its right: `v.x op s` (`__vec_scale_*`, `__vec_*Scalar_*`).
      const s = b.parts[0]!;
      return { type: a.type, parts: a.parts.map((part) => fn(e, part, s)) };
    }
    // A number with a vector on its right: Multiply and Add put the vector first (`v.x * s`, `v.x + s`).
    const s = a.parts[0]!;
    const commuted = operator === "*" || operator === "+";
    return { type: b.type, parts: b.parts.map((part) => commuted ? fn(e, part, s) : fn(e, s, part)) };
  }

  private call(name: string, args: Value[], type: MathType): Value {
    const e = this.e;
    const scalar = (value: Value) => value.parts[0]!;
    if (SCALAR_FUNCTIONS.has(name)) {
      return { type: "float", parts: [(S[name as ScalarFunction] as Op)(e, ...args.map(scalar))] };
    }
    switch (name) {
      case "pow":
        return { type: "float", parts: [S.pow(e, scalar(args[0]!), scalar(args[1]!))] };
      case "log":
        // One argument is the Logarithm node's default Base of 10.
        return { type: "float", parts: [S.log(e, scalar(args[0]!), args[1] ? scalar(args[1]) : "10")] };
      case "lerp": {
        const t = scalar(args[2]!);
        return { type, parts: args[0]!.parts.map((part, index) => S.lerp(e, part, args[1]!.parts[index]!, t)) };
      }
      case "vec2":
      case "vec3":
      case "vec4":
        return { type, parts: args.map(scalar) };
      case "dot": {
        const [a, b] = args as [Value, Value];
        const terms = a.parts.map((part, index) => `${part} * ${b.parts[index]!}`).join(" + ");
        return { type: "float", parts: [e.local(terms, [...a.parts, ...b.parts])] };
      }
      case "cross": {
        const [[ax, ay, az], [bx, by, bz]] = [args[0]!.parts, args[1]!.parts] as [string[], string[]];
        const deps = [...args[0]!.parts, ...args[1]!.parts];
        return {
          type: "vec3",
          parts: [
            e.local(`${ay} * ${bz} - ${az} * ${by}`, deps),
            e.local(`${az} * ${bx} - ${ax} * ${bz}`, deps),
            e.local(`${ax} * ${by} - ${ay} * ${bx}`, deps),
          ],
        };
      }
      case "length":
        return { type: "float", parts: [e.local(`Math.hypot(${args[0]!.parts.join(", ")})`, args[0]!.parts)] };
      case "distance": {
        const [a, b] = args as [Value, Value];
        const terms = a.parts.map((part, index) => `${part} - ${b.parts[index]!}`).join(", ");
        return { type: "float", parts: [e.local(`Math.hypot(${terms})`, [...a.parts, ...b.parts])] };
      }
      case "normalize": {
        // `__vec_normalize_*`: the zero vector at or below a length of 1e-8, and for NaN.
        const v = args[0]!;
        const l = e.local(`Math.hypot(${v.parts.join(", ")})`, v.parts);
        return { type: v.type, parts: v.parts.map((part) => e.local(`${l} > 1e-8 ? ${part} / ${l} : 0`, [l, part])) };
      }
    }
    throw new Error(`Math Expression has no function '${name}'`);
  }
}

/** One output's module-level helper: its name, declaration, and the input indices to pass it. */
export type MathOutputHelper = {
  /** `__mx_<hash>`: a hash of the declaration, so equal helpers share one declaration. */
  name: string;
  /** `var __mx_<hash> = (i0, i2) => …;` */
  declaration: string;
  /** Indices into the signature's inputs, in parameter order. */
  inputs: number[];
};

/** 64-bit FNV-1a, as hex: the helper name's hash. */
function hash64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * The helper of each output of a formula with no type error: it takes only the inputs that output
 * reads and computes only what it needs, with one object literal for a vector output.
 */
export function emitMathExpression(analysis: MathAnalysis): MathOutputHelper[] {
  if (analysis.typeError) throw new Error(analysis.typeError.message);
  const compiler = new Compiler(analysis);
  const outputs = new Map<string, Value>();
  for (const statement of analysis.program.statements) {
    const value = compiler.statement(statement);
    if (statement.kind === "expr") outputs.set(analysis.signature.outputs[0]!.name, value);
    else if (!statement.local) outputs.set(statement.name, value);
  }
  const locals = compiler.e.locals;
  const localIndex = new Map(locals.map((local, index) => [local.name, index] as const));
  return analysis.signature.outputs.map((output) => {
    const value = outputs.get(output.name)!;
    // The locals and parameters this output reads, through what they read.
    const needed = new Set<number>();
    const params = new Set<string>();
    const visit = (atom: string) => {
      if (/^i\d+$/.test(atom)) {
        params.add(atom);
        return;
      }
      const index = localIndex.get(atom);
      if (index === undefined || needed.has(index)) return;
      needed.add(index);
      for (const dep of locals[index]!.deps) visit(dep);
    };
    for (const part of value.parts) visit(part);
    const inputs = analysis.signature.inputs.map((_, index) => index).filter((index) => params.has(`i${index}`));
    const result = value.type === "float"
      ? value.parts[0]!
      : `{ ${MATH_TYPE_AXES[value.type].map((axis, index) => `${axis}: ${value.parts[index]!}`).join(", ")} }`;
    const body = [...needed].sort((a, b) => a - b).map((index) => `const ${locals[index]!.name} = ${locals[index]!.expr};`);
    const paramList = inputs.map((index) => `i${index}`).join(", ");
    const fn = body.length === 0
      ? `(${paramList}) => (${result})`
      : `(${paramList}) => { ${body.join(" ")} return ${result}; }`;
    const name = `__mx_${hash64(fn)}`;
    return { name, declaration: `var ${name} = ${fn};`, inputs };
  });
}
