import type { CodegenContext, UnboxedVector } from "@haptic/scripting";

export type VecKind = "vec2" | "vec3" | "vec4";

export const VEC_AXES: Readonly<Record<VecKind, readonly string[]>> = {
  vec2: ["x", "y"],
  vec3: ["x", "y", "z"],
  vec4: ["x", "y", "z", "w"],
};

export function joinSetup(a?: string, b?: string): string | undefined {
  if (a && b) return `${a}, ${b}`;
  return a || b;
}

export function joinSetups(parts: readonly (string | undefined)[]): string | undefined {
  const nonEmpty = parts.filter((p): p is string => Boolean(p));
  return nonEmpty.length > 0 ? nonEmpty.join(", ") : undefined;
}

export function vecAxis(vec: UnboxedVector, axis: string): string {
  return (vec as Record<string, string>)[axis]!;
}

export function makeUnboxed(kind: VecKind, values: readonly string[], setup?: string): UnboxedVector {
  if (kind === "vec2") return { kind: "vec2", x: values[0]!, y: values[1]!, ...(setup ? { setup } : {}) };
  if (kind === "vec3") return { kind: "vec3", x: values[0]!, y: values[1]!, z: values[2]!, ...(setup ? { setup } : {}) };
  return { kind: "vec4", x: values[0]!, y: values[1]!, z: values[2]!, w: values[3]!, ...(setup ? { setup } : {}) };
}

/**
 * Reads a vector input pin as unboxed scalar components. If the producer is
 * already unboxed (or disconnected constant), uses its scalars directly;
 * otherwise binds the boxed input once into a scalar temp and reads `.x/.y/.z/.w`.
 */
export function readVectorAsUnboxed(
  ctx: CodegenContext,
  pinName: string,
  kind: VecKind,
): UnboxedVector | undefined {
  const unboxed = ctx.inputUnboxed?.(pinName);
  if (unboxed && unboxed.kind === kind) return unboxed;
  if (!ctx.allocTemp) return undefined;
  const tmp = ctx.allocTemp();
  const expr = ctx.input(pinName);
  const axes = VEC_AXES[kind];
  return makeUnboxed(kind, axes.map((axis) => `${tmp}.${axis}`), `${tmp} = (${expr})`);
}

/** Wraps an unboxed vector into a single boxed object expression (evaluating `setup` first). */
export function boxUnboxedVector(vec: UnboxedVector): string {
  const obj = vec.kind === "vec2"
    ? `{ x: ${vec.x}, y: ${vec.y} }`
    : vec.kind === "vec3"
      ? `{ x: ${vec.x}, y: ${vec.y}, z: ${vec.z} }`
      : `{ x: ${vec.x}, y: ${vec.y}, z: ${vec.z}, w: ${vec.w} }`;
  return vec.setup ? `(${vec.setup}, ${obj})` : obj;
}

/** Evaluates `setup` (if any) before `expr` as a comma expression. */
export function withSetup(setup: string | undefined, expr: string): string {
  return setup ? `(${setup}, ${expr})` : expr;
}

/**
 * Materializes each component expression into a fresh scalar temp so every
 * input is evaluated once and downstream multi-axis ops read plain identifiers.
 */
export function bindUnboxedComponents(
  ctx: CodegenContext,
  kind: VecKind,
  exprs: readonly string[],
  priorSetup?: string,
): UnboxedVector {
  const temps = exprs.map(() => ctx.allocTemp!());
  const assigns = temps.map((t, i) => `${t} = (${exprs[i]})`).join(", ");
  return makeUnboxed(kind, temps, joinSetup(priorSetup, assigns));
}
