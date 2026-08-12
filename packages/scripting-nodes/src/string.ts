import {
  pin,
  type NodeDefinition,
  STRING,
  INT,
  BOOL,
} from "@babylonslate/scripting";

export const stringNodes: NodeDefinition[] = [
  {
    id: "string.concat",
    title: "Concat",
    category: "string",
    pure: true,
    pins: () => [
      pin("a", "a", "in", STRING),
      pin("b", "b", "in", STRING),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("a")}) + String(${ctx.input("b")}))`,
    }),
  },
  {
    id: "string.length",
    title: "Length",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "in", "in", STRING),
      pin("out", "out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).length)` }),
  },
  {
    id: "string.equals",
    title: "Equals",
    category: "string",
    pure: true,
    pins: () => [
      pin("a", "a", "in", STRING),
      pin("b", "b", "in", STRING),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("a")}) === String(${ctx.input("b")}))`,
    }),
  },
];
