import { newGuid, type Result } from "./guid-result";

/** Save data deliberately contains gameplay values, never Babylon scene objects. */
export type SaveGameValue = null | boolean | number | string | SaveGameValue[] | { [key: string]: SaveGameValue };
export type SaveGameFieldType =
  | "bool" | "int" | "float" | "string" | "tag" | "enum" | "vector2" | "vector3" | "vector4" | "rotator" | "quat" | "color"
  | "transform" | "actor" | "class" | "asset" | "struct";
/** Map keys hold any value type except Actor references, which have no stable value identity. */
export type SaveGameMapKeyType = Exclude<SaveGameFieldType, "actor">;
export interface SaveGameField {
  /** Persisted identity. Keep this ID when renaming the field. */
  id: string;
  name: string;
  type: SaveGameFieldType;
  defaultValue: SaveGameValue;
  /** Omitted holds one value. `array` holds a list; `map` holds `{ key, value }` entries with unique keys. */
  container?: "array" | "map";
  /**
   * `struct` fields: the Structure's id (a project Structure or a built-in such as `engine:FloatRange`). Values
   * are plain records of its fields; the editor offers only Structures that hold no object references.
   */
  structId?: string;
  /** `enum` fields: the Enum asset's id. Values are member names. */
  enumId?: string;
  /** `map` fields: the key type, and its Structure or Enum like `structId` and `enumId`. */
  keyType?: SaveGameMapKeyType;
  keyStructId?: string;
  keyEnumId?: string;
}
export interface SaveGameDefinition {
  id: string;
  schemaVersion: number;
  /** Data Definition mode: the stored asset keeps no fields of its own; the editor resolves them from this Data Definition. */
  fields: SaveGameField[];
  dataDefinitionId?: string;
  /** Data Definition mode: default values, by field ID, that replace the Data Definition's own. */
  defaults?: Record<string, SaveGameValue>;
}
export type SaveGameErrorCode = "missing" | "corrupt" | "incompatible" | "storage-full" | "unavailable" | "invalid" | "apply-failed";
export interface SaveGameFailure { code: SaveGameErrorCode; message: string }
export type SaveGameResult<T> = Result<T, SaveGameFailure>;
export class SaveGameError extends Error {
  readonly code: SaveGameErrorCode;
  constructor(code: SaveGameErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SaveGameError";
  }
}

/** Platform adapters own private storage and cross-tab/window exclusion. */
export interface SaveGameStorage {
  read(key: string): Promise<string | null>;
  /** Resolves only after close/commit. Failed writes must not touch other keys. */
  write(key: string, text: string): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** All adapters sharing a physical store must share this exclusive lock. */
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  requestPersistence?(): Promise<boolean>;
}
export interface SaveGameOptions { profile?: string; slot?: string }
export interface SaveGameInfo {
  projectId: string;
  profile: string;
  slot: string;
  definitionId: string;
  schemaVersion: number;
  sequence: number;
  createdAt: string;
  recovered: boolean;
  status: "ok" | "corrupt" | "incompatible";
  error?: SaveGameFailure;
}
export interface SaveGameMigrationData {
  schemaVersion: number;
  /** Persisted field IDs, independent of display names. */
  fields: Record<string, SaveGameValue>;
  state: SaveGameValue;
}
export type SaveGameMigration = (snapshot: SaveGameMigrationData) => void | SaveGameMigrationData | Promise<void | SaveGameMigrationData>;
export interface SaveGameServiceOptions<TData extends object = Record<string, SaveGameValue>> {
  projectId: string;
  definition: SaveGameDefinition;
  storage: SaveGameStorage;
  preview?: boolean;
  defaultProfile?: string;
  defaultSlot?: string;
  /** Run capture/apply while simulation is suspended at its next boundary. */
  atBoundary?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  captureState?: (data: TData) => SaveGameValue | Promise<SaveGameValue>;
  /** Validate and prepare without modifying the live world. */
  stageState?: (state: SaveGameValue, data: TData) => unknown | Promise<unknown>;
  /** Must restore its previous world if applying a staged load throws. */
  applyState?: (staged: unknown) => void | Promise<void>;
  resetState?: () => void | Promise<void>;
  onGameLoaded?: (info: SaveGameInfo, data: TData) => void;
  /** Optional host codec can move encoding and hashing into a worker. */
  encode?: (value: SaveGameValue) => Promise<string>;
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const fieldTypes = new Set<string>([
  "bool", "int", "float", "string", "tag", "enum", "vector2", "vector3", "vector4", "rotator", "quat", "color", "transform",
  "actor", "class", "asset", "struct",
] satisfies SaveGameFieldType[]);
const MAX_TAG = 0xffff_ffff;
const MAX_JSON_NODES = 250_000;

export function isSaveGameRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject cycles, non-finite values, class instances and prototype pollution. */
function walkSaveGameValue(value: unknown, clone: boolean): SaveGameValue {
  const seen = new Set<object>();
  let nodes = 0;
  function copy(current: unknown, depth: number): SaveGameValue {
    if (++nodes > MAX_JSON_NODES || depth > 64) throw new SaveGameError("invalid", "Save data exceeds the supported complexity.");
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current !== "object" || !current || seen.has(current)) throw new SaveGameError("invalid", "Save data must contain finite, acyclic JSON values.");
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_JSON_NODES) throw new SaveGameError("invalid", "Save data contains an oversized array.");
        if (clone) return Array.from(current, (entry) => copy(entry, depth + 1));
        for (let index = 0; index < current.length; index++) copy(current[index], depth + 1);
        return current as SaveGameValue[];
      }
      if (!isSaveGameRecord(current)) throw new SaveGameError("invalid", "Save data cannot contain class instances.");
      const result: Record<string, SaveGameValue> = {};
      for (const [key, entry] of Object.entries(current)) {
        if (forbiddenKeys.has(key)) throw new SaveGameError("invalid", "Save data contains a reserved property name.");
        const checked = copy(entry, depth + 1);
        if (clone) result[key] = checked;
      }
      return clone ? result : current as Record<string, SaveGameValue>;
    } finally {
      seen.delete(current);
    }
  }
  return copy(value, 0);
}

