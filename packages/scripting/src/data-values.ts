import {
  createDataObjectAsset,
  type DataFieldSnapshot,
  type DataObjectAsset,
} from "@babylonslate/core";
import type { StructField } from "./type-assets";
import { structInstanceDefault, type StructSchema, type TypeSchemas } from "./type-defaults";
import { ENGINE_STRUCTS } from "./engine-types";

export interface DataValidationIssue {
  code: string;
  severity: "error" | "warning";
  /** Dot-separated field names, or an empty string for the whole asset. */
  path: string;
  message: string;
}

export interface DataValidationOptions {
  /** Supply a project registry lookup to also validate asset existence and kind. */
  assetTypeForGuid?: (guid: string) => string | null | undefined;
}

export interface DataSchemaChange {
  kind: "added" | "renamed" | "removed" | "typeChanged";
  path: string;
  previousPath?: string;
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fieldPath = (parent: string, name: string): string => parent ? `${parent}.${name}` : name;
function schemaEntry<T>(entries: Readonly<Record<string, T>> | undefined, guid: string | undefined | null): T | undefined {
  return entries && guid && own(entries, guid) ? entries[guid] : undefined;
}
const engineStructures = new Map(ENGINE_STRUCTS.map((entry) => [entry.id, entry]));
function structureSchema(schemas: TypeSchemas | undefined, guid: string | null | undefined): StructSchema | undefined {
  return guid ? engineStructures.get(guid) ?? schemaEntry(schemas?.structs, guid) : undefined;
}

function mapKeyField(field: StructField): StructField {
  return { name: "key", typeId: field.keyTypeId || "string", typeClassId: field.keyTypeClassId };
}

function scalarField(field: StructField): StructField {
  return { ...field, container: "single" };
}

/** Legacy IDs derive from the original name; editors persist them before renaming. */
export function dataFieldIdentity(field: Pick<StructField, "id" | "name">): string {
  return field.id || `legacy:${field.name}`;
}

export function snapshotDataFields(
  fields: readonly StructField[],
  schemas?: TypeSchemas,
  visiting: ReadonlySet<string> = new Set(),
): DataFieldSnapshot[] {
  if (visiting.size > 64) return [];
  return fields.map((field) => {
    const nested = field.typeId === "struct" && field.typeClassId &&
      !visiting.has(field.typeClassId) ? structureSchema(schemas, field.typeClassId) : undefined;
    const keyNested = field.container === "map" && field.keyTypeId === "struct" && field.keyTypeClassId &&
      !visiting.has(field.keyTypeClassId) ? structureSchema(schemas, field.keyTypeClassId) : undefined;
    return {
      id: dataFieldIdentity(field),
      name: field.name,
      typeId: field.typeId,
      ...(field.typeClassId ? { typeClassId: field.typeClassId } : {}),
      ...(field.container ? { container: field.container } : {}),
      ...(field.keyTypeId ? { keyTypeId: field.keyTypeId } : {}),
      ...(field.keyTypeClassId ? { keyTypeClassId: field.keyTypeClassId } : {}),
      ...(nested ? {
        fields: snapshotDataFields(nested.fields, schemas, new Set([...visiting, field.typeClassId!])),
      } : {}),
      ...(keyNested ? {
        keyFields: snapshotDataFields(keyNested.fields, schemas, new Set([...visiting, field.keyTypeClassId!])),
      } : {}),
    };
  });
}

/** Defaults are copied once; later schema default edits never change this record. */
export function createDataObjectForStructure(
  structureGuid: string,
  fields: readonly StructField[],
  schemas?: TypeSchemas,
): DataObjectAsset {
  return createDataObjectAsset(
    structureGuid,
    serializeDataObjectValues(structInstanceDefault(fields, schemas, new Set([structureGuid])), fields, schemas),
    snapshotDataFields(fields, schemas, new Set([structureGuid])),
  );
}

function issue(
  issues: DataValidationIssue[], code: string, path: string, message: string,
  severity: DataValidationIssue["severity"] = "error",
): void {
  issues.push({ code, path, message, severity });
}

/** Reject values that JSON persistence would discard, coerce, or fail to write. */
function validateSerializable(
  value: unknown, issues: DataValidationIssue[], path: string,
  visiting = new Set<object>(), depth = 0,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || depth > 64 || visiting.has(value)) {
    issue(issues, "invalid-value", path, "Value must be finite, acyclic JSON data (at most 64 levels deep).");
    return;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    issue(issues, "invalid-value", path, "Value must be plain JSON data.");
    return;
  }
  let sparseArray = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!own(value, String(index))) { sparseArray = true; break; }
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0 || sparseArray) {
    issue(issues, "invalid-value", path, "Value contains entries that JSON cannot preserve.");
  }
  visiting.add(value);
  for (const [key, entry] of Object.entries(value)) validateSerializable(entry, issues, fieldPath(path, key), visiting, depth + 1);
  visiting.delete(value);
}

