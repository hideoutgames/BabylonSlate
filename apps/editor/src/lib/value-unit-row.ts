import { VALUE_UNITS, normalizeValueUnit, typeAcceptsUnit } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";

const NO_UNIT = "none";

/**
 * Unit row for a number or vector declaration (Class variable, Structure
 * field, Blackboard key); null for types that take no unit. The unit only
 * changes how values are shown.
 */
export function valueUnitRow(
  id: string,
  typeId: string | undefined,
  unit: unknown,
  onChange: (unit: string | undefined) => void,
): PropertyRow | null {
  if (!typeAcceptsUnit(typeId)) return null;
  return {
    kind: "enum",
    id,
    label: "Unit",
    value: normalizeValueUnit(unit) ?? NO_UNIT,
    options: [{ value: NO_UNIT, label: "None" }, ...VALUE_UNITS.map((entry) => ({ value: entry.value, label: entry.label }))],
    onChange: (next) => onChange(normalizeValueUnit(next)),
  };
}

/** Patch that drops a unit the new type cannot show. */
export function unitPatchForType(typeId: string): { unit?: undefined } {
  return typeAcceptsUnit(typeId) ? {} : { unit: undefined };
}
