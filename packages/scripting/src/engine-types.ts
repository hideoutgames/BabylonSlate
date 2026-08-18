/** Engine enum/struct registry (stable ids, not Content Browser assets). */

import { ENGINE_INPUT_MODE_ENUM_ID, INPUT_MODE_MEMBERS } from "@babylonslate/core";
import type { EnumMember, StructField } from "./type-assets";

export const ENGINE_TYPE_GUID_PREFIX = "engine:";

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

/** Built-in engine enums (`engine:InputMode`, future `engine:CollisionChannel`, …). */
export const ENGINE_ENUMS: readonly EngineEnum[] = [
  {
    id: ENGINE_INPUT_MODE_ENUM_ID,
    name: "Input Mode",
    members: INPUT_MODE_MEMBERS.map((name, value) => ({ name, value })),
  },
];

/** Future engine user-style structs register here. Pin-kind math types stay first-class. */
export const ENGINE_STRUCTS: readonly EngineStruct[] = [];

export function engineTypeGuid(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith(ENGINE_TYPE_GUID_PREFIX)
    ? trimmed
    : `${ENGINE_TYPE_GUID_PREFIX}${trimmed}`;
}

export function isEngineTypeGuid(guid: string): boolean {
  return guid.startsWith(ENGINE_TYPE_GUID_PREFIX);
}
