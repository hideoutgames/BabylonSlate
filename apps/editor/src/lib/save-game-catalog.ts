import {
  cloneSaveGameValue, parseMapDefaultEntries, validateSaveGameDefinition, validateSaveGameFieldValue,
  type SaveGameDefinition, type SaveGameField, type SaveGameFieldType, type SaveGameMapKeyType, type SaveGameValue,
} from "@haptic/core";
import { defaultValueForMember, structInstanceDefault, type StructField, type TypeSchemas } from "@haptic/scripting";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "./logic-graph-document";

type SaveAsset = { path: string; header: { guid?: string; type: string; payload?: Record<string, unknown> } };
type SaveDocument = { ref: { path?: string; kind: string }; content: unknown };

/** Default definition, including unsaved edits in its open asset document. */
export function defaultSaveGameDefinition(
  guid: string | null | undefined,
  assets: ReadonlyArray<SaveAsset>,
  documents: ReadonlyArray<SaveDocument>,
): SaveGameDefinition | undefined {
  if (!guid) return undefined;
  const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "SaveGame");
  if (!asset) return undefined;
  const open = documents.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === asset.path);
  try { return validateSaveGameDefinition(open?.content ?? asset.header.payload); }
  catch { return undefined; }
}

/** Registry headers omit document chunks; closed definitions must be loaded. */
export async function loadDefaultSaveGameDefinition(
  guid: string | null | undefined,
  assets: ReadonlyArray<SaveAsset>,
  documents: ReadonlyArray<SaveDocument>,
  loadAssetDocument: (kind: "save-game", path: string) => Promise<unknown>,
): Promise<SaveGameDefinition | undefined> {
  if (!guid) return undefined;
  const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "SaveGame");
  if (!asset) return undefined;
  const open = documents.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === asset.path);
  try { return validateSaveGameDefinition(open ? open.content : await loadAssetDocument("save-game", asset.path)); }
  catch { return undefined; }
}

const OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["object", "class", "delegate", "wildcard", "actor"]);

/** Whether each Structure, by id, holds only plain values at any depth. */
function plainStructureCheck(schemas: TypeSchemas): (guid: string) => boolean {
  const verdicts = new Map<string, boolean>();
  const plain = (guid: string, visiting: ReadonlySet<string>): boolean => {
    const known = verdicts.get(guid);
    if (known !== undefined) return known;
    if (visiting.has(guid)) return true;
    const schema = schemas.structs[guid];
    if (!schema) return false;
    const next = new Set([...visiting, guid]);
    const result = schema.fields.every((field) => {
      if (OBJECT_TYPE_IDS.has(field.typeId) || (field.keyTypeId && OBJECT_TYPE_IDS.has(field.keyTypeId))) return false;
      if (field.typeId === "struct" && field.typeClassId && !plain(field.typeClassId, next)) return false;
      if (field.keyTypeId === "struct" && field.keyTypeClassId && !plain(field.keyTypeClassId, next)) return false;
      return true;
    });
    verdicts.set(guid, result);
    return result;
  };
  return (guid) => plain(guid, new Set());
}

/**
 * Structures a Save Game field can hold: those whose fields, nested Structures included, carry no object,
 * class or delegate references, since a save stores plain values. Built-in ranges and curves qualify.
 */
