import { ASSET_TYPES } from "@babylonslate/core";
import type { EngineEnum, EngineStruct } from "./engine-types";

/** Engine types behind the Asset Registry nodes (`packages/scripting-nodes/src/asset-registry.ts`). */
export const ENGINE_ASSET_TYPE_ENUM_ID = "engine:AssetType";
export const ENGINE_ASSET_DATA_STRUCT_ID = "engine:AssetData";
export const ENGINE_ASSET_FILTER_STRUCT_ID = "engine:AssetFilter";

/** One member per asset header type, so Find Assets can target every type. */
export const ASSET_REGISTRY_ENUMS: EngineEnum[] = [
  {
    id: ENGINE_ASSET_TYPE_ENUM_ID,
    name: "Asset Type",
    members: ASSET_TYPES.map((name, value) => ({ name, value })),
  },
];

/** Field names are the runtime object keys Break and Make Structure read. */
export const ASSET_REGISTRY_STRUCTS: EngineStruct[] = [
  {
    id: ENGINE_ASSET_DATA_STRUCT_ID,
    name: "Asset Data",
    fields: [
      { name: "Asset", typeId: "asset" },
      { name: "Name", typeId: "string" },
      { name: "Path", typeId: "string" },
      { name: "Folder", typeId: "string" },
      { name: "Type", typeId: "enum", typeClassId: ENGINE_ASSET_TYPE_ENUM_ID },
      { name: "Class", typeId: "class", typeClassId: "BObject" },
      { name: "ParentClass", typeId: "class", typeClassId: "BObject" },
    ],
  },
  {
    id: ENGINE_ASSET_FILTER_STRUCT_ID,
    name: "Asset Filter",
    fields: [
      { name: "Folders", typeId: "string", container: "array", defaultValue: [] },
      { name: "Recursive", typeId: "bool", defaultValue: true },
      {
        name: "Types",
        typeId: "enum",
        typeClassId: ENGINE_ASSET_TYPE_ENUM_ID,
        container: "array",
        defaultValue: [],
      },
      { name: "Classes", typeId: "class", typeClassId: "BObject", container: "array", defaultValue: [] },
      { name: "IncludeSubclasses", typeId: "bool", defaultValue: true },
      { name: "NameContains", typeId: "string", defaultValue: "" },
    ],
  },
];
