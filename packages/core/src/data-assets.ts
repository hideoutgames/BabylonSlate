import { newGuid } from "./guid-result";

/** Persisted data assets. Identity and display names live in the .babasset header. */
export interface DataFieldSnapshot {
  /** Stable field identity, retained across renames. */
  id?: string;
  name: string;
  typeId: string;
  typeClassId?: string;
  container?: "single" | "array" | "map";
  keyTypeId?: string;
  keyTypeClassId?: string;
  /** Nested record schema at the time this value was authored. */
  fields?: DataFieldSnapshot[];
  /** Record schema for typed Map keys. Values use `fields` above. */
  keyFields?: DataFieldSnapshot[];
}

/** Independent authoring schema; no Structure asset is required. */
export interface DataDefinitionField extends DataFieldSnapshot {
  id: string;
  defaultValue?: unknown;
  category?: string;
  description?: string;
  required?: boolean;
  min?: number;
  max?: number;
}

export interface DataDefinitionAsset {
  kind: "dataDefinition";
  fields: DataDefinitionField[];
}

/** A sheet owns its records and their stable local identities. */
export interface DataSheetRow {
  id: string;
  name: string;
  values: Record<string, unknown>;
  /** Authoring snapshot for non-destructive schema reconciliation. */
  schema?: DataFieldSnapshot[];
}

export interface DataSheetAsset {
  kind: "dataSheet";
  definitionGuid: string | null;
  rows: DataSheetRow[];
}

/** Serializable catalog shared by editor Play, workers, and exported players. */
export interface DataAssetCatalogEntry {
  guid: string;
  type: "DataDefinition" | "DataSheet" | "Structure" | "Enum";
  name: string;
  payload: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDataDefinitionAsset(value: unknown): value is DataDefinitionAsset {
  return record(value) && value.kind === "dataDefinition" && Array.isArray(value.fields) &&
    value.fields.every((field) => record(field) && typeof field.id === "string" && typeof field.name === "string" && typeof field.typeId === "string");
}

export function isDataSheetRow(value: unknown): value is DataSheetRow {
  return record(value) && typeof value.id === "string" && typeof value.name === "string" && record(value.values);
}

export function isDataSheetAsset(value: unknown): value is DataSheetAsset {
  return record(value) && value.kind === "dataSheet" &&
    (value.definitionGuid === null || typeof value.definitionGuid === "string") &&
    Array.isArray(value.rows) && value.rows.every(isDataSheetRow);
}

export function createDataDefinitionAsset(fields: readonly DataDefinitionField[] = []): DataDefinitionAsset {
  return { kind: "dataDefinition", fields: structuredClone([...fields]) };
}

export function createDataSheetRow(
  name: string,
  values: Record<string, unknown> = {},
  schema?: readonly DataFieldSnapshot[],
  id: string = newGuid(),
): DataSheetRow {
  return { id, name, values: structuredClone(values), ...(schema ? { schema: structuredClone([...schema]) } : {}) };
}

export function createDataSheetAsset(
  definitionGuid: string | null = null,
  rows: readonly DataSheetRow[] = [],
): DataSheetAsset {
  return { kind: "dataSheet", definitionGuid: definitionGuid?.trim() || null, rows: structuredClone([...rows]) };
}

export function normalizeDataDefinitionAsset(value: unknown): DataDefinitionAsset {
  if (!record(value) || (value.kind !== undefined && value.kind !== "dataDefinition") ||
    (value.fields !== undefined && !Array.isArray(value.fields))) throw new Error("Invalid Data Definition payload.");
  const fields = ((value.fields ?? []) as unknown[]).map((entry): DataDefinitionField => {
    if (!record(entry) || typeof entry.name !== "string" || typeof entry.typeId !== "string") {
      throw new Error("Data Definition fields need a name and type.");
    }
    if ((entry.required !== undefined && typeof entry.required !== "boolean") ||
      (entry.min !== undefined && typeof entry.min !== "number") || (entry.max !== undefined && typeof entry.max !== "number") ||
      (entry.container !== undefined && !["single", "array", "map"].includes(String(entry.container)))) {
      throw new Error("Invalid Data Definition field rules.");
    }
    const snapshot = normalizeSnapshot([entry])[0]!;
    return {
      ...snapshot, id: typeof entry.id === "string" && entry.id ? entry.id : `legacy:${entry.name}`,
      ...(entry.defaultValue !== undefined ? { defaultValue: structuredClone(entry.defaultValue) } : {}),
      ...(typeof entry.category === "string" ? { category: entry.category } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.required === "boolean" ? { required: entry.required } : {}),
      ...(typeof entry.min === "number" ? { min: entry.min } : {}),
      ...(typeof entry.max === "number" ? { max: entry.max } : {}),
    };
  });
  return createDataDefinitionAsset(fields);
}

/** Opening a row never adopts defaults or drops unrecognized authored values. */
export function normalizeDataSheetRow(value: unknown): DataSheetRow {
  if (!isDataSheetRow(value)) throw new Error("Data Sheet rows need an id, name, and values object.");
  return createDataSheetRow(value.name, value.values, Array.isArray(value.schema) ? normalizeSnapshot(value.schema) : undefined, value.id);
}

function normalizeSnapshot(fields: unknown[], depth = 0): DataFieldSnapshot[] {
  if (depth > 64) return [];
  return fields.filter(record).filter((field) => typeof field.name === "string" && typeof field.typeId === "string").map((field) => ({
    ...(typeof field.id === "string" && field.id ? { id: field.id } : {}),
    name: field.name as string,
    typeId: field.typeId as string,
    ...(typeof field.typeClassId === "string" ? { typeClassId: field.typeClassId } : {}),
    ...(field.container === "single" || field.container === "array" || field.container === "map" ? { container: field.container } : {}),
    ...(typeof field.keyTypeId === "string" ? { keyTypeId: field.keyTypeId } : {}),
    ...(typeof field.keyTypeClassId === "string" ? { keyTypeClassId: field.keyTypeClassId } : {}),
    ...(Array.isArray(field.fields) ? { fields: normalizeSnapshot(field.fields, depth + 1) } : {}),
    ...(Array.isArray(field.keyFields) ? { keyFields: normalizeSnapshot(field.keyFields, depth + 1) } : {}),
  }));
}

export function normalizeDataSheetAsset(value: unknown): DataSheetAsset {
  if (!record(value) || (value.kind !== undefined && value.kind !== "dataSheet")) throw new Error("Invalid Data Sheet payload.");
  if ("objectGuids" in value || "structureGuid" in value) {
    throw new Error("Legacy reference Data Sheets must be converted before opening; their stored data has not been changed.");
  }
  if (value.rows !== undefined && !Array.isArray(value.rows)) throw new Error("Data Sheet rows must be an array.");
  return createDataSheetAsset(
    typeof value.definitionGuid === "string" ? value.definitionGuid : null,
    ((value.rows ?? []) as unknown[]).map(normalizeDataSheetRow),
  );
}