export function saveableStructures<T extends { guid: string; name: string }>(
  structures: readonly T[],
  schemas: TypeSchemas,
): T[] {
  const plain = plainStructureCheck(schemas);
  return structures.filter((entry) => plain(entry.guid)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Save Game field types whose pin type ids differ; Structure fields, TagContainer included, are `struct`. */
const PIN_TYPE_IDS: Partial<Record<SaveGameFieldType, string>> = { vector2: "vec2", vector3: "vec3", vector4: "vec4" };
const FIELD_TYPES_BY_PIN: Readonly<Record<string, SaveGameFieldType>> = {
  bool: "bool", int: "int", float: "float", string: "string", tag: "tag", enum: "enum", vec2: "vector2", vec3: "vector3",
  vec4: "vector4", rotator: "rotator", quat: "quat", color: "color", transform: "transform", class: "class", asset: "asset", struct: "struct",
};

export function saveFieldPinTypeId(type: SaveGameFieldType): string {
  return PIN_TYPE_IDS[type] ?? type;
}

/** One value of a type: references start as None, the rest as the type's own default. */
export function saveTypeDefault(type: SaveGameFieldType, typeClassId: string | undefined, schemas: TypeSchemas): SaveGameValue {
  if (type === "actor" || type === "class" || type === "asset") return null;
  return cloneSaveGameValue(defaultValueForMember(saveFieldPinTypeId(type), typeClassId, schemas));
}

/** A field's starting value: empty for an Array or Map, else one value of its type. */
export function saveFieldDefault(field: Pick<SaveGameField, "type" | "structId" | "enumId" | "container">, schemas: TypeSchemas): SaveGameValue {
  return field.container ? [] : saveTypeDefault(field.type, field.structId ?? field.enumId, schemas);
}

export interface SkippedSaveField {
  name: string;
  reason: string;
}

export interface ResolvedSaveGame {
  /** A linked Save Game's fields come from its Data Definition; an unlinked one is returned as stored. */
  definition: SaveGameDefinition;
  /** Data Definition fields a Save Game cannot hold. */
  skipped: SkippedSaveField[];
  /** The linked Data Definition is not in the project, so the Save Game has no fields. */
  missingDataDefinition: boolean;
}

type FieldTypeChoice = { type: SaveGameFieldType; ref?: string };

/** The Save Game type of a Data Definition type, or why it cannot be saved. */
function savedTypeOf(typeId: string, typeClassId: string | undefined, plain: (guid: string) => boolean): FieldTypeChoice | string {
  const type = FIELD_TYPES_BY_PIN[typeId];
  if (!type) return "Object references can't be saved.";
  if (type === "struct" && (!typeClassId || !plain(typeClassId))) return "Its Structure is missing or holds object references.";
  if (type === "enum" && !typeClassId) return "It has no Enum.";
  return type === "struct" || type === "enum" ? { type, ref: typeClassId } : { type };
}

function savedFieldOf(source: StructField & { id: string }, plain: (guid: string) => boolean): SaveGameField | string {
  const value = savedTypeOf(source.typeId, source.typeClassId, plain);
  if (typeof value === "string") return value;
  const field: SaveGameField = {
    id: source.id, name: source.name, type: value.type, defaultValue: null,
    ...(value.type === "struct" ? { structId: value.ref } : value.type === "enum" ? { enumId: value.ref } : {}),
  };
  if (source.container === "array") return { ...field, container: "array" };
  if (source.container !== "map") return field;
  const key = savedTypeOf(source.keyTypeId ?? "string", source.keyTypeClassId, plain);
  if (typeof key === "string") return `Its Map key: ${key}`;
  return {
    ...field, container: "map", keyType: key.type as SaveGameMapKeyType,
    ...(key.type === "struct" ? { keyStructId: key.ref } : key.type === "enum" ? { keyEnumId: key.ref } : {}),
  };
}

/** Data Definitions store an unset Asset or Class as an empty id; a save stores None. */
function savedDataDefault(field: SaveGameField, value: unknown): unknown {
  const none = (type: SaveGameFieldType, entry: unknown) => (type === "asset" || type === "class") && entry === "" ? null : entry;
  if (field.container === "map") return parseMapDefaultEntries(value).map((entry) => ({ key: entry.key, value: none(field.type, entry.value) }));
  if (field.container === "array") return Array.isArray(value) ? value.map((entry) => none(field.type, entry)) : value;
  return none(field.type, value);
}

function validDefault(field: SaveGameField, value: unknown): SaveGameValue | undefined {
  if (value === undefined) return undefined;
  try { return validateSaveGameFieldValue(field, value); }
  catch { return undefined; }
}

const RESERVED_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A Save Game linked to a Data Definition takes its fields, field IDs and defaults from that Data Definition each
 * time it is read, so editing the Data Definition updates every Save Game that uses it. A default override wins
 * when it still fits its field's type.
 */
export function resolveSaveGameDefinition(stored: unknown, schemas: TypeSchemas): ResolvedSaveGame {
  const definition = validateSaveGameDefinition(stored);
  if (!definition.dataDefinitionId) return { definition, skipped: [], missingDataDefinition: false };
  const schema = schemas.dataDefinitions?.[definition.dataDefinitionId];
  if (!schema) return { definition: { ...definition, fields: [] }, skipped: [], missingDataDefinition: true };
  const plain = plainStructureCheck(schemas);
  const dataDefaults = structInstanceDefault(schema.fields, schemas);
  const skipped: SkippedSaveField[] = [];
  const names = new Set<string>();
  const fields: SaveGameField[] = [];
  for (const source of schema.fields) {
    if (!source.id || !source.name) continue;
    if (names.has(source.name) || RESERVED_NAMES.has(source.name) || source.name.length > 128) {
      skipped.push({ name: source.name, reason: "Its name is reserved, too long or used twice." });
      continue;
    }
    const field = savedFieldOf(source as StructField & { id: string }, plain);
    if (typeof field === "string") {
      skipped.push({ name: source.name, reason: field });
      continue;
    }
    names.add(source.name);
    field.defaultValue = validDefault(field, definition.defaults?.[field.id])
      ?? validDefault(field, savedDataDefault(field, dataDefaults[source.name]))
      ?? saveFieldDefault(field, schemas);
    fields.push(field);
  }
  return { definition: validateSaveGameDefinition({ ...definition, fields }), skipped, missingDataDefinition: false };
}

/** Play, Export and the save manager need every field: a linked Save Game whose Data Definition is gone cannot run. */
export function requireSaveGameDefinition(stored: unknown, schemas: TypeSchemas): SaveGameDefinition {
  const resolved = resolveSaveGameDefinition(stored, schemas);
  if (resolved.missingDataDefinition) throw new Error("The Save Game's Data Definition is missing. Choose another one in the Save Game's Advanced settings.");
  return resolved.definition;
}

/** Type schemas, Data Definitions included, from project assets and open type documents (for reads outside React). */
export function projectTypeSchemas(
  assets: Parameters<typeof collectGraphTypeAssets>[0]["assets"],
  openDocuments: Parameters<typeof collectGraphTypeAssets>[0]["openDocuments"],
): TypeSchemas {
  return typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets, openDocuments }));
}
