import {
  pin,
  type NodeDefinition,
  type UnboxedVector,
  FLOAT,
  VEC2,
  VEC3,
  VEC4,
} from "@haptic/scripting";
import { hoistedCall } from "./hoisted-helper";
import {
  bindUnboxedComponents,
  boxUnboxedVector,
  joinSetups,
  readVectorAsUnboxed,
  vecAxis,
  withSetup,
  type VecKind,
} from "./unboxed-helpers";

type Ctx = Parameters<NodeDefinition["codegen"]>[0];

const AXES2 = ["x", "y"] as const;
const AXES3 = ["x", "y", "z"] as const;
const AXES4 = ["x", "y", "z", "w"] as const;

function lerpUnboxed(ctx: Ctx, kind: VecKind, axes: readonly string[]): UnboxedVector | undefined {
  if (!ctx.allocTemp) return undefined;
  const a = readVectorAsUnboxed(ctx, "a", kind);
  const b = readVectorAsUnboxed(ctx, "b", kind);
  if (!a || !b) return undefined;
  const t = ctx.allocTemp();
  const tAssign = `${t} = (${ctx.input("alpha")})`;
  const exprs = axes.map((axis) => {
    const av = vecAxis(a, axis);
    const bv = vecAxis(b, axis);
    return `${av} + (${bv} - ${av}) * ${t}`;
  });
  return bindUnboxedComponents(ctx, kind, exprs, joinSetups([a.setup, b.setup, tAssign]));
}

function lerpExpr(ctx: Ctx, kind: VecKind, axes: readonly string[]): string {
  if (ctx.allocTemp && ((ctx.isWired("a") && ctx.inputUnboxed?.("a")) || (ctx.isWired("b") && ctx.inputUnboxed?.("b")))) {
    const unboxed = lerpUnboxed(ctx, kind, axes);
    if (unboxed) return boxUnboxedVector(unboxed);
  }
  return hoistedCall(
    ctx,
    `__vec_lerp_${axes.join("")}`,
    "a, b, t",
    `({ ${axes.map((axis) => `${axis}: a.${axis} + (b.${axis} - a.${axis}) * t`).join(", ")} })`,
    [ctx.input("a"), ctx.input("b"), ctx.input("alpha")],
  );
}

function dotExpr(ctx: Ctx, kind: VecKind, axes: readonly string[]): string {
  if (ctx.allocTemp && ((ctx.isWired("a") && ctx.inputUnboxed?.("a")) || (ctx.isWired("b") && ctx.inputUnboxed?.("b")))) {
    const a = readVectorAsUnboxed(ctx, "a", kind);
    const b = readVectorAsUnboxed(ctx, "b", kind);
    if (a && b) {
      const expr = axes.map((axis) => `${vecAxis(a, axis)} * ${vecAxis(b, axis)}`).join(" + ");
      return withSetup(joinSetups([a.setup, b.setup]), expr);
    }
  }
  return hoistedCall(
    ctx,
    `__vec_dot_${axes.join("")}`,
    "a, b",
    axes.map((axis) => `a.${axis} * b.${axis}`).join(" + "),
    [ctx.input("a"), ctx.input("b")],
  );
}

function distanceExpr(ctx: Ctx, kind: VecKind, axes: readonly string[]): string {
  if (ctx.allocTemp && ((ctx.isWired("a") && ctx.inputUnboxed?.("a")) || (ctx.isWired("b") && ctx.inputUnboxed?.("b")))) {
    const a = readVectorAsUnboxed(ctx, "a", kind);
    const b = readVectorAsUnboxed(ctx, "b", kind);
    if (a && b) {
      const expr = `Math.hypot(${axes.map((axis) => `${vecAxis(a, axis)} - ${vecAxis(b, axis)}`).join(", ")})`;
      return withSetup(joinSetups([a.setup, b.setup]), expr);
    }
  }
  return hoistedCall(
    ctx,
    `__vec_distance_${axes.join("")}`,
    "a, b",
    `Math.hypot(${axes.map((axis) => `a.${axis} - b.${axis}`).join(", ")})`,
    [ctx.input("a"), ctx.input("b")],
  );
}

/** `Math.hypot` over the components of `v`, which must be a bound name. */
function hypotOf(v: string, axes: readonly string[]): string {
  return `Math.hypot(${axes.map((axis) => `${v}.${axis}`).join(", ")})`;
}

