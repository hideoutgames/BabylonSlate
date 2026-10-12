import { hardLoadingProperty, type DataFieldSnapshot } from "@babylonslate/core";
import type { StructField } from "./type-assets";
import type { TypeSchemas } from "./type-defaults";

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (field: Pick<StructField, "id" | "name">): string => field.id || `legacy:${field.name}`;

export function defaultFieldSnapshot(field: StructField): DataFieldSnapshot {
  return {
    id: identity(field), name: field.name, typeId: field.typeId,
    ...(field.typeClassId ? { typeClassId: field.typeClassId } : {}),
    ...(field.container ? { container: field.container } : {}),
    ...(field.keyTypeId ? { keyTypeId: field.keyTypeId } : {}),
    ...(field.keyTypeClassId ? { keyTypeClassId: field.keyTypeClassId } : {}),
    ...hardLoadingProperty(field),
  };
}

function sameType(field: StructField, previous: DataFieldSnapshot): boolean {
  return field.typeId === previous.typeId && (field.typeClassId || "") === (previous.typeClassId || "") &&
    (field.container || "single") === (previous.container || "single") &&
    (field.container !== "map" || ((field.keyTypeId || "string") === (previous.keyTypeId || "string") &&
      (field.keyTypeClassId || "") === (previous.keyTypeClassId || "")));
}

/** One collection snapshot must retain the metadata used by every occupied item. */
function mergeFields(left: readonly DataFieldSnapshot[] = [], right: readonly DataFieldSnapshot[] = [], authored: readonly DataFieldSnapshot[] = []): DataFieldSnapshot[] {
  const result = new Map(left.map(field => [identity(field), field]));
  const original = new Map(authored.map(field => [identity(field), field]));
  for (const field of right) {
    const previous = result.get(identity(field));
    const retained = previous && !sameType(previous, field) ? original.get(identity(field)) ?? previous : previous;
    result.set(identity(field), previous ? {
      ...retained!, name: previous.name,
      ...(previous.fields || field.fields ? { fields: mergeFields(previous.fields, field.fields, original.get(identity(field))?.fields) } : {}),
      ...(previous.keyFields || field.keyFields ? { keyFields: mergeFields(previous.keyFields, field.keyFields, original.get(identity(field))?.keyFields) } : {}),
    } : field);
  }
  return [...result.values()];
}

type Projection = { value: unknown; snapshot: DataFieldSnapshot; conflict: boolean };

/**
 * Project stored defaults using their authored identities, without adding defaults
 * or dropping retained values. Kept below type-defaults to avoid a dependency cycle.
 */
export function projectStoredDataDefault(
  field: StructField, value: unknown, schemas?: TypeSchemas,
  previous: DataFieldSnapshot | undefined = field as StructField & DataFieldSnapshot,
  depth = 0,
): Projection {
  const original = previous ? {
    ...defaultFieldSnapshot(previous),
    ...(previous.fields ? { fields: previous.fields } : {}),
    ...(previous.keyFields ? { keyFields: previous.keyFields } : {}),
  } : defaultFieldSnapshot(field);
  const snapshot = defaultFieldSnapshot(field);
  if (depth > 64) return { value, snapshot: original, conflict: true };
  if (previous && !sameType(field, previous)) {
    return { value, snapshot: { ...previous, name: field.name, id: identity(field) }, conflict: false };
  }
  if (field.container === "array" || field.container === "map") {
    if (!Array.isArray(value)) return { value, snapshot: original, conflict: false };
    let conflict = false;
    const scalar = { ...field, container: "single" as const };
    const scalarPrevious = previous ? { ...previous, container: "single" as const } : undefined;
    const projected = value.map(item => {
      if (field.container === "array") {
        const result = projectStoredDataDefault(scalar, item, schemas, scalarPrevious, depth + 1);
        conflict ||= result.conflict;
        if (result.snapshot.fields) snapshot.fields = mergeFields(snapshot.fields, result.snapshot.fields, previous?.fields);
        return result.value;
      }
      if (!record(item) || !own(item, "key") || !own(item, "value")) return item;
      const keyField = { name: "key", typeId: field.keyTypeId || "string", typeClassId: field.keyTypeClassId };
      const key = projectStoredDataDefault(keyField, item.key, schemas,
        previous ? { ...keyField, fields: previous.keyFields } : undefined, depth + 1);
      const entry = projectStoredDataDefault(scalar, item.value, schemas, scalarPrevious, depth + 1);
      conflict ||= key.conflict || entry.conflict;
      if (key.snapshot.fields) snapshot.keyFields = mergeFields(snapshot.keyFields, key.snapshot.fields, previous?.keyFields);
      if (entry.snapshot.fields) snapshot.fields = mergeFields(snapshot.fields, entry.snapshot.fields, previous?.fields);
      return { ...item, key: key.value, value: entry.value };
    });
    return conflict ? { value, snapshot: original, conflict } : { value: projected, snapshot, conflict };
  }
  const nested = field.typeId === "struct" && field.typeClassId && schemas?.structs && own(schemas.structs, field.typeClassId)
    ? schemas.structs[field.typeClassId] : undefined;
  if (!nested || !record(value)) return { value, snapshot: { ...snapshot, ...(previous?.fields ? { fields: previous.fields } : {}) }, conflict: false };
  const before = previous?.fields ?? [];
  const byId = new Map(before.map(item => [identity(item), item]));
  const byName = new Map(before.map(item => [item.name, item]));
  const sources = nested.fields.map(item => {
    const old = byId.get(identity(item));
    const sameName = byName.get(item.name);
    const source = old && own(value, old.name) ? old.name :
      (!sameName || identity(sameName) === identity(item)) && own(value, item.name) ? item.name : undefined;
    return { field: item, old, source };
  });
  const consumed = new Set(sources.flatMap(item => item.source === undefined ? [] : [item.source]));
  let conflict = byId.size !== before.length || byName.size !== before.length ||
    new Set(nested.fields.map(identity)).size !== nested.fields.length ||
    new Set(nested.fields.map(item => item.name)).size !== nested.fields.length;
  const projected = { ...value };
  const names = new Set(nested.fields.map(item => item.name));
  const fields: DataFieldSnapshot[] = [];
  for (const { field: item, old, source } of sources) {
    if (source !== item.name && own(value, item.name) && !consumed.has(item.name)) conflict = true;
    if (source === undefined) { fields.push(defaultFieldSnapshot(item)); continue; }
    const result = projectStoredDataDefault(item, value[source], schemas, old, depth + 1);
    conflict ||= result.conflict;
    fields.push(result.snapshot);
    if (source !== item.name && !names.has(source)) delete projected[source];
    Object.defineProperty(projected, item.name, { value: result.value, enumerable: true, writable: true, configurable: true });
  }
  const ids = new Set(fields.map(identity));
  for (const old of before) if (!consumed.has(old.name) && own(value, old.name) && !ids.has(identity(old)) && !names.has(old.name)) fields.push(old);
  return conflict ? { value, snapshot: original, conflict } : { value: projected, snapshot: { ...snapshot, fields }, conflict };
}
