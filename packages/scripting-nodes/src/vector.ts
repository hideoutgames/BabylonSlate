import {
  pin,
  type NodeDefinition,
  FLOAT,
  VEC2,
  VEC3,
  VEC4,
  type PinType,
} from "@babylonslate/scripting";

const AXES2 = ["x", "y"] as const;
const AXES3 = ["x", "y", "z"] as const;
const AXES4 = ["x", "y", "z", "w"] as const;

function componentWise(
  a: string,
  b: string,
  op: "+" | "-" | "*" | "/",
  axes: readonly string[],
): string {
  return `{ ${axes.map((axis) => `${axis}: (${a}).${axis} ${op} (${b}).${axis}`).join(", ")} }`;
}

function scaleExpr(v: string, s: string, axes: readonly string[]): string {
  return `{ ${axes.map((axis) => `${axis}: (${v}).${axis} * (${s})`).join(", ")} }`;
}

function lerpExpr(a: string, b: string, t: string, axes: readonly string[]): string {
  return `{ ${axes.map((axis) => `${axis}: (${a}).${axis} + ((${b}).${axis} - (${a}).${axis}) * (${t})`).join(", ")} }`;
}

function dotExpr(a: string, b: string, axes: readonly string[]): string {
  return `(${axes.map((axis) => `(${a}).${axis} * (${b}).${axis}`).join(" + ")})`;
}

function lengthExpr(v: string, axes: readonly string[]): string {
  return `Math.hypot(${axes.map((axis) => `(${v}).${axis}`).join(", ")})`;
}

function binaryVec(
  id: string,
  title: string,
  type: PinType,
  op: "+" | "-" | "*" | "/",
  axes: readonly string[],
): NodeDefinition {
  return {
    id,
    title,
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", type),
      pin("b", "B", "in", type),
      pin("out", "Out", "out", type),
    ],
    codegen: (ctx) => ({
      out: componentWise(ctx.input("a"), ctx.input("b"), op, axes),
    }),
  };
}

