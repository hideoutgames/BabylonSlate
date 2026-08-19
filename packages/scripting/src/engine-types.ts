/** Engine enum/struct registry (stable ids, not Content Browser assets). */

import { ENGINE_INPUT_MODE_ENUM_ID, INPUT_MODE_MEMBERS } from "@babylonslate/core";
import type { EnumMember, StructField } from "./type-assets";

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

/** Built-in engine enums (`engine:InputMode`, `engine:CollisionChannel`, …). */
export const ENGINE_ENUMS: readonly EngineEnum[] = [
  {
    id: ENGINE_INPUT_MODE_ENUM_ID,
    name: "Input Mode",
    members: INPUT_MODE_MEMBERS.map((name, value) => ({ name, value })),
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
