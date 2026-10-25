import { declaredValueUnit, type GraphClassMember } from "@haptic/core";
import type { PinListRow } from "@haptic/editor-kit";
import { defaultValueForMember } from "@haptic/scripting";
import type { typeSchemasFromGraphAssets } from "../lib/logic-graph-document";

/**
 * Saved member pins carry no ids, so their rows get positional ids. The rows
 * the Inspector last committed keep their editor ids while the saved pins
 * still match that commit, so a moved or added pin stays selected instead of
 * the selection staying on its old position.
 */
export type CommittedPinRowIds = {
  ownerId: string;
  pins: string;
  in: string[];
  out: string[];
};

export function committedPinRowIds(
  ownerId: string,
  pins: GraphClassMember["pins"],
  inputs: readonly PinListRow[],
  outputs: readonly PinListRow[],
): CommittedPinRowIds {
  return {
    ownerId,
    pins: JSON.stringify(pins ?? []),
    in: inputs.map((row) => row.id),
    out: outputs.map((row) => row.id),
  };
}

export function pinRowIdsFor(
  committed: CommittedPinRowIds | null,
  ownerId: string,
  pins: GraphClassMember["pins"],
  direction: "in" | "out",
): readonly string[] | undefined {
  return committed?.ownerId === ownerId && committed.pins === JSON.stringify(pins ?? [])
    ? committed[direction]
    : undefined;
}

export function memberPinRows(
  pins: GraphClassMember["pins"],
  memberId: string,
  direction: "in" | "out",
  ids?: readonly string[],
): PinListRow[] {
  return (pins ?? [])
    .filter((pin) => pin.direction === direction)
    .map((pin, index) => ({
      id: ids?.[index] ?? `${memberId}-${direction}-${index}`,
      name: pin.name,
      type: pin.typeId,
      ...(pin.container ? { container: pin.container } : {}),
      ...(pin.typeClassId ? { typeClassId: pin.typeClassId } : {}),
      ...(pin.unit ? { unit: pin.unit } : {}),
    }));
}

export function memberPinsFromRows(
  inputs: PinListRow[],
  outputs: PinListRow[],
): NonNullable<GraphClassMember["pins"]> {
  const toPin = (row: PinListRow, direction: "in" | "out") => {
    const pin: NonNullable<GraphClassMember["pins"]>[number] = {
      name: row.name,
      typeId: String(row.type),
      direction,
    };
    if (row.container && row.container !== "single") pin.container = row.container;
    if (row.typeClassId?.trim()) pin.typeClassId = row.typeClassId.trim();
    const unit = declaredValueUnit(pin.typeId, row.unit);
    if (unit) pin.unit = unit;
    return pin;
  };
  return [
    ...inputs.map((row) => toPin(row, "in")),
    ...outputs.map((row) => toPin(row, "out")),
  ];
}

export function variableContainerOf(
  member: GraphClassMember,
): "single" | "array" | "map" {
  return member.container === "array" || member.container === "map"
    ? member.container
    : "single";
}

export function defaultValueForVariableType(
  spec: {
    typeId: string;
    typeClassId?: string;
    container: "single" | "array" | "map";
  },
  schemas: ReturnType<typeof typeSchemasFromGraphAssets>,
): unknown {
  if (spec.container === "array" || spec.container === "map") return [];
  if (
    spec.typeId === "object" ||
    spec.typeId === "wildcard"
  ) {
    return undefined;
  }
  if (spec.typeId === "class") return spec.typeClassId ?? "Object";
  return defaultValueForMember(spec.typeId, spec.typeClassId, schemas);
}

export function seedVariableEntry(
  typeId: string,
  typeClassId: string | undefined,
  schemas: ReturnType<typeof typeSchemasFromGraphAssets>,
): unknown {
  if (typeId === "object" || typeId === "wildcard") {
    return null;
  }
  return defaultValueForMember(typeId, typeClassId, schemas);
}

export function asArrayDefaults(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

export function constrainedTypeClassId(
  typeId: string,
  typeClassId?: string,
): string | undefined {
  const trimmed = typeClassId?.trim();
  if (trimmed) return trimmed;
  if (typeId === "object" || typeId === "class") return "Object";
  return undefined;
}
