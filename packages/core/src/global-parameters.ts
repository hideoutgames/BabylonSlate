import { resizeParticleParameterValue } from "./particle-settings";

/** Asset header type of a Global Parameter Collection. */
export const GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE = "GlobalParameterCollection";

/** The value types a global parameter can hold. */
export const GLOBAL_PARAMETER_TYPES = ["float", "vec2", "vec3", "color"] as const;
export type GlobalParameterType = (typeof GLOBAL_PARAMETER_TYPES)[number];

/** Display names of the value types, in Title Case. */
export const GLOBAL_PARAMETER_TYPE_LABELS: Readonly<Record<GlobalParameterType, string>> = {
  float: "Float",
  vec2: "Vector 2",
  vec3: "Vector 3",
  color: "Color",
};

/** Longest parameter name, after trimming. */
export const GLOBAL_PARAMETER_NAME_MAX = 64;

/**
 * One named value of a collection. Graphs reference it by the collection guid and the stable
 * `id`, so a rename never breaks a reader; Class graphs set and get it by name.
 */
export interface GlobalParameter {
  id: string;
  /** Unique in the collection, case-sensitive, 1–64 characters after trimming. */
  name: string;
  type: GlobalParameterType;
  /** Sized to `type`. */
  defaultValue: number[];
}

export interface GlobalParameterCollectionPayload {
  parameters: GlobalParameter[];
}

/** Every collection's parameters by collection guid, as Play and exported games carry them. */
export type GlobalParameterCatalog = Record<string, GlobalParameter[]>;

export function isGlobalParameterType(value: unknown): value is GlobalParameterType {
  return typeof value === "string" && (GLOBAL_PARAMETER_TYPES as readonly string[]).includes(value);
}

/**
 * Fit a value to `type`: one component fills every component (alpha included), longer values
 * keep their leading components, missing components are 0 except color alpha (1).
 */
export function resizeGlobalParameterValue(value: readonly unknown[] | undefined, type: GlobalParameterType): number[] {
  return resizeParticleParameterValue(value, type);
}

/** A new parameter's value: 0 in every component, or opaque white for a Color. */
export function globalParameterStartValue(type: GlobalParameterType): number[] {
  return type === "color" ? [1, 1, 1, 1] : resizeGlobalParameterValue([0], type);
}

/** A trimmed name, or null when it is empty or longer than `GLOBAL_PARAMETER_NAME_MAX`. */
export function normalizeGlobalParameterName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= GLOBAL_PARAMETER_NAME_MAX ? name : null;
}

/**
 * `name` when no other parameter holds it, else its stem (a trailing `_N` removed) with the
 * first free `_1`, `_2`…, shortened to fit `GLOBAL_PARAMETER_NAME_MAX`. `exceptId` is the
 * parameter being renamed.
 */
export function uniqueGlobalParameterName(
  parameters: readonly Pick<GlobalParameter, "id" | "name">[],
  name = "Parameter",
  exceptId?: string,
): string {
  const taken = new Set(parameters.filter((parameter) => parameter.id !== exceptId).map((parameter) => parameter.name));
  if (!taken.has(name)) return name;
  const stem = name.replace(/_\d+$/, "") || name;
  for (let index = 1; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${stem.slice(0, GLOBAL_PARAMETER_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Parameters with an id, a valid name and a known type, defaults sized to the type. A repeated
 * id is dropped; a repeated name gets the first free `_N` suffix.
 */
export function normalizeGlobalParameters(value: unknown): GlobalParameter[] {
  if (!Array.isArray(value)) return [];
  const parameters: GlobalParameter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = normalizeGlobalParameterName(record.name);
    if (!id || !name || !isGlobalParameterType(record.type) || parameters.some((entry) => entry.id === id)) continue;
    const defaultValue = Array.isArray(record.defaultValue) ? record.defaultValue : globalParameterStartValue(record.type);
    parameters.push({
      id,
      name: uniqueGlobalParameterName(parameters, name),
      type: record.type,
      defaultValue: resizeGlobalParameterValue(defaultValue, record.type),
    });
  }
  return parameters;
}

export function normalizeGlobalParameterCollection(content: unknown): GlobalParameterCollectionPayload {
  const source = content && typeof content === "object" ? (content as Record<string, unknown>) : {};
  return { parameters: normalizeGlobalParameters(source.parameters) };
}

/** A new collection has no parameters. */
export function createDefaultGlobalParameterCollection(): GlobalParameterCollectionPayload {
  return { parameters: [] };
}

export function normalizeGlobalParameterCatalog(value: unknown): GlobalParameterCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const catalog: GlobalParameterCatalog = {};
  for (const [guid, parameters] of Object.entries(value)) {
    if (guid.trim()) catalog[guid] = normalizeGlobalParameters(parameters);
  }
  return catalog;
}

/** The parameter of a collection a graph reads, by id; null when either is gone. */
export function findGlobalParameter(
  catalog: Readonly<GlobalParameterCatalog>,
  collectionGuid: unknown,
  parameterId: unknown,
): GlobalParameter | null {
  if (typeof collectionGuid !== "string" || typeof parameterId !== "string") return null;
  return catalog[collectionGuid]?.find((parameter) => parameter.id === parameterId) ?? null;
}

/**
 * The parameter a Material or Particle Graph **Global Parameter** node reads. `valueType` is the
 * parameter's type when it was picked; the node's output follows it.
 */
export interface GlobalParameterSelection {
  collectionGuid: string;
  parameterId: string;
  valueType: GlobalParameterType;
}

const trimmedText = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A Global Parameter node's selection, or null while it has no collection, parameter or valid type. */
export function globalParameterSelection(
  properties: Readonly<Record<string, unknown>>,
): GlobalParameterSelection | null {
  const collectionGuid = trimmedText(properties.collectionGuid);
  const parameterId = trimmedText(properties.parameterId);
  const valueType = properties.valueType;
  if (!collectionGuid || !parameterId || !isGlobalParameterType(valueType)) return null;
  return { collectionGuid, parameterId, valueType };
}

/** A Global Parameter node's title: "<name> (Global <Type>)" when `catalog` holds its parameter, else "Global Parameter". */
export function globalParameterNodeTitle(
  properties: Readonly<Record<string, unknown>>,
  catalog: Readonly<GlobalParameterCatalog> | undefined,
): string {
  const selection = globalParameterSelection(properties);
  const parameter = selection && catalog
    ? findGlobalParameter(catalog, selection.collectionGuid, selection.parameterId)
    : null;
  return selection && parameter
    ? `${parameter.name} (Global ${GLOBAL_PARAMETER_TYPE_LABELS[selection.valueType]})`
    : "Global Parameter";
}

/**
 * The warning for a Global Parameter node: no parameter, or, given the project's `catalog`, a
 * parameter that is gone or has changed type since it was picked.
 */
export function globalParameterNodeWarning(
  properties: Readonly<Record<string, unknown>>,
  catalog: Readonly<GlobalParameterCatalog> | undefined,
): string | null {
  const selection = globalParameterSelection(properties);
  if (!selection) return "Global Parameter has no parameter selected";
  if (!catalog) return null;
  if (!catalog[selection.collectionGuid]) return "Global Parameter's collection is missing; it reads 0";
  const parameter = findGlobalParameter(catalog, selection.collectionGuid, selection.parameterId);
  if (!parameter) return "Global Parameter's parameter is no longer in its collection; it reads 0";
  return parameter.type === selection.valueType
    ? null
    : `"${parameter.name}" is now a ${GLOBAL_PARAMETER_TYPE_LABELS[parameter.type]} parameter; select it again to update this node`;
}
