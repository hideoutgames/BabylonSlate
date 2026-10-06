/** Enum / Structure / ScriptInterface type asset payloads (P5). */

export type EnumMember = { name: string; value: number };

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
