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

export type MaterialNumericType = Exclude<MaterialValueType, "texture">;

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

export function isNumericType(type: string): type is MaterialNumericType {
  return type === "float" || type === "vec2" || type === "vec3" || type === "vec4";
}

export function materialTypeLabel(type: MaterialValueType): string {
  return LABELS[type];
}

/** One numeric input boundary. Keep these in order when inlining functions. */
export interface MaterialConversion {
  from: MaterialNumericType;
  to: MaterialNumericType;
}

/** Preserve leading channels, discard excess channels, and fill missing channels with 1. */
export function convertMaterialValue(
  value: readonly number[],
  conversion: MaterialConversion,
): number[] {
  const sourceWidth = componentCount(conversion.from);
  return Array.from({ length: componentCount(conversion.to) }, (_, index) => {
    return index < sourceWidth ? (value[index] ?? 1) : 1;
  });
}

/**
 * Numeric inputs accept every numeric width. Textures only connect to textures.
 */
export function typesAreAssignable(
  from: MaterialValueType,
  to: MaterialValueType,
): boolean {
  if (from === to) return true;
  return isNumericType(from) && isNumericType(to);
}

export function conversionFor(
  from: MaterialValueType,
  to: MaterialValueType,
): MaterialConversion | null {
  if (from === to) return null;
  if (!isNumericType(from) || !isNumericType(to)) return null;
  return { from, to };
}

export type GenericResolution =
  | { ok: true; type: MaterialValueType }
  | { ok: false; conflict: [MaterialValueType, MaterialValueType] };

/**
 * Resolve one generic pin group from the types actually wired into it.
 * The group takes the widest numeric input, independently of connection order.
 */
export function resolveGenericType(
  connected: readonly MaterialValueType[],
): GenericResolution {
  let resolved: MaterialValueType = "float";
  for (const type of connected) {
    if (!isNumericType(type)) {
      return { ok: false, conflict: [resolved, type] };
    }
    if (componentCount(type) > componentCount(resolved)) {
      resolved = type;
    }
  }
  return { ok: true, type: resolved };
}
