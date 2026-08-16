import {
  pin,
  BOOL,
  EXEC,
  FLOAT,
  INT,
  STRING,
  VEC2,
  VEC3,
  classRef,
  defaultValueLiteral,
  enumRef,
  objectRef,
  structRef,
  type PinType,
} from "@babylonslate/scripting";

export type MemberPinRow = {
  name?: string;
  typeId?: string;
  typeClassId?: string;
  direction?: string;
};

function constraintClassId(typeClassId?: string): string {
  const trimmed = typeClassId?.trim();
  return trimmed ? trimmed : "BObject";
}

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

export function pinTypeForMember(
  typeId: string | undefined,
  typeClassId?: string,
): PinType {
  switch (typeId) {
    case "exec":
      return EXEC;
    case "bool":
      return BOOL;
    case "int":
      return INT;
    case "string":
      return STRING;
    case "vec2":
      return VEC2;
    case "vec3":
      return VEC3;
    case "object":
      return objectRef(constraintClassId(typeClassId));
    case "class":
      return classRef(constraintClassId(typeClassId));
    case "struct":
      return structRef("");
    case "enum":
      return enumRef("");
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
    defaultValue?: unknown;
  }>,
): string[] {
  return locals.map((local) => {
    const ident = localVariableIdent(local.name);
    const value =
      local.defaultValue !== undefined
        ? JSON.stringify(local.defaultValue)
        : defaultValueLiteral(pinTypeForMember(local.typeId, local.typeClassId));
    return `  let ${ident} = ${value};`;
  });
}