function scaleVec(
  id: string,
  title: string,
  type: PinType,
  axes: readonly string[],
  vectorPinId = "v",
): NodeDefinition {
  return {
    id,
    title,
    category: "vector",
    pure: true,
    pins: () => [
      pin(vectorPinId, "V", "in", type),
      pin("s", "S", "in", FLOAT),
      pin("out", "Out", "out", type),
    ],
    codegen: (ctx) => ({
      out: scaleExpr(ctx.input(vectorPinId), ctx.input("s"), axes),
    }),
  };
}

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
  binaryVec("vector.sub3", "Subtract Vector3", VEC3, "-", AXES3),
  binaryVec("vector.mul3", "Multiply Vector3", VEC3, "*", AXES3),
  binaryVec("vector.div3", "Divide Vector3", VEC3, "/", AXES3),
  {
    id: "vector.dot3",
    title: "Dot Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC3),
      pin("b", "B", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: dotExpr(ctx.input("a"), ctx.input("b"), AXES3),
    }),
  },
  {
    id: "vector.cross3",
    title: "Cross Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC3),
      pin("b", "B", "in", VEC3),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => {
      const a = ctx.input("a");
      const b = ctx.input("b");
      return {
        out: `{ x: (${a}).y * (${b}).z - (${a}).z * (${b}).y, y: (${a}).z * (${b}).x - (${a}).x * (${b}).z, z: (${a}).x * (${b}).y - (${a}).y * (${b}).x }`,
      };
    },
  },
  {
    id: "vector.length3",
    title: "Vector3 Length",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx.input("v"), AXES3) }),
  },
  {
    id: "vector.normalize3",
    title: "Normalize Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC3),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => {
      const v = ctx.input("v");
      const len = `__len_${ctx.node.id.replace(/[^A-Za-z0-9]/g, "_")}`;
      return {
        out: `((${len} => ${len} > 1e-8 ? { x: (${v}).x / ${len}, y: (${v}).y / ${len}, z: (${v}).z / ${len} } : { x: 0, y: 0, z: 0 })(${lengthExpr(v, AXES3)}))`,
      };
    },
  },
  {
    id: "vector.distance3",
    title: "Distance Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC3),
      pin("b", "B", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `Math.hypot((${ctx.input("a")}).x - (${ctx.input("b")}).x, (${ctx.input("a")}).y - (${ctx.input("b")}).y, (${ctx.input("a")}).z - (${ctx.input("b")}).z)`,
    }),
  },
  {
    id: "vector.lerp3",
    title: "Lerp Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC3),
      pin("b", "B", "in", VEC3),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: lerpExpr(ctx.input("a"), ctx.input("b"), ctx.input("alpha"), AXES3),
    }),
  },
  binaryVec("vector.add2", "Add Vector2", VEC2, "+", AXES2),
  binaryVec("vector.sub2", "Subtract Vector2", VEC2, "-", AXES2),
  binaryVec("vector.mul2", "Multiply Vector2", VEC2, "*", AXES2),
  binaryVec("vector.div2", "Divide Vector2", VEC2, "/", AXES2),
  scaleVec("vector.scale2", "Scale Vector2", VEC2, AXES2),
  {
    id: "vector.dot2",
    title: "Dot Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC2),
      pin("b", "B", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: dotExpr(ctx.input("a"), ctx.input("b"), AXES2),
    }),
  },
  {
    id: "vector.length2",
    title: "Vector2 Length",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx.input("v"), AXES2) }),
  },
  {
    id: "vector.normalize2",
    title: "Normalize Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC2),
      pin("out", "Out", "out", VEC2),
    ],
    codegen: (ctx) => {
      const v = ctx.input("v");
      return {
        out: `((${lengthExpr(v, AXES2)} > 1e-8 ? { x: (${v}).x / ${lengthExpr(v, AXES2)}, y: (${v}).y / ${lengthExpr(v, AXES2)} } : { x: 0, y: 0 }))`,
      };
    },
  },
  {
    id: "vector.distance2",
    title: "Distance Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC2),
      pin("b", "B", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `Math.hypot((${ctx.input("a")}).x - (${ctx.input("b")}).x, (${ctx.input("a")}).y - (${ctx.input("b")}).y)`,
    }),
  },
  {
    id: "vector.lerp2",
    title: "Lerp Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC2),
      pin("b", "B", "in", VEC2),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", VEC2),
    ],
    codegen: (ctx) => ({
      out: lerpExpr(ctx.input("a"), ctx.input("b"), ctx.input("alpha"), AXES2),
    }),
  },
  binaryVec("vector.add4", "Add Vector4", VEC4, "+", AXES4),
  binaryVec("vector.sub4", "Subtract Vector4", VEC4, "-", AXES4),
  binaryVec("vector.mul4", "Multiply Vector4", VEC4, "*", AXES4),
  binaryVec("vector.div4", "Divide Vector4", VEC4, "/", AXES4),
  scaleVec("vector.scale4", "Scale Vector4", VEC4, AXES4),
  {
    id: "vector.dot4",
    title: "Dot Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC4),
      pin("b", "B", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: dotExpr(ctx.input("a"), ctx.input("b"), AXES4),
    }),
  },
  {
    id: "vector.length4",
    title: "Vector4 Length",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx.input("v"), AXES4) }),
  },
  {
    id: "vector.normalize4",
    title: "Normalize Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC4),
      pin("out", "Out", "out", VEC4),
    ],
    codegen: (ctx) => {
      const v = ctx.input("v");
      const len = lengthExpr(v, AXES4);
      return {
        out: `((${len} > 1e-8 ? { x: (${v}).x / ${len}, y: (${v}).y / ${len}, z: (${v}).z / ${len}, w: (${v}).w / ${len} } : { x: 0, y: 0, z: 0, w: 0 }))`,
      };
    },
  },
  {
    id: "vector.lerp4",
    title: "Lerp Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC4),
      pin("b", "B", "in", VEC4),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", VEC4),
    ],
    codegen: (ctx) => ({
      out: lerpExpr(ctx.input("a"), ctx.input("b"), ctx.input("alpha"), AXES4),
    }),
  },
];
