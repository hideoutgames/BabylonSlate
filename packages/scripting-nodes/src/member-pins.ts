import {
  pin,
  BOOL,
  EXEC,
  FLOAT,
  INT,
  STRING,
  VEC2,
  VEC3,
  objectRef,
  type PinType,
} from "@babylonslate/scripting";

export type MemberPinRow = {
  name?: string;
  typeId?: string;
  direction?: string;
};

export function jsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function pinTypeForMember(typeId: string | undefined): PinType {
  switch (typeId) {
    case "exec":
      return EXEC;
    case "bool":
      return BOOL;
    case "int":
      return INT;
    case "string":
    case "enum":
      return STRING;
    case "vec2":
      return VEC2;
    case "vec3":
      return VEC3;
    case "object":
      return objectRef("BObject");
    default:
      return FLOAT;
  }
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
    return [pin(row.name, row.name, direction, pinTypeForMember(row.typeId))];
  });
}