/** Detach a bounded, JSON-compatible value without invoking toJSON methods. */
export function cloneSaveGameValue(value: unknown): SaveGameValue {
  return walkSaveGameValue(value, true);
}

/** Validate the combined snapshot budget without allocating another full copy. */
export function validateSaveGameValue(value: unknown): asserts value is SaveGameValue {
  walkSaveGameValue(value, false);
}

/** A plain record holding exactly these keys, each a finite number. */
function isNumberRecord(value: unknown, keys: readonly string[]): boolean {
  if (!isSaveGameRecord(value) || Object.keys(value).length !== keys.length) return false;
  return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}

/** One value of a field or map key type. */
function isSaveGameTypeValue(type: SaveGameFieldType, entry: unknown): boolean {
    switch (type) {
      case "bool": return typeof entry === "boolean";
      case "int": return typeof entry === "number" && Number.isSafeInteger(entry);
      case "float": return typeof entry === "number" && Number.isFinite(entry);
      case "tag": return typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= MAX_TAG;
      case "string":
      case "enum": return typeof entry === "string";
      case "actor":
      case "class":
      case "asset": return entry === null || (typeof entry === "string" && entry.length > 0);
      case "vector2": return isNumberRecord(entry, ["x", "y"]);
      case "vector3": return isNumberRecord(entry, ["x", "y", "z"]);
      case "vector4":
      case "quat":
      case "color": return isNumberRecord(entry, ["x", "y", "z", "w"]);
      case "rotator": return isNumberRecord(entry, ["pitch", "yaw", "roll"]);
      case "transform": return isSaveGameRecord(entry) && Object.keys(entry).length === 3 && isNumberRecord(entry.position, ["x", "y", "z"]) &&
        isNumberRecord(entry.rotation, ["x", "y", "z", "w"]) && isNumberRecord(entry.scale, ["x", "y", "z"]);
      case "struct": return isSaveGameRecord(entry);
    }
}

/** A field's type as `int`, `int[]` or `Map<string, int>`, for messages. */
export function describeSaveGameFieldType(field: Pick<SaveGameField, "type" | "container" | "keyType">): string {
  if (field.container === "map") return `Map<${field.keyType ?? "string"}, ${field.type}>`;
  return `${field.type}${field.container === "array" ? "[]" : ""}`;
}

