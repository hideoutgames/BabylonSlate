import {
  pin,
  type NodeDefinition,
  FLOAT,
  VEC2,
  VEC3,
  VEC4,
  type PinType,
} from "@haptic/scripting";
import { ARITHMETIC_SEARCH_ALIASES } from "./arithmetic-search-aliases";
import { hoistedCall } from "./hoisted-helper";

type Ctx = Parameters<NodeDefinition["codegen"]>[0];
const OP_NAMES = { "+": "add", "-": "sub", "*": "mul", "/": "div" } as const;

const AXES2 = ["x", "y"] as const;
const AXES3 = ["x", "y", "z"] as const;
const AXES4 = ["x", "y", "z", "w"] as const;

/**
 * Each helper binds its inputs once (`a`, `b`, `v`, `s`, `t`), so an impure
 * input such as Random Float is sampled once and every component sees it. The
 * helper is a module-scope function named for its operation and axes
 * (`__vec_add_xyz`), so a node evaluates with one call.
 */
function componentWise(
  ctx: Ctx,
  a: string,
  b: string,
  op: "+" | "-" | "*" | "/",
  axes: readonly string[],
): string {
  return hoistedCall(
    ctx,
    `__vec_${OP_NAMES[op]}_${axes.join("")}`,
    "a, b",
    `({ ${axes.map((axis) => `${axis}: a.${axis} ${op} b.${axis}`).join(", ")} })`,
    [a, b],
  );
}

function scaleExpr(ctx: Ctx, v: string, s: string, axes: readonly string[]): string {
  return hoistedCall(
    ctx,
    `__vec_scale_${axes.join("")}`,
    "v, s",
    `({ ${axes.map((axis) => `${axis}: v.${axis} * s`).join(", ")} })`,
    [v, s],
  );
}

function lerpExpr(ctx: Ctx, a: string, b: string, t: string, axes: readonly string[]): string {
  return hoistedCall(
    ctx,
    `__vec_lerp_${axes.join("")}`,
    "a, b, t",
    `({ ${axes.map((axis) => `${axis}: a.${axis} + (b.${axis} - a.${axis}) * t`).join(", ")} })`,
    [a, b, t],
  );
}

function dotExpr(ctx: Ctx, a: string, b: string, axes: readonly string[]): string {
  return hoistedCall(
    ctx,
    `__vec_dot_${axes.join("")}`,
    "a, b",
    axes.map((axis) => `a.${axis} * b.${axis}`).join(" + "),
    [a, b],
  );
}

function distanceExpr(ctx: Ctx, a: string, b: string, axes: readonly string[]): string {
  return hoistedCall(
    ctx,
    `__vec_distance_${axes.join("")}`,
    "a, b",
    `Math.hypot(${axes.map((axis) => `a.${axis} - b.${axis}`).join(", ")})`,
    [a, b],
  );
}

/** `Math.hypot` over the components of `v`, which must be a bound name. */
function hypotOf(v: string, axes: readonly string[]): string {
  return `Math.hypot(${axes.map((axis) => `${v}.${axis}`).join(", ")})`;
}

function lengthExpr(ctx: Ctx, v: string, axes: readonly string[]): string {
  return hoistedCall(ctx, `__vec_length_${axes.join("")}`, "v", hypotOf("v", axes), [v]);
}

/** Reads the vector once, so the length and every component see one value. */
function normalizeExpr(ctx: Ctx, v: string, axes: readonly string[]): string {
  const unit = axes.map((axis) => `${axis}: v.${axis} / l`).join(", ");
  const zero = axes.map((axis) => `${axis}: 0`).join(", ");
  return hoistedCall(
    ctx,
    `__vec_normalize_${axes.join("")}`,
    "v",
    `{ const l = ${hypotOf("v", axes)}; return l > 1e-8 ? { ${unit} } : { ${zero} }; }`,
    [v],
  );
}

