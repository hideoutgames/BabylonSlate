/**
 * Display units a user can give a number or vector declaration (Class
 * variable, Structure field, Blackboard key, function input). The stored
 * value is the short unit the editor's number fields show after the value
 * (`deg` shows as °); values themselves are never converted.
 */
export const VALUE_UNITS = [
  { value: "deg", label: "Degrees" },
  { value: "px", label: "Pixels" },
  { value: "%", label: "Percent" },
  { value: "ms", label: "Milliseconds" },
  { value: "s", label: "Seconds" },
  { value: "/s", label: "Per Second" },
] as const;

export type ValueUnit = (typeof VALUE_UNITS)[number]["value"];

const UNIT_VALUES = new Set<string>(VALUE_UNITS.map((unit) => unit.value));

/** Type ids a unit can describe; containers of these carry it onto each item. */
const UNIT_TYPES = new Set(["int", "float", "vec2", "vec3", "vec4"]);

/** A known unit, or undefined for none or an unknown one. */
export function normalizeValueUnit(value: unknown): ValueUnit | undefined {
  return typeof value === "string" && UNIT_VALUES.has(value) ? (value as ValueUnit) : undefined;
}

export function typeAcceptsUnit(typeId: string | undefined): boolean {
  return typeId !== undefined && UNIT_TYPES.has(typeId);
}

/** The unit a declaration of `typeId` shows: its own when the type takes one. */
export function declaredValueUnit(typeId: string | undefined, unit: unknown): ValueUnit | undefined {
  return typeAcceptsUnit(typeId) ? normalizeValueUnit(unit) : undefined;
}
