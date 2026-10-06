import { newGuid, type Result } from "./guid-result";

/** Save data deliberately contains gameplay values, never Babylon scene objects. */
export type SaveGameValue = null | boolean | number | string | SaveGameValue[] | { [key: string]: SaveGameValue };
export type SaveGameFieldType = "bool" | "int" | "float" | "string" | "vector3" | "actor" | "asset";
export interface SaveGameField {
  /** Persisted identity. Keep this ID when renaming the field. */
  id: string;
  name: string;
  type: SaveGameFieldType;
  defaultValue: SaveGameValue;
  array?: boolean;
}
export interface SaveGameDefinition {
  id: string;
  schemaVersion: number;
  fields: SaveGameField[];
}
export type SaveGameErrorCode = "missing" | "corrupt" | "incompatible" | "storage-full" | "unavailable" | "invalid" | "apply-failed";
export interface SaveGameFailure { code: SaveGameErrorCode; message: string }
export type SaveGameResult<T> = Result<T, SaveGameFailure>;
export class SaveGameError extends Error {
  constructor(readonly code: SaveGameErrorCode, message: string) {
    super(message);
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
  captureState?: () => SaveGameValue | Promise<SaveGameValue>;
  /** Validate and prepare without modifying the live world. */
  stageState?: (state: SaveGameValue) => unknown | Promise<unknown>;
  /** Must restore its previous world if applying a staged load throws. */
  applyState?: (staged: unknown) => void | Promise<void>;
  resetState?: () => void | Promise<void>;
  onGameLoaded?: (info: SaveGameInfo, data: TData) => void;
  /** Optional host codec can move encoding and hashing into a worker. */
  encode?: (value: SaveGameValue) => Promise<string>;
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const fieldTypes = new Set(["bool", "int", "float", "string", "vector3", "actor", "asset"]);
const MAX_JSON_NODES = 250_000;

export function isSaveGameRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject cycles, non-finite values, class instances and prototype pollution. */
export function cloneSaveGameValue(value: unknown): SaveGameValue {
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
        return Array.from(current, (entry) => copy(entry, depth + 1));
      }
      if (!isSaveGameRecord(current)) throw new SaveGameError("invalid", "Save data cannot contain class instances.");
      const result: Record<string, SaveGameValue> = {};
      for (const [key, entry] of Object.entries(current)) {
        if (forbiddenKeys.has(key)) throw new SaveGameError("invalid", "Save data contains a reserved property name.");
        result[key] = copy(entry, depth + 1);
      }
      return result;
    } finally {
      seen.delete(current);
    }
  }
  return copy(value, 0);
}

export function validateSaveGameFieldValue(field: SaveGameField, value: unknown): SaveGameValue {
  const scalar = (entry: unknown): boolean => {
    switch (field.type) {
      case "bool": return typeof entry === "boolean";
      case "int": return typeof entry === "number" && Number.isSafeInteger(entry);
      case "float": return typeof entry === "number" && Number.isFinite(entry);
      case "string": return typeof entry === "string";
      case "actor":
      case "asset": return entry === null || (typeof entry === "string" && entry.length > 0);
      case "vector3": return isSaveGameRecord(entry) && Object.keys(entry).length === 3 && [entry.x, entry.y, entry.z].every((axis) => typeof axis === "number" && Number.isFinite(axis));
    }
  };
  if (field.array ? !Array.isArray(value) || !value.every(scalar) : !scalar(value)) {
    throw new SaveGameError("invalid", `Save field “${field.name}” requires ${field.type}${field.array ? "[]" : ""}.`);
  }
  return cloneSaveGameValue(value);
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
    if (!isSaveGameRecord(entry) || typeof entry.id !== "string" || !entry.id || entry.id.length > 256 || forbiddenKeys.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 128 || forbiddenKeys.has(entry.name) || typeof entry.type !== "string" || !fieldTypes.has(entry.type) || (entry.array !== undefined && typeof entry.array !== "boolean")) {
      throw new SaveGameError("invalid", "Every Save Game field needs a stable ID, a name, a supported type and a matching default.");
    }
    if (ids.has(entry.id) || names.has(entry.name)) throw new SaveGameError("invalid", "Save Game field IDs and names must be unique.");
    ids.add(entry.id);
    names.add(entry.name);
    const field = { id: entry.id, name: entry.name, type: entry.type as SaveGameFieldType, defaultValue: entry.defaultValue as SaveGameValue, ...(entry.array === undefined ? {} : { array: entry.array }) };
    field.defaultValue = validateSaveGameFieldValue(field, entry.defaultValue);
    return field;
  });
  return { id: input.id, schemaVersion: input.schemaVersion as number, fields };
}

export function createSaveGameData(definition: SaveGameDefinition): Record<string, SaveGameValue> {
  return Object.fromEntries(validateSaveGameDefinition(definition).fields.map((field) => [field.name, cloneSaveGameValue(field.defaultValue)]));
}

/** Quotes names so authoring spaces, punctuation and renames remain valid TS. */
export function generateSaveGameTypes(definition: SaveGameDefinition, typeName = "SaveData"): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(typeName)) throw new SaveGameError("invalid", "The generated type name must be a TypeScript identifier.");
  const types: Record<SaveGameFieldType, string> = { bool: "boolean", int: "number", float: "number", string: "string", vector3: "{ x: number; y: number; z: number }", actor: "string | null", asset: "string | null" };
  const fields = validateSaveGameDefinition(definition).fields.map((field) => {
    const type = types[field.type];
    return `  ${JSON.stringify(field.name)}: ${field.array ? `Array<${type}>` : type};`;
  });
  return `export interface ${typeName} {\n${fields.join("\n")}\n}\n`;
}
