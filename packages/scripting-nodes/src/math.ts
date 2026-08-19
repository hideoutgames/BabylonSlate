import {
  pin,
  type NodeDefinition,
  FLOAT,
  INT,
  BOOL,
} from "@babylonslate/scripting";

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
    pure: true,
    pins: () => [
      pin("a", "a", "in", type),
      pin("b", "b", "in", type),
      pin("out", "out", "out", type),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("a")} ${op} ${ctx.input("b")})`,
    }),
  };
}

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
    title: "Greater or Equal",
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
    title: "Less or Equal",
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
    title: "Boolean And",
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
    title: "Boolean Or",
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
    title: "Boolean Not",
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
      out: `((${ctx.input("a")}) + ((${ctx.input("b")}) - (${ctx.input("a")})) * (${ctx.input("alpha")}))`,
    }),
  },
  {
    id: "math.clamp",
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
  {
    id: "math.sin",
    title: "Sin",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.sin(${ctx.input("in")})` }),
  },
  {
    id: "math.cos",
    title: "Cos",
    category: "math",
    pure: true,
    pins: () => [
      pin("in", "In", "in", FLOAT),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `Math.cos(${ctx.input("in")})` }),
  },
  {
    id: "math.degrees",
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
    category: "math",
    pure: true,
    pins: () => [pin("out", "Out", "out", FLOAT)],
    codegen: () => ({ out: `ctx.random.float()` }),
  },
  {
    id: "math.randomInt",
    title: "Random Int",
    category: "math",
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
    category: "math",
    pure: true,
    pins: () => [pin("out", "Out", "out", BOOL)],
    codegen: () => ({ out: `ctx.random.bool()` }),
  },
];
