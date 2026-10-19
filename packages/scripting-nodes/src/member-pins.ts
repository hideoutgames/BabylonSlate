import {
  pin,
  defaultValueLiteral,
  objectRef,
  pinTypeForVariable,
  type GraphPin,
  type PinType,
} from "@babylonslate/scripting";
import { mapDefaultLiteral } from "@babylonslate/core";
import { selfPin, subject } from "./self-pin";

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
  container?: string;
  keyTypeId?: string;
  keyTypeClassId?: string;
};

/**
 * Target of a member Call node. A member of the graph's own class (implicitSelf)
 * reads Self while the pin is unwired, so another instance can be wired in;
 * a member of another class needs the object to be wired.
 */
export function memberTargetPin(
  properties: Record<string, unknown>,
  name: string,
  classId: string,
): GraphPin {
  return properties.implicitSelf === true
    ? selfPin("target", name, objectRef(classId))
    : subject(pin("target", name, "in", objectRef(classId)));
}

export function jsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Function-local ident so authored names cannot collide with `ctx`. */
export function localVariableIdent(name: string): string {
  return `__lv_${jsIdent(name)}`;
}

/**
 * Property key for an object literal or destructuring pattern. `__proto__`
 * is computed, because a plain or quoted `__proto__` key in a literal sets
 * the prototype instead of storing a field.
 */
export function objectLiteralKey(name: string): string {
  if (name === "__proto__") return `[${JSON.stringify(name)}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Statement assigning a call's returned fields to output slots. A field the
 * result omits keeps the output type's default instead of `undefined`.
 */
export function assignResultFields(
  outputs: ReadonlyArray<{ key: string; slot: string; type: PinType }>,
  call: string,
): string {
  const fields = outputs
    .map((output) => `${objectLiteralKey(output.key)}: ${output.slot} = ${defaultValueLiteral(output.type)}`)
    .join(", ");
  return `({ ${fields} } = ${call} ?? {});`;
}

export function memberPinRows(properties: Record<string, unknown>): MemberPinRow[] {
  return Array.isArray(properties.pins)
    ? (properties.pins as MemberPinRow[])
    : [];
}

/** Fixed pins on member event entry and Call Parent nodes. */
export const EXEC_PIN_IDS: ReadonlySet<string> = new Set(["execIn", "execOut"]);
/** Fixed pins on member Call nodes; an argument may not take the Target pin's id. */
export const CALL_PIN_IDS: ReadonlySet<string> = new Set([
  "execIn",
  "execOut",
  "target",
]);

/**
 * Pin id for a signature row. The row name stays the display name and the
 * argument key. A name equal to one of the node's fixed pin ids gets a suffix,
 * so an argument called `target` cannot share the Target pin's id.
 */
export function memberArgPinId(
  name: string,
  fixedIds: ReadonlySet<string>,
): string {
  return fixedIds.has(name) ? `${name}__arg` : name;
}

export function dataMemberPins(
  properties: Record<string, unknown>,
  direction: "in" | "out",
  fixedIds: ReadonlySet<string>,
) {
  return memberPinRows(properties).flatMap((row) => {
    if (!row || typeof row.name !== "string" || row.name.length === 0) {
      return [];
    }
    if (row.typeId === "exec") return [];
    return [
      pin(
        memberArgPinId(row.name, fixedIds),
        row.name,
        direction,
        pinTypeForVariable(row),
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
