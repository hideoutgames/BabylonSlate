import { hardLoadingProperty } from "./asset-loading-policy";
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
  /** Asset and Class fields only: `"hard"` loads the reference with the asset that owns the value. Missing is Soft. */
  loading?: "hard";
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

/** A tree owns entries, their hierarchy, and stable internal identities. */
export interface DataTreeEntry {
  id: string;
  parentId: string | null;
  name: string;
  /** Omitted inherits; null explicitly makes this branch untyped. */
  definitionGuid?: string | null;
  values: Record<string, unknown>;
  /** Authoring snapshot for non-destructive schema reconciliation. */
  schema?: DataFieldSnapshot[];
}

export interface DataTreeAsset {
  kind: "dataTree";
  defaultDefinitionGuid: string | null;
  entries: DataTreeEntry[];
}

/** Serializable catalog shared by editor Play, workers, and exported players. */
export interface DataAssetCatalogEntry {
  guid: string;
  type: "DataDefinition" | "DataTree" | "Structure" | "Enum";
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

export function isDataTreeEntry(value: unknown): value is DataTreeEntry {
  return record(value) && typeof value.id === "string" && typeof value.name === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    (value.definitionGuid === undefined || value.definitionGuid === null || typeof value.definitionGuid === "string") && record(value.values);
}

export function isDataTreeAsset(value: unknown): value is DataTreeAsset {
  return record(value) && value.kind === "dataTree" &&
    (value.defaultDefinitionGuid === null || typeof value.defaultDefinitionGuid === "string") &&
    Array.isArray(value.entries) && value.entries.every(isDataTreeEntry);
}

export function createDataDefinitionAsset(fields: readonly DataDefinitionField[] = []): DataDefinitionAsset {
  return { kind: "dataDefinition", fields: structuredClone([...fields]) };
}

export interface CreateDataTreeEntryOptions {
  name: string;
  parentId?: string | null;
  definitionGuid?: string | null;
  values?: Record<string, unknown>;
  schema?: readonly DataFieldSnapshot[];
  id?: string;
}

export function createDataTreeEntry(options: CreateDataTreeEntryOptions): DataTreeEntry {
  return {
    id: options.id ?? newGuid(), parentId: options.parentId ?? null, name: options.name,
    ...(options.definitionGuid !== undefined ? { definitionGuid: options.definitionGuid } : {}),
    values: structuredClone(options.values ?? {}),
    ...(options.schema ? { schema: structuredClone([...options.schema]) } : {}),
  };
}

export function createDataTreeAsset(
  defaultDefinitionGuid: string | null = null,
  entries: readonly DataTreeEntry[] = [],
): DataTreeAsset {
  return { kind: "dataTree", defaultDefinitionGuid: defaultDefinitionGuid?.trim() || null, entries: structuredClone([...entries]) };
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

/** Opening an entry never adopts defaults or drops unrecognized authored values. */
export function normalizeDataTreeEntry(value: unknown): DataTreeEntry {
  if (!isDataTreeEntry(value)) throw new Error("Data Tree entries need an id, parentId, name, and values object.");
  return createDataTreeEntry({ ...value, schema: Array.isArray(value.schema) ? normalizeSnapshot(value.schema) : undefined });
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
    ...hardLoadingProperty(field),
  }));
}

export function normalizeDataTreeAsset(value: unknown): DataTreeAsset {
  if (!record(value) || (value.kind !== undefined && value.kind !== "dataTree")) throw new Error("Invalid Data Tree payload. Historical Data Sheets and Data Objects are unsupported.");
  if ("rows" in value || "objectGuids" in value || "structureGuid" in value || "definitionGuid" in value) {
    throw new Error("Historical Data Sheets and Data Objects cannot be opened as Data Trees; their stored data has not been changed.");
  }
  if (value.entries !== undefined && !Array.isArray(value.entries)) throw new Error("Data Tree entries must be an array.");
  if (value.defaultDefinitionGuid !== undefined && value.defaultDefinitionGuid !== null && typeof value.defaultDefinitionGuid !== "string") throw new Error("Invalid Data Tree default Definition.");
  return createDataTreeAsset(
    typeof value.defaultDefinitionGuid === "string" ? value.defaultDefinitionGuid : null,
    ((value.entries ?? []) as unknown[]).map(normalizeDataTreeEntry),
  );
}
