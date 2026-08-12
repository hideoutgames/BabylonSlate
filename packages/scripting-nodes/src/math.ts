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
];
