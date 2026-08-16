/**
 * Material value types (engineplan §2.3).
 *
 * Colors are float vectors with a display hint on the pin, not separate types:
 * the Babylon boundary in `@babylonslate/render` picks Color3 / Color4 versus
 * Vector3 / Vector4 when it lowers a build plan. Booleans are floats so the
 * catalog stays inside the portable Babylon block set.
 */
export type MaterialValueType =
  | "float"
  | "vec2"
  | "vec3"
  | "vec4"
  | "texture";

export const MATERIAL_NUMERIC_TYPES: readonly MaterialValueType[] = [
  "float",
  "vec2",
  "vec3",
  "vec4",
];

const COMPONENTS: Record<MaterialValueType, number> = {
  float: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  texture: 0,
};

const LABELS: Record<MaterialValueType, string> = {
  float: "Float",
  vec2: "Vector 2",
  vec3: "Vector 3",
  vec4: "Vector 4",
  texture: "Texture",
};

export function componentCount(type: MaterialValueType): number {
  return COMPONENTS[type];
}

export function isNumericType(type: MaterialValueType): boolean {
  return type !== "texture";
}

export function materialTypeLabel(type: MaterialValueType): string {
  return LABELS[type];
}

/** Widening applied while lowering so Babylon only ever sees exact types. */
export type MaterialConversion = { kind: "splat"; to: MaterialValueType };

/**
 * A float broadcasts into any vector. Everything else must match exactly:
 * truncation and partial widening need an explicit Split / Combine node so the
 * authored graph says which components move where.
 */
export function typesAreAssignable(
  from: MaterialValueType,
  to: MaterialValueType,
): boolean {
  if (from === to) return true;
  if (!isNumericType(from) || !isNumericType(to)) return false;
  return from === "float";
}

export function conversionFor(
  from: MaterialValueType,
  to: MaterialValueType,
): MaterialConversion | null {
  if (from === to) return null;
  if (!typesAreAssignable(from, to)) return null;
  return { kind: "splat", to };
}

export type GenericResolution =
  | { ok: true; type: MaterialValueType }
  | { ok: false; conflict: [MaterialValueType, MaterialValueType] };

/**
 * Resolve one generic pin group from the types actually wired into it.
 * Floats splat, so the group takes the single widest vector present.
 */
export function resolveGenericType(
  connected: readonly MaterialValueType[],
): GenericResolution {
  let resolved: MaterialValueType = "float";
  for (const type of connected) {
    if (!isNumericType(type)) {
      return { ok: false, conflict: [resolved, type] };
    }
    if (type === "float" || type === resolved) continue;
    if (resolved === "float") {
      resolved = type;
      continue;
    }
    return { ok: false, conflict: [resolved, type] };
  }
  return { ok: true, type: resolved };
}
