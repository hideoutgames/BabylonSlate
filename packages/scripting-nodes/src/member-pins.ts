import {
  pin,
  defaultValueLiteral,
  pinTypeForMember,
  pinTypeForVariable,
} from "@babylonslate/scripting";
import { mapDefaultLiteral } from "@babylonslate/core";

export {
  pinTypeForMember,
  pinTypeForVariable,
  typeIdFromPinType,
  typeClassIdFromPinType,
  keepsTypeClassId,
  isStructOrEnumTypeId,
  normalizeVariableContainer,
  variableTypeFromPinType,
} from "@babylonslate/scripting";

export type MemberPinRow = {
  name?: string;
  typeId?: string;
  typeClassId?: string;
  direction?: string;
};

export function jsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Function-local ident so authored names cannot collide with `ctx`. */
export function localVariableIdent(name: string): string {
  return `__lv_${jsIdent(name)}`;
}

export function objectLiteralKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export function memberPinRows(properties: Record<string, unknown>): MemberPinRow[] {
  return Array.isArray(properties.pins)
    ? (properties.pins as MemberPinRow[])
    : [];
}

export function dataMemberPins(
  properties: Record<string, unknown>,
  direction: "in" | "out",
) {
  return memberPinRows(properties).flatMap((row) => {
    if (!row || typeof row.name !== "string" || row.name.length === 0) {
      return [];
    }
    if (row.typeId === "exec") return [];
    return [
      pin(
        row.name,
        row.name,
        direction,
        pinTypeForMember(row.typeId, row.typeClassId),
      ),
    ];
  });
}

export function localVariablePreamble(
  locals: ReadonlyArray<{
    name: string;
    typeId?: string;
    typeClassId?: string;
    container?: string;
    keyTypeId?: string;
    keyTypeClassId?: string;
    defaultValue?: unknown;
  }>,
): string[] {
  return locals.map((local) => {
    const ident = localVariableIdent(local.name);
    const type = pinTypeForVariable({
      typeId: local.typeId,
      typeClassId: local.typeClassId,
      container: local.container,
      keyTypeId: local.keyTypeId,
      keyTypeClassId: local.keyTypeClassId,
    });
    const value =
      type.kind === "map"
        ? mapDefaultLiteral(local.defaultValue)
        : local.defaultValue !== undefined
          ? JSON.stringify(local.defaultValue)
          : defaultValueLiteral(type);
    return `  let ${ident} = ${value};`;
  });
}
