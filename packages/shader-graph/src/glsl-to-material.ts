import { createDefaultMaterialDocument, type MaterialDocument } from "./document";
import { lowerMaterialDocument } from "./lower";
import type { MaterialDiagnostic } from "./validate";

export interface GlslToMaterialOptions {
  name?: string;
  /** Explicit source bindings; varying names alone never imply mesh UV or time. */
  bindings?: Readonly<Record<string, "uv" | "time">>;
}

export type GlslToMaterialResult =
  | { ok: true; document: MaterialDocument; diagnostics: MaterialDiagnostic[] }
  | { ok: false; diagnostics: MaterialDiagnostic[] };

interface Token { text: string; line: number; column: number }
interface Value { node: string; pin: string; width: number; integer?: boolean; constant?: boolean }
interface Variable { width: number; value?: Value; readOnly: boolean }

class ConversionError extends Error {
  constructor(readonly token: Token, message: string) { super(message); }
}

const WIDTHS: Readonly<Record<string, number>> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
const CHANNELS = ["x", "y", "z", "w"];
const PRECISION = new Set(["lowp", "mediump", "highp"]);
const RESERVED = new Set("main void const uniform varying attribute in out inout precision lowp mediump highp if else for while do switch case default break continue return discard struct layout invariant centroid flat smooth noperspective int uint bool true false double mat2 mat3 mat4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4 sampler2D samplerCube".split(" "));
const UNARY: Readonly<Record<string, string>> = {
  radians: "math.radians", degrees: "math.degrees", sin: "math.sin", cos: "math.cos",
  tan: "math.tan", asin: "math.asin", acos: "math.acos", exp: "math.exp", exp2: "math.exp2",
  log: "math.log", log2: "math.log2", sqrt: "math.sqrt", inversesqrt: "math.inverseSqrt",
  abs: "math.abs", sign: "math.sign", floor: "math.floor", ceil: "math.ceil", fract: "math.fract",
  normalize: "vector.normalize", length: "vector.length",
};
const BINARY: Readonly<Record<string, string>> = { "+": "math.add", "-": "math.subtract", "*": "math.multiply", "/": "math.divide" };
const widthOf = (name: string): number | undefined => Object.hasOwn(WIDTHS, name) ? WIDTHS[name] : undefined;
const unaryOf = (name: string): string | undefined => Object.hasOwn(UNARY, name) ? UNARY[name] : undefined;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;
  let versionSeen = false;
  const advance = (text: string) => {
    for (const char of text) { if (char === "\n") { line++; column = 1; } else column++; }
    index += text.length;
  };
  while (index < source.length) {
    const rest = source.slice(index);
    const token = { text: rest[0]!, line, column };
    const whitespace = /^\s+/.exec(rest)?.[0];
    if (whitespace) { advance(whitespace); continue; }
    if (rest.startsWith("//")) { advance(rest.split("\n", 1)[0]!); continue; }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end < 0) throw new ConversionError(token, "Unterminated block comment.");
      advance(rest.slice(0, end + 2)); continue;
    }
    if (rest[0] === "#") {
      const directive = rest.split("\n", 1)[0]!;
      if (tokens.length || versionSeen || !/^#\s*version\s+(100|300\s+es)\s*$/.test(directive)) {
        throw new ConversionError(token, "Only an initial #version 100 or #version 300 es directive is supported; expand macros before conversion.");
      }
      versionSeen = true; advance(directive); continue;
    }
    const text = /^(?:[A-Za-z_][A-Za-z0-9_]*|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?|[+\-*/]=|[{}();,.=+\-*/])/.exec(rest)?.[0];
    if (!text) throw new ConversionError(token, `Unsupported character “${token.text}”. Only straight-line floating-point expressions are supported.`);
    tokens.push({ ...token, text }); advance(text);
    if (tokens.length > 4096) throw new ConversionError(token, "Shader exceeds the experimental converter's 4096-token limit.");
  }
  tokens.push({ text: "<end>", line, column });
  return tokens;
}

class Converter {
  readonly document: MaterialDocument;
  private readonly variables = new Map<string, Variable>();
  private readonly usedBindings = new Set<string>();
  private index = 0;
  private depth = 0;
  private serial = 0;
  private outputName = "gl_FragColor";
  private namedOutput = false;

