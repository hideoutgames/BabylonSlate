import {
  pin,
  type NodeDefinition,
  FLOAT,
  INT,
  BOOL,
} from "@haptic/scripting";
import { ARITHMETIC_SEARCH_ALIASES } from "./arithmetic-search-aliases";
import { hoistedCall } from "./hoisted-helper";

/**
 * Divide Int truncates toward zero and Modulo Int keeps the dividend's sign.
 * A zero divisor yields 0, so an Int pin never carries Infinity or NaN.
 */
function intDivisionExpr(
  ctx: Parameters<NodeDefinition["codegen"]>[0],
  a: string,
  b: string,
  op: "/" | "%",
): string {
  const result = op === "/" ? "Math.trunc(a / b)" : "a % b";
  return hoistedCall(
    ctx,
    op === "/" ? "__math_divInt" : "__math_modInt",
    "a, b",
    `(b === 0 ? 0 : ${result})`,
    [a, b],
  );
}

function binary(
  id: string,
  title: string,
  op: string,
  type: typeof FLOAT | typeof INT = FLOAT,
): NodeDefinition {
  return {
    id,
    title,
    category: "math",
    searchAliases: ARITHMETIC_SEARCH_ALIASES[op],
    pure: true,
    referentiallyTransparent: true,
    pins: () => [
      pin("a", "a", "in", type),
      pin("b", "b", "in", type),
      pin("out", "out", "out", type),
    ],
    codegen: (ctx) => ({
      out: type === INT && (op === "/" || op === "%")
        ? intDivisionExpr(ctx, ctx.input("a"), ctx.input("b"), op)
        : `(${ctx.input("a")} ${op} ${ctx.input("b")})`,
    }),
  };
}

/** One-input trig node: `expr` maps the input expression to the output expression. */
function trigNode(
  id: string,
  title: string,
  searchAliases: readonly string[],
  expr: (value: string) => string,
): NodeDefinition {
  return {
    id,
    searchAliases: [...searchAliases],
    title,
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: expr(ctx.input("in")) }),
  };
}

const toRadians = (value: string) => `((${value}) * Math.PI / 180)`;
const toDegrees = (value: string) => `((${value}) * 180 / Math.PI)`;

