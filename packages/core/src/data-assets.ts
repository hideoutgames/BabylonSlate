/** Persisted data assets. Identity and display names live in the .babasset header. */
export interface DataFieldSnapshot {
  /** Stable Structure field identity, retained across renames. */
  id?: string;
  name: string;
  typeId: string;
  typeClassId?: string;
  container?: "single" | "array" | "map";
  keyTypeId?: string;
  keyTypeClassId?: string;
  /** Nested Structure schema at the time this value was authored. */
  fields?: DataFieldSnapshot[];
  /** Structure schema for typed Map keys. Values use `fields` above. */
  keyFields?: DataFieldSnapshot[];
}

/** A standalone, reusable record. Sheet membership is never required. */
export interface DataObjectAsset {
  kind: "dataObject";
  structureGuid: string | null;
  values: Record<string, unknown>;
  /** Authoring snapshot for non-destructive schema reconciliation. */
  schema?: DataFieldSnapshot[];
}

/** An ordered collection of references to independently owned Data Objects. */
export interface DataSheetAsset {
  kind: "dataSheet";
  structureGuid: string | null;
  objectGuids: string[];
}

/** Serializable catalog shared by editor Play, workers, and exported players. */
export interface DataAssetCatalogEntry {
  guid: string;
  type: "DataObject" | "DataSheet" | "Structure" | "Enum";
  name: string;
  payload: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDataObjectAsset(value: unknown): value is DataObjectAsset {
  return record(value) && value.kind === "dataObject" &&
    (value.structureGuid === null || typeof value.structureGuid === "string") &&
    record(value.values);
}

export function isDataSheetAsset(value: unknown): value is DataSheetAsset {
  return record(value) && value.kind === "dataSheet" &&
    (value.structureGuid === null || typeof value.structureGuid === "string") &&
    Array.isArray(value.objectGuids) && value.objectGuids.every((guid) => typeof guid === "string");
}

export function createDataObjectAsset(
  structureGuid: string | null = null,
  values: Record<string, unknown> = {},
  schema?: readonly DataFieldSnapshot[],
): DataObjectAsset {
  return {
    kind: "dataObject",
    structureGuid: structureGuid?.trim() || null,
    values: structuredClone(values),
    ...(schema ? { schema: structuredClone([...schema]) } : {}),
  };
}

export function createDataSheetAsset(
  structureGuid: string | null = null,
  objectGuids: readonly string[] = [],
): DataSheetAsset {
  return {
    kind: "dataSheet",
    structureGuid: structureGuid?.trim() || null,
    objectGuids: [...new Set(objectGuids.map((guid) => guid.trim()).filter(Boolean))],
  };
}

/** Does not hydrate against a Structure or discard unrecognized authored values. */
export function normalizeDataObjectAsset(value: unknown): DataObjectAsset {
  const source = record(value) ? value : {};
  return createDataObjectAsset(
    typeof source.structureGuid === "string" ? source.structureGuid : null,
    record(source.values) ? source.values : {},
    Array.isArray(source.schema) ? normalizeSnapshot(source.schema) : undefined,
  );
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
  const source = record(value) ? value : {};
  return createDataSheetAsset(
    typeof source.structureGuid === "string" ? source.structureGuid : null,
    Array.isArray(source.objectGuids)
      ? source.objectGuids.filter((guid): guid is string => typeof guid === "string")
      : [],
  );
}