type FieldSource = { field: StructField; previous?: DataFieldSnapshot; source?: string };

function fieldSources(
  fields: readonly StructField[], snapshot: readonly DataFieldSnapshot[],
  values: Record<string, unknown>, issues: DataValidationIssue[], path: string,
): FieldSource[] {
  const names = new Set<string>();
  const ids = new Set<string>();
  const previousById = new Map(snapshot.map((field) => [dataFieldIdentity(field), field]));
  const previousByName = new Map(snapshot.map((field) => [field.name, field]));
  const seenSnapshotIds = new Set<string>();
  const seenSnapshotNames = new Set<string>();
  for (const field of snapshot) {
    const id = dataFieldIdentity(field);
    if (seenSnapshotIds.has(id) || seenSnapshotNames.has(field.name)) {
      issue(issues, "ambiguous-schema", path, "Stored field identities are ambiguous; repair the schema before reconciling.");
    }
    seenSnapshotIds.add(id);
    seenSnapshotNames.add(field.name);
  }
  return fields.map((field) => {
    const id = dataFieldIdentity(field);
    const at = fieldPath(path, field.name);
    if (!field.name.trim() || names.has(field.name) || ids.has(id)) {
      issue(issues, "invalid-schema", at, "Structure fields need unique, non-empty names and identities.");
    }
    names.add(field.name);
    ids.add(id);
    const previous = previousById.get(id);
    const sameName = previousByName.get(field.name);
    // Never assign an old field's value to a new field which reused its name.
    const source = previous && own(values, previous.name) ? previous.name :
      (!sameName || dataFieldIdentity(sameName) === id) && own(values, field.name) ? field.name : undefined;
    return { field, previous, source };
  });
}

function sameFieldType(a: StructField, b: DataFieldSnapshot): boolean {
  return a.typeId === b.typeId && (a.typeClassId || "") === (b.typeClassId || "") &&
    (a.container || "single") === (b.container || "single") &&
    (a.container !== "map" || ((a.keyTypeId || "string") === (b.keyTypeId || "string") &&
      (a.keyTypeClassId || "") === (b.keyTypeClassId || "")));
}

function validateFieldValue(
  field: StructField, value: unknown, schemas: TypeSchemas,
  issues: DataValidationIssue[], path: string, options: DataValidationOptions,
): void {
  const numeric = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  const components = (v: unknown, keys: readonly string[]): boolean => record(v) && keys.every((key) => own(v, key) && numeric(v[key]));
  let valid = true;
  switch (field.typeId) {
    case "float": valid = numeric(value); break;
    case "int": valid = typeof value === "number" && Number.isSafeInteger(value); break;
    case "tag": valid = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff; break;
    case "bool": valid = typeof value === "boolean"; break;
    case "string": valid = typeof value === "string"; break;
    case "vec2": valid = components(value, ["x", "y"]); break;
    case "vec3": valid = components(value, ["x", "y", "z"]); break;
    case "vec4":
    case "color": valid = components(value, ["x", "y", "z", "w"]); break;
    case "quat": valid = components(value, ["x", "y", "z", "w"]) && record(value) &&
      [value.x, value.y, value.z, value.w].some((component) => component !== 0); break;
    case "rotator": valid = components(value, ["pitch", "yaw", "roll"]); break;
    case "transform": valid = record(value) && components(value.position, ["x", "y", "z"]) &&
      components(value.rotation, ["x", "y", "z", "w"]) && components(value.scale, ["x", "y", "z"]); break;
    case "enum": {
      const schema = schemaEntry(schemas.enums, field.typeClassId);
      if (!schema) issue(issues, "missing-enum", path, "Choose an existing Enum for this field.");
      else valid = typeof value === "string" && schema.members.some((member) => member.name === value);
      break;
    }
    case "class": valid = typeof value === "string"; break;
    case "asset": {
      valid = typeof value === "string";
      if (valid && value && options.assetTypeForGuid) {
        const actual = options.assetTypeForGuid(value as string);
        if (!actual) issue(issues, "missing-asset", path, "Referenced asset no longer exists.");
        else if (field.typeClassId && actual !== field.typeClassId &&
          !(field.typeClassId === "Texture" && actual === "RenderTargetTexture") &&
          !(field.typeClassId === "Material" && actual === "MaterialInstance")) {
          issue(issues, "asset-type", path, `Expected a ${field.typeClassId} asset; found ${actual}.`);
        }
      }
      break;
    }
    case "struct": valid = record(value); break;
    // Data assets cannot retain references to live scene/runtime instances.
    case "object":
    case "actor": valid = value === null; break;
    case "wildcard": break;
    default: issue(issues, "unsupported-type", path, `Unsupported data field type: ${field.typeId}.`); return;
  }
  if (!valid) issue(issues, "type-mismatch", path, `Value does not match ${field.typeId}${field.typeClassId ? ` (${field.typeClassId})` : ""}.`);
}

