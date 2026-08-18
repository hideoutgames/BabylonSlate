/** Enum / Structure / ScriptInterface / FunctionLibrary type assets (P5). */

export type EnumMember = { name: string; value: number };

export type EnumAsset = {
  kind: "enum";
  guid: string;
  name: string;
  members: EnumMember[];
};

export type StructField = {
  name: string;
  typeId: string;
  /** Object/class constraint, or nested Structure/Enum asset guid. */
  typeClassId?: string;
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

export type FunctionLibraryAsset = {
  kind: "functionLibrary";
  guid: string;
  name: string;
  /** Parent class id — always FunctionLibrary. */
  parentClass: "FunctionLibrary";
  functionGraphIds: string[];
};

export type TypeAsset =
  | EnumAsset
  | StructureAsset
  | ScriptInterfaceAsset
  | FunctionLibraryAsset;

export function createEmptyEnum(guid: string, name: string): EnumAsset {
  return {
    kind: "enum",
    guid,
    name,
    members: [{ name: "None", value: 0 }],
  };
}

export function createEmptyStructure(
  guid: string,
  name: string,
): StructureAsset {
  return { kind: "structure", guid, name, fields: [] };
}

export function createEmptyScriptInterface(
  guid: string,
  name: string,
): ScriptInterfaceAsset {
  return { kind: "scriptInterface", guid, name, methods: [] };
}

export function createEmptyFunctionLibrary(
  guid: string,
  name: string,
): FunctionLibraryAsset {
  return {
    kind: "functionLibrary",
    guid,
    name,
    parentClass: "FunctionLibrary",
    functionGraphIds: [],
  };
}

export function scriptInterfaceHeaderMeta(asset: {
  guid?: string;
  name?: string;
  methods?: InterfaceMethod[];
}): {
  guid: string;
  name: string;
  methods: InterfaceMethod[];
} {
  return {
    guid: typeof asset.guid === "string" ? asset.guid : "",
    name: typeof asset.name === "string" && asset.name ? asset.name : "Interface",
    methods: Array.isArray(asset.methods) ? asset.methods : [],
  };
}