function isMapValue(field: SaveGameField, value: unknown): boolean {
  if (!Array.isArray(value) || !field.keyType) return false;
  const keys = new Set<string>();
  return value.every((entry) => {
    if (!isSaveGameRecord(entry) || Object.keys(entry).length !== 2 || !("key" in entry) || !("value" in entry)) return false;
    if (!isSaveGameTypeValue(field.keyType!, entry.key) || !isSaveGameTypeValue(field.type, entry.value)) return false;
    const key = JSON.stringify(entry.key);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function validateSaveGameFieldValue(field: SaveGameField, value: unknown): SaveGameValue {
  const valid = field.container === "map" ? isMapValue(field, value)
    : field.container === "array" ? Array.isArray(value) && value.every((entry) => isSaveGameTypeValue(field.type, entry))
      : isSaveGameTypeValue(field.type, value);
  if (!valid) throw new SaveGameError("invalid", `Save field “${field.name}” requires ${describeSaveGameFieldType(field)}${field.container === "map" ? " with unique keys" : ""}.`);
  return cloneSaveGameValue(value);
}

function isTypeReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function createDefaultSaveGameDefinition(id = newGuid()): SaveGameDefinition {
  return { id, schemaVersion: 1, fields: [] };
}

export function validateSaveGameDefinition(input: unknown): SaveGameDefinition {
  if (!isSaveGameRecord(input) || typeof input.id !== "string" || !input.id || input.id.length > 256 || !Number.isSafeInteger(input.schemaVersion) || (input.schemaVersion as number) < 1 || !Array.isArray(input.fields) || input.fields.length > 2048) {
    throw new SaveGameError("invalid", "A Save Game definition needs an ID, positive schema version and fields.");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const fields: SaveGameField[] = input.fields.map((entry: unknown) => {
    if (!isSaveGameRecord(entry) || typeof entry.id !== "string" || !entry.id || entry.id.length > 256 || forbiddenKeys.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 128 || forbiddenKeys.has(entry.name) || typeof entry.type !== "string" || !fieldTypes.has(entry.type) || (entry.container !== undefined && entry.container !== "array" && entry.container !== "map")) {
      throw new SaveGameError("invalid", "Every Save Game field needs a stable ID, a name, a supported type and a matching default.");
    }
    if (entry.type === "struct" && !isTypeReference(entry.structId)) throw new SaveGameError("invalid", `Save field “${entry.name}” needs a Structure.`);
    if (entry.type === "enum" && !isTypeReference(entry.enumId)) throw new SaveGameError("invalid", `Save field “${entry.name}” needs an Enum.`);
    const map = entry.container === "map";
    if (map && (typeof entry.keyType !== "string" || !fieldTypes.has(entry.keyType) || entry.keyType === "actor")) {
      throw new SaveGameError("invalid", `Save field “${entry.name}” needs a Map key type other than Actor Reference.`);
    }
    if (map && entry.keyType === "struct" && !isTypeReference(entry.keyStructId)) throw new SaveGameError("invalid", `Save field “${entry.name}” needs a key Structure.`);
    if (map && entry.keyType === "enum" && !isTypeReference(entry.keyEnumId)) throw new SaveGameError("invalid", `Save field “${entry.name}” needs a key Enum.`);
    if (ids.has(entry.id) || names.has(entry.name)) throw new SaveGameError("invalid", "Save Game field IDs and names must be unique.");
    ids.add(entry.id);
    names.add(entry.name);
    const field: SaveGameField = {
      id: entry.id, name: entry.name, type: entry.type as SaveGameFieldType, defaultValue: null,
      ...(entry.container === undefined ? {} : { container: entry.container }),
      ...(entry.type === "struct" ? { structId: entry.structId as string } : {}),
      ...(entry.type === "enum" ? { enumId: entry.enumId as string } : {}),
      ...(map ? { keyType: entry.keyType as SaveGameMapKeyType } : {}),
      ...(map && entry.keyType === "struct" ? { keyStructId: entry.keyStructId as string } : {}),
      ...(map && entry.keyType === "enum" ? { keyEnumId: entry.keyEnumId as string } : {}),
    };
    field.defaultValue = validateSaveGameFieldValue(field, entry.defaultValue);
    return field;
  });
  if (input.dataDefinitionId !== undefined && !isTypeReference(input.dataDefinitionId)) {
    throw new SaveGameError("invalid", "A Save Game's Data Definition must be an asset ID.");
  }
  if (input.defaults !== undefined && (!isSaveGameRecord(input.defaults) || Object.keys(input.defaults).some((key) => forbiddenKeys.has(key)))) {
    throw new SaveGameError("invalid", "Save Game default overrides must be values keyed by field ID.");
  }
  return {
    id: input.id, schemaVersion: input.schemaVersion as number, fields,
    ...(input.dataDefinitionId === undefined ? {} : { dataDefinitionId: input.dataDefinitionId as string }),
    ...(input.defaults === undefined ? {} : { defaults: cloneSaveGameValue(input.defaults) as Record<string, SaveGameValue> }),
  };
}

export function createSaveGameData(definition: SaveGameDefinition): Record<string, SaveGameValue> {
  return Object.fromEntries(validateSaveGameDefinition(definition).fields.map((field) => [field.name, cloneSaveGameValue(field.defaultValue)]));
}

/** Quotes names so authoring spaces, punctuation and renames remain valid TS. */
export function generateSaveGameTypes(definition: SaveGameDefinition, typeName = "SaveData"): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(typeName)) throw new SaveGameError("invalid", "The generated type name must be a TypeScript identifier.");
  const vector3 = "{ x: number; y: number; z: number }";
  const vector4 = "{ x: number; y: number; z: number; w: number }";
  const types: Record<SaveGameFieldType, string> = {
    bool: "boolean", int: "number", float: "number", string: "string", tag: "number", enum: "string",
    vector2: "{ x: number; y: number }", vector3, vector4, rotator: "{ pitch: number; yaw: number; roll: number }", quat: vector4, color: vector4,
    transform: `{ position: ${vector3}; rotation: ${vector4}; scale: ${vector3} }`,
    actor: "string | null", class: "string | null", asset: "string | null", struct: "Record<string, unknown>",
  };
  const fields = validateSaveGameDefinition(definition).fields.map((field) => {
    const type = types[field.type];
    const declared = field.container === "map" ? `Array<{ key: ${types[field.keyType ?? "string"]}; value: ${type} }>`
      : field.container === "array" ? `Array<${type}>` : type;
    return `  ${JSON.stringify(field.name)}: ${declared};`;
  });
  return `export interface ${typeName} {\n${fields.join("\n")}\n}\n`;
}
