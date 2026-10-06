import {
  createDataSheetRow,
  type DataFieldSnapshot,
  type DataSheetRow,
  type DataSheetAsset,
  type DataDefinitionAsset,
  type DataDefinitionField,
} from "@babylonslate/core";
import type { StructField } from "./type-assets";
import { defaultValueForMember, mergeEngineTypeSchemas, structInstanceDefault, type StructSchema, type TypeSchemas } from "./type-defaults";
import { ENGINE_STRUCTS } from "./engine-types";

export interface DataValidationIssue {
  code: string;
  rowId?: string;
  severity: "error" | "warning";
  /** Dot-separated field names, or an empty string for the whole asset. */
  path: string;
  message: string;
}

export interface DataValidationOptions {
  /** Supply a project registry lookup to also validate asset existence and kind. */
  assetTypeForGuid?: (guid: string) => string | null | undefined;
}
type ValidationContext = DataValidationOptions & { allowEmptyRequired?: boolean };
type FieldRules = Pick<DataDefinitionField, "required" | "min" | "max">;

function validateFieldRules(field: StructField, issues: DataValidationIssue[], path: string): void {
  const rules = field as StructField & FieldRules;
  if (rules.required !== undefined && typeof rules.required !== "boolean") issue(issues, "invalid-rule", path, "Required must be a boolean.");
  if ((rules.min !== undefined && (typeof rules.min !== "number" || !Number.isFinite(rules.min))) ||
    (rules.max !== undefined && (typeof rules.max !== "number" || !Number.isFinite(rules.max))) ||
    (rules.min !== undefined && rules.max !== undefined && rules.min > rules.max)) {
    issue(issues, "invalid-range", path, "Field limits must be finite and Minimum cannot exceed Maximum.");
  }
  if ((rules.min !== undefined || rules.max !== undefined) && field.typeId !== "int" && field.typeId !== "float") {
    issue(issues, "invalid-range", path, "Numeric limits apply only to Integer and Float fields.");
  }
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
  return guid ? engineStructures.get(guid) ?? schemaEntry(schemas?.dataDefinitions, guid) : undefined;
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
export function createDataRowForDefinition(
  definitionGuid: string,
  fields: readonly StructField[],
  schemas?: TypeSchemas,
  name = "New Entry",
  id?: string,
): DataSheetRow {
  return createDataSheetRow(
    name,
    serializeDataRowValues(structInstanceDefault(fields, schemas, new Set([definitionGuid])), fields, schemas),
    snapshotDataFields(fields, schemas, new Set([definitionGuid])),
    id,
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
      issue(issues, "invalid-schema", at, "Definition fields need unique, non-empty names and identities.");
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
  issues: DataValidationIssue[], path: string, options: ValidationContext,
): void {
  const rules = field as StructField & FieldRules;
  validateFieldRules(field, issues, path);
  if (!options.allowEmptyRequired && rules.required && (value === null || value === undefined || (typeof value === "string" && !value.trim()))) {
    issue(issues, "required", path, "A value is required.");
  }
  if (typeof value === "number" && ((rules.min !== undefined && value < rules.min) || (rules.max !== undefined && value > rules.max))) {
    issue(issues, "out-of-range", path, "Value is outside the field's allowed range.");
  }
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
export function serializeDataRowValues(
  values: Record<string, unknown>, fields: readonly StructField[], schemas?: TypeSchemas,
): Record<string, unknown> {
  const plain = (value: unknown): value is Record<string, unknown> => record(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const visit = (field: StructField, value: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error("Nested data exceeds 64 levels.");
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
  schemas: TypeSchemas, issues: DataValidationIssue[], options: ValidationContext,
  path: string, depth: number,
): unknown {
  if (depth > 64) {
    issue(issues, "recursive-schema", path, "Nested data exceeds 64 levels.");
    return value;
  }
  if (field.container === "array" || field.container === "map") {
    validateFieldRules(field, issues, path);
    if (!Array.isArray(value)) {
      issue(issues, "type-mismatch", path, `Expected ${field.container === "map" ? "Map entries" : "an array"}.`);
      return value;
    }
    if (!options.allowEmptyRequired && (field as StructField & FieldRules).required && value.length === 0) issue(issues, "required", path, "At least one entry is required.");
    const checkType = (element: StructField, at: string) => {
      if (element.typeId === "struct" && !structureSchema(schemas, element.typeClassId)) {
        issue(issues, "missing-structure", at, "Choose an existing Data Definition or engine type for this collection.");
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
    if (!nested) issue(issues, "missing-structure", path, "Choose an existing Data Definition or engine type for this field.");
    if (nested && record(value)) return projectFields(nested.fields, previous?.fields ?? [], value, schemas, issues, options, path, depth + 1);
  }
  return value;
}

function projectFields(
  fields: readonly StructField[], snapshot: readonly DataFieldSnapshot[], values: Record<string, unknown>,
  schemas: TypeSchemas, issues: DataValidationIssue[], options: ValidationContext,
  path = "", depth = 0,
): Record<string, unknown> {
  if (depth > 64) {
    issue(issues, "recursive-schema", path, "Nested data exceeds 64 levels.");
    return {};
  }
  const entries: [string, unknown][] = [];
  const consumed = new Set<string>();
  const sources = fieldSources(fields, snapshot, values, issues, path);
  const sourceNames = new Set(sources.flatMap((entry) => entry.source === undefined ? [] : [entry.source]));
  for (const { field, previous, source } of sources) {
    const at = fieldPath(path, field.name);
    if (previous && !sameFieldType(field, previous)) issue(issues, "type-changed", at, "Definition field type changed; review the preserved value.", "warning");
    if (source === undefined) {
      issue(issues, "missing-field", at, "Field has no authored value; apply Definition changes or reset this field.");
      continue;
    }
    consumed.add(source);
    if (source !== field.name && own(values, field.name) && !sourceNames.has(field.name)) {
      issue(issues, "rename-conflict", at, "A retained value already uses the renamed field's name.");
    }
    if (source !== field.name) issue(issues, "renamed-field", at, `Field was renamed from ${source}; apply Definition changes to save the new name.`, "warning");
    entries.push([field.name, projectFieldValue(field, previous, values[source], schemas, issues, options, at, depth)]);
  }
  for (const key of Object.keys(values)) {
    if (!consumed.has(key)) issue(issues, "unknown-field", fieldPath(path, key), "Field is no longer in the Data Definition. Its stored value is preserved.", "warning");
  }
  return Object.fromEntries(entries);
}

function inspectDataRow(row: DataSheetRow, definitionGuid: string | null, schemas: TypeSchemas, options: DataValidationOptions): {
  values: Record<string, unknown>; issues: DataValidationIssue[];
} {
  const issues: DataValidationIssue[] = [];
  if (!record(row.values)) {
    issue(issues, "invalid-values", "", "Data entry values must be an object.");
    return { values: {}, issues };
  }
  validateSerializable(row.values, issues, "");
  const definition = schemaEntry(schemas.dataDefinitions, definitionGuid);
  if (!definition) {
    issue(issues, "missing-definition", "", "Choose an existing Data Definition for this sheet.");
    return { values: {}, issues };
  }
  return { values: projectFields(definition.fields, row.schema ?? [], row.values, schemas, issues, options), issues };
}

export function validateDataRow(
  row: DataSheetRow, definitionGuid: string | null, schemas: TypeSchemas, options: DataValidationOptions = {},
): DataValidationIssue[] {
  return inspectDataRow(row, definitionGuid, schemas, options).issues.map((entry) => ({ ...entry, rowId: row.id }));
}

/** Check the independent schema even before it has any sheet entries. */
export function validateDataDefinition(
  definition: DataDefinitionAsset, schemas?: TypeSchemas, definitionGuid = "__data_definition__",
): DataValidationIssue[] {
  const available = mergeEngineTypeSchemas({
    ...schemas,
    dataDefinitions: { ...schemas?.dataDefinitions, [definitionGuid]: { name: "Data Definition", fields: definition.fields } },
  });
  const issues: DataValidationIssue[] = [];
  const visit = (fields: readonly StructField[], path: string, visiting: ReadonlySet<string>, requiresIds: boolean): void => {
    fieldSources(fields, [], {}, issues, path);
    for (const field of fields) {
      const at = fieldPath(path, field.name);
      if (requiresIds && !field.id?.trim()) issue(issues, "invalid-schema", at, "Definition fields need stable identities.");
      if (field.container !== undefined && !["single", "array", "map"].includes(field.container)) issue(issues, "invalid-schema", at, "Unknown field container.");
      validateFieldRules(field, issues, at);
      const checkType = (spec: StructField, typePath: string): void => {
        const unconstrained = { name: spec.name, typeId: spec.typeId, typeClassId: spec.typeClassId };
        validateFieldValue(unconstrained, spec.typeId === "struct" ? {} : defaultValueForMember(spec.typeId, spec.typeClassId, available), available, issues, typePath, { allowEmptyRequired: true });
        if (spec.typeId !== "struct") return;
        const nested = structureSchema(available, spec.typeClassId);
        if (!nested) { issue(issues, "missing-structure", typePath, "Select an existing nested Data Definition or engine type."); return; }
        if (!spec.typeClassId) return;
        if (visiting.has(spec.typeClassId)) {
          issue(issues, "recursive-schema", typePath, "Data Definitions cannot reference themselves directly or through another Definition.");
          return;
        }
        if (visiting.size >= 64) {
          issue(issues, "recursive-schema", typePath, "Nested Data Definitions cannot exceed 64 levels.");
          return;
        }
        visit(nested.fields, typePath, new Set([...visiting, spec.typeClassId]), !!schemaEntry(available.dataDefinitions, spec.typeClassId));
      };
      checkType(field, at);
      if (field.container === "map") checkType(mapKeyField(field), fieldPath(at, "key"));
      if (field.defaultValue !== undefined) {
        validateSerializable(field.defaultValue, issues, at);
        projectFieldValue(field, undefined, field.defaultValue, available, issues, { allowEmptyRequired: true }, at, 0);
      }
    }
  };
  visit(definition.fields, "", new Set([definitionGuid]), true);
  return issues;
}

export function validateDataSheet(
  sheet: DataSheetAsset, schemas: TypeSchemas, options: DataValidationOptions = {},
): DataValidationIssue[] {
  const issues: DataValidationIssue[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const row of sheet.rows) {
    if (!row.id.trim() || row.id.trim() !== row.id || ids.has(row.id)) issues.push({ code: "duplicate-row", severity: "error", path: "", rowId: row.id, message: "Entries need unique, non-empty identities without surrounding whitespace." });
    ids.add(row.id);
    if (!row.name.trim()) issues.push({ code: "missing-row-name", severity: "error", path: "", rowId: row.id, message: "Entry name cannot be empty." });
    const name = row.name.trim().toLowerCase();
    if (names.has(name)) issues.push({ code: "duplicate-row-name", severity: "error", path: "", rowId: row.id, message: "Entry names must be unique." });
    names.add(name);
    issues.push(...validateDataRow(row, sheet.definitionGuid, schemas, options));
  }
  if (!schemaEntry(schemas.dataDefinitions, sheet.definitionGuid) && sheet.rows.length === 0) {
    issue(issues, "missing-definition", "", "Choose an existing Data Definition for this sheet.");
  }
  return issues;
}

/** Detached, typed runtime value; invalid/missing authored fields fail explicitly. */
export function resolveDataRowValues(row: DataSheetRow, definitionGuid: string | null, schemas: TypeSchemas): Record<string, unknown> | null {
  const result = inspectDataRow(row, definitionGuid, schemas, {});
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
    issue(issues, "recursive-schema", path, "Nested data exceeds 64 levels.");
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
    issue(issues, "recursive-schema", path, "Nested data exceeds 64 levels.");
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
      issue(issues, "rename-conflict", at, "An existing retained value already uses this name. Resolve the conflict before applying Definition changes.");
      continue;
    }
    if (source === undefined) changes.push({ kind: "added", path: at });
    else if (source !== field.name) changes.push({ kind: "renamed", path: at, previousPath: fieldPath(path, source) });
    let value = source === undefined
      ? serializeDataRowValues(structInstanceDefault([field], schemas, visiting), [field], schemas)[field.name]
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
export function reconcileDataRow(
  row: DataSheetRow, definitionGuid: string | null, fields: readonly StructField[], schemas?: TypeSchemas,
): { row: DataSheetRow; changes: DataSchemaChange[]; issues: DataValidationIssue[] } {
  const changes: DataSchemaChange[] = [];
  const issues: DataValidationIssue[] = [];
  const result = reconcileFields(fields, row.schema ?? [], row.values, schemas, changes, issues, "",
    new Set(definitionGuid ? [definitionGuid] : []), 0);
  if (issues.some((entry) => entry.severity === "error")) return { row, changes, issues: issues.map((entry) => ({ ...entry, rowId: row.id })) };
  const next = createDataSheetRow(row.name, result.values, result.schema, row.id);
  if (schemas) issues.push(...validateDataRow(next, definitionGuid, schemas));
  for (const change of changes) {
    if (change.kind === "typeChanged") issue(issues, "type-changed", change.path, "Definition field type changed; the authored value was preserved.", "warning");
  }
  return { row: next, changes, issues: issues.map((entry) => ({ ...entry, rowId: row.id })) };
}
