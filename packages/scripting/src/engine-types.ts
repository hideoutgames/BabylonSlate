/** Engine enum/struct registry (stable ids, not Content Browser assets). */

import type { EnumMember, StructField } from "./type-assets";

export const ENGINE_INPUT_TYPE_STRUCT_ID = "engine:InputType";
export const ENGINE_INPUT_CONTROL_STRUCT_ID = "engine:InputControl";
export const ENGINE_INPUT_BINDING_STRUCT_ID = "engine:InputBinding";
export const ENGINE_INPUT_DEVICE_ENUM_ID = "engine:InputDevice";

export const ENGINE_TYPE_GUID_PREFIX = "engine:";

export const ENGINE_COLLISION_CHANNEL_ENUM_ID = "engine:CollisionChannel";
export const ENGINE_HIT_RESULT_STRUCT_ID = "engine:HitResult";

export const COLLISION_CHANNEL_MEMBERS = [
  "All",
  "WorldStatic",
  "WorldDynamic",
  "Pawn",
  "Visibility",
] as const;

export type EngineEnum = {
  id: string;
  name: string;
  members: EnumMember[];
};

export type EngineStruct = {
  id: string;
  name: string;
  fields: StructField[];
};

/** Built-in engine enums (`engine:CollisionChannel`, …). */
export const ENGINE_ENUMS: readonly EngineEnum[] = [
  {
    id: "engine:InputRebindStatus",
    name: "Input Rebind Status",
    members: ["idle", "listening", "completed", "cancelled"].map(
      (name, value) => ({ name, value }),
    ),
  },
  {
    id: ENGINE_INPUT_DEVICE_ENUM_ID,
    name: "Input Device",
    members: [
      "key",
      "mouseButton",
      "pointer",
      "gamepadButton",
      "gamepadAxis",
      "touch",
    ].map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_COLLISION_CHANNEL_ENUM_ID,
    name: "Collision Channel",
    members: COLLISION_CHANNEL_MEMBERS.map((name, value) => ({ name, value })),
  },
];

/** Engine user-style structs. Pin-kind math types stay first-class. */
export const ENGINE_STRUCTS: readonly EngineStruct[] = [
  {
    id: ENGINE_INPUT_TYPE_STRUCT_ID,
    name: "Input Type",
    fields: [
      { name: "Name", typeId: "string" },
      { name: "Asset", typeId: "asset" },
    ],
  },
  {
    id: ENGINE_INPUT_CONTROL_STRUCT_ID,
    name: "Input Control",
    fields: [
      {
        name: "Device",
        typeId: "enum",
        typeClassId: ENGINE_INPUT_DEVICE_ENUM_ID,
      },
      { name: "Code", typeId: "string" },
      ...["Shift", "Ctrl", "Alt", "Meta"].map((name) => ({
        name,
        typeId: "bool",
      })),
    ],
  },
  {
    id: ENGINE_INPUT_BINDING_STRUCT_ID,
    name: "Input Binding",
    fields: [
      {
        name: "Input",
        typeId: "struct",
        typeClassId: ENGINE_INPUT_TYPE_STRUCT_ID,
      },
      { name: "Id", typeId: "string" },
      {
        name: "Control",
        typeId: "struct",
        typeClassId: ENGINE_INPUT_CONTROL_STRUCT_ID,
      },
    ],
  },
  {
    id: ENGINE_HIT_RESULT_STRUCT_ID,
    name: "Hit Result",
    fields: [
      { name: "Hit", typeId: "bool" },
      { name: "Location", typeId: "vec3" },
      { name: "Normal", typeId: "vec3" },
      { name: "Actor", typeId: "actor" },
      { name: "Distance", typeId: "float" },
    ],
  },
];

export function engineTypeGuid(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith(ENGINE_TYPE_GUID_PREFIX)
    ? trimmed
    : `${ENGINE_TYPE_GUID_PREFIX}${trimmed}`;
}

export function isEngineTypeGuid(guid: string): boolean {
  return guid.startsWith(ENGINE_TYPE_GUID_PREFIX);
}
