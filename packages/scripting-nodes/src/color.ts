import {
  pin,
  type NodeDefinition,
  BOOL,
  COLOR,
  FLOAT,
} from "@babylonslate/scripting";

export const colorNodes: NodeDefinition[] = [
  {
    id: "color.lerp",
    title: "Lerp Color",
    category: "color",
    pure: true,
    pins: () => [
      pin("a", "A", "in", COLOR),
      pin("b", "B", "in", COLOR),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", COLOR),
    ],
    codegen: (ctx) => {
      const a = ctx.input("a");
      const b = ctx.input("b");
      const t = ctx.input("alpha");
      return {
        out: `{ x: (${a}).x + ((${b}).x - (${a}).x) * (${t}), y: (${a}).y + ((${b}).y - (${a}).y) * (${t}), z: (${a}).z + ((${b}).z - (${a}).z) * (${t}), w: (${a}).w + ((${b}).w - (${a}).w) * (${t}) }`,
      };
    },
  },
  {
    id: "color.multiply",
    title: "Multiply Color",
    category: "color",
    pure: true,
    pins: () => [
      pin("a", "A", "in", COLOR),
      pin("b", "B", "in", COLOR),
      pin("out", "Out", "out", COLOR),
    ],
    codegen: (ctx) => {
      const a = ctx.input("a");
      const b = ctx.input("b");
      return {
        out: `{ x: (${a}).x * (${b}).x, y: (${a}).y * (${b}).y, z: (${a}).z * (${b}).z, w: (${a}).w * (${b}).w }`,
      };
    },
  },
  {
    id: "color.nearlyEqual",
    title: "Color Nearly Equal",
    category: "color",
    pure: true,
    pins: () => [
      pin("a", "A", "in", COLOR),
      pin("b", "B", "in", COLOR),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => {
      const a = ctx.input("a");
      const b = ctx.input("b");
      return {
        out: `(Math.abs((${a}).x - (${b}).x) < 1e-6 && Math.abs((${a}).y - (${b}).y) < 1e-6 && Math.abs((${a}).z - (${b}).z) < 1e-6 && Math.abs((${a}).w - (${b}).w) < 1e-6)`,
      };
    },
  },
];