/** Atan2 of Y over X, in radians or degrees. */
function atan2Node(id: string, title: string, searchAliases: readonly string[], degrees: boolean): NodeDefinition {
  return {
    id,
    searchAliases: [...searchAliases],
    title,
    category: "math",
    pure: true,
    pins: () => [
      pin("y", "Y", "in", FLOAT),
      pin("x", "X", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const angle = `Math.atan2((${ctx.input("y")}), (${ctx.input("x")}))`;
      return { out: degrees ? toDegrees(angle) : angle };
    },
  };
}

/**
 * Trigonometry in radians and in degrees. The radian ids predate the degree
 * variants, so their titles say "(Radians)" and the old titles stay searchable.
 */
const TRIG_NODES: NodeDefinition[] = [
  trigNode("math.sin", "Sin (Radians)", ["sin", "sin(x)", "sine"], (value) => `Math.sin(${value})`),
  trigNode("math.sinDegrees", "Sin (Degrees)", ["sin", "sind", "sine degrees"], (value) => `Math.sin(${toRadians(value)})`),
  trigNode("math.cos", "Cos (Radians)", ["cos", "cos(x)", "cosine"], (value) => `Math.cos(${value})`),
  trigNode("math.cosDegrees", "Cos (Degrees)", ["cos", "cosd", "cosine degrees"], (value) => `Math.cos(${toRadians(value)})`),
  trigNode("math.tan", "Tan (Radians)", ["tan", "tan(x)", "tangent"], (value) => `Math.tan(${value})`),
  trigNode("math.tanDegrees", "Tan (Degrees)", ["tan", "tand", "tangent degrees"], (value) => `Math.tan(${toRadians(value)})`),
  trigNode("math.asin", "Asin (Radians)", ["asin", "asin(x)", "arcsine", "inverse sine"], (value) => `Math.asin(${value})`),
  trigNode("math.asinDegrees", "Asin (Degrees)", ["asin", "asind", "arcsine degrees"], (value) => toDegrees(`Math.asin(${value})`)),
  trigNode("math.acos", "Acos (Radians)", ["acos", "acos(x)", "arccosine", "inverse cosine"], (value) => `Math.acos(${value})`),
  trigNode("math.acosDegrees", "Acos (Degrees)", ["acos", "acosd", "arccosine degrees"], (value) => toDegrees(`Math.acos(${value})`)),
  trigNode("math.atan", "Atan (Radians)", ["atan", "atan(x)", "arctangent", "inverse tangent"], (value) => `Math.atan(${value})`),
  trigNode("math.atanDegrees", "Atan (Degrees)", ["atan", "atand", "arctangent degrees"], (value) => toDegrees(`Math.atan(${value})`)),
  atan2Node("math.atan2", "Atan2 (Radians)", ["atan2", "atan2(y,x)", "angle of vector"], false),
  atan2Node("math.atan2Degrees", "Atan2 (Degrees)", ["atan2", "atan2d", "angle of vector degrees"], true),
];

export const mathNodes: NodeDefinition[] = [
  binary("math.add", "Add", "+"),
  binary("math.sub", "Subtract", "-"),
  binary("math.mul", "Multiply", "*"),
  binary("math.div", "Divide", "/"),
  binary("math.mod", "Modulo", "%"),
  binary("math.add_int", "Add Int", "+", INT),
  binary("math.sub_int", "Subtract Int", "-", INT),
  binary("math.mul_int", "Multiply Int", "*", INT),
  binary("math.div_int", "Divide Int", "/", INT),
  binary("math.mod_int", "Modulo Int", "%", INT),
  {
    id: "math.negate",
    searchAliases: ["-","−","-x","negation"],
    title: "Negate",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "in", "in", FLOAT),
      pin("out", "out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `(-(${ctx.input("in")}))` }),
  },
  {
    id: "math.abs",
    searchAliases: ["abs","abs(x)","|x|"],
    title: "Abs",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "in", "in", FLOAT),
      pin("out", "out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.abs(${ctx.input("in")})` }),
  },
  {
    id: "math.compare",
    searchAliases: ["≈","~=","approximately equal"],
    title: "Nearly Equal",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "a", "in", FLOAT),
      pin("b", "b", "in", FLOAT),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(Math.abs((${ctx.input("a")}) - (${ctx.input("b")})) < 1e-6)`,
    }),
  },
  {
    id: "math.equals",
    searchAliases: ["=","==","===","a == b"],
    title: "Equal",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "A", "in", FLOAT),
      pin("b", "B", "in", FLOAT),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("a")}) === (${ctx.input("b")}))`,
    }),
  },
  {
    id: "math.notEquals",
    searchAliases: ["!=","!==","≠","a != b"],
    title: "Not Equal",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "A", "in", FLOAT),
      pin("b", "B", "in", FLOAT),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("a")}) !== (${ctx.input("b")}))`,
    }),
  },
  {
    id: "math.greater",
    searchAliases: [">","a > b"],
    title: "Greater Than",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "a", "in", FLOAT),
      pin("b", "b", "in", FLOAT),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({ out: `((${ctx.input("a")}) > (${ctx.input("b")}))` }),
  },
  {
    id: "math.greaterEqual",
    searchAliases: [">=","≥","a >= b"],
    title: "Greater Or Equal",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "a", "in", FLOAT),
      pin("b", "b", "in", FLOAT),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("a")}) >= (${ctx.input("b")}))`,
    }),
  },
  {
    id: "math.less",
    searchAliases: ["<","a < b"],
    title: "Less Than",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "a", "in", FLOAT),
      pin("b", "b", "in", FLOAT),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({ out: `((${ctx.input("a")}) < (${ctx.input("b")}))` }),
  },
  {
    id: "math.lessEqual",
    searchAliases: ["<=","≤","a <= b"],
    title: "Less Or Equal",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "a", "in", FLOAT),
      pin("b", "b", "in", FLOAT),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("a")}) <= (${ctx.input("b")}))`,
    }),
  },
  {
    id: "boolean.and",
    searchAliases: ["&&","∧","a && b"],
    title: "And Bool",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "a", "in", BOOL),
      pin("b", "b", "in", BOOL),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("a")}) && (${ctx.input("b")}))`,
    }),
  },
  {
    id: "boolean.or",
    searchAliases: ["||","∨","a || b"],
    title: "Or Bool",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "a", "in", BOOL),
      pin("b", "b", "in", BOOL),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("a")}) || (${ctx.input("b")}))`,
    }),
  },
  {
    id: "boolean.not",
    searchAliases: ["!","¬","!x"],
    title: "Not Bool",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "in", "in", BOOL),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({ out: `!(${ctx.input("in")})` }),
  },
  {
    id: "math.lerp",
    searchAliases: ["lerp","mix(a,b,t)","lerp(a,b,t)","a+(b-a)*t"],
    title: "Lerp",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "A", "in", FLOAT),
      pin("b", "B", "in", FLOAT),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(ctx, "__math_lerp", "a, b, t", "a + (b - a) * t", [
        ctx.input("a"),
        ctx.input("b"),
        ctx.input("alpha"),
      ]),
    }),
  },
  {
    id: "math.clamp",
    searchAliases: ["clamp(x,min,max)"],
    title: "Clamp",
    category: "math",
    pure: true,
    pins: () => [
      pin("value", "Value", "in", FLOAT),
      pin("min", "Min", "in", FLOAT),
      pin("max", "Max", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `Math.min((${ctx.input("max")}), Math.max((${ctx.input("min")}), (${ctx.input("value")})))`,
    }),
  },
  {
    id: "math.min",
    searchAliases: ["min","min(a,b)"],
    title: "Min",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "A", "in", FLOAT),
      pin("b", "B", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `Math.min((${ctx.input("a")}), (${ctx.input("b")}))`,
    }),
  },
  {
    id: "math.max",
    searchAliases: ["max","max(a,b)"],
    title: "Max",
    category: "math",
    pure: true,
    pins: () => [
      pin("a", "A", "in", FLOAT),
      pin("b", "B", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `Math.max((${ctx.input("a")}), (${ctx.input("b")}))`,
    }),
  },
  ...TRIG_NODES,
  {
    id: "math.degrees",
    searchAliases: ["degrees(x)","rad2deg","x * 180 / pi"],
    title: "Radians To Degrees",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("in")}) * 180 / Math.PI)`,
    }),
  },
  {
    id: "math.radians",
    searchAliases: ["radians(x)","deg2rad","x * pi / 180"],
    title: "Degrees To Radians",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("in")}) * Math.PI / 180)`,
    }),
  },
  {
    id: "math.floor",
    searchAliases: ["floor(x)","⌊x⌋"],
    title: "Floor",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.floor(${ctx.input("in")})` }),
  },
  {
    id: "math.ceil",
    searchAliases: ["ceil","ceil(x)","⌈x⌉"],
    title: "Ceil",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.ceil(${ctx.input("in")})` }),
  },
  {
    id: "math.round",
    searchAliases: ["round(x)"],
    title: "Round",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.round(${ctx.input("in")})` }),
  },
  {
    id: "math.sign",
    searchAliases: ["sign(x)","sgn"],
    title: "Sign",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.sign(${ctx.input("in")})` }),
  },
  {
    id: "math.power",
    searchAliases: ["^","**","pow","pow(a,b)","a^b","a**b"],
    title: "Power",
    category: "math",
    pure: true,
    pins: () => [
      pin("base", "Base", "in", FLOAT),
      pin("exp", "Exp", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `Math.pow((${ctx.input("base")}), (${ctx.input("exp")}))`,
    }),
  },
  {
    id: "math.sqrt",
    searchAliases: ["√","sqrt","sqrt(x)","√x"],
    title: "Sqrt",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.sqrt(${ctx.input("in")})` }),
  },
  {
    id: "math.random",
    title: "Random Float",
    category: "random",
    pure: true,
    pins: () => [pin("out", "Out", "out", FLOAT)],
    codegen: () => ({ out: `ctx.random.float()` }),
  },
  {
    id: "math.randomInt",
    title: "Random Int",
    category: "random",
    pure: true,
    pins: () => [
      pin("min", "Min", "in", INT),
      pin("max", "Max", "in", INT),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({
      out: `ctx.random.int((${ctx.input("min")}) | 0, (${ctx.input("max")}) | 0)`,
    }),
  },
  {
    id: "math.randomBool",
    title: "Random Bool",
    category: "random",
    pure: true,
    pins: () => [pin("out", "Out", "out", BOOL)],
    codegen: () => ({ out: `ctx.random.bool()` }),
  },
];
