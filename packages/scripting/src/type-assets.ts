/** Enum / Structure / ScriptInterface type asset payloads (P5). */
import type { DataFieldSnapshot } from "@babylonslate/core";

export type EnumMember = { name: string; value: number };

/** Enum member values are bytes: whole numbers from 0 to 255. */
export const ENUM_VALUE_MAX = 255;

/** Rounds and clamps a stored or typed member value into the byte range. */
export function clampEnumValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(ENUM_VALUE_MAX, Math.max(0, Math.round(value)));
}

export type EnumAsset = {
  kind: "enum";
  guid: string;
  name: string;
  members: EnumMember[];
};

export type StructField = {
  /** Optional for legacy assets; persisted identities make field renames safe. */
  id?: string;
  name: string;
  typeId: string;
  /** Object/class constraint, or nested Structure/Enum asset guid. */
  typeClassId?: string;
  /** Fields may hold the same typed collections as Class variables. */
  container?: "single" | "array" | "map";
  keyTypeId?: string;
  keyTypeClassId?: string;
  defaultValue?: unknown;
  /** Authored nested identities for a Data Definition field's stored default. */
  fields?: DataFieldSnapshot[];
  keyFields?: DataFieldSnapshot[];
  /** Asset and Class fields only: `"hard"` loads the reference with the asset that owns the value. Missing is Soft. */
  loading?: "hard";
  /** Number and vector fields: display unit (`VALUE_UNITS`). Missing is none. */
  unit?: string;
};

export type StructureAsset = {
  kind: "structure";
  guid: string;
  name: string;
  fields: StructField[];
};

export type InterfaceMethodPin = {
  name: string;
  typeId: string;
  direction: "in" | "out";
  typeClassId?: string;
};

export type InterfaceMethod = {
  name: string;
  pins: InterfaceMethodPin[];
};

export type ScriptInterfaceAsset = {
  kind: "scriptInterface";
  guid: string;
  name: string;
  methods: InterfaceMethod[];
};