function lengthExpr(ctx: Ctx, kind: VecKind, axes: readonly string[]): string {
  if (ctx.isWired("v")) {
    const u = ctx.inputUnboxed?.("v");
    if (u && u.kind === kind) {
      return withSetup(u.setup, `Math.hypot(${axes.map((axis) => vecAxis(u, axis)).join(", ")})`);
    }
  }
  return hoistedCall(ctx, `__vec_length_${axes.join("")}`, "v", hypotOf("v", axes), [ctx.input("v")]);
}

function normalizeUnboxed(ctx: Ctx, kind: VecKind, axes: readonly string[]): UnboxedVector | undefined {
  if (!ctx.allocTemp) return undefined;
  const v = readVectorAsUnboxed(ctx, "v", kind);
  if (!v) return undefined;
  const len = ctx.allocTemp();
  const lenAssign = `${len} = Math.hypot(${axes.map((axis) => vecAxis(v, axis)).join(", ")})`;
  const exprs = axes.map((axis) => `(${len} > 1e-8 ? ${vecAxis(v, axis)} / ${len} : 0)`);
  return bindUnboxedComponents(ctx, kind, exprs, joinSetups([v.setup, lenAssign]));
}

/** Reads the vector once, so the length and every component see one value. */
function normalizeExpr(ctx: Ctx, kind: VecKind, axes: readonly string[]): string {
  if (ctx.allocTemp && ctx.isWired("v") && ctx.inputUnboxed?.("v")) {
    const unboxed = normalizeUnboxed(ctx, kind, axes);
    if (unboxed) return boxUnboxedVector(unboxed);
  }
  const unit = axes.map((axis) => `${axis}: v.${axis} / l`).join(", ");
  const zero = axes.map((axis) => `${axis}: 0`).join(", ");
  return hoistedCall(
    ctx,
    `__vec_normalize_${axes.join("")}`,
    "v",
    `{ const l = ${hypotOf("v", axes)}; return l > 1e-8 ? { ${unit} } : { ${zero} }; }`,
    [ctx.input("v")],
  );
}

function lengthSquaredExpr(ctx: Ctx, kind: VecKind, axes: readonly string[]): string {
  if (ctx.isWired("v")) {
    const u = ctx.inputUnboxed?.("v");
    if (u && u.kind === kind) {
      return withSetup(u.setup, axes.map((axis) => `${vecAxis(u, axis)} * ${vecAxis(u, axis)}`).join(" + "));
    }
  }
  return hoistedCall(
    ctx,
    `__vec_lengthSquared_${axes.join("")}`,
    "v",
    axes.map((axis) => `v.${axis} * v.${axis}`).join(" + "),
    [ctx.input("v")],
  );
}

function cross3Unboxed(ctx: Ctx): UnboxedVector | undefined {
  if (!ctx.allocTemp) return undefined;
  const a = readVectorAsUnboxed(ctx, "a", "vec3");
  const b = readVectorAsUnboxed(ctx, "b", "vec3");
  if (!a || !b) return undefined;
  const ax = vecAxis(a, "x"), ay = vecAxis(a, "y"), az = vecAxis(a, "z");
  const bx = vecAxis(b, "x"), by = vecAxis(b, "y"), bz = vecAxis(b, "z");
  return bindUnboxedComponents(
    ctx,
    "vec3",
    [`${ay} * ${bz} - ${az} * ${by}`, `${az} * ${bx} - ${ax} * ${bz}`, `${ax} * ${by} - ${ay} * ${bx}`],
    joinSetups([a.setup, b.setup]),
  );
}