function lengthSquaredExpr(ctx: Ctx, v: string, axes: readonly string[]): string {
  return hoistedCall(
    ctx,
    `__vec_lengthSquared_${axes.join("")}`,
    "v",
    axes.map((axis) => `v.${axis} * v.${axis}`).join(" + "),
    [v],
  );
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
    searchAliases: ARITHMETIC_SEARCH_ALIASES[op],
    pure: true,
    pins: () => [
      pin("a", "A", "in", type),
      pin("b", "B", "in", type),
      pin("out", "Out", "out", type),
    ],
    codegen: (ctx) => ({
      out: componentWise(ctx, ctx.input("a"), ctx.input("b"), op, axes),
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
    searchAliases: ["*", "×", "v * s"],
    pure: true,
    pins: () => [
      pin(vectorPinId, "V", "in", type),
      pin("s", "S", "in", FLOAT),
      pin("out", "Out", "out", type),
    ],
    codegen: (ctx) => ({
      out: scaleExpr(ctx, ctx.input(vectorPinId), ctx.input("s"), axes),
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
    searchAliases: ["+","a + b","plus","sum"],
    title: "Add Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "a", "in", VEC3),
      pin("b", "b", "in", VEC3),
      pin("out", "out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: componentWise(ctx, ctx.input("a"), ctx.input("b"), "+", AXES3),
    }),
  },
  {
    id: "vector.scale3",
    searchAliases: ["*","×","v * s"],
    title: "Scale Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "v", "in", VEC3),
      pin("s", "s", "in", FLOAT),
      pin("out", "out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: scaleExpr(ctx, ctx.input("v"), ctx.input("s"), AXES3),
    }),
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
    searchAliases: ["·","dot","dot(a,b)","a · b"],
    title: "Dot Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC3),
      pin("b", "B", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: dotExpr(ctx, ctx.input("a"), ctx.input("b"), AXES3),
    }),
  },
  {
    id: "vector.cross3",
    searchAliases: ["×","cross","cross(a,b)","a × b"],
    title: "Cross Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC3),
      pin("b", "B", "in", VEC3),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(
        ctx,
        "__vec_cross_xyz",
        "a, b",
        "({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })",
        [ctx.input("a"), ctx.input("b")],
      ),
    }),
  },
  {
    id: "vector.length3",
    searchAliases: ["length(x)","magnitude","|v|"],
    title: "Vector3 Length",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx, ctx.input("v"), AXES3) }),
  },
  {
    id: "vector.lengthSquared3",
    searchAliases: ["lengthSquared(x)","dot(v,v)","|v|²"],
    title: "Vector3 Length Squared",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthSquaredExpr(ctx, ctx.input("v"), AXES3) }),
  },
  {
    id: "vector.normalize3",
    searchAliases: ["normalize(x)","x/length(x)"],
    title: "Normalize Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC3),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({ out: normalizeExpr(ctx, ctx.input("v"), AXES3) }),
  },
  {
    id: "vector.distance3",
    searchAliases: ["distance(a,b)","length(a-b)"],
    title: "Distance Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC3),
      pin("b", "B", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: distanceExpr(ctx, ctx.input("a"), ctx.input("b"), AXES3),
    }),
  },
  {
    id: "vector.lerp3",
    searchAliases: ["mix","mix(a,b,t)","lerp(a,b,t)","a+(b-a)*t"],
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
      out: lerpExpr(ctx, ctx.input("a"), ctx.input("b"), ctx.input("alpha"), AXES3),
    }),
  },
  binaryVec("vector.add2", "Add Vector2", VEC2, "+", AXES2),
  binaryVec("vector.sub2", "Subtract Vector2", VEC2, "-", AXES2),
  binaryVec("vector.mul2", "Multiply Vector2", VEC2, "*", AXES2),
  binaryVec("vector.div2", "Divide Vector2", VEC2, "/", AXES2),
  scaleVec("vector.scale2", "Scale Vector2", VEC2, AXES2),
  {
    id: "vector.dot2",
    searchAliases: ["·","dot","dot(a,b)","a · b"],
    title: "Dot Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC2),
      pin("b", "B", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: dotExpr(ctx, ctx.input("a"), ctx.input("b"), AXES2),
    }),
  },
  {
    id: "vector.length2",
    searchAliases: ["length(x)","magnitude","|v|"],
    title: "Vector2 Length",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx, ctx.input("v"), AXES2) }),
  },
  {
    id: "vector.lengthSquared2",
    searchAliases: ["lengthSquared(x)","dot(v,v)","|v|²"],
    title: "Vector2 Length Squared",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthSquaredExpr(ctx, ctx.input("v"), AXES2) }),
  },
  {
    id: "vector.normalize2",
    searchAliases: ["normalize(x)","x/length(x)"],
    title: "Normalize Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC2),
      pin("out", "Out", "out", VEC2),
    ],
    codegen: (ctx) => ({ out: normalizeExpr(ctx, ctx.input("v"), AXES2) }),
  },
  {
    id: "vector.distance2",
    searchAliases: ["distance(a,b)","length(a-b)"],
    title: "Distance Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC2),
      pin("b", "B", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: distanceExpr(ctx, ctx.input("a"), ctx.input("b"), AXES2),
    }),
  },
  {
    id: "vector.lerp2",
    searchAliases: ["mix","mix(a,b,t)","lerp(a,b,t)","a+(b-a)*t"],
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
      out: lerpExpr(ctx, ctx.input("a"), ctx.input("b"), ctx.input("alpha"), AXES2),
    }),
  },
  binaryVec("vector.add4", "Add Vector4", VEC4, "+", AXES4),
  binaryVec("vector.sub4", "Subtract Vector4", VEC4, "-", AXES4),
  binaryVec("vector.mul4", "Multiply Vector4", VEC4, "*", AXES4),
  binaryVec("vector.div4", "Divide Vector4", VEC4, "/", AXES4),
  scaleVec("vector.scale4", "Scale Vector4", VEC4, AXES4),
  {
    id: "vector.dot4",
    searchAliases: ["·","dot","dot(a,b)","a · b"],
    title: "Dot Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC4),
      pin("b", "B", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: dotExpr(ctx, ctx.input("a"), ctx.input("b"), AXES4),
    }),
  },
  {
    id: "vector.length4",
    searchAliases: ["length(x)","magnitude","|v|"],
    title: "Vector4 Length",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx, ctx.input("v"), AXES4) }),
  },
  {
    id: "vector.lengthSquared4",
    searchAliases: ["lengthSquared(x)","dot(v,v)","|v|²"],
    title: "Vector4 Length Squared",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthSquaredExpr(ctx, ctx.input("v"), AXES4) }),
  },
  {
    id: "vector.normalize4",
    searchAliases: ["normalize(x)","x/length(x)"],
    title: "Normalize Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC4),
      pin("out", "Out", "out", VEC4),
    ],
    codegen: (ctx) => ({ out: normalizeExpr(ctx, ctx.input("v"), AXES4) }),
  },
  {
    id: "vector.distance4",
    searchAliases: ["distance(a,b)","length(a-b)"],
    title: "Distance Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("a", "A", "in", VEC4),
      pin("b", "B", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: distanceExpr(ctx, ctx.input("a"), ctx.input("b"), AXES4),
    }),
  },
  {
    id: "vector.lerp4",
    searchAliases: ["mix","mix(a,b,t)","lerp(a,b,t)","a+(b-a)*t"],
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
      out: lerpExpr(ctx, ctx.input("a"), ctx.input("b"), ctx.input("alpha"), AXES4),
    }),
  },
];