  constructor(private readonly tokens: Token[], private readonly options: GlslToMaterialOptions) {
    this.document = createDefaultMaterialDocument(options.name?.trim() || "GLSL Material");
    this.document.shadingModel = "unlit";
    // Imported fragment output includes alpha. The user may choose Opaque after reviewing it.
    this.document.blendMode = "translucent";
    this.document.nodes = [];
    this.document.edges = [];
  }

  private get token(): Token { return this.tokens[this.index]!; }
  private take(): Token { return this.tokens[this.index++]!; }
  private accept(text: string): boolean { if (this.token.text !== text) return false; this.take(); return true; }
  private expect(text: string): void {
    if (!this.accept(text)) this.fail(`Expected “${text}”; found “${this.token.text}”.`);
  }
  private fail(message: string, token = this.token): never { throw new ConversionError(token, message); }
  private identifier(): Token {
    const token = this.take();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text)) this.fail("Expected a variable name.", token);
    return token;
  }
  private precision(): void { if (PRECISION.has(this.token.text)) this.take(); }
  private type(): number {
    this.precision();
    const token = this.take();
    const width = widthOf(token.text);
    if (!width) this.fail("Only float, vec2, vec3 and vec4 declarations are supported; matrices, integers, booleans and samplers cannot be converted yet.", token);
    return width;
  }
  private declare(name: Token, variable: Variable): void {
    if (this.variables.has(name.text) || name.text.startsWith("gl_") || name.text.includes("__") || widthOf(name.text) || unaryOf(name.text)
      || RESERVED.has(name.text)) {
      this.fail(`Variable name “${name.text}” is reserved or already declared.`, name);
    }
    this.variables.set(name.text, variable);
  }

  parse(): MaterialDocument {
    while (this.token.text !== "void") {
      if (this.accept("precision")) {
        if (!PRECISION.has(this.token.text)) this.fail("Expected a precision qualifier.");
        this.take(); this.expect("float"); this.expect(";");
      } else if (["uniform", "varying", "in"].includes(this.token.text)) {
        const qualifier = this.take().text;
        const width = this.type();
        const name = this.identifier();
        this.expect(";");
        const binding = this.options.bindings && Object.hasOwn(this.options.bindings, name.text) ? this.options.bindings[name.text] : undefined;
        let value: Value;
        if (binding) {
          if ((binding === "uv" && width !== 2) || (binding === "time" && (width !== 1 || qualifier !== "uniform"))) {
            this.fail(`Binding “${name.text}” requires ${binding === "uv" ? "vec2" : "uniform float"}.`, name);
          }
          this.usedBindings.add(name.text);
          value = this.node(binding === "uv" ? "input.uv" : "input.time", width, binding === "time" ? { timeMode: "seconds" } : {}, binding === "uv" ? "uv" : "time");
        } else {
          if (qualifier !== "uniform") this.fail(`Input “${name.text}” needs an explicit UV binding; arbitrary vertex varyings are unsupported.`, name);
          value = this.combine(CHANNELS.slice(0, width).map((channel) => this.node("param.float", 1, {
            name: width === 1 ? name.text : `${name.text}.${channel}`, value: [0],
          })));
        }
        this.declare(name, { width, value, readOnly: true });
      } else if (this.accept("out")) {
        if (this.namedOutput) this.fail("Multiple fragment outputs are unsupported.");
        if (this.type() !== 4) this.fail("The fragment output must be vec4.");
        const name = this.identifier();
        this.declare(name, { width: 4, readOnly: false });
        this.outputName = name.text; this.namedOutput = true; this.expect(";");
      } else if (this.token.text === "const") {
        this.declaration();
      } else {
        this.fail("Expected precision, numeric uniform/input, vec4 output, const declaration or void main(). Helper functions and other globals are unsupported.");
      }
    }
    this.expect("void"); this.expect("main"); this.expect("("); this.accept("void"); this.expect(")"); this.expect("{");
    if (!this.namedOutput) this.variables.set(this.outputName, { width: 4, readOnly: false });
    while (this.token.text !== "}") {
      if (this.token.text === "const" || widthOf(this.token.text) || PRECISION.has(this.token.text)) this.declaration();
      else this.assignment();
    }
    this.expect("}"); this.expect("<end>");
    const output = this.variables.get(this.outputName)?.value;
    if (!output) this.fail("Assign a vec4 value to the fragment output.", this.tokens[this.tokens.length - 1]!);
    for (const binding of Object.keys(this.options.bindings ?? {})) {
      if (!this.usedBindings.has(binding)) this.fail(`Binding “${binding}” has no matching source declaration.`, this.tokens[0]!);
    }
    const components = this.components(output);
    const color = this.combine(components.slice(0, 3));
    const terminal = this.node("output.surface", 0);
    this.wire(color, terminal.node, "baseColor");
    this.wire(components[3]!, terminal.node, "opacity");
    return this.document;
  }

  private declaration(): void {
    const readOnly = this.accept("const");
    const width = this.type();
    const name = this.identifier();
    const value = this.accept("=") ? this.expression() : undefined;
    if (readOnly && !value) this.fail("Const declarations require an initializer.", name);
    if (readOnly && !value?.constant) this.fail("Const initializers must be constant expressions.", name);
    if (value) this.sameWidth(value, width, name);
    this.declare(name, { width, value, readOnly });
    this.expect(";");
  }

  private assignment(): void {
    const name = this.identifier();
    const variable = this.variables.get(name.text);
    if (!variable) this.fail(`Unknown assignment target “${name.text}”. Control flow, discard, helper calls and component assignments are unsupported.`, name);
    if (variable.readOnly) this.fail(`Cannot assign to read-only input or const “${name.text}”.`, name);
    const operator = this.take();
    if (!["=", "+=", "-=", "*=", "/="].includes(operator.text)) this.fail("Only whole-variable assignment is supported.", operator);
    let value = this.expression();
    if (operator.text !== "=") {
      if (!variable.value) this.fail(`“${name.text}” is read before initialization.`, name);
      value = this.binary(operator.text[0]!, variable.value, value, operator);
    }
    this.sameWidth(value, variable.width, name);
    variable.value = value;
    this.expect(";");
  }

  private expression(minimum = 0): Value {
    if (++this.depth > 64) this.fail("Expression nesting exceeds the converter's limit.");
    let value = this.primary();
    const precedence: Readonly<Record<string, number>> = { "+": 1, "-": 1, "*": 2, "/": 2 };
    while ((Object.hasOwn(precedence, this.token.text) ? precedence[this.token.text]! : 0) > minimum) {
      const operator = this.take();
      value = this.binary(operator.text, value, this.expression(precedence[operator.text]!), operator);
    }
    this.depth--;
    return value;
  }

  private primary(): Value {
    const token = this.take();
    let value: Value;
    if (token.text === "+" || token.text === "-") {
      if (++this.depth > 64) this.fail("Expression nesting exceeds the converter's limit.", token);
      value = this.primary(); this.depth--;
      if (token.text === "-") value = { ...this.operation("math.negate", value.width, [value], ["value"]), integer: value.integer };
    } else if (token.text === "(") {
      value = this.expression(); this.expect(")");
    } else if (/^(?:\d|\.\d)/.test(token.text)) {
      const number = Number(token.text);
      if (!Number.isFinite(Math.fround(number))) this.fail("Numeric literals must fit a finite GLSL float.", token);
      if (/^0\d+$/.test(token.text)) this.fail("Octal integer literals are unsupported; use a decimal floating-point literal.", token);
      value = { ...this.node("const.float", 1, { value: [number] }), integer: /^\d+$/.test(token.text), constant: true };
    } else if (/^[A-Za-z_]/.test(token.text)) {
      if (this.accept("(")) {
        const args: Value[] = [];
        if (!this.accept(")")) {
          do { args.push(this.expression()); } while (this.accept(","));
          this.expect(")");
        }
        value = this.call(token, args);
      } else {
        const variable = this.variables.get(token.text);
        if (!variable?.value) this.fail(variable ? `“${token.text}” is read before initialization.` : `Unknown variable “${token.text}”; shader globals are unsupported.`, token);
        value = variable.value;
      }
    } else this.fail(`Expected an expression; found “${token.text}”.`, token);
    while (this.accept(".")) {
      const swizzle = this.identifier();
      const alphabet = ["xyzw", "rgba", "stpq"].find((set) => [...swizzle.text].every((char) => set.includes(char)));
      if (value.width === 1 || !alphabet || swizzle.text.length > 4 || [...swizzle.text].some((char) => alphabet.indexOf(char) >= value.width)) {
        this.fail(`Invalid swizzle “${swizzle.text}” for this value.`, swizzle);
      }
      const parts = this.components(value);
      value = this.combine([...swizzle.text].map((char) => parts[alphabet.indexOf(char)]!));
    }
    return value;
  }

  private sameWidth(value: Value, width: number, token: Token): void {
    if (value.width !== width || value.integer) this.fail(`Expected ${width === 1 ? "float" : `vec${width}`} without implicit conversion; use an explicit constructor.`, token);
  }

  private binary(operator: string, left: Value, right: Value, token: Token): Value {
    if (left.integer || right.integer) this.fail("Integer arithmetic and implicit integer conversions are unsupported; use floating-point literals or explicit float constructors.", token);
    if (left.width !== right.width && left.width !== 1 && right.width !== 1) this.fail("Arithmetic vector widths must match.", token);
    const width = Math.max(left.width, right.width);
    return this.operation(BINARY[operator]!, width, [this.splat(left, width), this.splat(right, width)], ["a", "b"]);
  }

  private call(token: Token, args: Value[]): Value {
    const width = widthOf(token.text);
    if (width) {
      if (!args.length) this.fail("Constructors require values.", token);
      if (args.length === 1 && args[0]!.width === 1) return this.splat({ ...args[0]!, integer: false }, width);
      const components = args.flatMap((value) => this.components(value).map((part) => ({ ...part, integer: false })));
      if (args.length === 1 && components.length > width) return this.combine(components.slice(0, width));
      if (components.length !== width) this.fail(`Constructor ${token.text} requires exactly ${width} components.`, token);
      return this.combine(components);
    }
    if (args.some((value) => value.integer)) this.fail("Builtins require floating-point arguments; use explicit float constructors.", token);
    const count = (expected: number) => { if (args.length !== expected) this.fail(`${token.text} requires ${expected} argument(s).`, token); };
    const equal = () => { if (args.some((value) => value.width !== args[0]!.width)) this.fail(`${token.text} requires matching vector widths.`, token); };
    const unary = unaryOf(token.text);
    if (unary) {
      count(1);
      return this.operation(unary, token.text === "length" ? 1 : args[0]!.width, args, ["value"]);
    }
    if (token.text === "atan") {
      if (args.length === 1) return this.operation("math.atan", args[0]!.width, args, ["value"]);
      count(2); equal(); return this.operation("math.atan2", args[0]!.width, args, ["y", "x"]);
    }
    if (["dot", "distance", "cross", "reflect", "pow"].includes(token.text)) {
      count(2); equal();
      if (token.text === "cross" && args[0]!.width !== 3) this.fail("cross requires two vec3 arguments.", token);
      const node = token.text === "pow" ? "math.pow" : `vector.${token.text}`;
      const pins = token.text === "pow" ? ["base", "exponent"] : token.text === "reflect" ? ["incident", "normal"] : ["a", "b"];
      return this.operation(node, ["dot", "distance"].includes(token.text) ? 1 : args[0]!.width, args, pins);
    }
    if (["min", "max", "mod"].includes(token.text)) {
      count(2);
      const target = args[0]!.width;
      if (args[1]!.width !== 1 && args[1]!.width !== target) this.fail(`${token.text} requires matching widths or a scalar second argument.`, token);
      return this.operation(`math.${token.text}`, target, [args[0]!, this.splat(args[1]!, target)], ["a", "b"]);
    }
    if (["clamp", "mix", "smoothstep"].includes(token.text)) {
      count(3);
      const target = token.text === "smoothstep" ? args[2]!.width : args[0]!.width;
      if (token.text === "mix") {
        if (args[1]!.width !== target || (args[2]!.width !== 1 && args[2]!.width !== target)) this.fail("mix requires matching first two arguments and a matching or scalar weight.", token);
      } else {
        const boundaries = token.text === "clamp" ? args.slice(1) : args.slice(0, 2);
        if (boundaries[0]!.width !== boundaries[1]!.width || ![1, target].includes(boundaries[0]!.width)) this.fail(`${token.text} boundaries must both be scalar or match the value's width.`, token);
      }
      return this.operation(`math.${token.text}`, target, args.map((value) => this.splat(value, target)), token.text === "clamp" ? ["value", "min", "max"] : token.text === "mix" ? ["a", "b", "alpha"] : ["edgeA", "edgeB", "value"]);
    }
    if (token.text === "step") {
      count(2);
      if (args[0]!.width !== 1 && args[0]!.width !== args[1]!.width) this.fail("step requires a scalar or matching-width edge.", token);
      return this.operation("math.step", args[1]!.width, [this.splat(args[0]!, args[1]!.width), args[1]!], ["edge", "value"]);
    }
    this.fail(`Function “${token.text}” cannot be converted to ordinary material nodes. Texture sampling, custom helpers and unsupported builtins are not approximated.`, token);
  }

  private node(type: string, width: number, properties: Record<string, unknown> = {}, pin = "out"): Value {
    if (++this.serial > 2048) this.fail("Generated graph exceeds the converter's 2048-node limit.", this.tokens[Math.min(this.index, this.tokens.length - 1)]!);
    const id = `glsl-${this.serial}`;
    this.document.nodes.push({ id, type, properties, position: { x: (this.serial % 6) * 240, y: Math.floor(this.serial / 6) * 140 } });
    return { node: id, pin, width };
  }
  private wire(value: Value, node: string, pin: string): void {
    this.document.edges.push({ id: `glsl-edge-${this.document.edges.length + 1}`, sourceNodeId: value.node, sourcePinId: value.pin, targetNodeId: node, targetPinId: pin });
  }
  private operation(type: string, width: number, args: Value[], pins: string[]): Value {
    const value = this.node(type, width);
    args.forEach((arg, index) => this.wire(arg, value.node, pins[index]!));
    return { ...value, constant: args.every((arg) => arg.constant) };
  }
  private components(value: Value): Value[] {
    if (value.width === 1) return [value];
    const split = this.operation("vector.split", 1, [value], ["value"]);
    return CHANNELS.slice(0, value.width).map((pin) => ({ ...split, pin }));
  }
  private combine(parts: Value[]): Value {
    if (parts.length === 1) return parts[0]!;
    const value = this.operation("vector.combine", parts.length, parts, CHANNELS.slice(0, parts.length));
    return { ...value, pin: parts.length === 2 ? "xy" : parts.length === 3 ? "xyz" : "xyzw" };
  }
  private splat(value: Value, width: number): Value {
    return value.width === width ? value : this.combine(Array<Value>(width).fill(value));
  }
}

