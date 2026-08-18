import { defaultJsValue } from "./pin-defaults";
import type { PinType } from "./types";
import { pinTypeForMember } from "./member-pin-type";
import { ENGINE_ENUMS, ENGINE_STRUCTS } from "./engine-types";
import type { EnumMember, StructField } from "./type-assets";

export type EnumSchema = {
  name: string;
  members: EnumMember[];
};

export type StructSchema = {
  name: string;
  fields: StructField[];
};

export type TypeSchemas = {
  enums: Readonly<Record<string, EnumSchema>>;
  structs: Readonly<Record<string, StructSchema>>;
};

export function emptyTypeSchemas(): TypeSchemas {
  return { enums: {}, structs: {} };
}

export function mergeEngineTypeSchemas(
  project?: Partial<TypeSchemas>,
): TypeSchemas {
  const enums: Record<string, EnumSchema> = { ...(project?.enums ?? {}) };
  const structs: Record<string, StructSchema> = { ...(project?.structs ?? {}) };
  for (const entry of ENGINE_ENUMS) {
    enums[entry.id] = { name: entry.name, members: entry.members };
  }
  for (const entry of ENGINE_STRUCTS) {
    structs[entry.id] = { name: entry.name, fields: entry.fields };
  }
  return { enums, structs };
}

export function knownGuidsFromSchemas(schemas: TypeSchemas): Set<string> {
  return new Set([...Object.keys(schemas.enums), ...Object.keys(schemas.structs)]);
}

export function firstEnumMemberName(schema: EnumSchema | undefined): string {
  const name = schema?.members.find((member) => member.name.trim())?.name;
  return name ?? "";
}

export function defaultValueForPinType(
  type: PinType,
  schemas?: TypeSchemas,
): unknown {
  if (type.kind === "enumRef") {
    const schema = type.guid ? schemas?.enums[type.guid] : undefined;
    const first = firstEnumMemberName(schema);
    return first || defaultJsValue(type);
  }
  if (type.kind === "structRef") {
    const schema = type.guid ? schemas?.structs[type.guid] : undefined;
    if (!schema) return {};
    return structInstanceDefault(schema.fields, schemas, new Set([type.guid]));
  }
  return defaultJsValue(type);
}

export function defaultValueForMember(
  typeId: string | undefined,
  typeClassId?: string,
  schemas?: TypeSchemas,
): unknown {
  return defaultValueForPinType(pinTypeForMember(typeId, typeClassId), schemas);
}

export function structInstanceDefault(
  fields: readonly StructField[],
  schemas?: TypeSchemas,
  visiting: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.name) continue;
    result[field.name] = defaultValueForStructField(field, schemas, visiting);
  }
  return result;
}

function defaultValueForStructField(
  field: StructField,
  schemas: TypeSchemas | undefined,
  visiting: ReadonlySet<string>,
): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  const type = pinTypeForMember(field.typeId, field.typeClassId);
  if (type.kind === "structRef" && type.guid) {
    if (visiting.has(type.guid)) return {};
    const nested = schemas?.structs[type.guid];
    if (!nested) return {};
    const next = new Set(visiting);
    next.add(type.guid);
    return structInstanceDefault(nested.fields, schemas, next);
  }
  return defaultValueForPinType(type, schemas);
}

export function hydrateStructInstance(
  fields: readonly StructField[],
  value: unknown,
  schemas?: TypeSchemas,
): Record<string, unknown> {
  const authored =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const defaults = structInstanceDefault(fields, schemas);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.name) continue;
    if (Object.prototype.hasOwnProperty.call(authored, field.name)) {
      const type = pinTypeForMember(field.typeId, field.typeClassId);
      if (type.kind === "structRef") {
        const nested = type.guid ? schemas?.structs[type.guid] : undefined;
        result[field.name] = nested
          ? hydrateStructInstance(nested.fields, authored[field.name], schemas)
          : authored[field.name];
      } else {
        result[field.name] = authored[field.name];
      }
    } else {
      result[field.name] = defaults[field.name];
    }
  }
  return result;
}
