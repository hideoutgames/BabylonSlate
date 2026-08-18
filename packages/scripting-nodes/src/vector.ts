import {
  pin,
  type NodeDefinition,
  FLOAT,
  VEC2,
  VEC3,
  VEC4,
} from "@babylonslate/scripting";

export const vectorNodes: NodeDefinition[] = [
  {
    id: "vector.make3",
    title: "Make Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("x", "x", "in", FLOAT),
      pin("y", "y", "in", FLOAT),
      pin("z", "z", "in", FLOAT),
      pin("out", "out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `{ x: ${ctx.input("x")}, y: ${ctx.input("y")}, z: ${ctx.input("z")} }`,
    }),
  },
  {
    id: "vector.break3",
    title: "Break Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("in", "in", "in", VEC3),
      pin("x", "x", "out", FLOAT),
      pin("y", "y", "out", FLOAT),
      pin("z", "z", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const v = ctx.input("in");
      return { x: `(${v}).x`, y: `(${v}).y`, z: `(${v}).z` };
    },
  },
  {
    id: "vector.add3",
    title: "Add Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "a", "in", VEC3),
      pin("b", "b", "in", VEC3),
      pin("out", "out", "out", VEC3),
    ],
    codegen: (ctx) => {
      const a = ctx.input("a");
      const b = ctx.input("b");
      return {
        out: `{ x: (${a}).x + (${b}).x, y: (${a}).y + (${b}).y, z: (${a}).z + (${b}).z }`,
      };
    },
  },
  {
    id: "vector.scale3",
    title: "Scale Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "v", "in", VEC3),
      pin("s", "s", "in", FLOAT),
      pin("out", "out", "out", VEC3),
    ],
    codegen: (ctx) => {
      const v = ctx.input("v");
      const s = ctx.input("s");
      return {
        out: `{ x: (${v}).x * (${s}), y: (${v}).y * (${s}), z: (${v}).z * (${s}) }`,
      };
    },
  },
  {
    id: "vector.make2",
    title: "Make Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("x", "x", "in", FLOAT),
      pin("y", "y", "in", FLOAT),
      pin("out", "out", "out", VEC2),
    ],
    codegen: (ctx) => ({
      out: `{ x: ${ctx.input("x")}, y: ${ctx.input("y")} }`,
    }),
  },
  {
    id: "vector.break2",
    title: "Break Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("in", "in", "in", VEC2),
      pin("x", "x", "out", FLOAT),
      pin("y", "y", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const v = ctx.input("in");
      return { x: `(${v}).x`, y: `(${v}).y` };
    },
  },
  {
    id: "vector.make4",
    title: "Make Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("x", "x", "in", FLOAT),
      pin("y", "y", "in", FLOAT),
      pin("z", "z", "in", FLOAT),
      pin("w", "w", "in", FLOAT),
      pin("out", "out", "out", VEC4),
    ],
    codegen: (ctx) => ({
      out: `{ x: ${ctx.input("x")}, y: ${ctx.input("y")}, z: ${ctx.input("z")}, w: ${ctx.input("w")} }`,
    }),
  },
  {
    id: "vector.break4",
    title: "Break Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("in", "in", "in", VEC4),
      pin("x", "x", "out", FLOAT),
      pin("y", "y", "out", FLOAT),
      pin("z", "z", "out", FLOAT),
      pin("w", "w", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const v = ctx.input("in");
      return {
        x: `(${v}).x`,
        y: `(${v}).y`,
        z: `(${v}).z`,
        w: `(${v}).w`,
      };
    },
  },
];