/**
 * Experimental, deterministic conversion to ordinary editable nodes, never Custom GLSL.
 * Accepts one fragment void main(), float/vec2/vec3/vec4 declarations, straight-line
 * whole-variable assignments, constructors, + - * /, swizzles and supported native
 * math/vector builtins. Numeric uniforms become zero-default Float parameters
 * (one per vector component, avoiding Color parameter color-space conversion);
 * UV/time inputs require explicit bindings. Integer literals require constructors.
 * Rejects control flow, helper functions, samplers, matrices, arrays and macros.
 * The output is an unlit translucent surface Material carrying the fragment RGBA
 * channels through the editor's normal material color management.
 * Conversion is structural: successful validation/lowering does not compile on a GPU.
 */
export function convertGlslToMaterial(source: string, options: GlslToMaterialOptions = {}): GlslToMaterialResult {
  try {
    if (source.length > 32768) throw new ConversionError({ text: "", line: 1, column: 1 }, "Shader exceeds the experimental converter's 32768-character limit.");
    const document = new Converter(tokenize(source), options).parse();
    const lowered = lowerMaterialDocument(document);
    if (!lowered.ok) return { ok: false, diagnostics: lowered.diagnostics };
    return { ok: true, document, diagnostics: lowered.diagnostics };
  } catch (error) {
    if (!(error instanceof ConversionError)) throw error;
    return { ok: false, diagnostics: [{ code: "material.glslConversion.unsupported", severity: "error", line: error.token.line, stage: "fragment", message: `Line ${error.token.line}, column ${error.token.column}: ${error.message}` }] };
  }
}