function breakVector(ctx: Ctx, kind: VecKind, axes: readonly string[]): Record<string, string> {
  const u = ctx.inputUnboxed?.("in");
  if (u && u.kind === kind) {
    const out: Record<string, string> = {};
    for (const axis of axes) out[axis] = withSetup(u.setup, vecAxis(u, axis));
    return out;
  }
  const v = ctx.input("in");
  const out: Record<string, string> = {};
  for (const axis of axes) out[axis] = `(${v}).${axis}`;
  return out;
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
    codegenUnboxed: (ctx) =>
      ctx.allocTemp
        ? { out: bindUnboxedComponents(ctx, "vec3", [ctx.input("x"), ctx.input("y"), ctx.input("z")]) }
        : undefined,
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
    codegen: (ctx) => breakVector(ctx, "vec3", AXES3),
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
    codegenUnboxed: (ctx) =>
      ctx.allocTemp
        ? { out: bindUnboxedComponents(ctx, "vec2", [ctx.input("x"), ctx.input("y")]) }
        : undefined,
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
    codegen: (ctx) => breakVector(ctx, "vec2", AXES2),
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
    codegenUnboxed: (ctx) =>
      ctx.allocTemp
        ? { out: bindUnboxedComponents(ctx, "vec4", [ctx.input("x"), ctx.input("y"), ctx.input("z"), ctx.input("w")]) }
        : undefined,
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
    codegen: (ctx) => breakVector(ctx, "vec4", AXES4),
  },
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
      out: dotExpr(ctx, "vec3", AXES3),
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
    codegen: (ctx) => {
      if (ctx.allocTemp && ((ctx.isWired("a") && ctx.inputUnboxed?.("a")) || (ctx.isWired("b") && ctx.inputUnboxed?.("b")))) {
        const unboxed = cross3Unboxed(ctx);
        if (unboxed) return { out: boxUnboxedVector(unboxed) };
      }
      return {
        out: hoistedCall(
          ctx,
          "__vec_cross_xyz",
          "a, b",
          "({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })",
          [ctx.input("a"), ctx.input("b")],
        ),
      };
    },
    codegenUnboxed: (ctx) => {
      const vec = cross3Unboxed(ctx);
      return vec ? { out: vec } : undefined;
    },
  },
  {
    id: "vector.length3",
    searchAliases: ["length(x)","magnitude","|v|"],
    title: "Length Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx, "vec3", AXES3) }),
  },
  {
    id: "vector.lengthSquared3",
    searchAliases: ["lengthSquared(x)","dot(v,v)","|v|²"],
    title: "Length Squared Vector3",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC3),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthSquaredExpr(ctx, "vec3", AXES3) }),
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
    codegen: (ctx) => ({ out: normalizeExpr(ctx, "vec3", AXES3) }),
    codegenUnboxed: (ctx) => {
      const vec = normalizeUnboxed(ctx, "vec3", AXES3);
      return vec ? { out: vec } : undefined;
    },
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
      out: distanceExpr(ctx, "vec3", AXES3),
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
      out: lerpExpr(ctx, "vec3", AXES3),
    }),
    codegenUnboxed: (ctx) => {
      const vec = lerpUnboxed(ctx, "vec3", AXES3);
      return vec ? { out: vec } : undefined;
    },
  },
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
      out: dotExpr(ctx, "vec2", AXES2),
    }),
  },
  {
    id: "vector.length2",
    searchAliases: ["length(x)","magnitude","|v|"],
    title: "Length Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx, "vec2", AXES2) }),
  },
  {
    id: "vector.lengthSquared2",
    searchAliases: ["lengthSquared(x)","dot(v,v)","|v|²"],
    title: "Length Squared Vector2",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC2),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthSquaredExpr(ctx, "vec2", AXES2) }),
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
    codegen: (ctx) => ({ out: normalizeExpr(ctx, "vec2", AXES2) }),
    codegenUnboxed: (ctx) => {
      const vec = normalizeUnboxed(ctx, "vec2", AXES2);
      return vec ? { out: vec } : undefined;
    },
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
      out: distanceExpr(ctx, "vec2", AXES2),
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
      out: lerpExpr(ctx, "vec2", AXES2),
    }),
    codegenUnboxed: (ctx) => {
      const vec = lerpUnboxed(ctx, "vec2", AXES2);
      return vec ? { out: vec } : undefined;
    },
  },
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
      out: dotExpr(ctx, "vec4", AXES4),
    }),
  },
  {
    id: "vector.length4",
    searchAliases: ["length(x)","magnitude","|v|"],
    title: "Length Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthExpr(ctx, "vec4", AXES4) }),
  },
  {
    id: "vector.lengthSquared4",
    searchAliases: ["lengthSquared(x)","dot(v,v)","|v|²"],
    title: "Length Squared Vector4",
    category: "vector",
    pure: true,
    pins: () => [
      pin("v", "V", "in", VEC4),
      pin("out", "Out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: lengthSquaredExpr(ctx, "vec4", AXES4) }),
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
    codegen: (ctx) => ({ out: normalizeExpr(ctx, "vec4", AXES4) }),
    codegenUnboxed: (ctx) => {
      const vec = normalizeUnboxed(ctx, "vec4", AXES4);
      return vec ? { out: vec } : undefined;
    },
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
      out: distanceExpr(ctx, "vec4", AXES4),
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
      out: lerpExpr(ctx, "vec4", AXES4),
    }),
    codegenUnboxed: (ctx) => {
      const vec = lerpUnboxed(ctx, "vec4", AXES4);
      return vec ? { out: vec } : undefined;
    },
  },
];