/** Convert typed runtime Maps to portable entries before authoring/validation. */
export function serializeDataObjectValues(
  values: Record<string, unknown>, fields: readonly StructField[], schemas?: TypeSchemas,
): Record<string, unknown> {
  const plain = (value: unknown): value is Record<string, unknown> => record(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const visit = (field: StructField, value: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error("Nested Structure data exceeds 64 levels.");
    if (field.container === "array") return Array.isArray(value) ? value.map((item) => visit(scalarField(field), item, depth + 1)) : value;
    if (field.container === "map") {
      const entries: unknown = value instanceof Map ? [...value].map(([key, item]) => ({ key, value: item })) : value;
      return Array.isArray(entries) ? entries.map((entry) => plain(entry) && own(entry, "key") && own(entry, "value") ? {
        ...entry, key: visit(mapKeyField(field), entry.key, depth + 1), value: visit(scalarField(field), entry.value, depth + 1),
      } : entry) : value;
    }
    const nested = field.typeId === "struct" ? structureSchema(schemas, field.typeClassId) : undefined;
    return nested && plain(value) ? visitFields(value, nested.fields, depth + 1) : value;
  };
  const visitFields = (source: Record<string, unknown>, schema: readonly StructField[], depth: number): Record<string, unknown> => {
    const result = { ...source };
    for (const field of schema) if (own(source, field.name)) {
      Object.defineProperty(result, field.name, { value: visit(field, source[field.name], depth), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return structuredClone(visitFields(values, fields, 0));
}

function projectFieldValue(
  field: StructField, previous: DataFieldSnapshot | undefined, value: unknown,
  schemas: TypeSchemas, issues: DataValidationIssue[], options: DataValidationOptions,
  path: string, depth: number,
): unknown {
  if (depth > 64) {
    issue(issues, "recursive-schema", path, "Nested Structure data exceeds 64 levels.");
    return value;
  }
  if (field.container === "array" || field.container === "map") {
    if (!Array.isArray(value)) {
      issue(issues, "type-mismatch", path, `Expected ${field.container === "map" ? "Map entries" : "an array"}.`);
      return value;
    }
    const checkType = (element: StructField, at: string) => {
      if (element.typeId === "struct" && !structureSchema(schemas, element.typeClassId)) {
        issue(issues, "missing-structure", at, "Choose an existing Structure for this collection.");
      }
      if (element.typeId === "enum" && !schemaEntry(schemas.enums, element.typeClassId)) {
        issue(issues, "missing-enum", at, "Choose an existing Enum for this collection.");
      }
    };
    checkType(field, path);
    if (field.container === "map") checkType(mapKeyField(field), fieldPath(path, "key"));
    if (field.container === "array") return value.map((item, index) =>
      projectFieldValue(scalarField(field), previous, item, schemas, issues, options, fieldPath(path, String(index)), depth + 1));
    const entries: [unknown, unknown][] = [];
    const keys = new Set<unknown>();
    for (const [index, entry] of value.entries()) {
      const at = fieldPath(path, String(index));
      if (!record(entry) || !own(entry, "key") || !own(entry, "value")) {
        issue(issues, "type-mismatch", at, "Map entries need a key and value.");
        continue;
      }
      const keyField = mapKeyField(field);
      const key = projectFieldValue(keyField, previous ? { ...keyField, fields: previous.keyFields } : undefined,
        entry.key, schemas, issues, options, fieldPath(at, "key"), depth + 1);
      if (keys.has(key)) issue(issues, "duplicate-key", fieldPath(at, "key"), "Map keys must be unique.");
      keys.add(key);
      const item = projectFieldValue(scalarField(field), previous, entry.value, schemas, issues, options, fieldPath(at, "value"), depth + 1);
      entries.push([key, item]);
    }
    return new Map(entries);
  }
  validateFieldValue(field, value, schemas, issues, path, options);
  if (field.typeId === "struct") {
    const nested = structureSchema(schemas, field.typeClassId);
    if (!nested) issue(issues, "missing-structure", path, "Choose an existing Structure for this field.");
    if (nested && record(value)) return projectFields(nested.fields, previous?.fields ?? [], value, schemas, issues, options, path, depth + 1);
  }
  return value;
}

function projectFields(
  fields: readonly StructField[], snapshot: readonly DataFieldSnapshot[], values: Record<string, unknown>,
  schemas: TypeSchemas, issues: DataValidationIssue[], options: DataValidationOptions,
  path = "", depth = 0,
): Record<string, unknown> {
  if (depth > 64) {
    issue(issues, "recursive-schema", path, "Nested Structure data exceeds 64 levels.");
    return {};
  }
  const entries: [string, unknown][] = [];
  const consumed = new Set<string>();
  const sources = fieldSources(fields, snapshot, values, issues, path);
  const sourceNames = new Set(sources.flatMap((entry) => entry.source === undefined ? [] : [entry.source]));
  for (const { field, previous, source } of sources) {
    const at = fieldPath(path, field.name);
    if (previous && !sameFieldType(field, previous)) issue(issues, "type-changed", at, "Structure field type changed; review the preserved value.", "warning");
    if (source === undefined) {
      issue(issues, "missing-field", at, "Field has no authored value; apply Structure changes or reset this field.");
      continue;
    }
    consumed.add(source);
    if (source !== field.name && own(values, field.name) && !sourceNames.has(field.name)) {
      issue(issues, "rename-conflict", at, "A retained value already uses the renamed field's name.");
    }
    if (source !== field.name) issue(issues, "renamed-field", at, `Field was renamed from ${source}; apply Structure changes to save the new name.`, "warning");
    entries.push([field.name, projectFieldValue(field, previous, values[source], schemas, issues, options, at, depth)]);
  }
  for (const key of Object.keys(values)) {
    if (!consumed.has(key)) issue(issues, "unknown-field", fieldPath(path, key), "Field is no longer in the Structure. Its stored value is preserved.", "warning");
  }
  return Object.fromEntries(entries);
}

function inspectDataObject(asset: DataObjectAsset, schemas: TypeSchemas, options: DataValidationOptions): {
  values: Record<string, unknown>; issues: DataValidationIssue[];
} {
  const issues: DataValidationIssue[] = [];
  if (!record(asset.values)) {
    issue(issues, "invalid-values", "", "Data Object values must be an object.");
    return { values: {}, issues };
  }
  validateSerializable(asset.values, issues, "");
  const structure = structureSchema(schemas, asset.structureGuid);
  if (!structure) {
    issue(issues, "missing-structure", "", "Choose an existing Structure for this Data Object.");
    return { values: {}, issues };
  }
  return { values: projectFields(structure.fields, asset.schema ?? [], asset.values, schemas, issues, options), issues };
}

export function validateDataObject(
  asset: DataObjectAsset, schemas: TypeSchemas, options: DataValidationOptions = {},
): DataValidationIssue[] {
  return inspectDataObject(asset, schemas, options).issues;
}

/** Detached, typed runtime value; invalid/missing authored fields fail explicitly. */
export function resolveDataObjectValues(asset: DataObjectAsset, schemas: TypeSchemas): Record<string, unknown> | null {
  const result = inspectDataObject(asset, schemas, {});
  return result.issues.some((entry) => entry.severity === "error") ? null : structuredClone(result.values);
}

/** A collection shares field metadata; retain orphan metadata found in any item. */
function mergeSnapshots(
  left: readonly DataFieldSnapshot[], right: readonly DataFieldSnapshot[], previous: readonly DataFieldSnapshot[],
): DataFieldSnapshot[] {
  const result = new Map(left.map((field) => [dataFieldIdentity(field), field]));
  const old = new Map(previous.map((field) => [dataFieldIdentity(field), field]));
  for (const field of right) {
    const id = dataFieldIdentity(field);
    const existing = result.get(id);
    if (!existing) { result.set(id, field); continue; }
    const retained = !sameFieldType(existing, field) ? old.get(id) ?? existing : existing;
    result.set(id, {
      ...retained,
      name: existing.name,
      ...(existing.id ? { id: existing.id } : {}),
      ...(existing.fields || field.fields ? { fields: mergeSnapshots(existing.fields ?? [], field.fields ?? [], old.get(id)?.fields ?? []) } : {}),
      ...(existing.keyFields || field.keyFields ? { keyFields: mergeSnapshots(existing.keyFields ?? [], field.keyFields ?? [], old.get(id)?.keyFields ?? []) } : {}),
    });
  }
  return [...result.values()];
}

function reconcileFieldValue(
  field: StructField, previous: DataFieldSnapshot | undefined, value: unknown,
  schemas: TypeSchemas | undefined, changes: DataSchemaChange[], issues: DataValidationIssue[],
  path: string, visiting: ReadonlySet<string>, depth: number,
): { value: unknown; fields?: DataFieldSnapshot[]; keyFields?: DataFieldSnapshot[] } {
  if (depth > 64) {
    issue(issues, "recursive-schema", path, "Nested Structure data exceeds 64 levels.");
    return { value };
  }
  if ((field.container === "array" || field.container === "map") && !Array.isArray(value)) {
    return { value, ...(previous?.fields ? { fields: previous.fields } : {}), ...(previous?.keyFields ? { keyFields: previous.keyFields } : {}) };
  }
  if (field.container === "array" && Array.isArray(value)) {
    let fields: DataFieldSnapshot[] | undefined;
    const result = value.map((entry, index) => {
      const item = reconcileFieldValue(scalarField(field), previous, entry, schemas, changes, issues,
        fieldPath(path, String(index)), visiting, depth + 1);
      if (item.fields) fields = fields ? mergeSnapshots(fields, item.fields, previous?.fields ?? []) : item.fields;
      return item.value;
    });
    return { value: result, ...(fields ? { fields } : {}) };
  }
  if (field.container === "map" && Array.isArray(value)) {
    let fields: DataFieldSnapshot[] | undefined;
    let keyFields: DataFieldSnapshot[] | undefined;
    const keyField = mapKeyField(field);
    const keyPrevious = previous ? { ...keyField, fields: previous.keyFields } : undefined;
    const result = value.map((entry, index) => {
      if (!record(entry) || !own(entry, "key") || !own(entry, "value")) return entry;
      const at = fieldPath(path, String(index));
      const key = reconcileFieldValue(keyField, keyPrevious, entry.key, schemas, changes, issues, fieldPath(at, "key"), visiting, depth + 1);
      const item = reconcileFieldValue(scalarField(field), previous, entry.value, schemas, changes, issues, fieldPath(at, "value"), visiting, depth + 1);
      if (key.fields) keyFields = keyFields ? mergeSnapshots(keyFields, key.fields, previous?.keyFields ?? []) : key.fields;
      if (item.fields) fields = fields ? mergeSnapshots(fields, item.fields, previous?.fields ?? []) : item.fields;
      return { ...entry, key: key.value, value: item.value };
    });
    return { value: result, ...(fields ? { fields } : {}), ...(keyFields ? { keyFields } : {}) };
  }
  const nested = field.typeId === "struct" ? structureSchema(schemas, field.typeClassId) : undefined;
  if (nested && record(value)) {
    const result = reconcileFields(nested.fields, previous?.fields ?? [], value, schemas, changes, issues, path,
      new Set([...visiting, field.typeClassId!]), depth + 1);
    return { value: result.values, fields: result.schema };
  }
  return { value };
}

function reconcileFields(
  fields: readonly StructField[], snapshot: readonly DataFieldSnapshot[], values: Record<string, unknown>,
  schemas: TypeSchemas | undefined, changes: DataSchemaChange[], issues: DataValidationIssue[],
  path: string, visiting: ReadonlySet<string>, depth: number,
): { values: Record<string, unknown>; schema: DataFieldSnapshot[] } {
  if (depth > 64) {
    issue(issues, "recursive-schema", path, "Nested Structure data exceeds 64 levels.");
    return { values, schema: [...snapshot] };
  }
  const sources = fieldSources(fields, snapshot, values, issues, path);
  const consumed = new Set(sources.flatMap((entry) => entry.source === undefined ? [] : [entry.source]));
  const result = { ...values };
  const schema = snapshotDataFields(fields, schemas, visiting);
  const currentNames = new Set(fields.map((field) => field.name));
  // Read from the original values throughout: simultaneous renames cannot clobber one another.
  for (const { source, field } of sources) {
    if (source !== undefined && source !== field.name && !currentNames.has(source)) delete result[source];
  }
  for (const [index, { field, previous, source }] of sources.entries()) {
    const at = fieldPath(path, field.name);
    if (previous && !sameFieldType(field, previous)) changes.push({ kind: "typeChanged", path: at });
    if (source !== field.name && own(values, field.name) && !consumed.has(field.name)) {
      issue(issues, "rename-conflict", at, "An existing retained value already uses this name. Resolve the conflict before applying Structure changes.");
      continue;
    }
    if (source === undefined) changes.push({ kind: "added", path: at });
    else if (source !== field.name) changes.push({ kind: "renamed", path: at, previousPath: fieldPath(path, source) });
    let value = source === undefined
      ? serializeDataObjectValues(structInstanceDefault([field], schemas, visiting), [field], schemas)[field.name]
      : values[source];
    // Only descend into compatible authored objects; never coerce an old field value.
    if (!previous || sameFieldType(field, previous)) {
      const reconciled = reconcileFieldValue(field, previous, value, schemas, changes, issues, at, visiting, depth);
      value = reconciled.value;
      if (reconciled.fields) schema[index]!.fields = reconciled.fields;
      if (reconciled.keyFields) schema[index]!.keyFields = reconciled.keyFields;
    }
    if (previous && !sameFieldType(field, previous)) {
      const validation: DataValidationIssue[] = [];
      const availableSchemas = schemas ?? { structs: {}, enums: {} };
      projectFieldValue(field, undefined, value, availableSchemas, validation, {}, at, depth);
      if (validation.some((entry) => entry.severity === "error")) {
        // Until repaired, retain the authored type so reference tracking still sees
        // assets inside an incompatible value. Renames still update its storage key.
        schema[index] = { ...previous, name: field.name, id: dataFieldIdentity(field) };
      }
    }
    Object.defineProperty(result, field.name, { value, enumerable: true, configurable: true, writable: true });
  }
  const previousByName = new Map(snapshot.map((field) => [field.name, field]));
  const snapshotNames = new Set(schema.map((field) => field.name));
  const snapshotIds = new Set(schema.map(dataFieldIdentity));
  for (const key of Object.keys(values)) {
    if (consumed.has(key)) continue;
    changes.push({ kind: "removed", path: fieldPath(path, key) });
    const old = previousByName.get(key);
    if (old && !snapshotNames.has(key) && !snapshotIds.has(dataFieldIdentity(old))) {
      schema.push(old);
      snapshotNames.add(key);
      snapshotIds.add(dataFieldIdentity(old));
    }
  }
  return { values: result, schema };
}

/**
 * Explicit schema migration preview. The caller chooses whether to save it.
 * Unknown/removed fields survive; type changes are reported without coercion.
 * Conflicts fail atomically, returning the original authored payload.
 */
export function reconcileDataObject(
  asset: DataObjectAsset, fields: readonly StructField[], schemas?: TypeSchemas,
): { asset: DataObjectAsset; changes: DataSchemaChange[]; issues: DataValidationIssue[] } {
  const changes: DataSchemaChange[] = [];
  const issues: DataValidationIssue[] = [];
  const result = reconcileFields(fields, asset.schema ?? [], asset.values, schemas, changes, issues, "",
    new Set(asset.structureGuid ? [asset.structureGuid] : []), 0);
  if (issues.some((entry) => entry.severity === "error")) return { asset, changes, issues };
  const next = createDataObjectAsset(asset.structureGuid, result.values, result.schema);
  if (schemas) issues.push(...validateDataObject(next, schemas));
  for (const change of changes) {
    if (change.kind === "typeChanged") issue(issues, "type-changed", change.path, "Structure field type changed; the authored value was preserved.", "warning");
  }
  return { asset: next, changes, issues };
}
