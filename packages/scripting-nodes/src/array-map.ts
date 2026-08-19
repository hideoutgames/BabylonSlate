import {
  pin,
  type NodeDefinition,
  EXEC,
  INT,
  BOOL,
  RESOLVING_WILDCARD,
  arrayOf,
} from "@babylonslate/scripting";

const T = RESOLVING_WILDCARD;

export const arrayMapNodes: NodeDefinition[] = [
  {
    id: "array.get",
    title: "Array Get",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "array", "in", arrayOf(T)),
      pin("index", "index", "in", INT),
      pin("out", "out", "out", T),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("array")})[${ctx.input("index")}]`,
    }),
  },
  {
    id: "array.length",
    title: "Array Length",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "array", "in", arrayOf(T)),
      pin("out", "out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `(${ctx.input("array")}).length` }),
  },
  {
    id: "array.append",
    title: "Array Append",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "array", "in", arrayOf(T)),
      pin("item", "item", "in", T),
      pin("out", "out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = (${ctx.input("array")}).concat([${ctx.input("item")}]);`,
      );
    },
  },
  {
    id: "array.contains",
    title: "Array Contains",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "array", "in", arrayOf(T)),
      pin("item", "item", "in", T),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("array")}).includes(${ctx.input("item")})`,
    }),
  },
  {
    id: "array.make",
    title: "Make Array",
    category: "array",
    pure: true,
    pins: () => [pin("out", "Out", "out", arrayOf(T))],
    codegen: () => ({ out: "[]" }),
  },
  {
    id: "array.set",
    title: "Array Set",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = (${ctx.input("array")}).slice(); ${out}[${ctx.input("index")}] = ${ctx.input("item")};`,
      );
    },
  },
  {
    id: "array.insert",
    title: "Array Insert",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = (${ctx.input("array")}).slice(); ${out}.splice(${ctx.input("index")}, 0, ${ctx.input("item")});`,
      );
    },
  },
  {
    id: "array.removeIndex",
    title: "Array Remove Index",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = (${ctx.input("array")}).slice(); ${out}.splice(${ctx.input("index")}, 1);`,
      );
    },
  },
  {
    id: "array.find",
    title: "Array Find",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("array")}).indexOf(${ctx.input("item")})`,
    }),
  },
  {
    id: "array.clear",
    title: "Array Clear",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("out")} = [];`);
    },
  },
];
